import { createServer } from 'node:http'
import type { BrowserConfig } from './config.js'
import { browserConfigFromEnv, loadDotEnv } from './config.js'
import { BrowserSessionManager } from './browser/manager.js'
import { startViewerServer } from './browser/viewer-server.js'
import { listen, readJsonBody } from './mcp/http.js'
import type { SessionCreateOptions } from './protocol/types.js'

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function startBrowserServer(config: BrowserConfig): Promise<{
  manager: BrowserSessionManager
  url: string
  viewerUrl: string
  close: () => Promise<void>
}> {
  const manager = new BrowserSessionManager(config, { idleTimeoutMs: config.idleTimeoutMs })
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, sessions: (await manager.list()).length })
        return
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        sendJson(res, 200, { sessions: await manager.list() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readJsonBody(req)
        const options = (typeof body === 'object' && body !== null ? body : {}) as SessionCreateOptions
        const { info, created } = await manager.create(options)
        sendJson(res, created ? 201 : 200, info)
        return
      }

      const toolMatch = /^\/sessions\/([^/]+)\/tool$/.exec(url.pathname)
      if (req.method === 'POST' && toolMatch) {
        const id = decodeURIComponent(toolMatch[1] ?? '')
        const body = await readJsonBody(req)
        const name = typeof body === 'object' && body !== null && 'name' in body
          ? (body as { name?: unknown }).name
          : undefined
        const args = typeof body === 'object' && body !== null && 'args' in body && typeof (body as { args?: unknown }).args === 'object'
          ? ((body as { args: Record<string, unknown> }).args ?? {})
          : {}
        if (typeof name !== 'string' || name.trim() === '') {
          sendJson(res, 400, { error: 'name is required' })
          return
        }
        const result = await manager.handleTool(id, name, args)
        sendJson(res, 200, result)
        return
      }

      const match = /^\/sessions\/([^/]+)$/.exec(url.pathname)
      if (match) {
        const id = decodeURIComponent(match[1] ?? '')
        if (req.method === 'GET') {
          sendJson(res, 200, await manager.info(id))
          return
        }
        if (req.method === 'DELETE') {
          const removed = await manager.close(id)
          sendJson(res, removed ? 200 : 404, { removed })
          return
        }
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 400, { error: message })
      else res.destroy()
    }
  })

  const port = await listen(http, config.host, config.port)
  const base = `http://${config.host}:${port}`
  const viewer = await startViewerServer(
    manager,
    config.viewerHost ?? '127.0.0.1',
    config.viewerPort ?? 0,
  )
  return {
    manager,
    url: base,
    viewerUrl: viewer.url,
    close: async () => {
      await manager.closeAll()
      manager.stop()
      await viewer.close()
      await new Promise<void>(resolve => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv()
  const config = browserConfigFromEnv()
  const handle = await startBrowserServer(config)
  console.log(`[browser] session manager listening on ${handle.url}`)
  console.log(`[browser] viewer listening on ${handle.viewerUrl}`)
  console.log(`[browser] Chrome: ${config.chromePath}`)
  console.log(`[browser] headless: ${config.headless}`)

  const originalClose = handle.close
  const shutdown = async (): Promise<void> => {
    console.log('[browser] shutting down sessions')
    await originalClose()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
