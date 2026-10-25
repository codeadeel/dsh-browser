import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserConfig } from '../src/config.js'
import { BrowserSession } from '../src/browser/session.js'
import { startFixtureServer, type FixtureServer } from './fixture-server.js'

const chromePath =
  process.env.CHROME_PATH ?? '/opt/chrome-for-testing/chrome/linux-156.0.8078.47/chrome-linux64/chrome'
const hasChrome = existsSync(chromePath)

let tempRoot = ''
let fixture: FixtureServer
let config: BrowserConfig

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-browser-test-'))
  config = {
    host: '127.0.0.1',
    port: 0,
    chromePath,
    headless: true,
    profileRoot: join(tempRoot, 'profiles'),
    artifactRoot: join(tempRoot, 'artifacts'),
    defaultTimeoutMs: 15_000,
    navigationTimeoutMs: 30_000,
    idleTimeoutMs: 0,
  }
  fixture = await startFixtureServer()
})

afterAll(async () => {
  await fixture?.close()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

describe.skipIf(!hasChrome)('BrowserSession', () => {
  it('navigates, snapshots, clicks, types, screenshots, and manages tabs', async () => {
    const session = new BrowserSession(config, {
      id: 'session-main',
      profileDir: join(tempRoot, 'profiles', 'session-main'),
      headless: true,
    })
    await session.start()
    try {
      const page = await session.navigate(`${fixture.url}/page`)
      expect(page.url).toContain('/page')
      expect(page.title).toBe('Test Page')
      expect(page.text).toContain('fixture page')
      expect(page.elements.some(element => element.tag === 'input')).toBe(true)

      const click = await session.click('#go')
      expect(click.ok).toBe(true)
      const afterClick = await session.snapshot()
      expect(afterClick.text).toContain('clicked')

      const typed = await session.type('#name', 'Ada Lovelace')
      expect(typed.ok).toBe(true)
      expect(typed.value).toBe('Ada Lovelace')

      // Viewer keyboard path: type, Backspace, Ctrl+A, replace.
      await session.navigate(`${fixture.url}/page`)
      await session.click('#name')
      const unsubscribe = await session.subscribeScreencast(() => undefined)
      try {
        const key = async (type: 'key-down' | 'key-up', value: string, code: string, text?: string, modifiers = 0) => {
          await session.dispatchViewerInput({ type, key: value, code, ...(text ? { text } : {}), modifiers })
        }
        for (const [value, code] of [['a', 'KeyA'], ['b', 'KeyB'], ['c', 'KeyC']] as const) {
          await key('key-down', value, code, value)
          await key('key-up', value, code)
        }
        await key('key-down', 'Backspace', 'Backspace')
        await key('key-up', 'Backspace', 'Backspace')
        await key('key-down', 'a', 'KeyA', undefined, 2)
        await key('key-up', 'a', 'KeyA', undefined, 2)
        await key('key-down', 'Z', 'KeyZ', 'Z', 8)
        await key('key-up', 'Z', 'KeyZ', undefined, 8)
      } finally {
        await unsubscribe()
      }
      const keyboardSnapshot = await session.snapshot()
      expect(keyboardSnapshot.elements.find(element => element.tag === 'input')?.text).toBe('Z')

      const shot = await session.screenshot()
      expect(shot.bytes).toBeGreaterThan(1000)
      expect(existsSync(shot.path)).toBe(true)

      const opened = await session.newTab(`${fixture.url}/next`)
      expect(opened).toHaveLength(2)
      const active = opened.find(tab => tab.active)
      expect(active?.title).toBe('Next Page')

      const selected = await session.selectTab(0)
      expect(selected.find(tab => tab.active)?.index).toBe(0)
      const closed = await session.closeTab(1)
      expect(closed).toHaveLength(1)
    } finally {
      await session.close()
    }
  })

  it('scrolls the page via wheel input', async () => {
    const session = new BrowserSession(config, {
      id: 'session-wheel',
      profileDir: join(tempRoot, 'profiles', 'session-wheel'),
      headless: true,
    })
    await session.start()
    try {
      await session.navigate(`data:text/html,${encodeURIComponent('<div style="height:3000px"></div>')}`)
      const unsubscribe = await session.subscribeScreencast(() => undefined)
      try {
        for (let i = 0; i < 5; i++) {
          await session.dispatchViewerInput({ type: 'wheel', x: 800, y: 500, deltaX: 0, deltaY: 120 })
        }
        await new Promise(resolve => setTimeout(resolve, 300))
        const snapshot = await session.snapshot()
        expect(snapshot.scrollY).toBeGreaterThan(0)
      } finally {
        await unsubscribe()
      }
    } finally {
      await session.close()
    }
  })

  it('keeps cookies isolated between sessions', async () => {
    const a = new BrowserSession(config, {
      id: 'session-a',
      profileDir: join(tempRoot, 'profiles', 'session-a'),
      headless: true,
    })
    const b = new BrowserSession(config, {
      id: 'session-b',
      profileDir: join(tempRoot, 'profiles', 'session-b'),
      headless: true,
    })
    await a.start()
    await b.start()
    try {
      await a.navigate(`${fixture.url}/set-cookie?name=session&value=A`)
      const aRead = await a.navigate(`${fixture.url}/read-cookie`)
      expect(aRead.text).toContain('session=A')

      const bRead = await b.navigate(`${fixture.url}/read-cookie`)
      expect(bRead.text).not.toContain('session=A')
      expect(a.profileDir).not.toBe(b.profileDir)
      expect(a.browserPid).not.toBeNull()
      expect(b.browserPid).not.toBeNull()
      expect(a.browserPid).not.toBe(b.browserPid)
    } finally {
      await a.close()
      await b.close()
    }
  })
})
