import type { Page } from 'puppeteer-core'
import type { BrowserElement, BrowserSearchResult, BrowserSnapshot } from '../protocol/types.js'

/** Page-side snapshot: text, links, and the numbered interactive inventory. */
export async function collectSnapshot(page: Page): Promise<Omit<BrowserSnapshot, 'capturedAt'>> {
  return page.evaluate(() => {
    const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()
    const isVisible = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }

    const elements: BrowserElement[] = []
    let counter = 0
    const interactive = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]',
    )
    for (const element of interactive) {
      if (counter >= 150) break
      if (!isVisible(element)) continue
      counter += 1
      const id = `e${counter}`
      element.setAttribute('data-dsh-id', id)
      const tag = element.tagName.toLowerCase()
      const rawText =
        (element as HTMLInputElement).value
        || (element as HTMLInputElement).placeholder
        || element.innerText
        || element.textContent
        || element.getAttribute('aria-label')
        || ''
      const text = clean(rawText).slice(0, 200)
      const type = tag === 'input' || tag === 'button' ? (element as HTMLInputElement).type : undefined
      const href = element instanceof HTMLAnchorElement ? element.href : undefined
      elements.push({
        id,
        selector: `[data-dsh-id="${id}"]`,
        tag,
        text,
        ...(type ? { type } : {}),
        ...(href ? { href } : {}),
      })
    }

    const links: Array<{ text: string; href: string }> = []
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const text = clean(anchor.innerText || anchor.textContent || '').slice(0, 160)
      if (text && anchor.href) links.push({ text, href: anchor.href })
      if (links.length >= 50) break
    }

    return {
      url: window.location.href,
      title: document.title,
      text: clean(document.body?.innerText ?? '').slice(0, 12_000),
      scrollX: window.scrollX ?? 0,
      scrollY: window.scrollY ?? 0,
      links,
      elements,
    }
  })
}

export interface ElementMatch {
  id: string
  tag: string
  text: string
  href?: string
  x: number
  y: number
  width: number
  height: number
}

/** Enumerate visible matches for a CSS selector, assigning snapshot ids. */
export async function collectMatches(page: Page, selector: string, limit: number): Promise<ElementMatch[]> {
  return page.evaluate(({ sel, limit }) => {
    const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()
    const rows: ElementMatch[] = []
    let counter = 0
    const nodes = document.querySelectorAll(sel)
    for (let index = 0; index < nodes.length && rows.length < limit; index++) {
      const element = nodes[index] as HTMLElement
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      if (!visible) continue
      counter += 1
      const id = `e${counter}`
      element.setAttribute('data-dsh-id', id)
      const rawText =
        (element as HTMLInputElement).value
        || element.innerText
        || element.textContent
        || element.getAttribute('aria-label')
        || ''
      rows.push({
        id,
        tag: element.tagName.toLowerCase(),
        text: clean(rawText).slice(0, 200),
        ...(element instanceof HTMLAnchorElement ? { href: element.href } : {}),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
    return rows
  }, { sel: selector, limit })
}

/** Extract result links from a Google or DuckDuckGo results page. */
export async function collectSearchResults(
  page: Page,
  engine: 'google' | 'duckduckgo',
  maxResults: number,
): Promise<BrowserSearchResult[]> {
  return page.evaluate(
    ({ selectedEngine, maxResults }) => {
      const unwrap = (href: string): string => {
        if (href.includes('uddg=')) {
          try {
            return new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') ?? href
          } catch {
            return href
          }
        }
        return href
      }
      const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()
      const rows: BrowserSearchResult[] = []
      const seen = new Set<string>()
      const anchors = selectedEngine === 'duckduckgo'
        ? Array.from(document.querySelectorAll<HTMLAnchorElement>('.result__a[href]'))
        : Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      for (const anchor of anchors) {
        if (rows.length >= maxResults) break
        const url = unwrap(anchor.href)
        if (!/^https?:\/\//i.test(url)) continue
        const host = new URL(url).hostname
        if (host.endsWith('google.com') || host.endsWith('gstatic.com') || host.endsWith('googleusercontent.com')) continue
        if (host.endsWith('duckduckgo.com')) continue
        const title = clean(anchor.innerText || anchor.textContent || '')
        if (title.length < 3 || seen.has(url)) continue
        seen.add(url)
        const container = anchor.closest('.result, div')
        const snippet = clean(container?.textContent ?? '').slice(0, 300)
        rows.push({ title, url, snippet })
      }
      return rows
    },
    { selectedEngine: engine, maxResults },
  )
}
