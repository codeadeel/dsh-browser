import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { listen, readJsonBody } from '../mcp/http.js'
import { runSearch } from './providers.js'
import type { SearchConfigUpdate, SearchConfigStore } from './store.js'

function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('cache-control', 'no-store')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res)
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface SearchConfigServerHandle {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Serve the settings routes (`/config`, `/test`) for one request.
 * Returns true when the request was handled. Mountable next to the MCP
 * endpoint so the whole search gateway lives on one port.
 */
export async function handleSearchConfigRequest(
  store: SearchConfigStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/config') {
      json(res, 200, store.publicConfig())
      return true
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const body = await readJsonBody(req)
      if (typeof body !== 'object' || body === null) {
        json(res, 400, { error: 'config body must be an object' })
        return true
      }
      const updated = await store.update(body as SearchConfigUpdate)
      json(res, 200, updated)
      return true
    }
    if (req.method === 'POST' && (url.pathname === '/test' || url.pathname === '/search')) {
      const body = await readJsonBody(req)
      const query = typeof body === 'object' && body !== null && typeof (body as { query?: unknown }).query === 'string'
        ? (body as { query: string }).query
        : url.pathname === '/test' ? 'DeepSeek Harness' : ''
      try {
        const result = await runSearch(query, store.get())
        json(res, 200, {
          ok: true,
          query,
          provider: result.provider,
          results: result.results,
          attempts: result.attempts,
        })
      } catch (error) {
        json(res, 200, {
          ok: false,
          query,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return true
    }
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) json(res, 400, { error: message })
    else res.destroy()
    return true
  }
}

/** Legacy standalone settings server; the unified gateway mounts these routes itself. */
export async function startSearchConfigServer(
  store: SearchConfigStore,
  host: string,
  port: number,
): Promise<SearchConfigServerHandle> {
  const http = createServer(async (req, res) => {
    const handled = await handleSearchConfigRequest(store, req, res)
    if (!handled) {
      json(res, 404, { error: 'not found' })
    }
  })

  const actualPort = await listen(http, host, port)
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}
