/**
 * Host half of dsh-browser-panel.
 *
 * 1. Proxies the browser viewer, browser session manager, and search settings
 *    APIs through the DSH web server origin, so the browser client never talks
 *    to the services directly and the backing services stay loopback-only.
 * 2. Bridges a WebSocket input channel to the viewer through the DSH origin.
 * 3. Registers native `browser_*` tools that bind to the browser session
 *    whose id matches the calling agent's DSH session id (auto-created on
 *    first use). No per-session MCP patch is needed.
 */
import { WebSocketServer, WebSocket } from 'ws'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { forward, readBody } from './proxy.js'
import { BROWSER_SESSION_ID, registerBrowserTools } from './tools.js'

export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer) {
    const viewerBase = (process.env.DSH_BROWSER_VIEWER_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
    const browserBase = (process.env.DSH_BROWSER_API_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
    const viewerWsBase = viewerBase.replace(/^http/, 'ws')
    const connection = ctx.get('connection')
    const disposers = []

    // Runtime-configurable search stack address. Env sets the default; the
    // plugin settings page can change it at runtime and it persists across
    // DSH restarts in the harness home.
    const defaultSearchUrl = (process.env.DSH_SEARCH_URL || process.env.DSH_SEARCH_CONFIG_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
    const targetFile = join(
      process.env.DSH_BROWSER_DATA_DIR
        || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'dsh-browser-runtime.json') : join(homedir(), '.dsh', 'dsh-browser-runtime.json')),
    )
    let searchTarget = defaultSearchUrl
    try {
      const persisted = JSON.parse(readFileSync(targetFile, 'utf8'))
      if (typeof persisted?.searchUrl === 'string' && /^https?:\/\//i.test(persisted.searchUrl)) {
        searchTarget = persisted.searchUrl.replace(/\/$/, '')
      }
    } catch {
      // No persisted target yet; the env default applies.
    }
    const persistTarget = (url) => {
      try {
        mkdirSync(dirname(targetFile), { recursive: true })
        writeFileSync(targetFile, `${JSON.stringify({ searchUrl: url }, null, 2)}\n`, { mode: 0o600 })
      } catch {
        // Persistence is best-effort; the in-memory value still applies.
      }
    }

    const isLoopback = (req) => {
      const address = req.socket?.remoteAddress
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    }
    // Shared secret for the in-process DSH MCP client when the webserver binds
    // a non-loopback address. The DSH patch embeds the same value in the URL.
    const mcpKey = (process.env.DSH_SEARCH_MCP_KEY || '').trim()

    const health = webServer.register({
      kind: 'exact',
      path: '/dsh-browser/health',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      },
    })
    disposers.push(health)

    const mount = (prefix, base) => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: (req, res) => {
          if (connection) {
            const admission = connection.admit(req)
            if ('rejection' in admission) {
              res.writeHead(admission.rejection)
              res.end(admission.rejection === 401 ? 'dsh web authentication required' : 'forbidden')
              return
            }
          }
          const suffix = (req.url ?? '').slice(prefix.length) || '/'
          forward(req, res, `${base}${suffix}`)
        },
      })
      disposers.push(dispose)
    }

    mount('/dsh-browser/viewer', viewerBase)
    mount('/dsh-browser/browser', browserBase)

    // Search: dynamic target, plus the DSH MCP client connects through this
    // origin on the loopback path so it follows runtime target changes.
    const searchTargetRoute = webServer.register({
      kind: 'exact',
      path: '/dsh-browser/search-target',
      handler: (req, res) => {
        if (connection) {
          const admission = connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'dsh web authentication required' : 'forbidden')
            return
          }
        }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (req.method === 'GET') {
          res.end(JSON.stringify({ searchUrl: searchTarget }))
          return
        }
        if (req.method === 'POST') {
          void readBody(req).then(async raw => {
            try {
              const body = JSON.parse(raw || '{}')
              const url = typeof body?.searchUrl === 'string' ? body.searchUrl.trim() : ''
              if (!/^https?:\/\//i.test(url)) {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'searchUrl must be an http(s) URL' }))
                return
              }
              searchTarget = url.replace(/\/$/, '')
              persistTarget(searchTarget)
              res.writeHead(200)
              res.end(JSON.stringify({ searchUrl: searchTarget }))
            } catch {
              if (!res.headersSent) {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'invalid request body' }))
              }
            }
          }).catch(() => {
            if (!res.headersSent) res.destroy()
          })
          return
        }
        res.writeHead(405)
        res.end(JSON.stringify({ error: 'method not allowed' }))
      },
    })
    disposers.push(searchTargetRoute)

    const searchMount = webServer.register({
      kind: 'prefix',
      path: '/dsh-browser/search',
      handler: (req, res) => {
        const suffix = (req.url ?? '').slice('/dsh-browser/search'.length) || '/'
        // The in-process DSH MCP client has no browser cookie. Admit the /mcp
        // path when it presents the shared MCP key, or when the key is unset
        // and the request arrives over loopback (e.g. DSH bound to 0.0.0.0).
        let admitted = false
        if (suffix.startsWith('/mcp')) {
          if (mcpKey !== '') {
            try {
              const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key')
              admitted = key === mcpKey
            } catch {
              admitted = false
            }
          } else {
            admitted = isLoopback(req)
          }
        }
        if (connection && !admitted) {
          const admission = connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'dsh web authentication required' : 'forbidden')
            return
          }
        }
        forward(req, res, `${searchTarget}${suffix}`)
      },
    })
    disposers.push(searchMount)

    if (connection) {
      const wss = new WebSocketServer({ noServer: true })
      const upgrade = webServer.registerUpgrade({
        path: '/dsh-browser/ws',
        handler: (req, socket, head) => {
          const admission = connection.admitConnection(req)
          if ('rejection' in admission) {
            socket.write(`HTTP/1.1 ${admission.rejection} Unauthorized\r\nConnection: close\r\n\r\n`)
            socket.destroy()
            return
          }
          let sessionId = ''
          try {
            sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session') ?? ''
          } catch {
            sessionId = ''
          }
          if (!BROWSER_SESSION_ID.test(sessionId)) {
            admission.release()
            socket.destroy()
            return
          }
          wss.handleUpgrade(req, socket, head, client => {
            client.once('close', () => admission.release())
            const upstream = new WebSocket(`${viewerWsBase}/sessions/${encodeURIComponent(sessionId)}/ws`)
            const pending = []
            let upstreamOpen = false
            upstream.on('open', () => {
              upstreamOpen = true
              for (const data of pending.splice(0)) {
                if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
              }
            })
            upstream.on('message', data => {
              if (client.readyState === WebSocket.OPEN) client.send(data)
            })
            upstream.on('error', () => {
              if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream error')
            })
            upstream.on('close', () => {
              if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream closed')
            })
            client.on('message', data => {
              if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(data)
              else if (!upstreamOpen) pending.push(data)
            })
            client.on('error', () => upstream.close())
            client.on('close', () => {
              if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close()
            })
          })
        },
      })
      disposers.push(upgrade)
      disposers.push(() => {
        for (const client of wss.clients) client.terminate()
        wss.close()
      })
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A route that was never registered must not break disposal.
        }
      }
    })
  }

  const browserApiUrl = (process.env.DSH_BROWSER_API_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
  const toolDisposers = registerBrowserTools(ctx, browserApiUrl)
  if (toolDisposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of toolDisposers) dispose()
    })
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    systemPrompt.section({
      name: 'dsh-browser',
      order: systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: () =>
        'browser_* tools drive the dedicated Chromium for this DSH session, which a human can watch and take over in the live browser panel. Prefer browser_snapshot to read a page and browser_click/browser_type with snapshot ids (like e3, from browser_snapshot or browser_find) to interact. Use browser_wait_for after interactions that load content instead of fixed sleeps. If a page shows a CAPTCHA, consent wall, or another anti-bot check (blocked=true), ask the human to complete it in the live browser panel, then retry. Never attempt to bypass CAPTCHA or other anti-bot checks. For web search, always call mcp__search__web_search — the plain web_search tool is the provider\'s built-in search, which is unavailable and returns errors.',
    })
  }
}

export const name = 'dsh-browser-panel-host'
