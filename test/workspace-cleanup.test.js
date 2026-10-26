import { describe, expect, it, vi } from 'vitest'
import { installWorkspaceSessionCleanup } from '../panel/workspace-cleanup.js'

function harness(initialWorkspaces) {
  const workspaces = initialWorkspaces.map((workspace) => ({
    ...workspace,
    sessionIds: [...workspace.sessionIds],
  }))
  const closeSession = vi.fn(async () => undefined)
  let onChange

  const registry = {
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
  }

  const ctx = {
    inject: (deps, callback) => {
      expect(deps).toEqual(['workspaceRegistry'])
      callback({
        workspaceRegistry: registry,
        on: (event, listener) => {
          expect(event).toBe('domain/changed')
          onChange = listener
          return () => {
            onChange = undefined
          }
        },
        effect: () => undefined,
      })
    },
  }

  installWorkspaceSessionCleanup(ctx, {
    browserApiUrl: 'http://browser.test',
    closeSession,
    logger: { warn: () => undefined },
  })

  return {
    closeSession,
    change: (change) => onChange?.(change),
  }
}

const closed = (closeSession) => closeSession.mock.calls.map(([sessionId]) => sessionId).sort()

describe('workspace session cleanup', () => {
  it('closes every browser session attached to a deleted workspace', async () => {
    const { closeSession, change } = harness([
      { id: 'ws-1', sessionIds: ['session-a', 'session-b'] },
      { id: 'ws-2', sessionIds: ['session-c'] },
    ])

    change({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'deleted' })

    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(2))
    expect(closed(closeSession)).toEqual(['session-a', 'session-b'])
  })

  it('tracks sessions attached after the initial snapshot', async () => {
    const { closeSession, change } = harness([
      { id: 'ws-1', sessionIds: ['session-a'] },
    ])

    change({
      domain: 'workspace',
      table: 'workspaces',
      key: 'ws-1',
      operation: 'put',
      value: { sessionIds: ['session-a', 'session-b'] },
    })
    change({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'deleted' })

    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(2))
    expect(closed(closeSession)).toEqual(['session-a', 'session-b'])
  })

  it('ignores other domains, tables, and unknown workspaces', async () => {
    const { closeSession, change } = harness([
      { id: 'ws-1', sessionIds: ['session-a'] },
    ])

    change({ domain: 'search', table: 'workspaces', key: 'ws-1', operation: 'deleted' })
    change({ domain: 'workspace', table: 'sessions', key: 'ws-1', operation: 'deleted' })
    change({ domain: 'workspace', table: 'workspaces', key: 'missing', operation: 'deleted' })
    change({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'put', value: {} })

    await Promise.resolve()
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('filters invalid session ids', async () => {
    const { closeSession, change } = harness([
      { id: 'ws-1', sessionIds: ['session-a', 'not a session id'] },
    ])

    change({ domain: 'workspace', table: 'workspaces', key: 'ws-1', operation: 'deleted' })

    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1))
    expect(closed(closeSession)).toEqual(['session-a'])
  })
})
