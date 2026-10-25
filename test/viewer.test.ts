import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserConfig } from '../src/config.js'
import { startBrowserServer } from '../src/browser-server.js'
import { startFixtureServer, type FixtureServer } from './fixture-server.js'

const chromePath =
  process.env.CHROME_PATH ?? '/opt/chrome-for-testing/chrome/linux-156.0.8078.47/chrome-linux64/chrome'
const hasChrome = existsSync(chromePath)

let tempRoot = ''
let fixture: FixtureServer

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-viewer-test-'))
  fixture = await startFixtureServer()
})

afterAll(async () => {
  await fixture?.close()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

describe.skipIf(!hasChrome)('CDP viewer server', () => {
  it('lists the session, streams a frame/state event, and navigates', async () => {
    const config: BrowserConfig = {
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
    const handle = await startBrowserServer(config)
    let sessionId = ''
    try {
      const { info: session } = await handle.manager.create({ id: 'viewer-session' })
      sessionId = session.id

      const sessionsResponse = await fetch(`${handle.viewerUrl}/sessions`)
      expect(sessionsResponse.status).toBe(200)
      expect(sessionsResponse.headers.get('access-control-allow-origin')).toBe('*')
      const sessions = await sessionsResponse.json() as { sessions: Array<{ id: string }> }
      expect(sessions.sessions.map(row => row.id)).toContain('viewer-session')

      const controller = new AbortController()
      const stream = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/stream`, {
        signal: controller.signal,
      })
      expect(stream.status).toBe(200)
      const reader = stream.body?.getReader()
      expect(reader).toBeDefined()
      const deadline = Date.now() + 10_000
      let streamText = ''
      while (!streamText.includes('event: state') && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader!.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 10_000)),
        ])
        if (chunk.done) break
        streamText += new TextDecoder().decode(chunk.value)
      }
      expect(streamText).toContain('event: state')
      controller.abort()

      const gotoResponse = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/goto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `${fixture.url}/page` }),
      })
      expect(gotoResponse.status).toBe(200)
      const goto = await gotoResponse.json() as { ok: boolean; title: string }
      expect(goto).toMatchObject({ ok: true, title: 'Test Page' })

      const stateResponse = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/state`)
      const state = await stateResponse.json() as { tabs: Array<{ url: string }> }
      expect(state.tabs[0]?.url).toContain('/page')

      const newTabResponse = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'new' }),
      })
      const newTabs = await newTabResponse.json() as { tabs: Array<{ active: boolean }> }
      expect(newTabs.tabs).toHaveLength(2)
      expect(newTabs.tabs.filter(tab => tab.active)).toHaveLength(1)

      const selectResponse = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'select', index: 0 }),
      })
      const selected = await selectResponse.json() as { tabs: Array<{ index: number; active: boolean }> }
      expect(selected.tabs.find(tab => tab.active)?.index).toBe(0)

      const closeResponse = await fetch(`${handle.viewerUrl}/sessions/${sessionId}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'close', index: 1 }),
      })
      const closed = await closeResponse.json() as { tabs: Array<unknown> }
      expect(closed.tabs).toHaveLength(1)
    } finally {
      if (sessionId) await handle.manager.close(sessionId)
      await handle.close()
    }
  })
})
