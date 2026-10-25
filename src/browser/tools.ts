import type { BrowserSession } from './session.js'

export interface ToolCallResult {
  ok: boolean
  content: string
  structured?: unknown
  error?: string
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function record(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface BatchStep {
  action: string
  [key: string]: unknown
}

const BATCH_ACTIONS = new Set([
  'navigate',
  'snapshot',
  'search',
  'click',
  'type',
  'press',
  'scroll',
  'back',
  'forward',
  'reload',
  'tabs',
  'screenshot',
  'wait_for',
  'find',
  'console',
  'network',
])

/**
 * Shared browser-tool dispatch used by the per-session MCP server and the
 * session-manager REST endpoint (`POST /sessions/:id/tool`).
 *
 * The tool name matches the model-facing name minus the `browser_` prefix for
 * batch steps, e.g. step `{ "action": "click", "selector": "e3" }`.
 */
export async function handleBrowserTool(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const tool = name.startsWith('browser_') ? name.slice('browser_'.length) : name
  try {
    if (tool === 'navigate') {
      const url = requireString(args, 'url')
      const snapshot = await session.navigate(url)
      return ok(jsonText({ url: snapshot.url, title: snapshot.title, text: snapshot.text.slice(0, 2000) }), snapshot)
    }
    if (tool === 'snapshot') {
      const snapshot = await session.snapshot()
      return ok(jsonText(snapshot), snapshot)
    }
    if (tool === 'search') {
      const query = requireString(args, 'query')
      const engine = args.engine === 'google' || args.engine === 'duckduckgo' || args.engine === 'auto' ? args.engine : 'auto'
      const maxResults = optionalInt(args, 'maxResults')
      const result = await session.search(query, {
        engine,
        ...(maxResults !== undefined ? { maxResults } : {}),
      })
      return ok(jsonText(result), result)
    }
    if (tool === 'click') {
      const result = await session.click(requireString(args, 'selector'))
      return ok(jsonText(result), result)
    }
    if (tool === 'type') {
      const result = await session.type(requireString(args, 'selector'), requireString(args, 'text'))
      return ok(jsonText(result), result)
    }
    if (tool === 'press') {
      const result = await session.press(requireString(args, 'key'))
      return ok(jsonText(result), result)
    }
    if (tool === 'scroll') {
      const direction = args.direction
      if (direction !== 'up' && direction !== 'down' && direction !== 'top' && direction !== 'bottom') {
        throw new Error('direction must be up, down, top, or bottom')
      }
      const result = await session.scroll(direction)
      return ok(jsonText(result), result)
    }
    if (tool === 'back' || tool === 'forward' || tool === 'reload') {
      const result = await session[tool]()
      return ok(jsonText(result), result)
    }
    if (tool === 'tabs') {
      const action = args.action
      const index = optionalInt(args, 'index')
      const url = typeof args.url === 'string' ? args.url : undefined
      let tabs
      if (action === 'list' || action === undefined) tabs = await session.tabs()
      else if (action === 'new') tabs = await session.newTab(url)
      else if (action === 'select') {
        if (index === undefined) throw new Error('index is required for select')
        tabs = await session.selectTab(index)
      } else if (action === 'close') {
        if (index === undefined) throw new Error('index is required for close')
        tabs = await session.closeTab(index)
      } else {
        throw new Error('action must be list, new, select, or close')
      }
      return ok(jsonText(tabs), { tabs })
    }
    if (tool === 'screenshot') {
      const fullPage = args.fullPage === true
      const shot = await session.screenshot(fullPage)
      return {
        ok: true,
        content: `Screenshot saved to ${shot.path} (${shot.bytes} bytes)`,
        structured: { path: shot.path, mime: shot.mime, bytes: shot.bytes, base64: shot.base64 },
      }
    }
    if (tool === 'wait_for') {
      const result = await session.waitFor({
        selector: typeof args.selector === 'string' ? args.selector : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        timeoutMs: optionalInt(args, 'timeoutMs'),
      })
      return ok(jsonText(result), result)
    }
    if (tool === 'find') {
      const result = await session.find(requireString(args, 'selector'), optionalInt(args, 'maxResults'))
      return ok(jsonText(result), result)
    }
    if (tool === 'console') {
      const level = typeof args.level === 'string' ? args.level : 'all'
      const clear = args.clear !== false
      const limit = optionalInt(args, 'limit')
      const result = await session.readConsole({ level, clear, limit })
      return ok(jsonText(result), result)
    }
    if (tool === 'network') {
      const clear = args.clear !== false
      const limit = optionalInt(args, 'limit')
      const result = await session.readNetwork({ clear, limit })
      return ok(jsonText(result), result)
    }
    if (tool === 'batch') {
      const steps = args.steps
      if (!Array.isArray(steps) || steps.length === 0 || steps.length > 25) {
        throw new Error('steps must be an array of 1-25 step objects')
      }
      const outputs: Array<{ action: string; ok: boolean; content?: string; error?: string }> = []
      for (const raw of steps) {
        if (typeof raw !== 'object' || raw === null) throw new Error('each step must be an object')
        const step = raw as BatchStep
        if (typeof step.action !== 'string' || !BATCH_ACTIONS.has(step.action)) {
          throw new Error(`unknown batch action: ${String(step.action)}`)
        }
        const { action, ...rest } = step
        const result = await handleBrowserTool(session, `browser_${action}`, rest)
        outputs.push({
          action,
          ok: result.ok,
          ...(result.ok ? { content: result.content } : { error: result.error }),
        })
      }
      return ok(jsonText(outputs), { steps: outputs })
    }
    throw new Error(`unknown browser tool: ${name}`)
  } catch (error) {
    return {
      ok: false,
      content: `BROWSER_ERROR: ${errorMessage(error)}`,
      error: errorMessage(error),
    }
  }
}

function ok(content: string, structured: unknown): ToolCallResult {
  return { ok: true, content, structured: record(structured) }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
  return value.trim()
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value
}
