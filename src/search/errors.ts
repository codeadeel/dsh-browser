export class SearchBlockedError extends Error {
  readonly code = 'SEARCH_BLOCKED'
  readonly needsHuman = true

  constructor(message: string) {
    super(message)
    this.name = 'SearchBlockedError'
  }
}

export class SearchProviderError extends Error {
  readonly code = 'SEARCH_PROVIDER_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'SearchProviderError'
  }
}
