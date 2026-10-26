/**
 * Close browser sessions when their DSH workspace is deleted.
 *
 * Deleting a workspace only removes its registration; DSH deliberately keeps
 * the workspace directory and every session log. The browser service has no
 * workspace concept, so the host plugin mirrors the workspace -> sessionIds
 * account from the workspace registry and reacts to the post-durability
 * `domain/changed` delete event.
 *
 * @module dsh-browser-panel/workspace-cleanup
 */
import { BROWSER_SESSION_ID } from './tools.js'

/**
 * Install the workspace deletion observer on a DSH host context.
 *
 * The `workspaceRegistry` service is optional: without it the install is a
 * no-op, so the browser panel still works in profiles that do not compose the
 * workspace registry. The injected child scope is disposed with the plugin.
 *
 * @param {{ inject?: Function }} ctx - DSH host context.
 * @param {{
 *   browserApiUrl?: string,
 *   closeSession?: (sessionId: string) => Promise<unknown>,
 *   logger?: { warn?: (message: string) => void },
 * }} [options]
 */
export function installWorkspaceSessionCleanup(ctx, options = {}) {
  const browserApiUrl = String(options.browserApiUrl ?? '').replace(/\/$/, '')
  if (!ctx || typeof ctx.inject !== 'function' || browserApiUrl === '') return

  const logger = options.logger
  const closeSession = options.closeSession
    ?? ((sessionId) => deleteBrowserSession(browserApiUrl, sessionId, logger))
  const sessionsByWorkspace = new Map()

  const remember = (workspaceId, sessionIds) => {
    const key = String(workspaceId ?? '')
    if (key === '') return
    const ids = Array.isArray(sessionIds)
      ? sessionIds.map(String).filter((sessionId) => BROWSER_SESSION_ID.test(sessionId))
      : []
    sessionsByWorkspace.set(key, new Set(ids))
  }

  const take = (workspaceId) => {
    const ids = sessionsByWorkspace.get(workspaceId)
    sessionsByWorkspace.delete(workspaceId)
    return ids ? [...ids] : []
  }

  const closeAll = (sessionIds) => {
    if (sessionIds.length === 0) return
    void Promise.allSettled(sessionIds.map((sessionId) => closeSession(sessionId)))
  }

  ctx.inject(['workspaceRegistry'], (scope) => {
    const registry = scope.workspaceRegistry

    try {
      for (const workspace of registry.list()) {
        remember(workspace.id, workspace.sessionIds)
      }
    } catch (error) {
      logger?.warn?.(`[dsh-browser] workspace cleanup: could not read the workspace registry: ${String(error)}`)
    }

    scope.on('domain/changed', (change) => {
      if (!change || change.domain !== 'workspace' || change.table !== 'workspaces') return

      if (change.operation === 'deleted') {
        closeAll(take(String(change.key ?? '')))
        return
      }
      if (change.operation !== 'put') return

      if (change.value && Array.isArray(change.value.sessionIds)) {
        remember(change.key, change.value.sessionIds)
        return
      }
      const workspace = registry.get(change.key)
      if (workspace) remember(workspace.id, workspace.sessionIds)
    })

    scope.effect(() => () => {
      sessionsByWorkspace.clear()
    }, 'dsh-browser.workspaceCleanup')
  })
}

/**
 * Ask the browser service to close one session.
 *
 * @param {string} browserApiUrl - Browser service base URL.
 * @param {string} sessionId - DSH/browser session id.
 * @param {{ warn?: (message: string) => void } | undefined} logger
 */
async function deleteBrowserSession(browserApiUrl, sessionId, logger) {
  try {
    const response = await fetch(
      `${browserApiUrl}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok && response.status !== 404) {
      logger?.warn?.(`[dsh-browser] workspace cleanup: browser session ${sessionId} returned HTTP ${response.status}`)
    }
  } catch (error) {
    logger?.warn?.(`[dsh-browser] workspace cleanup: could not close browser session ${sessionId}: ${String(error)}`)
  }
}
