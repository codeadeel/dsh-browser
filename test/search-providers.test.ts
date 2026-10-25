import { describe, expect, it, vi } from 'vitest'
import {
  parseDuckDuckGoHtml,
  parseGoogleCseJson,
  parseBraveJson,
  parseBraveMcpContent,
  parseGoogleGeminiJson,
  parseGoogleVertexJson,
  parseSearxngJson,
  runSearch,
  SearchBlockedError,
  unwrapDuckDuckGoUrl,
  type SearchRunResult,
} from '../src/search/providers.js'
import type { SearchConfig } from '../src/config.js'

const DDG_FIXTURE = `
<html><body>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Page</a>
    </h2>
    <a class="result__snippet">A useful example page for browser tests.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="https://example.org/second">Second Result</a>
    </h2>
    <a class="result__snippet">Another source.</a>
  </div>
</body></html>`

const config: SearchConfig = {
  host: '127.0.0.1',
  port: 0,
  providerOrder: ['duckduckgo'],
  maxResults: 8,
  timeoutMs: 5_000,
  searxngUrl: null,
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

describe('search parsers', () => {
  it('unwraps DuckDuckGo redirect links', () => {
    expect(unwrapDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F')).toBe('https://example.com/')
  })

  it('parses DuckDuckGo HTML results', () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE, 8)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      title: 'Example Page',
      url: 'https://example.com/page',
      provider: 'duckduckgo',
    })
    expect(results[0]?.snippet).toContain('useful example page')
  })

  it('parses SearXNG JSON results', () => {
    const results = parseSearxngJson(
      {
        results: [
          { title: 'One', url: 'https://one.example/', content: 'first' },
          { title: 'One duplicate', url: 'https://one.example/', content: 'duplicate' },
          { title: 'Two', url: 'https://two.example/', content: 'second' },
        ],
      },
      8,
    )
    expect(results.map(result => result.title)).toEqual(['One', 'Two'])
  })

  it('parses Google Programmable Search results', () => {
    const results = parseGoogleCseJson(
      {
        items: [
          { title: 'One', link: 'https://one.example/', snippet: 'first' },
          { title: 'Duplicate', link: 'https://one.example/', snippet: 'dup' },
          { title: 'Two', link: 'https://two.example/', snippet: 'second' },
        ],
      },
      8,
    )
    expect(results.map(result => result.title)).toEqual(['One', 'Two'])
    expect(results[0]?.provider).toBe('google-cse')
  })

  it('parses Vertex AI Search searchLite results', () => {
    const results = parseGoogleVertexJson(
      {
        results: [
          {
            id: '1',
            document: {
              derivedStructData: {
                title: 'Vertex One',
                link: 'https://one.example/',
                snippets: [{ snippet: 'first snippet' }, { snippet: 'more text' }],
              },
            },
          },
          {
            id: '2',
            document: {
              derivedStructData: {
                htmlTitle: 'Vertex Two',
                link: 'https://two.example/',
                snippets: [{ snippet: 'second snippet' }],
              },
            },
          },
          {
            id: '3',
            document: {
              derivedStructData: {
                title: 'No Link',
                link: '',
              },
            },
          },
        ],
        totalSize: 3,
      },
      8,
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      title: 'Vertex One',
      url: 'https://one.example/',
      snippet: 'first snippet more text',
      provider: 'google-vertex',
    })
    expect(results[1]?.title).toBe('Vertex Two')
  })

  it('rejects Vertex AI Search error responses', () => {
    expect(() => parseGoogleVertexJson({ error: { message: 'API key not valid' } }, 8)).toThrow(
      /API key not valid/,
    )
  })

  it('parses Gemini Search JSON-array output', () => {
    const results = parseGoogleGeminiJson(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '[{"title":"One","url":"https://one.example/","snippet":"first"},{"title":"Two","url":"https://two.example/","snippet":"second"}]',
                },
              ],
            },
          },
        ],
      },
      8,
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      title: 'One',
      url: 'https://one.example/',
      snippet: 'first',
      provider: 'google-gemini',
    })
  })

  it('falls back to Gemini grounding chunks when the output is not JSON', () => {
    const results = parseGoogleGeminiJson(
      {
        candidates: [
          {
            content: { parts: [{ text: 'Here is what I found: ...' }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://a.example/', title: 'A' } },
                { web: { uri: 'https://b.example/', title: 'B' } },
              ],
            },
          },
        ],
      },
      8,
    )
    expect(results.map(result => result.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(results[0]?.provider).toBe('google-gemini')
  })

  it('parses Brave Search web results', () => {
    const results = parseBraveJson(
      {
        web: {
          results: [
            { title: 'Brave One', url: 'https://one.example/', description: 'first' },
            { title: 'Duplicate', url: 'https://one.example/', description: 'dup' },
            { title: 'Brave Two', url: 'https://two.example/', description: 'second' },
          ],
        },
      },
      8,
    )
    expect(results.map(result => result.title)).toEqual(['Brave One', 'Brave Two'])
    expect(results[0]).toMatchObject({ url: 'https://one.example/', snippet: 'first', provider: 'brave' })
  })

  it('parses Brave MCP server text blocks', () => {
    const results = parseBraveMcpContent(
      [
        { type: 'text', text: JSON.stringify({ title: 'Mcp One', url: 'https://mcp.example/', description: 'via mcp' }) },
        { type: 'text', text: 'not json' },
        { type: 'text', text: JSON.stringify({ title: 'Mcp Two', url: 'https://mcp2.example/', description: 'second' }) },
      ],
      8,
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ title: 'Mcp One', url: 'https://mcp.example/', provider: 'brave' })
  })
})

describe('search provider chain', () => {
  it('returns DuckDuckGo results and records the attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(DDG_FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } })),
    )
    const result: SearchRunResult = await runSearch('example', config)
    expect(result.provider).toBe('duckduckgo')
    expect(result.results).toHaveLength(2)
    expect(result.attempts[0]).toMatchObject({ provider: 'duckduckgo', ok: true, count: 2 })
    vi.unstubAllGlobals()
  })

  it('uses Google Programmable Search when configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        items: [{ title: 'CSE Result', link: 'https://cse.example/', snippet: 'from google' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    try {
      const result = await runSearch('example', {
        ...config,
        providerOrder: ['google-cse', 'duckduckgo'],
        googleCseApiKey: 'test-key',
        googleCseCx: 'test-cx',
      })
      expect(result.provider).toBe('google-cse')
      expect(result.results[0]).toMatchObject({ title: 'CSE Result', url: 'https://cse.example/' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed when all providers fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no results', { status: 200 })))
    try {
      await expect(runSearch('example', config)).rejects.toThrow(
        /All search providers failed|Google returned no parsable results/,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
