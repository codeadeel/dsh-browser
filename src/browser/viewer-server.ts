import { createServer, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { BrowserSessionManager } from './manager.js'
import type { ViewerInputEvent } from './session.js'
import { listen, readJsonBody } from '../mcp/http.js'

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

export interface ViewerHandle {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

/** Validate one input batch; throws a message-safe Error on invalid payloads. */
function parseInputBatch(body: unknown): ViewerInputEvent[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('input body must be an object')
  }
  const events = Array.isArray((body as { events?: unknown }).events)
    ? (body as { events: ViewerInputEvent[] }).events
    : [body as ViewerInputEvent]
  if (events.length === 0 || events.length > 100) {
    throw new Error('input batch must contain 1-100 events')
  }
  return events
}

export async function startViewerServer(
  manager: BrowserSessionManager,
  host: string,
  port: number,
): Promise<ViewerHandle> {
  const wss = new WebSocketServer({ noServer: true })
  const http = createServer(async (req, res) => {
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        json(res, 200, { sessions: await manager.list() })
        return
      }

      const streamMatch = /^\/sessions\/([^/]+)\/stream$/.exec(url.pathname)
      if (req.method === 'GET' && streamMatch) {
        const id = decodeURIComponent(streamMatch[1] ?? '')
        const session = manager.getSession(id)
        if (!session) {
          json(res, 404, { error: `unknown session: ${id}` })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 1500\n\n')
        const send = (event: string, payload: unknown): void => {
          if (res.writableEnded) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        send('state', { ...(await manager.info(id)), connected: true })
        let lastTabs = JSON.stringify(await session.tabs())
        send('tabs', JSON.parse(lastTabs))
        const unsubscribe = await session.subscribeScreencast(frame => {
          send('frame', frame)
        })
        const keepalive = setInterval(() => {
          if (!res.writableEnded) res.write(': keepalive\n\n')
        }, 15_000)
        const tabPoll = setInterval(() => {
          void session.tabs().then(tabs => {
            const encoded = JSON.stringify(tabs)
            if (encoded !== lastTabs) {
              lastTabs = encoded
              send('tabs', tabs)
            }
          }).catch(() => undefined)
        }, 1_000)
        req.on('close', () => {
          clearInterval(keepalive)
          clearInterval(tabPoll)
          void unsubscribe().catch(() => undefined)
        })
        return
      }

      const inputMatch = /^\/sessions\/([^/]+)\/input$/.exec(url.pathname)
      if (req.method === 'POST' && inputMatch) {
        const id = decodeURIComponent(inputMatch[1] ?? '')
        const session = manager.getSession(id)
        if (!session) {
          json(res, 404, { error: `unknown session: ${id}` })
          return
        }
        const body = await readJsonBody(req)
        let events: ViewerInputEvent[]
        try {
          events = parseInputBatch(body)
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        await session.queueViewerInput(events)
        manager.touchId(id)
        json(res, 200, { ok: true, count: events.length })
        return
      }

      const gotoMatch = /^\/sessions\/([^/]+)\/goto$/.exec(url.pathname)
      if (req.method === 'POST' && gotoMatch) {
        const id = decodeURIComponent(gotoMatch[1] ?? '')
        const session = manager.getSession(id)
        if (!session) {
          json(res, 404, { error: `unknown session: ${id}` })
          return
        }
        const body = await readJsonBody(req)
        const rawUrl = typeof body === 'object' && body !== null && 'url' in body
          ? (body as { url?: unknown }).url
          : undefined
        if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
          json(res, 400, { error: 'url is required' })
          return
        }
        const snapshot = await session.navigate(rawUrl)
        json(res, 200, { ok: true, url: snapshot.url, title: snapshot.title })
        return
      }

      const tabsMatch = /^\/sessions\/([^/]+)\/tabs$/.exec(url.pathname)
      if (tabsMatch) {
        const id = decodeURIComponent(tabsMatch[1] ?? '')
        const session = manager.getSession(id)
        if (!session) {
          json(res, 404, { error: `unknown session: ${id}` })
          return
        }
        if (req.method === 'GET') {
          json(res, 200, { tabs: await session.tabs() })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (typeof body !== 'object' || body === null) {
            json(res, 400, { error: 'tabs body must be an object' })
            return
          }
          const action = (body as { action?: unknown }).action
          const index = (body as { index?: unknown }).index
          const tabUrl = (body as { url?: unknown }).url
          if (action === 'new') {
            const tabs = await session.newTab(typeof tabUrl === 'string' ? tabUrl : undefined)
            json(res, 200, { tabs })
            return
          }
          if (action === 'select' || action === 'close') {
            if (typeof index !== 'number' || !Number.isInteger(index)) {
              json(res, 400, { error: 'index is required' })
              return
            }
            const tabs = action === 'select'
              ? await session.selectTab(index)
              : await session.closeTab(index)
            json(res, 200, { tabs })
            return
          }
          json(res, 400, { error: 'action must be new, select, or close' })
          return
        }
      }

      const stateMatch = /^\/sessions\/([^/]+)\/state$/.exec(url.pathname)
      if (req.method === 'GET' && stateMatch) {
        const id = decodeURIComponent(stateMatch[1] ?? '')
        json(res, 200, await manager.info(id))
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) json(res, 500, { error: message })
      else res.destroy()
    }
  })

  const actualPort = await listen(http, host, port)

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = /^\/sessions\/([^/]+)\/ws$/.exec(url.pathname)
    if (!match) {
      socket.destroy()
      return
    }
    const id = decodeURIComponent(match[1] ?? '')
    const session = manager.getSession(id)
    if (!session) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, client => {
      client.on('message', raw => {
        let body: unknown
        try {
          body = JSON.parse(String(raw))
        } catch {
          client.send(JSON.stringify({ ok: false, error: 'input must be JSON' }))
          return
        }
        let events: ViewerInputEvent[]
        try {
          events = parseInputBatch(body)
        } catch (error) {
          client.send(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          return
        }
        void session.queueViewerInput(events).then(() => {
          manager.touchId(id)
          if (client.readyState === client.OPEN) client.send(JSON.stringify({ ok: true, count: events.length }))
        }).catch(error => {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })
      })
    })
  })

  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    },
  }
}
