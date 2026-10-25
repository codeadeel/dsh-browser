import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BrowserConfig, SearchConfig } from '../src/config.js'
import { startStatelessMcpServer } from '../src/mcp/http.js'
import { createSearchMcpServer } from '../src/search/mcp.js'
import { startBrowserServer } from '../src/browser-server.js'
import { startFixtureServer, type FixtureServer } from './fixture-server.js'

const chromePath =
  process.env.CHROME_PATH ?? '/opt/chrome-for-testing/chrome/linux-156.0.8078.47/chrome-linux64/chrome'
const hasChrome = existsSync(chromePath)

let tempRoot = ''
let fixture: FixtureServer
let searchConfig: SearchConfig
let browserConfig: BrowserConfig

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-test-'))
  fixture = await startFixtureServer()
  searchConfig = {
    host: '127.0.0.1',
    port: 0,
    providerOrder: ['searxng', 'duckduckgo'],
    maxResults: 8,
    timeoutMs: 5_000,
    searxngUrl: fixture.url,
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
    configPath: '/tmp/dsh-search-test.json',
    userAgent: 'test-agent',
  }
  browserConfig = {
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
})

afterAll(async () => {
  await fixture?.close()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'dsh-mcp-test', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

describe('search MCP', () => {
  it('exposes web_search and returns provider results', async () => {
    const handle = await startStatelessMcpServer(() => createSearchMcpServer(searchConfig), '127.0.0.1', 0)
    const client = await connect(handle.url)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain('web_search')
      const result = await client.callTool({
        name: 'web_search',
        arguments: { query: 'fixture query', maxResults: 3 },
      })
      const structured = result.structuredContent as {
        provider: string
        results: Array<{ title: string; url: string }>
      }
      expect(structured.provider).toBe('searxng')
      expect(structured.results[0]).toMatchObject({ title: 'Test Page' })
      expect(structured.results[0]?.url).toContain('/page')
    } finally {
      await client.close()
      await handle.close()
    }
  })
})

describe.skipIf(!hasChrome)('browser MCP and hybrid flow', () => {
  it('searches through one MCP server and opens the result in the dedicated browser', async () => {
    const searchHandle = await startStatelessMcpServer(() => createSearchMcpServer(searchConfig), '127.0.0.1', 0)
    const browserHandle = await startBrowserServer(browserConfig)
    let searchClient: Client | null = null
    let browserClient: Client | null = null
    let sessionId = ''
    try {
      const { info: session } = await browserHandle.manager.create({ id: 'hybrid-session' })
      sessionId = session.id
      searchClient = await connect(searchHandle.url)
      browserClient = await connect(session.mcpUrl)

      const searchResult = await searchClient.callTool({
        name: 'web_search',
        arguments: { query: 'fixture query', maxResults: 3 },
      })
      const searchData = searchResult.structuredContent as {
        results: Array<{ url: string; title: string }>
      }
      const first = searchData.results[0]
      expect(first?.url).toContain('/page')

      const navigate = await browserClient.callTool({
        name: 'browser_navigate',
        arguments: { url: first?.url },
      })
      const navigateData = navigate.structuredContent as { title: string; url: string }
      expect(navigateData.title).toBe('Test Page')
      expect(navigateData.url).toContain('/page')

      const snapshot = await browserClient.callTool({ name: 'browser_snapshot', arguments: {} })
      const snapshotData = snapshot.structuredContent as { text: string; elements: unknown[] }
      expect(snapshotData.text).toContain('fixture page')
      expect(snapshotData.elements.length).toBeGreaterThan(0)

      const screenshot = await browserClient.callTool({
        name: 'browser_screenshot',
        arguments: { fullPage: false },
      })
      const screenshotData = screenshot.structuredContent as { path: string; bytes: number }
      expect(screenshotData.bytes).toBeGreaterThan(1000)
      expect(existsSync(screenshotData.path)).toBe(true)

      const tabs = await browserClient.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })
      const tabData = tabs.structuredContent as { tabs: Array<{ active: boolean }> }
      expect(tabData.tabs.filter(tab => tab.active)).toHaveLength(1)
    } finally {
      if (browserClient) await browserClient.close()
      if (searchClient) await searchClient.close()
      if (sessionId) await browserHandle.manager.close(sessionId)
      await browserHandle.close()
      await searchHandle.close()
    }
  })
})
