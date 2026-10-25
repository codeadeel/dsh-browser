import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer, { type Browser, type CDPSession, type KeyInput, type Page } from 'puppeteer-core'
import type {
  BrowserSearchResponse,
  BrowserSnapshot,
  BrowserTab,
} from '../protocol/types.js'
import { collectMatches, collectSearchResults, collectSnapshot } from './inspect.js'
import { editingCommands, virtualKey } from './input-codes.js'
import type { BrowserConfig } from '../config.js'

export interface BrowserSessionOptions {
  id: string
  profileDir: string
  headless: boolean
  keepProfile?: boolean
}

export interface BrowserSessionSearchOptions {
  engine?: 'google' | 'duckduckgo' | 'auto'
  maxResults?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeUrl(input: string): string {
  const value = input.trim()
  if (value === '') throw new Error('url is required')
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) return `http://${value}`
  if (/^[\w.-]+(?::\d+)?(?:\/|$)/.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

function normalizeSelector(selector: string): string {
  return /^e\d+$/.test(selector) ? `[data-dsh-id="${selector}"]` : selector
}

function isBlockedText(text: string): boolean {
  const value = text.toLowerCase()
  return [
    'unusual traffic',
    'our systems have detected',
    'captcha',
    'before you continue to google',
    'enablejs',
    'verify you are human',
    'bots use duckduckgo too',
    'select all squares containing a duck',
    'access denied',
  ].some(marker => value.includes(marker))
}


export interface ScreencastFrame {
  data: string
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  url: string
}

export interface ConsoleEntry {
  level: string
  text: string
  capturedAt: string
}

export interface NetworkEntry {
  method: string
  url: string
  status: number
  type: string
  durationMs: number | null
  capturedAt: string
}

export type ViewerInputEvent =
  | { type: 'mouse-move'; x: number; y: number; modifiers?: number }
  | { type: 'mouse-down'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number }
  | { type: 'mouse-up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key-down'; key: string; code: string; text?: string; modifiers?: number }
  | { type: 'key-up'; key: string; code: string; modifiers?: number }

export class BrowserSession {
  readonly id: string
  readonly profileDir: string
  readonly headless: boolean
  readonly keepProfile: boolean
  private readonly config: BrowserConfig
  private browser: Browser | null = null
  private pages: Page[] = []
  private active = 0
  private screencastSession: CDPSession | null = null
  private screencastStarting: Promise<void> | null = null
  private readonly frameSubscribers = new Set<(frame: ScreencastFrame) => void>()
  private inputChain: Promise<void> = Promise.resolve()
  private consoleBuffer: ConsoleEntry[] = []
  private networkBuffer: NetworkEntry[] = []

  constructor(config: BrowserConfig, options: BrowserSessionOptions) {
    this.config = config
    this.id = options.id
    this.profileDir = options.profileDir
    this.headless = options.headless
    this.keepProfile = options.keepProfile ?? false
  }

  async start(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true })
    await mkdir(this.config.artifactRoot, { recursive: true })
    this.browser = await puppeteer.launch({
      executablePath: this.config.chromePath,
      headless: this.headless,
      userDataDir: this.profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1600,1000',
      ],
      defaultViewport: { width: 1600, height: 1000 },
    })
    const page = await this.browser.newPage()
    await this.setupPage(page)
    this.pages = [page]
    this.active = 0
  }

  get browserPid(): number | null {
    return this.browser?.process()?.pid ?? null
  }

  private async setupPage(page: Page): Promise<void> {
    page.setDefaultTimeout(this.config.defaultTimeoutMs)
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    // tsx/esbuild injects a __name helper into serialized evaluate callbacks.
    // Define a harmless browser-side shim before those callbacks run.
    await page.evaluateOnNewDocument('globalThis.__name = (fn) => fn;')
    page.on('console', message => {
      this.consoleBuffer.push({ level: message.type(), text: message.text().slice(0, 1000), capturedAt: nowIso() })
      if (this.consoleBuffer.length > 200) this.consoleBuffer.shift()
    })
    page.on('response', response => {
      const url = response.url()
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      const request = response.request()
      const timing = response.timing()
      this.networkBuffer.push({
        method: request.method(),
        url: url.slice(0, 500),
        status: response.status(),
        type: request.resourceType(),
        durationMs: timing ? Math.round((timing.receiveHeadersEnd - timing.requestTime) * 1000) : null,
        capturedAt: nowIso(),
      })
      if (this.networkBuffer.length > 200) this.networkBuffer.shift()
    })
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
    await page.evaluate('globalThis.__name = (fn) => fn;')
  }

  private async currentPage(): Promise<Page> {
    if (!this.browser) throw new Error('browser session is not started')
    const page = this.pages[this.active]
    if (page && !page.isClosed()) return page
    const next = await this.browser.newPage()
    await this.setupPage(next)
    this.pages = [next]
    this.active = 0
    return next
  }

  async tabs(): Promise<BrowserTab[]> {
    if (this.pages.length === 0) await this.currentPage()
    const rows: BrowserTab[] = []
    for (let index = 0; index < this.pages.length; index++) {
      const page = this.pages[index]
      if (!page || page.isClosed()) continue
      rows.push({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: index === this.active,
      })
    }
    return rows
  }

  async newTab(url?: string): Promise<BrowserTab[]> {
    if (!this.browser) throw new Error('browser session is not started')
    const page = await this.browser.newPage()
    await this.setupPage(page)
    this.pages.push(page)
    this.active = this.pages.length - 1
    if (url && url.trim() !== '') await this.navigate(url)
    await this.restartScreencast()
    return this.tabs()
  }

  async selectTab(index: number): Promise<BrowserTab[]> {
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) throw new Error(`no tab at index ${index}`)
    this.active = index
    await this.restartScreencast()
    return this.tabs()
  }

  async closeTab(index: number): Promise<BrowserTab[]> {
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) throw new Error(`no tab at index ${index}`)
    const page = this.pages[index]
    this.pages.splice(index, 1)
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
    if (this.pages.length === 0) {
      await this.currentPage()
    } else if (index === this.active) {
      this.active = Math.min(index, this.pages.length - 1)
    } else if (index < this.active) {
      this.active -= 1
    }
    await this.restartScreencast()
    return this.tabs()
  }

  async navigate(rawUrl: string): Promise<BrowserSnapshot> {
    const url = normalizeUrl(rawUrl)
    const page = await this.currentPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
    await new Promise(resolve => setTimeout(resolve, 500))
    return this.snapshot()
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = await this.currentPage()
    const result = await collectSnapshot(page)
    return { ...result, capturedAt: nowIso() }
  }

  async click(rawSelector: string): Promise<{ ok: boolean; selector: string; url: string; title: string; message?: string }> {
    const selector = normalizeSelector(rawSelector)
    const page = await this.currentPage()
    try {
      await page.waitForSelector(selector, { timeout: this.config.defaultTimeoutMs })
      await page.click(selector)
      await new Promise(resolve => setTimeout(resolve, 400))
      return { ok: true, selector, url: page.url(), title: await page.title().catch(() => '') }
    } catch (error) {
      return {
        ok: false,
        selector,
        url: page.url(),
        title: await page.title().catch(() => ''),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async type(rawSelector: string, text: string): Promise<{ ok: boolean; selector: string; value: string; message?: string }> {
    const selector = normalizeSelector(rawSelector)
    const page = await this.currentPage()
    try {
      await page.waitForSelector(selector, { timeout: this.config.defaultTimeoutMs })
      await page.click(selector, { count: 3 })
      await page.type(selector, text, { delay: 0 })
      const value = await page.$eval(selector, element => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          return element.value
        }
        return element.textContent ?? ''
      })
      return { ok: true, selector, value: value.slice(0, 500) }
    } catch (error) {
      return {
        ok: false,
        selector,
        value: '',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async press(key: string): Promise<{ ok: boolean; key: string; message?: string }> {
    const page = await this.currentPage()
    try {
      await page.keyboard.press(key as KeyInput)
      return { ok: true, key }
    } catch (error) {
      return { ok: false, key, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async scroll(direction: 'up' | 'down' | 'top' | 'bottom'): Promise<{ ok: boolean; url: string; title: string }> {
    const page = await this.currentPage()
    await page.evaluate(dir => {
      if (dir === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
      else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
      else window.scrollBy({ top: dir === 'down' ? window.innerHeight * 0.8 : -window.innerHeight * 0.8, behavior: 'instant' })
    }, direction)
    return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
  }

  async back(): Promise<{ ok: boolean; url: string; title: string; message?: string }> {
    const page = await this.currentPage()
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
    } catch (error) {
      return { ok: false, url: page.url(), title: await page.title().catch(() => ''), message: error instanceof Error ? error.message : String(error) }
    }
  }

  async forward(): Promise<{ ok: boolean; url: string; title: string; message?: string }> {
    const page = await this.currentPage()
    try {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
    } catch (error) {
      return { ok: false, url: page.url(), title: await page.title().catch(() => ''), message: error instanceof Error ? error.message : String(error) }
    }
  }

  async reload(): Promise<{ ok: boolean; url: string; title: string; message?: string }> {
    const page = await this.currentPage()
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
    } catch (error) {
      return { ok: false, url: page.url(), title: await page.title().catch(() => ''), message: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(query: string, options: BrowserSessionSearchOptions = {}): Promise<BrowserSearchResponse> {
    const trimmed = query.trim()
    if (trimmed === '') throw new Error('query is required')
    const limit = Math.max(1, Math.min(options.maxResults ?? 8, 20))
    const requested = options.engine ?? 'auto'
    const engines: Array<'google' | 'duckduckgo'> = requested === 'auto' ? ['google', 'duckduckgo'] : [requested]
    let last: BrowserSearchResponse | null = null

    for (const engine of engines) {
      const url =
        engine === 'google'
          ? `https://www.google.com/search?q=${encodeURIComponent(trimmed)}&num=${Math.max(limit, 10)}&hl=en&pws=0`
          : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`
      await this.navigate(url)
      const page = await this.currentPage()
      await new Promise(resolve => setTimeout(resolve, engine === 'google' ? 1200 : 500))
      const bodyText = await page.evaluate(() => document.body?.innerText ?? '')
      const blocked = isBlockedText(bodyText)
      const results = await collectSearchResults(page, engine, limit)
      last = {
        query: trimmed,
        engine,
        results,
        blocked,
        pageUrl: page.url(),
        ...(blocked
          ? { message: `${engine} returned a human-verification page. Complete it in the dedicated browser, then retry.` }
          : results.length === 0
            ? { message: `${engine} returned no parsable result links.` }
            : {}),
      }
      if (blocked || results.length > 0) return last
    }

    if (!last) throw new Error('search did not run')
    return last
  }

  async screenshot(fullPage = false): Promise<{ path: string; mime: string; base64: string; bytes: number }> {
    const page = await this.currentPage()
    await mkdir(this.config.artifactRoot, { recursive: true })
    const path = join(this.config.artifactRoot, `${this.id}-${Date.now()}.png`)
    const buffer = await page.screenshot({ path, fullPage, type: 'png' })
    const data = Buffer.isBuffer(buffer) ? buffer : await readFile(path)
    return {
      path,
      mime: 'image/png',
      base64: data.toString('base64'),
      bytes: data.length,
    }
  }


  /** Subscribe to a JPEG screencast of the active page. */
  async subscribeScreencast(subscriber: (frame: ScreencastFrame) => void): Promise<() => Promise<void>> {
    await this.ensureScreencast()
    this.frameSubscribers.add(subscriber)
    return async () => {
      this.frameSubscribers.delete(subscriber)
      if (this.frameSubscribers.size === 0) await this.stopScreencast()
    }
  }

  private async restartScreencast(): Promise<void> {
    if (this.frameSubscribers.size === 0) return
    await this.stopScreencast()
    await this.ensureScreencast()
  }

  /** Serialize screencast start/stop so concurrent subscribers and input cannot leave a stale session reference. */
  private async ensureScreencast(): Promise<void> {
    if (this.screencastSession) return
    if (!this.screencastStarting) {
      this.screencastStarting = this.createScreencast().finally(() => {
        this.screencastStarting = null
      })
    }
    await this.screencastStarting
  }

  private async createScreencast(): Promise<void> {
    const page = await this.currentPage()
    const session = await page.createCDPSession()
    this.screencastSession = session
    session.on('Page.screencastFrame', frame => {
      const viewport = page.viewport()
      const payload: ScreencastFrame = {
        data: frame.data,
        width: frame.metadata.deviceWidth,
        height: frame.metadata.deviceHeight,
        viewportWidth: viewport?.width ?? frame.metadata.deviceWidth,
        viewportHeight: viewport?.height ?? frame.metadata.deviceHeight,
        url: page.url(),
      }
      for (const subscriber of this.frameSubscribers) {
        try {
          subscriber(payload)
        } catch {
          // A disconnected viewer must not stop the other subscribers.
        }
      }
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    })
    session.on('disconnected', () => {
      if (this.screencastSession === session) this.screencastSession = null
    })
    await session.send('Page.enable')
    const width = 1280
    const height = 800
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 82,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    })
    // Chrome emits screencast frames only on damage; a re-subscription on a
    // static page can otherwise see none. Nudge a repaint for one frame.
    await page.evaluate(() => {
      const root = document.documentElement
      const previous = root.style.opacity
      root.style.opacity = '0.9999'
      requestAnimationFrame(() => {
        root.style.opacity = previous
      })
    }).catch(() => undefined)
  }

  private async stopScreencast(): Promise<void> {
    if (this.screencastStarting) await this.screencastStarting.catch(() => undefined)
    const session = this.screencastSession
    this.screencastSession = null
    if (!session) return
    await session.send('Page.stopScreencast').catch(() => undefined)
    await session.detach().catch(() => undefined)
  }

  /** Forward one viewer input event into the page via CDP. */
  async dispatchViewerInput(event: ViewerInputEvent): Promise<void> {
    if (!this.screencastSession) await this.ensureScreencast()
    const session = this.screencastSession
    if (!session) throw new Error('browser viewer is not streaming')
    const modifiers = event.modifiers ?? 0
    if (event.type === 'mouse-move') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: event.x, y: event.y, modifiers,
      })
      return
    }
    if (event.type === 'mouse-down') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: event.x, y: event.y, button: event.button ?? 'left',
        clickCount: event.clickCount ?? 1, modifiers,
      })
      return
    }
    if (event.type === 'mouse-up') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: event.x, y: event.y, button: event.button ?? 'left',
        clickCount: event.clickCount ?? 1, modifiers,
      })
      return
    }
    if (event.type === 'wheel') {
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: event.x, y: event.y,
        deltaX: event.deltaX, deltaY: event.deltaY, modifiers,
      })
      return
    }
    if (event.type === 'key-down') {
      const vk = virtualKey(event.key, event.code)
      const commands = editingCommands(event.key, modifiers)
      const text = commands === undefined ? event.text : undefined
      const params: Record<string, unknown> = {
        type: text ? 'keyDown' : 'rawKeyDown',
        key: event.key,
        code: event.code,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
        ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
        ...(commands ? { commands } : {}),
      }
      await session.send('Input.dispatchKeyEvent', params as never)
      return
    }
    const vk = virtualKey(event.key, event.code)
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: event.key, code: event.code, modifiers,
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
    })
  }

  /** Serialize viewer input so rapid clicks cannot interleave or reorder. */
  async queueViewerInput(events: ViewerInputEvent[]): Promise<void> {
    if (events.length === 0) return
    const run = this.inputChain.then(async () => {
      for (const event of events) await this.dispatchViewerInput(event)
    })
    this.inputChain = run.catch(() => undefined)
    await run
  }

  /** Poll until a selector becomes visible or page text contains the needle. */
  async waitFor(options: {
    selector?: string
    text?: string
    timeoutMs?: number
  }): Promise<{ ok: boolean; found: boolean; waitedMs: number; url: string; title: string; message?: string }> {
    const started = Date.now()
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 500), 60_000)
    const page = await this.currentPage()
    const describe = async () => ({ url: page.url(), title: await page.title().catch(() => '') })
    if (!options.selector && !options.text) {
      await new Promise(resolve => setTimeout(resolve, timeoutMs))
      return { ok: true, found: true, waitedMs: timeoutMs, ...(await describe()) }
    }
    for (;;) {
      let found = false
      if (options.selector) {
        const selector = normalizeSelector(options.selector)
        found = await page.evaluate((sel) => {
          const element = document.querySelector(sel)
          if (!element) return false
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }, selector)
      } else if (options.text) {
        const needle = options.text.toLowerCase()
        found = await page.evaluate(text => (document.body?.innerText ?? '').toLowerCase().includes(text), needle)
      }
      if (found) return { ok: true, found: true, waitedMs: Date.now() - started, ...(await describe()) }
      if (Date.now() - started >= timeoutMs) {
        return {
          ok: false,
          found: false,
          waitedMs: Date.now() - started,
          ...(await describe()),
          message: `condition not met within ${timeoutMs} ms`,
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  /** Enumerate visible matches for a CSS selector with snapshot-style ids. */
  async find(selector: string, maxResults?: number): Promise<{
    selector: string
    matches: Array<{ id: string; tag: string; text: string; href?: string; x: number; y: number; width: number; height: number }>
  }> {
    const limit = Math.max(1, Math.min(maxResults ?? 20, 50))
    const page = await this.currentPage()
    const matches = await collectMatches(page, selector, limit)
    return { selector, matches }
  }

  /** Read buffered console messages since the previous clear. */
  async readConsole(options: { level?: string; clear?: boolean; limit?: number }): Promise<{
    level: string
    cleared: boolean
    messages: ConsoleEntry[]
  }> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    const level = options.level ?? 'all'
    const filtered = level === 'all'
      ? this.consoleBuffer
      : this.consoleBuffer.filter(entry => entry.level === level || (level === 'warn' && entry.level === 'warning'))
    const messages = filtered.slice(-limit)
    if (options.clear) this.consoleBuffer = []
    return { level, cleared: options.clear === true, messages }
  }

  /** Read buffered network activity since the previous clear. */
  async readNetwork(options: { clear?: boolean; limit?: number }): Promise<{
    cleared: boolean
    requests: NetworkEntry[]
  }> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    const requests = this.networkBuffer.slice(-limit)
    if (options.clear) this.networkBuffer = []
    return { cleared: options.clear === true, requests }
  }

  async close(): Promise<void> {
    await this.stopScreencast()
    for (const page of this.pages) {
      if (!page.isClosed()) await page.close().catch(() => undefined)
    }
    this.pages = []
    const browser = this.browser
    this.browser = null
    if (browser) await browser.close().catch(() => undefined)
    if (!this.keepProfile) await rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
