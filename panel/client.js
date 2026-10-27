/**
 * Direct CDP screencast panel.
 *
 * The browser service exposes a JPEG screencast plus CDP input on the viewer
 * port. This panel renders only the page pixels, not Chrome chrome, and floats
 * over the DSH UI. When closed it leaves only a small Browser button.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-panel',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const C = {
      panel: '#1b1c22',
      border: '#3a3d49',
      header: '#262833',
      text: '#e8eaf2',
      dim: '#9aa0ae',
      accent: '#4f9cf9',
      input: '#121318',
    }

    function viewerBase() {
      return '/dsh-browser/viewer'
    }

    function searchBase() {
      return '/dsh-browser/search'
    }

    function browserBase() {
      return '/dsh-browser/browser'
    }

    function smallButton(label, title, onClick) {
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        onClick,
        style: {
          background: 'transparent',
          color: C.dim,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: '3px 8px',
          fontSize: 12,
          lineHeight: 1.2,
          cursor: 'pointer',
          flexShrink: 0,
        },
      }, label)
    }

    const MIN_WIDTH = 360
    const MIN_HEIGHT = 260
    const SIZE_KEY = 'dsh-browser-panel-layout-v3'
    const DEFAULT_TOP = 52
    const DEFAULT_RIGHT = 16

    function defaultPanelLayout() {
      return {
        width: Math.min(560, Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.46))),
        height: Math.min(520, Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.55))),
        top: DEFAULT_TOP,
        right: DEFAULT_RIGHT,
      }
    }

    function loadPanelLayout() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(SIZE_KEY) || 'null')
        if (raw && Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
          return {
            width: Math.max(MIN_WIDTH, Math.min(window.innerWidth - 32, raw.width)),
            height: Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 32, raw.height)),
            top: Number.isFinite(raw.top) ? Math.max(8, Math.min(window.innerHeight - MIN_HEIGHT - 8, raw.top)) : DEFAULT_TOP,
            right: Number.isFinite(raw.right) ? Math.max(8, Math.min(window.innerWidth - MIN_WIDTH - 8, raw.right)) : DEFAULT_RIGHT,
          }
        }
      } catch {
        // Ignore corrupt storage and use the default.
      }
      return defaultPanelLayout()
    }

    function savePanelLayout(layout) {
      try {
        window.localStorage.setItem(SIZE_KEY, JSON.stringify({
          width: Math.round(layout.width),
          height: Math.round(layout.height),
          top: Math.round(layout.top),
          right: Math.round(layout.right),
        }))
      } catch {
        // Storage is optional.
      }
    }

/**
 * Ranked search-provider settings. Top row is searched first; unconfigured
 * providers are skipped. This file replaces the old SearchSettings inline
 * component (see client.js for where it is spliced in).
 */
const SEARCH_PROVIDER_ROWS = [
  { id: 'searxng', name: 'SearXNG', desc: 'Self-hosted meta-search · free, no key' },
  { id: 'google-cse', name: 'Google Programmable Search', desc: 'Legacy JSON API · key + cx' },
  { id: 'google-gemini', name: 'Google Gemini Search', desc: 'Whole-web grounding · official · key' },
  { id: 'brave', name: 'Brave Search API', desc: 'Independent web index · key' },
  { id: 'google-vertex', name: 'Google Vertex AI Search', desc: 'Site-scoped app search · key' },
  { id: 'duckduckgo', name: 'DuckDuckGo', desc: 'Free fallback · always available' },
]

function SearchSettings() {
  const [order, setOrder] = useState(SEARCH_PROVIDER_ROWS.map(row => row.id))
  const [expanded, setExpanded] = useState({})
  const [form, setForm] = useState({
    searxngUrl: '',
    googleCseApiKey: '',
    googleCseCx: '',
    googleGeminiApiKey: '',
    googleGeminiModel: 'gemini-3.8-flash',
    braveApiKey: '',
    googleVertexApiKey: '',
    googleVertexProjectId: '',
    googleVertexEngineId: '',
    maxResults: 8,
  })
  const [keys, setKeys] = useState({})
  const [status, setStatus] = useState('loading…')
  const [testQuery, setTestQuery] = useState('DeepSeek Harness')
  const [testResult, setTestResult] = useState(null)
  const [stackUrl, setStackUrl] = useState('')
  const [stackStatus, setStackStatus] = useState('')

  const applyConfig = config => {
    const configured = Array.isArray(config.providerOrder) ? config.providerOrder : []
    const merged = []
    for (const id of configured) if (!merged.includes(id) && SEARCH_PROVIDER_ROWS.some(row => row.id === id)) merged.push(id)
    for (const row of SEARCH_PROVIDER_ROWS) if (!merged.includes(row.id)) merged.push(row.id)
    setOrder(merged)
    setForm({
      searxngUrl: config.searxngUrl ?? '',
      googleCseApiKey: '',
      googleCseCx: config.googleCseCx ?? '',
      googleGeminiApiKey: '',
      googleGeminiModel: config.googleGeminiModel ?? 'gemini-3.8-flash',
      braveApiKey: '',
      googleVertexApiKey: '',
      googleVertexProjectId: config.googleVertexProjectId ?? '',
      googleVertexEngineId: config.googleVertexEngineId ?? '',
      maxResults: config.maxResults ?? 8,
    })
    setKeys({
      cse: { has: config.hasGoogleCseKey === true, preview: config.googleCseKeyPreview ?? '' },
      gemini: { has: config.hasGoogleGeminiKey === true, preview: config.googleGeminiKeyPreview ?? '' },
      brave: { has: config.hasBraveKey === true, preview: config.braveKeyPreview ?? '', mcp: config.braveMcpConfigured === true },
      vertex: { has: config.hasGoogleVertexKey === true, preview: config.googleVertexKeyPreview ?? '' },
    })
    const parts = []
    if (config.hasGoogleCseKey) parts.push(`CSE key ${config.googleCseKeyPreview}`)
    if (config.hasGoogleGeminiKey) parts.push(`Gemini key ${config.googleGeminiKeyPreview}`)
    if (config.hasBraveKey) parts.push(`Brave key ${config.braveKeyPreview}`)
    if (config.hasGoogleVertexKey) parts.push(`Vertex key ${config.googleVertexKeyPreview}`)
    setStatus(parts.length > 0 ? `Saved keys: ${parts.join(' · ')}` : 'No keys saved yet')
  }

  const loadTarget = async () => {
    try {
      let response = await fetch('/dsh-browser/gateway-target')
      if (response.status === 404) response = await fetch('/dsh-browser/search-target')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const url = typeof body.gatewayUrl === 'string' ? body.gatewayUrl : body.searchUrl
      if (typeof url === 'string') setStackUrl(url)
    } catch (error) {
      setStackStatus(`Gateway URL unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveStackUrl = async () => {
    setStackStatus('saving…')
    try {
      let response = await fetch('/dsh-browser/gateway-target', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gatewayUrl: stackUrl.trim() }),
      })
      if (response.status === 404) {
        response = await fetch('/dsh-browser/search-target', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ searchUrl: stackUrl.trim() }),
        })
      }
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      // Probe the new target through the proxy.
      const probe = await fetch('/dsh-browser/search/health').then(r => r.json()).catch(() => ({}))
      if (probe.ok === true) {
        setStackStatus('Saved · gateway reachable')
      } else {
        setStackStatus('Saved · gateway unreachable — check the address')
      }
      void reload()
    } catch (error) {
      setStackStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reload = async () => {
    try {
      const response = await fetch(`${searchBase()}/config`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      applyConfig(await response.json())
    } catch (error) {
      setStatus(`Search settings unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  useEffect(() => {
    let cancelled = false
    void loadTarget()
    void fetch(`${searchBase()}/config`)
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then(config => { if (!cancelled) applyConfig(config) })
      .catch(error => {
        if (!cancelled) setStatus(`Search settings unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => { cancelled = true }
  }, [])

  const setField = (name, value) => setForm(previous => ({ ...previous, [name]: value }))

  const move = (id, direction) => {
    setOrder(previous => {
      const next = [...previous]
      const index = next.indexOf(id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= next.length) return previous
      next.splice(index, 1)
      next.splice(target, 0, id)
      return next
    })
  }

  const save = async () => {
    setStatus('saving…')
    try {
      const body = {
        providerOrder: order,
        searxngUrl: form.searxngUrl,
        googleCseCx: form.googleCseCx,
        googleGeminiModel: form.googleGeminiModel,
        googleVertexProjectId: form.googleVertexProjectId,
        googleVertexEngineId: form.googleVertexEngineId,
        maxResults: Number(form.maxResults),
        ...(form.googleCseApiKey.trim() === '' ? {} : { googleCseApiKey: form.googleCseApiKey.trim() }),
        ...(form.googleGeminiApiKey.trim() === '' ? {} : { googleGeminiApiKey: form.googleGeminiApiKey.trim() }),
        ...(form.braveApiKey.trim() === '' ? {} : { braveApiKey: form.braveApiKey.trim() }),
        ...(form.googleVertexApiKey.trim() === '' ? {} : { googleVertexApiKey: form.googleVertexApiKey.trim() }),
      }
      const response = await fetch(`${searchBase()}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      applyConfig(result)
      const parts = []
      if (result.hasGoogleCseKey) parts.push(`CSE ${result.googleCseKeyPreview}`)
      if (result.hasGoogleGeminiKey) parts.push(`Gemini ${result.googleGeminiKeyPreview}`)
      if (result.hasBraveKey) parts.push(`Brave ${result.braveKeyPreview}`)
      if (result.hasGoogleVertexKey) parts.push(`Vertex ${result.googleVertexKeyPreview}`)
      setStatus(parts.length > 0 ? `Saved. ${parts.join(' · ')}` : 'Saved. No keys set')
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const clearKey = async (field) => {
    setStatus('clearing…')
    try {
      const response = await fetch(`${searchBase()}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: true }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
      applyConfig(result)
      setStatus('Key cleared')
    } catch (error) {
      setStatus(`Clear failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const test = async () => {
    setTestResult({ status: 'testing…' })
    try {
      const response = await fetch(`${searchBase()}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: testQuery }),
      })
      setTestResult(await response.json())
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const labelStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500 }
  const inputStyle = {
    height: 34,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    padding: '0 10px',
  }
  const primaryButton = {
    height: 34,
    padding: '0 16px',
    border: 'none',
    borderRadius: 8,
    background: '#4f9cf9',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  }
  const secondaryButton = {
    height: 34,
    padding: '0 16px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    cursor: 'pointer',
  }
  const field = (label, control) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('span', { style: labelStyle }, label),
    control,
  )

  const keyField = (id, value, placeholder, saved) => h('input', {
    type: 'password',
    value,
    placeholder: saved ? 'leave blank to keep saved key' : placeholder,
    onChange: event => { const v = event.currentTarget.value; setField(id, v) },
    style: inputStyle,
  })

  const providerFields = (row) => {
    if (row.id === 'searxng') {
      return field('SearXNG URL', h('input', {
        value: form.searxngUrl,
        placeholder: 'http://searxng:8080',
        onChange: event => { const v = event.currentTarget.value; setField('searxngUrl', v) },
        style: inputStyle,
      }))
    }
    if (row.id === 'google-cse') {
      return [
        field('Google API key', keyField('googleCseApiKey', form.googleCseApiKey, 'paste Google API key', keys.cse?.has)),
        field('Search engine ID (cx)', h('input', {
          value: form.googleCseCx,
          placeholder: 'cx id',
          onChange: event => { const v = event.currentTarget.value; setField('googleCseCx', v) },
          style: inputStyle,
        })),
        keys.cse?.has ? h('button', { type: 'button', onClick: () => clearKey('clearGoogleCseKey'), style: secondaryButton }, 'Clear key') : null,
      ]
    }
    if (row.id === 'google-gemini') {
      return [
        field('AI Studio API key', keyField('googleGeminiApiKey', form.googleGeminiApiKey, 'paste AI Studio key', keys.gemini?.has)),
        field('Model', h('input', {
          value: form.googleGeminiModel,
          placeholder: 'gemini-3.8-flash',
          onChange: event => { const v = event.currentTarget.value; setField('googleGeminiModel', v) },
          style: inputStyle,
        })),
        keys.gemini?.has ? h('button', { type: 'button', onClick: () => clearKey('clearGoogleGeminiKey'), style: secondaryButton }, 'Clear key') : null,
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.4 } },
          'This key is used directly against the Gemini API. Move Gemini to the top of the provider order to force it; the first provider that returns results wins.'),
      ]
    }
    if (row.id === 'brave') {
      return [
        field('Subscription token', keyField('braveApiKey', form.braveApiKey, 'paste Brave subscription token', keys.brave?.has)),
        keys.brave?.has ? h('button', { type: 'button', onClick: () => clearKey('clearBraveKey'), style: secondaryButton }, 'Clear key') : null,
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: 1.4 } },
          'A UI key uses Brave REST immediately. For the compose brave-mcp service, set BRAVE_API_KEY in the stack .env before docker compose up, then restart brave-mcp.'),
      ]
    }
    if (row.id === 'google-vertex') {
      return [
        field('Cloud API key', keyField('googleVertexApiKey', form.googleVertexApiKey, 'paste Google Cloud API key', keys.vertex?.has)),
        field('Project ID', h('input', {
          value: form.googleVertexProjectId,
          placeholder: 'your-gcp-project',
          onChange: event => { const v = event.currentTarget.value; setField('googleVertexProjectId', v) },
          style: inputStyle,
        })),
        field('Engine (app) ID', h('input', {
          value: form.googleVertexEngineId,
          placeholder: 'app id from AI Applications',
          onChange: event => { const v = event.currentTarget.value; setField('googleVertexEngineId', v) },
          style: inputStyle,
        })),
        keys.vertex?.has ? h('button', { type: 'button', onClick: () => clearKey('clearGoogleVertexKey'), style: secondaryButton }, 'Clear key') : null,
      ]
    }
    return h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, 'Always available — no configuration.')
  }

  const rowStatus = (row) => {
    if (row.id === 'searxng') return form.searxngUrl.trim() === '' ? 'needs URL' : 'ready'
    if (row.id === 'duckduckgo') return 'always on'
    if (row.id === 'brave') {
      if (keys.brave?.has) return `key ${keys.brave.preview} · REST`
      if (keys.brave?.mcp) return 'mcp service · stack key'
    }
    const keyed = { 'google-cse': keys.cse, 'google-gemini': keys.gemini, brave: keys.brave, 'google-vertex': keys.vertex }[row.id]
    return keyed?.has ? `key ${keyed.preview}` : 'needs key'
  }

  return h('div', {
    'data-dsh-search-settings': 'true',
    style: { padding: '24px 0', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14 },
  },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('h2', { style: { margin: 0, color: 'var(--dsw-alias-label-primary)', fontSize: 18 } }, 'Search providers'),
      h('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 } },
        'Searched top to bottom; the first provider that returns results wins. Unconfigured providers are skipped automatically. Keys are stored on the search gateway, never returned in full.'),
    ),
    h('div', {
      style: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-module-platform)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
    },
      h('span', { style: labelStyle }, 'Stack gateway address'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('input', {
          value: stackUrl,
          placeholder: 'http://127.0.0.1:8787',
          spellCheck: false,
          onChange: event => { const v = event.currentTarget.value; setStackUrl(v) },
          style: { ...inputStyle, flex: 1 },
        }),
        h('button', { type: 'button', onClick: saveStackUrl, style: primaryButton }, 'Save'),
      ),
      h('span', {
        style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
      }, stackStatus || 'Enter one URL. Use http://127.0.0.1:8787 when the backend is on this host; otherwise use its reachable gateway URL.'),
    ),
    ...order.map((id, index) => {
      const row = SEARCH_PROVIDER_ROWS.find(entry => entry.id === id)
      if (!row) return null
      const isOpen = expanded[row.id] === true
      return h('div', {
        key: row.id,
        'data-search-row': row.id,
        style: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-module-platform)',
          overflow: 'hidden',
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' },
        },
          h('span', {
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, width: 18, flexShrink: 0 },
          }, String(index + 1)),
          h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0, cursor: 'pointer' }, onClick: () => setExpanded(previous => ({ ...previous, [row.id]: !previous[row.id] })) },
            h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600 } }, row.name),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } }, row.desc),
          ),
          h('span', {
            style: {
              color: rowStatus(row) === 'needs key' || rowStatus(row) === 'needs URL' ? '#c9a227' : '#3fbf6e',
              fontSize: 11,
              flexShrink: 0,
            },
          }, rowStatus(row)),
          h('button', { type: 'button', title: 'Move up (search earlier)', onClick: () => move(row.id, -1), style: secondaryButton }, '↑'),
          h('button', { type: 'button', title: 'Move down (search later)', onClick: () => move(row.id, 1), style: secondaryButton }, '↓'),
        ),
        isOpen ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
          ...(Array.isArray(providerFields(row)) ? providerFields(row) : [providerFields(row)]),
        ) : null,
      )
    }),
    h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, minHeight: 18 } }, status),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
      h('button', { type: 'button', onClick: save, style: primaryButton }, 'Save'),
      h('button', { type: 'button', onClick: test, style: secondaryButton }, 'Test search'),
      h('input', {
        value: testQuery,
        onChange: event => { const v = event.currentTarget.value; setTestQuery(v) },
        placeholder: 'test query',
        style: { ...inputStyle, flex: 1, minWidth: 200 },
      }),
      h('span', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 } },
        'Max',
        h('input', {
          type: 'number',
          min: 1,
          max: 20,
          value: form.maxResults,
          onChange: event => { const v = Number(event.currentTarget.value); setField('maxResults', Number.isFinite(v) ? v : 8) },
          style: { ...inputStyle, width: 64 },
        }),
      ),
    ),
    testResult ? h('pre', {
      style: {
        margin: 0,
        padding: 12,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        maxHeight: 260,
        overflow: 'auto',
      },
    }, JSON.stringify(testResult, null, 2).slice(0, 4000)) : null,
  )
}

    function BrowserPanel() {
      const [open, setOpen] = useState(false)
      const [sessionsList, setSessionsList] = useState([])
      const [sessionId, setSessionId] = useState('')
      const [frame, setFrame] = useState(null)
      const [status, setStatus] = useState('idle')
      const [addr, setAddr] = useState('')
      const [nonce, setNonce] = useState(0)
      const [tabs, setTabs] = useState([])
      const [transport, setTransport] = useState('connecting')
      const [maximized, setMaximized] = useState(false)
      const [layout, setLayout] = useState(loadPanelLayout)
      const resizeRef = useRef(null)
      const imgRef = useRef(null)
      const addrFocused = useRef(false)
      const held = useRef(new Map())
      const inputChain = useRef(Promise.resolve())
      const lastMove = useRef(0)
      const lastWheel = useRef(0)
      const wsRef = useRef(null)
      const wsReady = useRef(false)
      const wsRetry = useRef(0)
      const manualSelect = useRef(false)

      useEffect(() => {
        savePanelLayout(layout)
      }, [layout])

      // Find the active browser session from the viewer service.
      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        const discover = async () => {
          try {
            const response = await fetch(`${viewerBase()}/sessions`)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            const list = Array.isArray(body.sessions) ? body.sessions : []
            if (!cancelled) {
              setSessionsList(list)
              const mostRecent = [...list].sort((a, b) =>
                String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')))[0]
              if (mostRecent?.id) {
                setSessionId(previous => {
                  if (previous && list.some(row => row.id === previous)) return previous
                  if (manualSelect.current) return previous || mostRecent.id
                  return mostRecent.id
                })
                setStatus('connected')
              } else {
                setStatus('no session')
              }
            }
          } catch (error) {
            if (!cancelled) setStatus(error instanceof Error ? error.message : String(error))
          }
        }
        void discover()
        const timer = window.setInterval(() => { void discover() }, 5000)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [open])

      // Screencast feed.
      useEffect(() => {
        if (!open || !sessionId) return undefined
        const source = new EventSource(`${viewerBase()}/sessions/${encodeURIComponent(sessionId)}/stream`)
        source.addEventListener('frame', event => {
          try {
            const payload = JSON.parse(event.data)
            setFrame(payload)
            setStatus('live')
            if (!addrFocused.current && payload.url) setAddr(payload.url)
          } catch {
            // Ignore malformed frames; the next frame recovers.
          }
        })
        source.addEventListener('state', event => {
          try {
            const payload = JSON.parse(event.data)
            if (!addrFocused.current && payload.tabs) {
              const active = payload.tabs.find(tab => tab.active)
              if (active?.url) setAddr(active.url)
            }
          } catch {
            // Ignore malformed state.
          }
        })
        source.addEventListener('tabs', event => {
          try {
            const payload = JSON.parse(event.data)
            if (Array.isArray(payload)) {
              setTabs(payload)
              const active = payload.find(tab => tab.active)
              if (active?.url && !addrFocused.current) setAddr(active.url)
            }
          } catch {
            // Ignore malformed tab rows.
          }
        })
        source.onerror = () => setStatus('reconnecting')
        return () => source.close()
      }, [open, sessionId, nonce])

      // Low-latency WebSocket input channel, with HTTP fallback.
      useEffect(() => {
        if (!open || !sessionId) return undefined
        let closed = false
        let timer
        const connect = () => {
          if (closed) return
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
          const ws = new WebSocket(`${protocol}//${window.location.host}/dsh-browser/ws?session=${encodeURIComponent(sessionId)}`)
          wsRef.current = ws
          wsReady.current = false
          ws.onopen = () => {
            wsReady.current = true
            wsRetry.current = 0
            setTransport('ws')
          }
          ws.onmessage = () => {
            // Ack frames from the viewer; errors surface through the status dot.
          }
          ws.onclose = () => {
            wsReady.current = false
            setTransport('http')
            if (wsRef.current === ws) wsRef.current = null
            if (!closed) {
              wsRetry.current += 1
              timer = window.setTimeout(connect, Math.min(1000 * 2 ** (wsRetry.current - 1), 10_000))
            }
          }
          ws.onerror = () => {
            try {
              ws.close()
            } catch {
              // Closing an already-failed socket is a no-op.
            }
          }
        }
        connect()
        return () => {
          closed = true
          window.clearTimeout(timer)
          try {
            wsRef.current?.close()
          } catch {
            // Ignore close errors during teardown.
          }
          wsRef.current = null
          wsReady.current = false
        }
      }, [open, sessionId, nonce])

      const post = (path, body) => {
        void fetch(`${viewerBase()}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      }

      const createSession = async () => {
        try {
          const response = await fetch(`${browserBase()}/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const created = await response.json()
          if (!response.ok) throw new Error(created.error || `HTTP ${response.status}`)
          if (created.id) {
            manualSelect.current = true
            setSessionId(created.id)
            setFrame(null)
            setStatus('connected')
            setNonce(value => value + 1)
          }
        } catch (error) {
          setStatus(`New session failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const tabAction = (action, index, url) => {
        if (!sessionId) return
        setFrame(null)
        post(`/sessions/${encodeURIComponent(sessionId)}/tabs`, {
          action,
          ...(index === undefined ? {} : { index }),
          ...(url === undefined ? {} : { url }),
        })
        setTimeout(() => imgRef.current?.focus(), 0)
      }

      const point = (clientX, clientY) => {
        const img = imgRef.current
        if (!img || !frame || frame.width <= 0 || frame.height <= 0) return null
        const rect = img.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null

        // The screen is rendered with object-fit: contain. Remove letterbox
        // offsets, then convert display pixels to the page viewport (the
        // coordinate space CDP Input expects), not the screencast resolution.
        const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
        const shownWidth = frame.width * scale
        const shownHeight = frame.height * scale
        const offsetX = (rect.width - shownWidth) / 2
        const offsetY = (rect.height - shownHeight) / 2
        const localX = clientX - rect.left - offsetX
        const localY = clientY - rect.top - offsetY
        if (localX < 0 || localY < 0 || localX > shownWidth || localY > shownHeight) return null

        const viewportWidth = frame.viewportWidth || frame.width
        const viewportHeight = frame.viewportHeight || frame.height
        return {
          x: localX / shownWidth * viewportWidth,
          y: localY / shownHeight * viewportHeight,
        }
      }

      const sendInput = events => {
        if (!sessionId || events.length === 0) return
        const run = inputChain.current.then(async () => {
          const ws = wsRef.current
          if (ws && wsReady.current && ws.readyState === 1) {
            ws.send(JSON.stringify(events.length === 1 ? events[0] : { events }))
            return
          }
          await fetch(`${viewerBase()}/sessions/${encodeURIComponent(sessionId)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(events.length === 1 ? events[0] : { events }),
          })
        }).catch(() => undefined)
        inputChain.current = run
      }

      const modifierBits = event =>
        (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

      const mouseBase = event => {
        const p = point(event.clientX, event.clientY)
        if (!p) return null
        return {
          x: p.x,
          y: p.y,
          button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
          clickCount: Math.min(Math.max(event.detail || 1, 1), 3),
          modifiers: modifierBits(event),
        }
      }

      const onMouseDown = event => {
        const base = mouseBase(event)
        if (!base) return
        event.preventDefault()
        imgRef.current?.focus()
        sendInput([
          { type: 'mouse-move', x: base.x, y: base.y, modifiers: base.modifiers },
          { type: 'mouse-down', ...base },
        ])
      }

      const onMouseUp = event => {
        const base = mouseBase(event)
        if (!base) return
        event.preventDefault()
        sendInput([{ type: 'mouse-up', ...base }])
      }

      const onMouseMove = event => {
        if (event.buttons === 0) return
        const now = performance.now()
        if (now - lastMove.current < 25) return
        lastMove.current = now
        const base = mouseBase(event)
        if (!base) return
        sendInput([{ type: 'mouse-move', x: base.x, y: base.y, modifiers: base.modifiers }])
      }

      const keyText = (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return undefined
        if (event.key === 'Enter') return '\r'
        return event.key.length === 1 ? event.key : undefined
      }

      const onKeyDown = event => {
        if (!sessionId) return
        if (!event.repeat && event.code) held.current.set(event.code, event.key)
        const text = keyText(event)
        sendInput([{
          type: 'key-down',
          key: event.key,
          code: event.code,
          ...(text === undefined ? {} : { text }),
          modifiers: modifierBits(event),
        }])
        event.preventDefault()
        event.stopPropagation()
      }

      const onKeyUp = event => {
        if (!sessionId) return
        event.preventDefault()
        event.stopPropagation()
        held.current.delete(event.code)
        sendInput([{ type: 'key-up', key: event.key, code: event.code, modifiers: modifierBits(event) }])
      }

      const onBlur = () => {
        const releases = []
        for (const [code, key] of held.current) releases.push({ type: 'key-up', key, code, modifiers: 0 })
        sendInput(releases)
        held.current.clear()
      }

      const startResize = (event, direction) => {
        if (maximized) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        resizeRef.current = {
          direction,
          startX: event.clientX,
          startY: event.clientY,
          layout: { ...layout },
        }
        document.body.classList.add('dsh-browser-panel-resizing')
      }

      const moveResize = event => {
        const start = resizeRef.current
        if (!start) return
        const dx = event.clientX - start.startX
        const dy = event.clientY - start.startY
        const direction = start.direction
        let width = start.layout.width
        let height = start.layout.height
        let top = start.layout.top
        let right = start.layout.right

        if (direction.includes('e')) {
          const left = window.innerWidth - start.layout.right - start.layout.width
          width = Math.max(MIN_WIDTH, Math.min(window.innerWidth - left - 8, start.layout.width + dx))
          right = window.innerWidth - left - width
        }
        if (direction.includes('w')) {
          width = Math.max(MIN_WIDTH, Math.min(window.innerWidth - start.layout.right - 8, start.layout.width - dx))
        }
        if (direction.includes('s')) {
          height = Math.max(MIN_HEIGHT, Math.min(window.innerHeight - start.layout.top - 8, start.layout.height + dy))
        }
        if (direction.includes('n')) {
          const bottom = start.layout.top + start.layout.height
          top = Math.max(8, Math.min(bottom - MIN_HEIGHT, start.layout.top + dy))
          height = bottom - top
        }

        setLayout({ width, height, top, right })
      }

      const endResize = event => {
        if (!resizeRef.current) return
        resizeRef.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        document.body.classList.remove('dsh-browser-panel-resizing')
      }

      const closePanel = () => {
        setOpen(false)
        setMaximized(false)
      }

      const go = event => {
        event.preventDefault()
        const value = addr.trim()
        if (!value || !sessionId) return
        post(`/sessions/${encodeURIComponent(sessionId)}/goto`, { url: value })
        setTimeout(() => {
          setNonce(value => value + 1)
          imgRef.current?.focus()
        }, 500)
      }

      if (!open) {
        return ReactDOM.createPortal(
          h('button', {
            type: 'button',
            'data-dsh-browser-panel': 'button',
            title: 'Open live browser',
            onClick: () => {
              manualSelect.current = false
              setOpen(true)
            },
            style: {
              position: 'fixed',
              top: 8,
              right: 56,
              zIndex: 400,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 32,
              padding: '0 12px',
              borderRadius: 16,
              border: `1px solid ${C.border}`,
              background: C.header,
              color: C.text,
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: '0 4px 18px rgba(0,0,0,0.25)',
            },
          },
            h('span', {
              style: { width: 7, height: 7, borderRadius: '50%', background: '#3fbf6e' },
            }),
            'Browser',
          ),
          document.body,
        )
      }

      const needsHuman = !!frame?.url && /google\.[^/]+\/sorry|consent\.google\.|\/captcha|challenge/i.test(frame.url)
      const panelStyle = maximized
        ? {
          position: 'fixed',
          top: 16,
          left: 16,
          right: 16,
          bottom: 16,
          zIndex: 400,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }
        : {
          position: 'fixed',
          top: layout.top,
          right: layout.right,
          width: layout.width,
          height: layout.height,
          zIndex: 400,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }

      return ReactDOM.createPortal(
        h('div', {
          'data-dsh-browser-panel': 'open',
          'data-maximized': maximized ? 'true' : 'false',
          style: panelStyle,
        },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 9px',
              background: C.header,
              borderBottom: `1px solid ${C.border}`,
            },
          },
            h('span', {
              style: { width: 7, height: 7, borderRadius: '50%', background: status === 'live' ? '#3fbf6e' : '#c9a227' },
              title: status,
            }),
            h('select', {
              value: sessionId,
              title: 'Browser session',
              'aria-label': 'Browser session',
              onChange: event => {
                const value = event.currentTarget.value
                manualSelect.current = true
                setSessionId(value)
                setFrame(null)
                setNonce(n => n + 1)
              },
              style: {
                flex: 1,
                minWidth: 0,
                height: 26,
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: C.input,
                color: C.text,
                fontSize: 11,
                padding: '0 4px',
              },
            },
              ...sessionsList.map(row => h('option', { key: row.id, value: row.id }, row.id)),
              ...(sessionId && !sessionsList.some(row => row.id === sessionId)
                ? [h('option', { key: sessionId, value: sessionId }, sessionId)]
                : []),
            ),
            smallButton('+', 'New browser session', createSession),
            smallButton('⟳', 'Reconnect viewer', () => { setFrame(null); setNonce(value => value + 1) }),
            smallButton(maximized ? '⤡' : '⤢', maximized ? 'Restore browser panel' : 'Maximize browser over chat', () => setMaximized(value => !value)),
            smallButton('×', 'Close browser panel', closePanel),
          ),
          h('form', {
            onSubmit: go,
            style: { display: 'flex', gap: 6, padding: '6px 8px', borderBottom: `1px solid ${C.border}` },
          },
            h('input', {
              value: addr,
              placeholder: 'https://… or search',
              spellCheck: false,
              onFocus: () => { addrFocused.current = true },
              onBlur: () => { addrFocused.current = false },
              onChange: event => { const value = event.currentTarget.value; setAddr(value) },
              style: {
                flex: 1,
                minWidth: 0,
                height: 28,
                padding: '0 8px',
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: C.input,
                color: C.text,
                fontSize: 12,
                outline: 'none',
              },
            }),
            h('button', {
              type: 'submit',
              style: {
                height: 28,
                padding: '0 10px',
                border: 'none',
                borderRadius: 6,
                background: C.accent,
                color: '#fff',
                fontSize: 12,
                cursor: 'pointer',
              },
            }, 'Go'),
          ),
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderBottom: `1px solid ${C.border}`,
              background: C.panel,
              overflowX: 'auto',
              flexShrink: 0,
              minHeight: 32,
            },
          },
            ...tabs.map(tab => h('div', {
              key: tab.index,
              title: tab.url,
              onClick: () => tabAction('select', tab.index),
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 150,
                padding: '3px 4px 3px 8px',
                borderRadius: 6,
                background: tab.active ? '#3a3d49' : 'transparent',
                color: tab.active ? C.text : C.dim,
                fontSize: 11,
                cursor: 'pointer',
                flexShrink: 0,
              },
            },
              h('span', {
                style: { maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, tab.title || tab.url || `Tab ${tab.index + 1}`),
              h('button', {
                type: 'button',
                title: 'Close tab',
                onClick: event => {
                  event.stopPropagation()
                  tabAction('close', tab.index)
                },
                style: {
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  padding: '0 2px',
                  cursor: 'pointer',
                  fontSize: 12,
                  lineHeight: 1,
                },
              }, '×'),
            )),
            h('button', {
              type: 'button',
              title: 'New tab',
              onClick: () => tabAction('new'),
              style: {
                background: 'transparent',
                color: C.dim,
                border: `1px solid ${C.border}`,
                borderRadius: 5,
                padding: '2px 7px',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              },
            }, '+'),
          ),
          needsHuman ? h('div', {
            'data-human-check': 'true',
            style: {
              padding: '7px 10px',
              background: '#3a2f12',
              color: '#f0c674',
              fontSize: 11,
              lineHeight: 1.4,
              borderBottom: `1px solid ${C.border}`,
              flexShrink: 0,
            },
          }, 'Human verification likely. Take over in this panel, finish the check, then ask the agent to continue.') : null,
          h('div', {
            style: {
              flex: 1,
              minHeight: 0,
              background: '#0d0e12',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            },
          },
            frame
              ? h('img', {
                ref: imgRef,
                src: `data:image/jpeg;base64,${frame.data}`,
                alt: 'Live browser page',
                tabIndex: 0,
                draggable: false,
                onMouseDown,
                onMouseUp,
                onMouseMove,
                onContextMenu: event => event.preventDefault(),
                onWheel: event => {
                  const now = performance.now()
                  if (now - lastWheel.current < 20) return
                  lastWheel.current = now
                  const base = mouseBase(event)
                  if (!base) return
                  const factor = event.deltaMode === 1 ? 120 : event.deltaMode === 2 ? 600 : 1
                  sendInput([{
                    type: 'wheel', x: base.x, y: base.y,
                    deltaX: Math.round(event.deltaX * factor),
                    deltaY: Math.round(event.deltaY * factor),
                    modifiers: base.modifiers,
                  }])
                },
                onKeyDown,
                onKeyUp,
                onBlur,
                style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block', cursor: 'crosshair' },
              })
              : h('span', { style: { color: C.dim, fontSize: 12 } }, status === 'no session' ? 'No browser session' : 'Waiting for browser frame…'),
          ),
          h('div', {
            style: {
              padding: '5px 9px',
              color: C.dim,
              fontSize: 11,
              borderTop: `1px solid ${C.border}`,
            },
          }, status === 'live' ? `Shared page • click or type to take over • input: ${transport}` : `Viewer: ${status}`),
          maximized ? null : [
            ['n', { top: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' }],
            ['s', { bottom: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' }],
            ['e', { top: 12, right: 0, bottom: 12, width: 6, cursor: 'ew-resize' }],
            ['w', { top: 12, left: 0, bottom: 12, width: 6, cursor: 'ew-resize' }],
            ['ne', { top: 0, right: 0, width: 12, height: 12, cursor: 'nesw-resize' }],
            ['nw', { top: 0, left: 0, width: 12, height: 12, cursor: 'nwse-resize' }],
            ['se', { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' }],
            ['sw', { bottom: 0, left: 0, width: 12, height: 12, cursor: 'nesw-resize' }],
          ].map(([direction, position]) => h('div', {
            key: direction,
            title: `Drag to resize (${direction})`,
            'aria-label': `Resize browser panel ${direction}`,
            'data-resize-handle': direction,
            onPointerDown: event => startResize(event, direction),
            onPointerMove: moveResize,
            onPointerUp: endResize,
            onPointerCancel: endResize,
            style: {
              position: 'absolute',
              zIndex: 3,
              touchAction: 'none',
              ...position,
            },
          })),
        ),
        document.body,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-browser-panel',
        order: 60,
      }, BrowserPanel))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-browser-panel',
      }, SearchSettings))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
