import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type SearchProviderName = 'auto' | 'searxng' | 'google-cse' | 'google-gemini' | 'brave' | 'google-vertex' | 'duckduckgo' | 'google'

export const RANKABLE_PROVIDERS: SearchProviderName[] = [
  'searxng',
  'google-cse',
  'google-gemini',
  'brave',
  'google-vertex',
  'duckduckgo',
]

export const DEFAULT_PROVIDER_ORDER: SearchProviderName[] = [
  'searxng',
  'google-cse',
  'google-gemini',
  'brave',
  'google-vertex',
  'duckduckgo',
]

export interface SearchConfig {
  host: string
  port: number
  providerOrder: SearchProviderName[]
  maxResults: number
  timeoutMs: number
  searxngUrl: string | null
  googleCseApiKey: string
  googleCseCx: string
  googleGeminiApiKey: string
  googleGeminiModel: string
  braveApiKey: string
  braveMcpUrl: string
  googleVertexApiKey: string
  googleVertexProjectId: string
  googleVertexEngineId: string
  googleVertexEndpoint: string
  configPath: string
  userAgent: string
}

export interface BrowserConfig {
  host: string
  port: number
  viewerHost?: string
  viewerPort?: number
  chromePath: string
  headless: boolean
  profileRoot: string
  artifactRoot: string
  defaultTimeoutMs: number
  navigationTimeoutMs: number
  idleTimeoutMs: number
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return
  try {
    process.loadEnvFile(path)
  } catch {
    // A malformed optional .env should not prevent the service from starting.
  }
}

function envString(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

function providerOrderFromEnv(): SearchProviderName[] {
  const rawOrder = process.env.SEARCH_PROVIDER_ORDER?.trim() || ''
  const names = rawOrder.split(',').map(value => value.trim()).filter(value => value !== '')
  if (names.length > 0) {
    const order: SearchProviderName[] = []
    for (const name of names) {
      if (isProviderName(name) && !order.includes(name)) order.push(name)
    }
    if (order.length > 0) return order
  }
  // Legacy single-provider selection: that provider goes first, rest default.
  const legacy = envString('SEARCH_PROVIDER', 'auto') as SearchProviderName
  if (legacy !== 'auto' && isProviderName(legacy)) {
    return [legacy, ...DEFAULT_PROVIDER_ORDER.filter(name => name !== legacy)]
  }
  return [...DEFAULT_PROVIDER_ORDER]
}

function isProviderName(value: string): value is SearchProviderName {
  return ['auto', 'searxng', 'google-cse', 'google-gemini', 'brave', 'google-vertex', 'duckduckgo', 'google'].includes(value)
}

export function searchConfigFromEnv(): SearchConfig {
  return {
    host: envString('SEARCH_HOST', '127.0.0.1'),
    port: envInt('SEARCH_PORT', 8787),
    providerOrder: providerOrderFromEnv(),
    maxResults: envInt('SEARCH_MAX_RESULTS', 8),
    timeoutMs: envInt('SEARCH_TIMEOUT_MS', 20_000),
    searxngUrl: process.env.SEARXNG_URL?.trim() || null,
    googleCseApiKey: process.env.GOOGLE_CSE_API_KEY?.trim() || '',
    googleCseCx: process.env.GOOGLE_CSE_CX?.trim() || '',
    googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY?.trim() || '',
    googleGeminiModel: envString('GOOGLE_GEMINI_MODEL', 'gemini-3.8-flash'),
    braveApiKey: process.env.BRAVE_API_KEY?.trim() || '',
    braveMcpUrl: process.env.BRAVE_MCP_URL?.trim() || '',
    googleVertexApiKey: process.env.GOOGLE_VERTEX_API_KEY?.trim() || '',
    googleVertexProjectId: process.env.GOOGLE_VERTEX_PROJECT_ID?.trim() || '',
    googleVertexEngineId: process.env.GOOGLE_VERTEX_ENGINE_ID?.trim() || '',
    googleVertexEndpoint: envString('GOOGLE_VERTEX_ENDPOINT', 'https://discoveryengine.googleapis.com/v1'),
    configPath: resolve(envString('SEARCH_CONFIG_PATH', './data/search-config.json')),
    userAgent: envString('SEARCH_USER_AGENT', DEFAULT_USER_AGENT),
  }
}

function discoverChromePath(): string {
  const candidates = [
    process.env.CHROME_PATH?.trim(),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/chrome-for-testing/chrome/linux-156.0.8078.47/chrome-linux64/chrome',
  ].filter((value): value is string => typeof value === 'string' && value !== '')
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? 'google-chrome'
}

export function browserConfigFromEnv(): BrowserConfig {
  return {
    host: envString('BROWSER_HOST', '127.0.0.1'),
    port: envInt('BROWSER_PORT', 8788),
    viewerHost: envString('BROWSER_VIEWER_HOST', '127.0.0.1'),
    viewerPort: envInt('BROWSER_VIEWER_PORT', 8791),
    chromePath: discoverChromePath(),
    headless: envBool('BROWSER_HEADLESS', true),
    profileRoot: resolve(envString('BROWSER_PROFILE_ROOT', './data/sessions')),
    artifactRoot: resolve(envString('BROWSER_ARTIFACT_ROOT', './artifacts')),
    defaultTimeoutMs: envInt('BROWSER_TIMEOUT_MS', 20_000),
    navigationTimeoutMs: envInt('BROWSER_NAV_TIMEOUT_MS', 45_000),
    idleTimeoutMs: envInt('BROWSER_IDLE_TIMEOUT_MS', 30 * 60 * 1000),
  }
}
