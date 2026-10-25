import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_PROVIDER_ORDER, type SearchConfig, type SearchProviderName } from '../config.js'

export interface PublicSearchConfig {
  providerOrder: SearchProviderName[]
  maxResults: number
  searxngUrl: string | null
  googleCseCx: string
  hasGoogleCseKey: boolean
  googleCseKeyPreview: string
  googleGeminiModel: string
  hasGoogleGeminiKey: boolean
  googleGeminiKeyPreview: string
  hasBraveKey: boolean
  braveKeyPreview: string
  braveMcpConfigured: boolean
  googleVertexProjectId: string
  googleVertexEngineId: string
  hasGoogleVertexKey: boolean
  googleVertexKeyPreview: string
  configFile: string
}

export interface SearchConfigUpdate {
  providerOrder?: unknown
  maxResults?: unknown
  searxngUrl?: unknown
  googleCseApiKey?: unknown
  googleCseCx?: unknown
  clearGoogleCseKey?: unknown
  googleGeminiApiKey?: unknown
  googleGeminiModel?: unknown
  clearGoogleGeminiKey?: unknown
  braveApiKey?: unknown
  clearBraveKey?: unknown
  googleVertexApiKey?: unknown
  googleVertexProjectId?: unknown
  googleVertexEngineId?: unknown
  clearGoogleVertexKey?: unknown
}

function isProvider(value: unknown): value is SearchProviderName {
  return typeof value === 'string' && ['auto', 'searxng', 'google-cse', 'google-gemini', 'brave', 'google-vertex', 'duckduckgo', 'google'].includes(value)
}

function normalizeOrder(value: unknown): SearchProviderName[] | null {
  if (!Array.isArray(value)) return null
  const order: SearchProviderName[] = []
  for (const entry of value) {
    if (isProvider(entry) && entry !== 'auto' && entry !== 'google' && !order.includes(entry)) order.push(entry)
  }
  return order.length > 0 ? order : null
}

/** Legacy single-provider setting → a priority order with that provider first. */
function legacyOrder(provider: unknown): SearchProviderName[] {
  if (isProvider(provider) && provider !== 'auto') {
    return [provider, ...DEFAULT_PROVIDER_ORDER.filter(name => name !== provider)]
  }
  return [...DEFAULT_PROVIDER_ORDER]
}

function previewKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export class SearchConfigStore {
  private config: SearchConfig
  private readonly filename: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(initial: SearchConfig) {
    this.config = { ...initial }
    this.filename = initial.configPath
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filename, 'utf8')) as Record<string, unknown>
      const order = normalizeOrder(raw.providerOrder)
      if (order) this.config.providerOrder = order
      else if (raw.provider !== undefined) this.config.providerOrder = legacyOrder(raw.provider)
      if (typeof raw.maxResults === 'number' && Number.isFinite(raw.maxResults)) {
        this.config.maxResults = Math.max(1, Math.min(20, Math.round(raw.maxResults)))
      }
      if (typeof raw.searxngUrl === 'string') this.config.searxngUrl = raw.searxngUrl.trim() || null
      if (typeof raw.googleCseApiKey === 'string') this.config.googleCseApiKey = raw.googleCseApiKey.trim()
      if (typeof raw.googleCseCx === 'string') this.config.googleCseCx = raw.googleCseCx.trim()
      if (typeof raw.googleGeminiApiKey === 'string') this.config.googleGeminiApiKey = raw.googleGeminiApiKey.trim()
      if (typeof raw.braveApiKey === 'string') this.config.braveApiKey = raw.braveApiKey.trim()
      if (typeof raw.googleGeminiModel === 'string') this.config.googleGeminiModel = raw.googleGeminiModel.trim()
      if (typeof raw.googleVertexApiKey === 'string') this.config.googleVertexApiKey = raw.googleVertexApiKey.trim()
      if (typeof raw.googleVertexProjectId === 'string') this.config.googleVertexProjectId = raw.googleVertexProjectId.trim()
      if (typeof raw.googleVertexEngineId === 'string') this.config.googleVertexEngineId = raw.googleVertexEngineId.trim()
      if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)) {
        this.config.timeoutMs = Math.max(1_000, Math.min(60_000, Math.round(raw.timeoutMs)))
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error(`[search] could not load ${this.filename}: ${String(error)}`)
    }
  }

  get(): SearchConfig {
    return this.config
  }

  publicConfig(): PublicSearchConfig {
    return {
      providerOrder: this.config.providerOrder,
      maxResults: this.config.maxResults,
      searxngUrl: this.config.searxngUrl,
      googleCseCx: this.config.googleCseCx,
      hasGoogleCseKey: this.config.googleCseApiKey !== '',
      googleCseKeyPreview: previewKey(this.config.googleCseApiKey),
      googleGeminiModel: this.config.googleGeminiModel,
      hasGoogleGeminiKey: this.config.googleGeminiApiKey !== '',
      googleGeminiKeyPreview: previewKey(this.config.googleGeminiApiKey),
      hasBraveKey: this.config.braveApiKey !== '',
      braveKeyPreview: previewKey(this.config.braveApiKey),
      braveMcpConfigured: this.config.braveMcpUrl !== '',
      googleVertexProjectId: this.config.googleVertexProjectId,
      googleVertexEngineId: this.config.googleVertexEngineId,
      hasGoogleVertexKey: this.config.googleVertexApiKey !== '',
      googleVertexKeyPreview: previewKey(this.config.googleVertexApiKey),
      configFile: this.filename,
    }
  }

  async update(input: SearchConfigUpdate): Promise<PublicSearchConfig> {
    if (input.providerOrder !== undefined) {
      const order = normalizeOrder(input.providerOrder)
      if (!order) throw new Error('providerOrder must be an array of provider names')
      this.config.providerOrder = order
    }
    if (input.maxResults !== undefined) {
      if (typeof input.maxResults !== 'number' || !Number.isFinite(input.maxResults)) {
        throw new Error('maxResults must be a number')
      }
      this.config.maxResults = Math.max(1, Math.min(20, Math.round(input.maxResults)))
    }
    if (input.searxngUrl !== undefined) {
      if (typeof input.searxngUrl !== 'string') throw new Error('searxngUrl must be a string')
      this.config.searxngUrl = input.searxngUrl.trim() || null
    }
    if (input.googleCseCx !== undefined) {
      if (typeof input.googleCseCx !== 'string') throw new Error('googleCseCx must be a string')
      this.config.googleCseCx = input.googleCseCx.trim()
    }
    if (input.clearGoogleCseKey === true) {
      this.config.googleCseApiKey = ''
    } else if (typeof input.googleCseApiKey === 'string' && input.googleCseApiKey.trim() !== '') {
      this.config.googleCseApiKey = input.googleCseApiKey.trim()
    }
    if (input.clearGoogleGeminiKey === true) {
      this.config.googleGeminiApiKey = ''
    } else if (typeof input.googleGeminiApiKey === 'string' && input.googleGeminiApiKey.trim() !== '') {
      this.config.googleGeminiApiKey = input.googleGeminiApiKey.trim()
    }
    if (input.clearBraveKey === true) {
      this.config.braveApiKey = ''
    } else if (typeof input.braveApiKey === 'string' && input.braveApiKey.trim() !== '') {
      this.config.braveApiKey = input.braveApiKey.trim()
    }
    if (input.googleGeminiModel !== undefined) {
      if (typeof input.googleGeminiModel !== 'string') throw new Error('googleGeminiModel must be a string')
      this.config.googleGeminiModel = input.googleGeminiModel.trim() || 'gemini-3.8-flash'
    }
    if (input.googleVertexProjectId !== undefined) {
      if (typeof input.googleVertexProjectId !== 'string') throw new Error('googleVertexProjectId must be a string')
      this.config.googleVertexProjectId = input.googleVertexProjectId.trim()
    }
    if (input.googleVertexEngineId !== undefined) {
      if (typeof input.googleVertexEngineId !== 'string') throw new Error('googleVertexEngineId must be a string')
      this.config.googleVertexEngineId = input.googleVertexEngineId.trim()
    }
    if (input.clearGoogleVertexKey === true) {
      this.config.googleVertexApiKey = ''
    } else if (typeof input.googleVertexApiKey === 'string' && input.googleVertexApiKey.trim() !== '') {
      this.config.googleVertexApiKey = input.googleVertexApiKey.trim()
    }

    await this.persist()
    return this.publicConfig()
  }

  private async persist(): Promise<void> {
    const payload = {
      providerOrder: this.config.providerOrder,
      maxResults: this.config.maxResults,
      searxngUrl: this.config.searxngUrl,
      googleCseApiKey: this.config.googleCseApiKey,
      googleCseCx: this.config.googleCseCx,
      googleGeminiApiKey: this.config.googleGeminiApiKey,
      googleGeminiModel: this.config.googleGeminiModel,
      braveApiKey: this.config.braveApiKey,
      googleVertexApiKey: this.config.googleVertexApiKey,
      googleVertexProjectId: this.config.googleVertexProjectId,
      googleVertexEngineId: this.config.googleVertexEngineId,
      timeoutMs: this.config.timeoutMs,
    }
    const run = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filename), { recursive: true })
      const temp = `${this.filename}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.filename)
    })
    this.writeQueue = run.catch(() => undefined)
    await run
  }
}
