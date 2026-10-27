import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_PROVIDER_ORDER, type SearchConfig } from '../src/config.js'
import { startSearchGateway } from '../src/search-server.js'
import { SearchConfigStore } from '../src/search/store.js'

let tempRoot = ''

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-gateway-test-'))
})

afterAll(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

function config(path: string): SearchConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    providerOrder: ['searxng', ...DEFAULT_PROVIDER_ORDER.filter(name => name !== 'searxng')],
    maxResults: 8,
    timeoutMs: 5_000,
    searxngUrl: 'http://searxng.test',
    googleCseApiKey: '',
    googleCseCx: '',
    googleGeminiApiKey: '',
    googleGeminiModel: 'gemini-3.8-flash',
    braveApiKey: '',
    braveMcpUrl: '',
    googleVertexApiKey: '',
    googleVertexProjectId: '',
    googleVertexEngineId: '',
    googleVertexEndpoint: 'https://discoveryengine.googleapis.com/v1',
    configPath: path,
    userAgent: 'test-agent',
  }
}

async function listenOn(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind')
  return address.port
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('unified search gateway', () => {
  it('serves MCP, settings, and health on a single port', async () => {
    const store = new SearchConfigStore(config(join(tempRoot, 'gateway.json')))
    await store.load()
    const handle = await startSearchGateway(store, '127.0.0.1', 0)

    try {
      const health = await fetch(`${handle.url}/health`).then(response => response.json())
      expect(health).toMatchObject({ ok: true })

      const initial = await fetch(`${handle.url}/config`).then(response => response.json())
      expect(initial.providerOrder).toContain('searxng')

      const saved = await fetch(`${handle.url}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerOrder: ['duckduckgo', 'searxng'] }),
      }).then(response => response.json())
      expect(saved.providerOrder[0]).toBe('duckduckgo')

      // The MCP endpoint lives on the same port.
      const client = new Client({ name: 'dsh-gateway-test', version: '0.1.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.mcpUrl)))
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('web_search')
      await client.close()

      // /test routes on the same port and follows the ranked order. Stub only
      // outbound provider calls; localhost requests must reach the gateway.
      const realFetch = globalThis.fetch.bind(globalThis)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input)
          if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
          return new Response(
            JSON.stringify({ results: [{ title: 'X', url: 'https://x.example/', content: 'snippet' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }),
      )
      try {
        const tested = await fetch(`${handle.url}/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'example' }),
        }).then(response => response.json())
        expect(tested.ok).toBe(true)
        expect(tested.provider).toBe('searxng')

        const searched = await fetch(`${handle.url}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'example' }),
        }).then(response => response.json())
        expect(searched.ok).toBe(true)
        expect(searched.provider).toBe('searxng')
      } finally {
        vi.unstubAllGlobals()
      }
    } finally {
      await handle.close()
    }
  })

  it('fronts the browser API, viewer SSE, and viewer WebSocket on the same port', async () => {
    const browser = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessions: 0 }))
        return
      }
      if (req.url === '/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessions: [{ id: 's' }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const viewer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.url === '/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessions: [{ id: 's' }] }))
        return
      }
      if (req.url === '/sessions/s/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write('event: frame\ndata: {"x":1}\n\n')
        setTimeout(() => res.end(), 50)
        return
      }
      res.writeHead(404)
      res.end()
    })
    const viewerWss = new WebSocketServer({ noServer: true })
    viewer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname !== '/sessions/s/ws') {
        socket.destroy()
        return
      }
      viewerWss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(`echo:${String(data)}`)
        })
      })
    })

    const browserPort = await listenOn(browser)
    const viewerPort = await listenOn(viewer)
    const store = new SearchConfigStore(config(join(tempRoot, 'gateway-ingress.json')))
    await store.load()
    const gateway = await startSearchGateway(store, '127.0.0.1', 0, {
      browserApiUrl: `http://127.0.0.1:${browserPort}`,
      viewerUrl: `http://127.0.0.1:${viewerPort}`,
    })

    try {
      const health = await fetch(`${gateway.url}/browser/health`).then(response => response.json())
      expect(health).toMatchObject({ ok: true, sessions: 0 })

      const sessions = await fetch(`${gateway.url}/viewer/sessions`).then(response => response.json())
      expect(sessions.sessions).toEqual([{ id: 's' }])

      const stream = await fetch(`${gateway.url}/viewer/sessions/s/stream`)
      expect(await stream.text()).toContain('event: frame')

      const ws = new WebSocket(`${gateway.url.replace(/^http/, 'ws')}/viewer/sessions/s/ws`)
      try {
        const echoed = await new Promise<string>((resolve, reject) => {
          ws.on('open', () => ws.send('hello'))
          ws.on('message', (data) => resolve(String(data)))
          ws.on('error', reject)
        })
        expect(echoed).toBe('echo:hello')
      } finally {
        ws.close()
      }
    } finally {
      await gateway.close()
      for (const client of viewerWss.clients) client.terminate()
      await new Promise<void>((resolve) => viewerWss.close(() => resolve()))
      await closeServer(viewer)
      await closeServer(browser)
    }
  })
})
