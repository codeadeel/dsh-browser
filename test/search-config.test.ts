import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_ORDER, type SearchConfig } from '../src/config.js'
import { SearchConfigStore } from '../src/search/store.js'

let tempRoot = ''

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'dsh-search-config-'))
})

afterAll(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

function baseConfig(path: string): SearchConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    providerOrder: [...DEFAULT_PROVIDER_ORDER],
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
    configPath: path,
    userAgent: 'test-agent',
  }
}

describe('SearchConfigStore', () => {
  it('persists provider settings, masks keys, and supports clearing keys', async () => {
    const base = baseConfig(join(tempRoot, 'search.json'))
    const store = new SearchConfigStore(base)
    await store.load()

    const saved = await store.update({
      providerOrder: ['google-cse', 'brave', 'duckduckgo'],
      searxngUrl: 'http://searxng:8080',
      googleCseApiKey: 'AIzaFAKE1234567890',
      googleCseCx: 'cx-test',
      maxResults: 5,
    })
    expect(saved).toMatchObject({
      providerOrder: ['google-cse', 'brave', 'duckduckgo'],
      searxngUrl: 'http://searxng:8080',
      googleCseCx: 'cx-test',
      hasGoogleCseKey: true,
      googleCseKeyPreview: 'AIza…7890',
      maxResults: 5,
    })
    expect(JSON.stringify(saved)).not.toContain('AIzaFAKE1234567890')

    const reloaded = new SearchConfigStore(base)
    await reloaded.load()
    expect(reloaded.get().googleCseApiKey).toBe('AIzaFAKE1234567890')
    expect(reloaded.get().providerOrder).toEqual(['google-cse', 'brave', 'duckduckgo'])

    const cleared = await reloaded.update({ clearGoogleCseKey: true })
    expect(cleared.hasGoogleCseKey).toBe(false)
    expect(cleared.googleCseKeyPreview).toBe('')
  })

  it('persists Vertex AI Search settings and masks the Vertex key', async () => {
    const base = baseConfig(join(tempRoot, 'search-vertex.json'))
    const store = new SearchConfigStore(base)
    await store.load()

    const saved = await store.update({
      providerOrder: ['google-vertex'],
      googleVertexApiKey: 'AIzaVERTEXFAKE9876',
      googleVertexProjectId: 'my-gcp-project',
      googleVertexEngineId: 'my-search-app_1729',
    })
    expect(saved).toMatchObject({
      providerOrder: ['google-vertex'],
      googleVertexProjectId: 'my-gcp-project',
      googleVertexEngineId: 'my-search-app_1729',
      hasGoogleVertexKey: true,
      googleVertexKeyPreview: 'AIza…9876',
    })
    expect(JSON.stringify(saved)).not.toContain('AIzaVERTEXFAKE9876')

    const reloaded = new SearchConfigStore(base)
    await reloaded.load()
    expect(reloaded.get().googleVertexApiKey).toBe('AIzaVERTEXFAKE9876')
    expect(reloaded.get().providerOrder).toEqual(['google-vertex'])

    const cleared = await reloaded.update({ clearGoogleVertexKey: true })
    expect(cleared.hasGoogleVertexKey).toBe(false)
  })

  it('persists and masks the Brave Search key', async () => {
    const base = baseConfig(join(tempRoot, 'search-brave.json'))
    const store = new SearchConfigStore(base)
    await store.load()

    const saved = await store.update({ braveApiKey: 'BSAFAKEKEY8765' })
    expect(saved).toMatchObject({ hasBraveKey: true, braveKeyPreview: 'BSAF…8765' })
    expect(JSON.stringify(saved)).not.toContain('BSAFAKEKEY8765')

    const reloaded = new SearchConfigStore(base)
    await reloaded.load()
    expect(reloaded.get().braveApiKey).toBe('BSAFAKEKEY8765')

    const cleared = await reloaded.update({ clearBraveKey: true })
    expect(cleared.hasBraveKey).toBe(false)
  })

  it('migrates a legacy single-provider setting into a priority order', async () => {
    const path = join(tempRoot, 'search-legacy.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ provider: 'google-gemini', googleGeminiApiKey: 'AIzaOLD1234' }))
    const store = new SearchConfigStore(baseConfig(path))
    await store.load()
    expect(store.get().providerOrder[0]).toBe('google-gemini')
    expect(store.get().providerOrder).toContain('duckduckgo')
  })
})
