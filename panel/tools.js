/** Model-facing browser_* tool definitions and registration. */
export const BROWSER_SESSION_ID = /^[a-zA-Z0-9._-]{1,80}$/

/** Model-facing browser tools, dispatched against the caller's DSH session. */
const TOOL_DEFS = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the active tab of this session\'s dedicated Chromium. Accepts a URL, hostname, localhost address, or plain search text (which becomes a Google search).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, hostname, localhost address, or search text' },
      },
      required: ['url'],
    },
    timeoutMs: 120000,
  },
  {
    name: 'browser_snapshot',
    description:
      'Return the current page title, URL, visible text, links, and a numbered inventory of interactive elements. Use element ids such as e3 with browser_click and browser_type.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 60000,
  },
  {
    name: 'browser_search',
    description:
      'Search the web by navigating this session\'s browser to Google, falling back to DuckDuckGo when auto is selected. If Google shows CAPTCHA or consent, blocked=true and the human should complete it in the live browser panel, then retry. This is the direct browser-search lane; web_search is the API/SearXNG lane.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        engine: { type: 'string', enum: ['google', 'duckduckgo', 'auto'], description: 'Search engine' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum result links' },
      },
      required: ['query'],
    },
    timeoutMs: 120000,
  },
  {
    name: 'browser_click',
    description: 'Click an element by snapshot id (e3) or CSS selector in this session\'s browser.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Snapshot element id like e3, or a CSS selector' },
      },
      required: ['selector'],
    },
    timeoutMs: 60000,
  },
  {
    name: 'browser_type',
    description: 'Type text into an input, textarea, select, or contenteditable element by snapshot id or CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Snapshot element id like e3, or a CSS selector' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    timeoutMs: 60000,
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key such as Enter, Tab, Escape, ArrowDown, or Control+A.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press' },
      },
      required: ['key'],
    },
    timeoutMs: 30000,
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the active tab up, down, to the top, or to the bottom.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
      },
      required: ['direction'],
    },
    timeoutMs: 30000,
  },
  {
    name: 'browser_back',
    description: 'Go back on the active tab.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 60000,
  },
  {
    name: 'browser_forward',
    description: 'Go forward on the active tab.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 60000,
  },
  {
    name: 'browser_reload',
    description: 'Reload the active tab.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 60000,
  },
  {
    name: 'browser_tabs',
    description: 'List tabs, open a new tab, select a tab by index, or close a tab.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab action' },
        index: { type: 'integer', minimum: 0, description: 'Tab index for select and close' },
        url: { type: 'string', description: 'URL for a new tab' },
      },
      required: ['action'],
    },
    timeoutMs: 60000,
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the active page. Returns the saved file path and size.',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
      },
    },
    timeoutMs: 60000,
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait until a CSS selector is visible or the page text contains the given text. Resolves when the condition is met or the timeout elapses. Prefer this over fixed sleeps after clicks and navigations.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text to wait for in the page body' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Timeout in milliseconds' },
      },
    },
    timeoutMs: 90000,
  },
  {
    name: 'browser_find',
    description:
      'Enumerate visible matches for a CSS selector with snapshot-style ids (e1, e2, ...) plus text and bounding boxes. The ids can be used with browser_click and browser_type.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to enumerate' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum matches' },
      },
      required: ['selector'],
    },
    timeoutMs: 60000,
  },
  {
    name: 'browser_batch',
    description:
      'Run up to 25 browser steps sequentially in one call to reduce round trips. Each step has an action field (navigate, snapshot, search, click, type, press, scroll, back, forward, reload, tabs, screenshot, wait_for, find, console, network) plus the same arguments as the individual tools, without the browser_ prefix.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Step action name' },
            },
            required: ['action'],
          },
          description: 'Ordered browser steps',
        },
      },
      required: ['steps'],
    },
    timeoutMs: 300000,
  },
  {
    name: 'browser_console',
    description: 'Read console messages buffered since the previous read. Pass clear=true to reset the buffer after reading.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'log', 'warn', 'error', 'info', 'debug'], description: 'Message level filter' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum messages' },
      },
    },
    timeoutMs: 30000,
  },
  {
    name: 'browser_network',
    description: 'Read network requests buffered since the previous read. Pass clear=true to reset the buffer after reading.',
    parameters: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear the buffer after reading' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum requests' },
      },
    },
    timeoutMs: 30000,
  },
]

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    content: { type: 'string' },
    error: { type: 'string' },
  },
}

export function registerBrowserTools(ctx, browserApiUrl) {
  const tools = ctx.get('tools')
  if (!tools) return []
  const disposers = []
  for (const def of TOOL_DEFS) {
    const definition = {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      timeoutMs: def.timeoutMs,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: typeof value?.content === 'string' ? value.content : '' }],
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        if (typeof sessionId !== 'string' || !BROWSER_SESSION_ID.test(sessionId)) {
          throw new Error('browser tools require an active DSH session')
        }
        let response
        try {
          response = await fetch(`${browserApiUrl}/sessions/${encodeURIComponent(sessionId)}/tool`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: def.name, args }),
            signal: exec?.signal,
          })
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError'
          throw new Error(aborted ? 'browser tool call was cancelled' : `browser service unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(`browser service error ${response.status}: ${String(body?.error ?? '')}`)
        }
        if (body?.ok !== true) {
          throw new Error(typeof body?.error === 'string' && body.error !== '' ? body.error : 'browser tool failed')
        }
        return { ok: true, content: typeof body?.content === 'string' ? body.content : '' }
      },
    }
    disposers.push(tools.register(definition))
  }
  return disposers
}
