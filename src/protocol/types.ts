export interface SearchResult {
  title: string
  url: string
  snippet: string
  provider: string
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  provider: string
  tookMs: number
}

export interface BrowserLink {
  text: string
  href: string
}

export interface BrowserElement {
  id: string
  selector: string
  tag: string
  text: string
  type?: string
  href?: string
}

export interface BrowserSnapshot {
  url: string
  title: string
  text: string
  scrollX: number
  scrollY: number
  links: BrowserLink[]
  elements: BrowserElement[]
  capturedAt: string
}

export interface BrowserTab {
  index: number
  url: string
  title: string
  active: boolean
}

export interface SessionInfo {
  id: string
  mcpUrl: string
  profileDir: string
  createdAt: string
  lastActivityAt: string | null
  headless: boolean
  browserPid: number | null
  tabs: BrowserTab[]
}

export interface SessionCreateOptions {
  id?: string
  headless?: boolean
  keepProfile?: boolean
}

export interface BrowserSearchResult {
  title: string
  url: string
  snippet: string
}

export interface BrowserSearchResponse {
  query: string
  engine: 'google' | 'duckduckgo'
  results: BrowserSearchResult[]
  blocked: boolean
  pageUrl: string
  message?: string
}
