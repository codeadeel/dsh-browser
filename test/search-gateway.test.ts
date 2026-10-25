import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
      } finally {
        vi.unstubAllGlobals()
      }
    } finally {
      await handle.close()
    }
  })
})
