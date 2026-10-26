import {
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

/**
 * The stack ingress: one HTTP/WS port in front of the browser API, the
 * viewer, and the search routes. The backing services stay on the compose
 * network and publish no host ports.
 */
export interface GatewayProxyOptions {
  /** Internal browser API base, e.g. http://browser:8790. */
  browserApiUrl: string
  /** Internal viewer base, e.g. http://browser:8791. */
  viewerUrl: string
}

export interface GatewayProxy {
  /** Handle /browser/* or /viewer/*; false leaves the request to the search routes. */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** Attach the viewer WebSocket upgrade handler to the gateway HTTP server. */
  attach(server: Server): void
  close(): Promise<void>
}

interface Match {
  target: URL
  prefix: '/browser' | '/viewer'
}

/**
 * Build the path-prefixed ingress proxy. `/browser/*` maps to the browser
 * service root and `/viewer/*` maps to the viewer root, including its
 * `/sessions/:id/stream` SSE and `/sessions/:id/ws` WebSocket routes.
 */
export function createGatewayProxy(options: GatewayProxyOptions): GatewayProxy {
  const browser = parseBase(options.browserApiUrl, 'browser')
  const viewer = parseBase(options.viewerUrl, 'viewer')
  const wss = new WebSocketServer({ noServer: true })
  const upstreams = new Set<WebSocket>()

  const match = (rawUrl: string | undefined): Match | null => {
    const url = new URL(rawUrl ?? '/', 'http://gateway.local')
    const routes: ReadonlyArray<['/browser' | '/viewer', URL]> = [
      ['/browser', browser],
      ['/viewer', viewer],
    ]
    for (const [prefix, base] of routes) {
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue
      const target = new URL(base.href)
      target.pathname = `${base.pathname.replace(/\/$/, '')}${url.pathname.slice(prefix.length) || '/'}`
      target.search = url.search
      return { target, prefix }
    }
    return null
  }

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const matched = match(req.url)
    if (!matched) return false

    const headers: OutgoingHttpHeaders = { ...req.headers, host: matched.target.host }
    const onResponse = (upstreamRes: IncomingMessage): void => {
      if (res.writableEnded) {
        upstreamRes.destroy()
        return
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    }
    const upstream = matched.target.protocol === 'https:'
      ? httpsRequest(matched.target, { method: req.method, headers }, onResponse)
      : httpRequest(matched.target, { method: req.method, headers }, onResponse)

    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `gateway upstream failed: ${error.message}` }))
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
    return true
  }

  const attach = (server: Server): void => {
    server.on('upgrade', (req, socket, head) => {
      const matched = match(req.url)
      if (!matched || matched.prefix !== '/viewer') {
        socket.destroy()
        return
      }

      const target = new URL(matched.target.href)
      target.protocol = matched.target.protocol === 'https:' ? 'wss:' : 'ws:'
      wss.handleUpgrade(req, socket, head, (client) => {
        const upstream = new WebSocket(target)
        upstreams.add(upstream)
        const pending: Array<{ data: RawData; binary: boolean }> = []
        let open = false

        upstream.on('open', () => {
          open = true
          for (const { data, binary } of pending.splice(0)) {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
          }
        })
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
        })
        upstream.on('error', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream error')
        })
        upstream.on('close', () => {
          upstreams.delete(upstream)
          if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream closed')
        })
        client.on('message', (data, binary) => {
          if (open && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
          else if (!open) pending.push({ data, binary })
        })
        client.on('error', () => upstream.close())
        client.on('close', () => {
          upstreams.delete(upstream)
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.close()
          }
        })
      })
    })
  }

  const close = async (): Promise<void> => {
    for (const client of wss.clients) client.terminate()
    for (const upstream of upstreams) upstream.terminate()
    upstreams.clear()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return { handle, attach, close }
}

function parseBase(raw: string, name: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} upstream URL is invalid: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} upstream URL must be http(s): ${raw}`)
  }
  return url
}
