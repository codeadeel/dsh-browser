import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { SearchResult } from '../protocol/types.js'
import type { SearchConfig, SearchProviderName } from '../config.js'
import { SearchBlockedError, SearchProviderError } from './errors.js'
import {
  isBlockedPage,
  parseBraveJson,
  parseBraveMcpContent,
  parseDuckDuckGoHtml,
  parseGoogleCseJson,
  parseGoogleGeminiJson,
  parseGoogleVertexJson,
  parseSearxngJson,
} from './parsers.js'

// Re-exports so callers keep one import surface.
export { SearchBlockedError, SearchProviderError } from './errors.js'
export {
  cleanText,
  isBlockedPage,
  parseBraveJson,
  parseBraveMcpContent,
  parseDuckDuckGoHtml,
  parseGoogleCseJson,
  parseGoogleGeminiJson,
  parseGoogleVertexJson,
  parseSearxngJson,
  unwrapDuckDuckGoUrl,
} from './parsers.js'

export interface SearchAttempt {
  provider: string
  ok: boolean
  count: number
  error?: string
}

export interface SearchRunResult {
  results: SearchResult[]
  provider: string
  attempts: SearchAttempt[]
}

async function fetchText(url: string, config: SearchConfig): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    headers: {
      'user-agent': config.userAgent,
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'follow',
  })
  return { status: response.status, text: await response.text() }
}

export async function searchDuckDuckGo(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const { status, text } = await fetchText(url, config)
  if (status >= 400) throw new SearchProviderError(`DuckDuckGo returned HTTP ${status}`)
  if (isBlockedPage(text)) throw new SearchBlockedError('DuckDuckGo returned a bot challenge')
  const results = parseDuckDuckGoHtml(text, limit)
  if (results.length === 0) throw new SearchProviderError('DuckDuckGo returned no parsable results')
  return results
}

export async function searchSearxng(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  if (!config.searxngUrl) throw new SearchProviderError('SEARXNG_URL is not configured')
  const base = config.searxngUrl.replace(/\/$/, '')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`
  const { status, text } = await fetchText(url, config)
  if (status >= 400) throw new SearchProviderError(`SearXNG returned HTTP ${status}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SearchProviderError('SearXNG returned invalid JSON')
  }
  const results = parseSearxngJson(parsed, limit)
  if (results.length === 0) throw new SearchProviderError('SearXNG returned no results')
  return results
}

function apiError(prefix: string, status: number, parsed: unknown): SearchProviderError {
  const message = typeof parsed === 'object' && parsed !== null
    ? (parsed as { error?: { message?: unknown } }).error?.message
    : undefined
  return new SearchProviderError(`${prefix} returned HTTP ${status}${message ? `: ${String(message)}` : ''}`)
}

export async function searchGoogleCse(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  if (config.googleCseApiKey === '' || config.googleCseCx === '') {
    throw new SearchProviderError('Google CSE key and cx are not configured')
  }
  const url = new URL('https://www.googleapis.com/customsearch/v1')
  url.searchParams.set('key', config.googleCseApiKey)
  url.searchParams.set('cx', config.googleCseCx)
  url.searchParams.set('q', query)
  url.searchParams.set('num', String(Math.min(Math.max(limit, 1), 10)))
  url.searchParams.set('safe', 'off')
  const { status, text } = await fetchText(url.toString(), config)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SearchProviderError(`Google CSE returned invalid JSON (HTTP ${status})`)
  }
  if (status >= 400) throw apiError('Google CSE', status, parsed)
  const results = parseGoogleCseJson(parsed, limit)
  if (results.length === 0) throw new SearchProviderError('Google CSE returned no results')
  return results
}

export async function searchGoogleVertex(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  if (config.googleVertexApiKey === '' || config.googleVertexProjectId === '' || config.googleVertexEngineId === '') {
    throw new SearchProviderError('Google Vertex AI Search key, project id, and engine (app) id are not configured')
  }
  const endpoint = config.googleVertexEndpoint.replace(/\/$/, '')
  const url = new URL(
    `${endpoint}/projects/${encodeURIComponent(config.googleVertexProjectId)}` +
    `/locations/global/collections/default_collection/engines/${encodeURIComponent(config.googleVertexEngineId)}` +
    `/servingConfigs/default_search:searchLite`,
  )
  url.searchParams.set('key', config.googleVertexApiKey)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': config.userAgent,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({ query, pageSize: Math.min(Math.max(limit, 1), 20) }),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'follow',
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SearchProviderError(`Google Vertex AI Search returned invalid JSON (HTTP ${response.status})`)
  }
  if (response.status >= 400) throw apiError('Google Vertex AI Search', response.status, parsed)
  const results = parseGoogleVertexJson(parsed, limit)
  if (results.length === 0) throw new SearchProviderError('Google Vertex AI Search returned no results')
  return results
}

const GROUNDING_REDIRECT_MARKER = 'vertexaisearch.cloud.google.com/grounding-api'

async function resolveGroundingRedirect(url: string, config: SearchConfig): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': config.userAgent,
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
    })
    const final = response.url
    if (final && final !== url && /^https?:\/\//i.test(final)) return final
  } catch {
    // Keep the original link; the caller drops it as unresolvable.
  }
  return url
}

export async function searchGoogleGemini(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  if (config.googleGeminiApiKey === '') {
    throw new SearchProviderError('Google Gemini key is not configured')
  }
  const model = config.googleGeminiModel || 'gemini-3.8-flash'
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`)
  url.searchParams.set('key', config.googleGeminiApiKey)
  const prompt =
    `Search the web for: ${JSON.stringify(query)}\n` +
    `Return a JSON array of up to ${Math.min(Math.max(limit, 1), 20)} results, each an object with exactly three fields: ` +
    `"title" (the page title), "url" (the full https URL), and "snippet" (1-2 sentence description). ` +
    `Use the search tool, then output only the JSON array, no markdown, no commentary.`
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': config.userAgent,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    // Grounding runs a live web search plus generation; give it more headroom
    // than the generic provider timeout.
    signal: AbortSignal.timeout(Math.max(config.timeoutMs, 45_000)),
    redirect: 'follow',
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SearchProviderError(`Gemini Search returned invalid JSON (HTTP ${response.status})`)
  }
  if (response.status >= 400) throw apiError('Gemini Search', response.status, parsed)
  const parsedResults = parseGoogleGeminiJson(parsed, limit)
  if (parsedResults.length === 0) throw new SearchProviderError('Gemini Search returned no results')

  // Google hands the model citation redirect links, not real page URLs.
  // Resolve them in parallel and drop the ones that do not resolve.
  const resolved = await Promise.all(parsedResults.map(async result => {
    if (result.url.includes(GROUNDING_REDIRECT_MARKER)) {
      return { ...result, url: await resolveGroundingRedirect(result.url, config) }
    }
    return result
  }))
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const result of resolved) {
    if (result.url.includes(GROUNDING_REDIRECT_MARKER)) continue
    if (!/^https?:\/\//i.test(result.url) || seen.has(result.url)) continue
    seen.add(result.url)
    results.push(result)
    if (results.length >= limit) break
  }
  if (results.length === 0) throw new SearchProviderError('Gemini Search results could not be resolved to real URLs')
  return results
}

export async function searchBrave(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  // A key saved in the plugin UI is authoritative and works immediately over
  // Brave's REST API. The stack's brave-mcp container only sees its startup
  // BRAVE_API_KEY env, so use the MCP lane only when no UI key is saved.
  if (config.braveApiKey === '' && config.braveMcpUrl) {
    return searchBraveViaMcp(query, config, limit)
  }
  if (config.braveApiKey === '') {
    throw new SearchProviderError('Brave Search key is not configured')
  }
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(Math.max(limit, 1), 20)))
  url.searchParams.set('country', 'all')
  url.searchParams.set('search_lang', 'en')
  const response = await fetch(url.toString(), {
    headers: {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': config.userAgent,
      'x-subscription-token': config.braveApiKey,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'follow',
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SearchProviderError(`Brave Search returned invalid JSON (HTTP ${response.status})`)
  }
  if (response.status >= 400) throw apiError('Brave Search', response.status, parsed)
  const results = parseBraveJson(parsed, limit)
  if (results.length === 0) throw new SearchProviderError('Brave Search returned no results')
  return results
}

async function searchBraveViaMcp(query: string, config: SearchConfig, limit: number): Promise<SearchResult[]> {
  const base = config.braveMcpUrl.replace(/\/$/, '')
  const client = new Client({ name: 'dsh-search-gateway', version: '0.2.0' })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
    await client.connect(transport)
    const result = await client.callTool({
      name: 'brave_web_search',
      arguments: { query, count: Math.min(Math.max(limit, 1), 20), country: 'ALL' },
    })
    if (result.isError) {
      const blocks = Array.isArray(result.content) ? result.content : []
      const text = blocks
        .filter((block): block is { type: 'text'; text: string } => {
          return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        })
        .map(block => (block as { text: string }).text)
        .join(' ')
      throw new SearchProviderError(`Brave MCP search failed: ${text || 'unknown error'}`)
    }
    const results = parseBraveMcpContent(result.content, limit)
    if (results.length === 0) throw new SearchProviderError('Brave MCP returned no results')
    return results
  } finally {
    await client.close().catch(() => undefined)
  }
}

function effectiveOrder(config: SearchConfig): SearchProviderName[] {
  const order: SearchProviderName[] = []
  for (const name of config.providerOrder) {
    if (!order.includes(name) && name !== 'auto' && name !== 'google') order.push(name)
  }
  if (!order.includes('duckduckgo')) order.push('duckduckgo')
  return order
}

function providerConfigured(provider: SearchProviderName, config: SearchConfig): string | null {
  if (provider === 'searxng') return config.searxngUrl ? null : 'SEARXNG_URL is not configured'
  if (provider === 'google-cse') return config.googleCseApiKey && config.googleCseCx ? null : 'Google CSE key and cx are not configured'
  if (provider === 'google-gemini') return config.googleGeminiApiKey ? null : 'Google Gemini key is not configured'
  if (provider === 'brave') return config.braveApiKey || config.braveMcpUrl ? null : 'Brave Search key or BRAVE_MCP_URL is not configured'
  if (provider === 'google-vertex') {
    return config.googleVertexApiKey && config.googleVertexProjectId && config.googleVertexEngineId
      ? null
      : 'Google Vertex AI Search key, project id, and engine (app) id are not configured'
  }
  if (provider === 'duckduckgo') return null
  return null
}

export async function runSearch(query: string, config: SearchConfig): Promise<SearchRunResult> {
  const trimmed = query.trim()
  if (trimmed === '') throw new SearchProviderError('query must be a non-empty string')
  const limit = Math.max(1, Math.min(config.maxResults, 20))
  const attempts: SearchAttempt[] = []
  let lastError: unknown = null

  for (const provider of effectiveOrder(config)) {
    const missing = providerConfigured(provider, config)
    if (missing) {
      attempts.push({ provider, ok: false, count: 0, error: missing })
      continue
    }
    try {
      const results =
        provider === 'searxng'
          ? await searchSearxng(trimmed, config, limit)
          : provider === 'google-cse'
            ? await searchGoogleCse(trimmed, config, limit)
            : provider === 'google-gemini'
              ? await searchGoogleGemini(trimmed, config, limit)
              : provider === 'brave'
                ? await searchBrave(trimmed, config, limit)
                : provider === 'google-vertex'
                  ? await searchGoogleVertex(trimmed, config, limit)
                  : await searchDuckDuckGo(trimmed, config, limit)
      attempts.push({ provider, ok: true, count: results.length })
      if (results.length > 0) return { results, provider, attempts }
    } catch (error) {
      lastError = error
      attempts.push({
        provider,
        ok: false,
        count: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (lastError instanceof SearchBlockedError) throw lastError
  const detail = attempts.map(attempt => `${attempt.provider}: ${attempt.error ?? 'no results'}`).join('; ')
  throw new SearchProviderError(`All search providers failed (${detail})`)
}
