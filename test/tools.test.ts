import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { BrowserConfig } from '../src/config.js'
import { startBrowserServer } from '../src/browser-server.js'
import { startFixtureServer, type FixtureServer } from './fixture-server.js'

const chromePath =
  process.env.CHROME_PATH ?? '/opt/chrome-for-testing/chrome/linux-156.0.8078.47/chrome-linux64/chrome'
const hasChrome = existsSync(chromePath)

let tempRoot = ''
let fixture: FixtureServer

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tools-test-'))
  fixture = await startFixtureServer()
})

afterAll(async () => {
  await fixture?.close()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

function config(): BrowserConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    chromePath,
    headless: true,
    profileRoot: join(tempRoot, 'profiles'),
    artifactRoot: join(tempRoot, 'artifacts'),
    defaultTimeoutMs: 15_000,
    navigationTimeoutMs: 30_000,
    idleTimeoutMs: 0,
  }
}

interface ToolResponse {
  ok: boolean
  content?: string
  structured?: any
  error?: string
}

async function callTool(base: string, id: string, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const response = await fetch(`${base}/sessions/${id}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
  expect(response.status).toBe(200)
  return await response.json() as ToolResponse
}

describe.skipIf(!hasChrome)('browser tools and session binding', () => {
  it('create-or-get is idempotent and tool calls update activity', async () => {
    const handle = await startBrowserServer(config())
    try {
      const first = await handle.manager.create({ id: 'bound-session' })
      expect(first.created).toBe(true)
      const again = await handle.manager.create({ id: 'bound-session' })
      expect(again.created).toBe(false)
      expect(again.info.id).toBe('bound-session')
      expect(again.info.mcpUrl).toBe(first.info.mcpUrl)
      expect(again.info.lastActivityAt).toBeDefined()

      await new Promise(resolve => setTimeout(resolve, 10))
      await handle.manager.handleTool('bound-session', 'browser_snapshot', {})
      const info = await handle.manager.info('bound-session')
      expect(Date.parse(info.lastActivityAt ?? '')).toBeGreaterThanOrEqual(Date.parse(again.info.lastActivityAt ?? ''))
    } finally {
      await handle.close()
    }
  })

  it('dispatches tools over POST /sessions/:id/tool with auto-create', async () => {
    const handle = await startBrowserServer(config())
    try {
      const navigate = await callTool(handle.url, 'agent-ses-123', 'browser_navigate', { url: `${fixture.url}/page` })
      expect(navigate.ok).toBe(true)
      expect(navigate.content).toContain('Test Page')

      // The session was auto-created for the agent.
      const list = await fetch(`${handle.url}/sessions`).then(response => response.json()) as { sessions: Array<{ id: string }> }
      expect(list.sessions.map(row => row.id)).toContain('agent-ses-123')

      const wait = await callTool(handle.url, 'agent-ses-123', 'browser_wait_for', { text: 'fixture page', timeoutMs: 5000 })
      expect(wait.ok).toBe(true)
      expect(wait.structured.found).toBe(true)

      const find = await callTool(handle.url, 'agent-ses-123', 'browser_find', { selector: '#name' })
      expect(find.ok).toBe(true)
      expect(find.structured.matches).toHaveLength(1)
      expect(find.structured.matches[0]).toMatchObject({ id: 'e1', tag: 'input' })

      const consoleRead = await callTool(handle.url, 'agent-ses-123', 'browser_console', { level: 'log' })
      expect(consoleRead.ok).toBe(true)
      expect(consoleRead.structured.messages.some((entry: { text: string }) => entry.text.includes('fixture ready'))).toBe(true)

      const network = await callTool(handle.url, 'agent-ses-123', 'browser_network', {})
      expect(network.ok).toBe(true)
      expect(network.structured.requests.some((entry: { url: string }) => entry.url.includes('/page'))).toBe(true)

      const batch = await callTool(handle.url, 'agent-ses-123', 'browser_batch', {
        steps: [
          { action: 'navigate', url: `${fixture.url}/next` },
          { action: 'wait_for', text: 'second fixture page', timeoutMs: 5000 },
          { action: 'snapshot' },
        ],
      })
      expect(batch.ok).toBe(true)
      expect(batch.structured.steps).toHaveLength(3)
      expect(batch.structured.steps.every((step: { ok: boolean }) => step.ok)).toBe(true)
      expect(batch.structured.steps[2].content).toContain('Next Page')

      const unknown = await callTool(handle.url, 'agent-ses-123', 'browser_bogus', {})
      expect(unknown.ok).toBe(false)
      expect(unknown.error).toContain('unknown browser tool')
    } finally {
      await handle.close()
    }
  })

  it('accepts viewer input over WebSocket', async () => {
    const handle = await startBrowserServer(config())
    try {
      const { info: session } = await handle.manager.create({ id: 'ws-session' })
      const controller = new AbortController()
      const stream = await fetch(`${handle.viewerUrl}/sessions/${session.id}/stream`, { signal: controller.signal })
      expect(stream.status).toBe(200)
      const reader = stream.body?.getReader()
      const deadline = Date.now() + 10_000
      let text = ''
      while (!text.includes('event: state') && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader!.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream read timeout')), 10_000)),
        ])
        if (!chunk || chunk.done) break
        text += new TextDecoder().decode(chunk.value)
      }
      expect(text).toContain('event: state')

      const ws = new WebSocket(`${handle.viewerUrl.replace(/^http/, 'ws')}/sessions/${session.id}/ws`)
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve())
          ws.once('error', reject)
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ws open timeout')), 10_000)),
      ])
      const ack = await new Promise<{ ok: boolean; count: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws ack timeout')), 5000)
        ws.once('message', raw => {
          clearTimeout(timer)
          resolve(JSON.parse(String(raw)) as { ok: boolean; count: number })
        })
        ws.send(JSON.stringify({ events: [{ type: 'key-down', key: 'a', code: 'KeyA' }] }))
      })
      expect(ack).toMatchObject({ ok: true, count: 1 })

      const bad = await new Promise<{ ok: boolean }>((resolve) => {
        ws.once('message', raw => resolve(JSON.parse(String(raw)) as { ok: boolean }))
        ws.send('not json')
      })
      expect(bad.ok).toBe(false)

      ws.close()
      controller.abort()
    } finally {
      await handle.close()
    }
  })
})
