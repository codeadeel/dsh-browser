import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserConfig } from '../config.js'
import type { SessionCreateOptions, SessionInfo } from '../protocol/types.js'
import { startStatelessMcpServer, type HttpHandle } from '../mcp/http.js'
import { BrowserSession } from './session.js'
import { createBrowserMcpServer } from './mcp.js'
import { handleBrowserTool, type ToolCallResult } from './tools.js'

interface ManagedSession {
  session: BrowserSession
  mcp: HttpHandle
  createdAt: string
  lastActivityAt: string | null
}

function safeSessionId(value: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
    throw new Error('session id must match [a-zA-Z0-9._-]{1,80}')
  }
  return value
}

export interface BrowserManagerOptions {
  /** Close sessions that saw no activity for this many milliseconds. 0 disables the sweep. */
  idleTimeoutMs: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

export class BrowserSessionManager {
  private readonly config: BrowserConfig
  private readonly idleTimeoutMs: number
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly sweepTimer: NodeJS.Timeout

  constructor(config: BrowserConfig, options: Partial<BrowserManagerOptions> = {}) {
    this.config = config
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch(() => undefined)
    }, 60_000)
    this.sweepTimer.unref?.()
  }

  /** Create a session, or return the existing one when `options.id` is already running. */
  async create(options: SessionCreateOptions = {}): Promise<{ info: SessionInfo; created: boolean }> {
    const id = safeSessionId(options.id?.trim() || `session-${randomUUID().slice(0, 8)}`)
    const existing = this.sessions.get(id)
    if (existing) {
      return { info: await this.info(id), created: false }
    }
    const profileDir = join(this.config.profileRoot, id)
    const session = new BrowserSession(this.config, {
      id,
      profileDir,
      headless: options.headless ?? this.config.headless,
      keepProfile: options.keepProfile ?? false,
    })

    await session.start()
    try {
      const mcp = await startStatelessMcpServer(() => createBrowserMcpServer(session), this.config.host, 0)
      const createdAt = new Date().toISOString()
      this.sessions.set(id, { session, mcp, createdAt, lastActivityAt: createdAt })
      return { info: await this.info(id), created: true }
    } catch (error) {
      await session.close().catch(() => undefined)
      throw error
    }
  }

  /** Create-or-get a session with an explicit id, used for DSH session binding. */
  async getOrCreate(id: string, options: Omit<SessionCreateOptions, 'id'> = {}): Promise<BrowserSession> {
    const existing = this.sessions.get(safeSessionId(id))
    if (existing) {
      this.touch(existing)
      return existing.session
    }
    const { info } = await this.create({ ...options, id: safeSessionId(id) })
    const created = this.sessions.get(info.id)
    if (!created) throw new Error(`failed to create session: ${info.id}`)
    return created.session
  }

  getSession(id: string): BrowserSession | undefined {
    return this.sessions.get(id)?.session
  }

  /** Run one model-facing browser tool against a session, creating it on demand. */
  async handleTool(id: string, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const managed = this.sessions.get(safeSessionId(id))
    if (managed) this.touch(managed)
    const session = await this.getOrCreate(id)
    return handleBrowserTool(session, name, args)
  }

  /** Record viewer activity so idle cleanup does not kill a watched session. */
  touchId(id: string): void {
    const managed = this.sessions.get(id)
    if (managed) this.touch(managed)
  }

  private touch(managed: ManagedSession): void {
    managed.lastActivityAt = new Date().toISOString()
  }

  async info(id: string): Promise<SessionInfo> {
    const managed = this.sessions.get(id)
    if (!managed) throw new Error(`unknown session: ${id}`)
    return {
      id,
      mcpUrl: managed.mcp.url,
      profileDir: managed.session.profileDir,
      createdAt: managed.createdAt,
      lastActivityAt: managed.lastActivityAt,
      headless: managed.session.headless,
      browserPid: managed.session.browserPid,
      tabs: await managed.session.tabs(),
    }
  }

  async list(): Promise<SessionInfo[]> {
    return Promise.all(Array.from(this.sessions.keys()).map(id => this.info(id)))
  }

  async close(id: string): Promise<boolean> {
    const managed = this.sessions.get(id)
    if (!managed) return false
    this.sessions.delete(id)
    await managed.mcp.close().catch(() => undefined)
    await managed.session.close().catch(() => undefined)
    return true
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    await Promise.all(ids.map(id => this.close(id)))
  }

  async sweepIdle(): Promise<string[]> {
    if (this.idleTimeoutMs <= 0) return []
    const now = Date.now()
    const closed: string[] = []
    for (const [id, managed] of this.sessions) {
      const last = managed.lastActivityAt ?? managed.createdAt
      if (now - Date.parse(last) > this.idleTimeoutMs) {
        await this.close(id)
        closed.push(id)
      }
    }
    return closed
  }

  stop(): void {
    clearInterval(this.sweepTimer)
  }
}
