import { load } from 'cheerio'
import type { SearchResult } from '../protocol/types.js'
import { SearchProviderError } from './errors.js'

export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function isBlockedPage(text: string): boolean {
  const value = text.toLowerCase()
  return [
    'unusual traffic',
    'our systems have detected',
    'captcha',
    'before you continue to google',
    'enablejs',
    'verify you are human',
  ].some(marker => value.includes(marker))
}

export function unwrapDuckDuckGoUrl(href: string): string {
  if (href.startsWith('//duckduckgo.com/l/?') || href.startsWith('/l/?')) {
    const absolute = href.startsWith('//') ? `https:${href}` : `https://duckduckgo.com${href}`
    try {
      return new URL(absolute).searchParams.get('uddg') ?? absolute
    } catch {
      return absolute
    }
  }
  return href
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const $ = load(html)
  const results: SearchResult[] = []
  const seen = new Set<string>()

  $('.result').each((_, element) => {
    if (results.length >= limit) return false
    const node = $(element)
    const anchor = node.find('.result__a').first()
    const href = anchor.attr('href')
    const title = cleanText(anchor.text())
    if (!href || title === '') return
    const url = unwrapDuckDuckGoUrl(href)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    const snippet = cleanText(node.find('.result__snippet').first().text())
    results.push({ title, url, snippet, provider: 'duckduckgo' })
    return
  })

  return results
}

export function parseSearxngJson(json: unknown, limit: number): SearchResult[] {
  if (typeof json !== 'object' || json === null) {
    throw new SearchProviderError('SearXNG returned a non-object JSON response')
  }
  const rawResults = (json as { results?: unknown }).results
  if (!Array.isArray(rawResults)) {
    throw new SearchProviderError('SearXNG response is missing a results array')
  }
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of rawResults) {
    if (results.length >= limit) break
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const url = typeof row.url === 'string' ? row.url : ''
    const title = typeof row.title === 'string' ? cleanText(row.title) : ''
    const snippet = typeof row.content === 'string' ? cleanText(row.content) : ''
    if (!url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet, provider: 'searxng' })
  }
  return results
}

export function parseGoogleCseJson(json: unknown, limit: number): SearchResult[] {
  if (typeof json !== 'object' || json === null) {
    throw new SearchProviderError('Google CSE returned a non-object JSON response')
  }
  const error = (json as { error?: { message?: unknown } }).error
  if (error) {
    throw new SearchProviderError(`Google CSE error: ${String(error.message ?? 'unknown error')}`)
  }
  const items = (json as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (results.length >= limit) break
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const url = typeof row.link === 'string' ? row.link : ''
    const title = typeof row.title === 'string' ? cleanText(row.title) : ''
    const snippet = typeof row.snippet === 'string' ? cleanText(row.snippet) : ''
    if (!url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet, provider: 'google-cse' })
  }
  return results
}

export function parseGoogleVertexJson(json: unknown, limit: number): SearchResult[] {
  if (typeof json !== 'object' || json === null) {
    throw new SearchProviderError('Vertex AI Search returned a non-object JSON response')
  }
  const error = (json as { error?: { message?: unknown } }).error
  if (error) {
    throw new SearchProviderError(`Vertex AI Search error: ${String(error.message ?? 'unknown error')}`)
  }
  const rawResults = (json as { results?: unknown }).results
  if (!Array.isArray(rawResults)) return []
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of rawResults) {
    if (results.length >= limit) break
    if (typeof item !== 'object' || item === null) continue
    const document = (item as { document?: unknown }).document
    if (typeof document !== 'object' || document === null) continue
    const data = (document as { derivedStructData?: unknown; structData?: unknown })
    const struct = (data.derivedStructData ?? data.structData)
    if (typeof struct !== 'object' || struct === null) continue
    const row = struct as Record<string, unknown>
    const url = typeof row.link === 'string' ? row.link : ''
    const title = typeof row.title === 'string' && row.title.trim() !== ''
      ? cleanText(row.title)
      : typeof row.htmlTitle === 'string' ? cleanText(row.htmlTitle) : ''
    const snippets = Array.isArray(row.snippets)
      ? row.snippets
        .filter((entry): entry is { snippet?: unknown } => typeof entry === 'object' && entry !== null)
        .map(entry => typeof entry.snippet === 'string' ? cleanText(entry.snippet) : '')
        .filter(text => text !== '')
        .join(' ')
      : ''
    if (!url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet: snippets.slice(0,400), provider: 'google-vertex' })
  }
  return results
}

export function parseGoogleGeminiJson(json: unknown, limit: number): SearchResult[] {
  if (typeof json !== 'object' || json === null) {
    throw new SearchProviderError('Gemini Search returned a non-object JSON response')
  }
  const error = (json as { error?: { message?: unknown } }).error
  if (error) {
    throw new SearchProviderError(`Gemini Search error: ${String(error.message ?? 'unknown error')}`)
  }
  const candidates = (json as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const first = candidates[0]
  if (typeof first !== 'object' || first === null) return []

  const results: SearchResult[] = []
  const seen = new Set<string>()
  const push = (row: { title?: unknown; url?: unknown; snippet?: unknown }): void => {
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    const title = typeof row.title === 'string' ? cleanText(row.title) : ''
    const snippet = typeof row.snippet === 'string' ? cleanText(row.snippet) : ''
    if (results.length >= limit || !url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) return
    seen.add(url)
    results.push({ title, url, snippet: snippet.slice(0,400), provider: 'google-gemini' })
  }

  // Preferred: the model was asked to emit a JSON array of {title,url,snippet}.
  const content = (first as { content?: { parts?: Array<{ text?: unknown }> } }).content
  const text = Array.isArray(content?.parts)
    ? content.parts.map(part => typeof part.text === 'string' ? part.text : '').join('\n')
    : ''
  const arrayMatch = /\[[\s\S]*\]/.exec(text)
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (typeof item === 'object' && item !== null) push(item as Record<string, unknown>)
      }
    } catch {
      // Fall through to grounding chunks when the model output is not clean JSON.
    }
  }

  // Fallback: the grounding citations Google Search produced.
  if (results.length === 0) {
    const chunks = (first as { groundingMetadata?: { groundingChunks?: unknown } }).groundingMetadata?.groundingChunks
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (typeof chunk !== 'object' || chunk === null) continue
        const web = (chunk as { web?: unknown }).web
        if (typeof web !== 'object' || web === null) continue
        const row = web as { uri?: unknown; title?: unknown }
        push({
          url: typeof row.uri === 'string' ? row.uri : '',
          title: typeof row.title === 'string' ? row.title : new URL(row.uri as string).hostname,
          snippet: '',
        })
      }
    }
  }

  return results
}

export function parseBraveJson(json: unknown, limit: number): SearchResult[] {
  if (typeof json !== 'object' || json === null) {
    throw new SearchProviderError('Brave Search returned a non-object JSON response')
  }
  const error = (json as { error?: { message?: unknown } }).error
  if (error) {
    throw new SearchProviderError(`Brave Search error: ${String(error.message ?? 'unknown error')}`)
  }
  const web = (json as { web?: unknown }).web
  const rawResults = typeof web === 'object' && web !== null ? (web as { results?: unknown }).results : undefined
  if (!Array.isArray(rawResults)) return []
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of rawResults) {
    if (results.length >= limit) break
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const url = typeof row.url === 'string' ? row.url : ''
    const title = typeof row.title === 'string' ? cleanText(row.title) : ''
    const snippet = typeof row.description === 'string' ? cleanText(row.description) : ''
    if (!url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet: snippet.slice(0,400), provider: 'brave' })
  }
  return results
}

export function parseBraveMcpContent(content: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(content)) return []
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const block of content) {
    if (results.length >= limit) break
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if (typeof text !== 'string' || text.trim() === '') continue
    try {
      const entry = JSON.parse(text) as Record<string, unknown>
      const url = typeof entry.url === 'string' ? entry.url : ''
      const title = typeof entry.title === 'string' ? cleanText(entry.title) : ''
      const snippet = typeof entry.description === 'string' ? cleanText(entry.description) : ''
      if (!url || !/^https?:\/\//i.test(url) || title === '' || seen.has(url)) continue
      seen.add(url)
      results.push({ title, url, snippet: snippet.slice(0,400), provider: 'brave' })
    } catch {
      // Not a JSON block; skip.
    }
  }
  return results
}
