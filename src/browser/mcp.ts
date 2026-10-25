import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserSession } from './session.js'
import { handleBrowserTool } from './tools.js'

interface ToolSpec {
  name: string
  title: string
  description: string
  schema: Record<string, z.ZodTypeAny>
  readOnly: boolean
}

const TOOLS: ToolSpec[] = [
  {
    name: 'browser_navigate',
    title: 'Navigate the dedicated browser',
    description:
      'Navigate the active tab of the dedicated Chromium session. Accepts a URL, hostname, localhost address, or plain search text (which becomes a Google search).',
    schema: { url: z.string().min(1).describe('URL, hostname, localhost address, or search text') },
    readOnly: false,
  },
  {
    name: 'browser_snapshot',
    title: 'Read the current page',
    description:
      'Return the current page title, URL, visible text, links, and a numbered inventory of interactive elements. Use element ids such as e3 with browser_click and browser_type.',
    schema: {},
    readOnly: true,
  },
  {
    name: 'browser_search',
    title: 'Search through the browser',
    description:
      'Search the web by navigating this dedicated browser to Google, falling back to DuckDuckGo when auto is selected. If Google shows CAPTCHA or consent, blocked=true and the human should complete it in the browser, then retry. This is the direct browser-search lane; web_search is the API/SearXNG lane.',
    schema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'duckduckgo', 'auto']).default('auto'),
      maxResults: z.number().int().min(1).max(20).optional(),
    },
    readOnly: false,
  },
  {
    name: 'browser_click',
    title: 'Click an element',
    description: 'Click an element by snapshot id (e3) or CSS selector.',
    schema: { selector: z.string().min(1).describe('Snapshot element id like e3, or a CSS selector') },
    readOnly: false,
  },
  {
    name: 'browser_type',
    title: 'Type into a field',
    description: 'Type text into an input, textarea, select, or contenteditable element by snapshot id or CSS selector.',
    schema: { selector: z.string().min(1), text: z.string() },
    readOnly: false,
  },
  {
    name: 'browser_press',
    title: 'Press a key',
    description: 'Press a keyboard key such as Enter, Tab, Escape, ArrowDown, or Control+A.',
    schema: { key: z.string().min(1) },
    readOnly: false,
  },
  {
    name: 'browser_scroll',
    title: 'Scroll the page',
    description: 'Scroll the active tab up, down, to the top, or to the bottom.',
    schema: { direction: z.enum(['up', 'down', 'top', 'bottom']) },
    readOnly: false,
  },
  {
    name: 'browser_back',
    title: 'Browser back',
    description: 'Go back on the active tab.',
    schema: {},
    readOnly: false,
  },
  {
    name: 'browser_forward',
    title: 'Browser forward',
    description: 'Go forward on the active tab.',
    schema: {},
    readOnly: false,
  },
  {
    name: 'browser_reload',
    title: 'Browser reload',
    description: 'Reload the active tab.',
    schema: {},
    readOnly: false,
  },
  {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List tabs, open a new tab, select a tab by index, or close a tab.',
    schema: {
      action: z.enum(['list', 'new', 'select', 'close']),
      index: z.number().int().min(0).optional(),
      url: z.string().optional(),
    },
    readOnly: false,
  },
  {
    name: 'browser_screenshot',
    title: 'Screenshot the page',
    description: 'Capture a PNG screenshot of the active page. Returns the file path and image content.',
    schema: { fullPage: z.boolean().default(false) },
    readOnly: true,
  },
  {
    name: 'browser_wait_for',
    title: 'Wait for a page condition',
    description:
      'Wait until a CSS selector is visible or the page text contains the given text. Resolves when the condition is met or the timeout elapses.',
    schema: {
      selector: z.string().optional().describe('CSS selector to wait for'),
      text: z.string().optional().describe('Text to wait for in the page body'),
      timeoutMs: z.number().int().min(500).max(60_000).optional(),
    },
    readOnly: true,
  },
  {
    name: 'browser_find',
    title: 'Find elements by selector',
    description:
      'Enumerate visible matches for a CSS selector with snapshot-style ids (e1, e2, ...) plus text and bounding boxes. The ids can be used with browser_click and browser_type.',
    schema: {
      selector: z.string().min(1),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
    readOnly: true,
  },
  {
    name: 'browser_batch',
    title: 'Run a batch of browser steps',
    description:
      'Run up to 25 browser steps sequentially in one call. Steps have an action field (navigate, snapshot, search, click, type, press, scroll, back, forward, reload, tabs, screenshot, wait_for, find, console, network) plus the same arguments as the individual tools, without the browser_ prefix.',
    schema: {
      steps: z.array(z.record(z.string(), z.unknown())).min(1).max(25),
    },
    readOnly: false,
  },
  {
    name: 'browser_console',
    title: 'Read browser console messages',
    description: 'Read console messages buffered since the previous read. Pass clear=true to reset the buffer after reading.',
    schema: {
      level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).default('all'),
      clear: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
  },
  {
    name: 'browser_network',
    title: 'Read browser network activity',
    description: 'Read network requests buffered since the previous read. Pass clear=true to reset the buffer after reading.',
    schema: {
      clear: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
  },
]

export function createBrowserMcpServer(session: BrowserSession): McpServer {
  const server = new McpServer({
    name: `dsh-browser-${session.id}`,
    version: '0.2.0',
  })

  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: z.object(spec.schema),
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: true },
      },
      async args => {
        const result = await handleBrowserTool(session, spec.name, args as Record<string, unknown>)
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: result.content },
        ]
        const structured = result.structured as { base64?: string; mime?: string } | undefined
        if (spec.name === 'browser_screenshot' && result.ok && structured?.base64) {
          content.push({ type: 'image', data: structured.base64, mimeType: structured.mime ?? 'image/png' })
        }
        return {
          ...(result.ok ? {} : { isError: true }),
          content,
          ...(result.ok && result.structured !== undefined
            ? { structuredContent: result.structured as { [key: string]: unknown } }
            : {}),
        }
      },
    )
  }

  return server
}
