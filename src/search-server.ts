import { createServer, type ServerResponse } from 'node:http'
import { searchConfigFromEnv, loadDotEnv } from './config.js'
import { handleStatelessMcpRequest, listen, type HttpHandle } from './mcp/http.js'
import { createSearchMcpServer } from './search/mcp.js'
import { SearchConfigStore } from './search/store.js'
import { handleSearchConfigRequest } from './search/config-server.js'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface SearchGatewayHandle {
  url: string
  mcpUrl: string
  close: () => Promise<void>
}

/**
 * The unified search gateway: one HTTP port serving the MCP endpoint
 * (`/mcp`), the settings API (`/config`, `/test`), and `/health`.
 * Everything else in the search stack stays on the compose network.
 */
export async function startSearchGateway(
  store: SearchConfigStore,
  host: string,
  port: number,
): Promise<SearchGatewayHandle> {
  const http = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
    try {
      if (pathname === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      if (pathname === '/mcp') {
        await handleStatelessMcpRequest(req, res, () => createSearchMcpServer(() => store.get()))
        return
      }
      if (await handleSearchConfigRequest(store, req, res)) return
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 400, { error: message })
      else res.destroy()
    }
  })

  const actualPort = await listen(http, host, port)
  return {
    url: `http://${host}:${actualPort}`,
    mcpUrl: `http://${host}:${actualPort}/mcp`,
    close: async () => {
      await new Promise<void>(resolve => {
        http.close(() => resolve())
        http.closeAllConnections()
      })
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv()
  const config = searchConfigFromEnv()
  const store = new SearchConfigStore(config)
  await store.load()

  const handle = await startSearchGateway(store, config.host, config.port)
  console.log(`[search] gateway listening on ${handle.url}`)
  console.log(`[search] MCP endpoint: ${handle.mcpUrl}`)
  console.log(`[search] settings API: ${handle.url}/config`)
  console.log(`[search] config file: ${config.configPath}`)

  const shutdown = async (): Promise<void> => {
    console.log('[search] shutting down')
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

export type { HttpHandle }
