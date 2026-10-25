import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface HttpHandle {
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text) as unknown
}

export async function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port')
  return address.port
}

export async function startStatefulMcpServer(
  server: McpServer,
  host: string,
  port: number,
): Promise<HttpHandle> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  await server.connect(transport)

  const http = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (url !== '/mcp' && !url.startsWith('/mcp?')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      await transport.handleRequest(req, res, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) sendJson(res, 400, { error: message })
      else res.destroy()
    }
  })

  const actualPort = await listen(http, host, port)
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/mcp`,
    close: async () => {
      await new Promise<void>(resolve => http.close(() => resolve()))
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    },
  }
}

export async function handleStatelessMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  createMcpServer: () => McpServer,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    })
    return
  }
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    const body = await readJsonBody(req)
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    res.on('close', () => {
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: null,
      })
    } else {
      res.destroy()
    }
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  }
}

export async function startStatelessMcpServer(
  createMcpServer: () => McpServer,
  host: string,
  port: number,
  onRequest?: () => void,
): Promise<HttpHandle> {
  const http = createServer(async (req, res) => {
    const url = req.url ?? '/'
    onRequest?.()

    if (url === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (url !== '/mcp' && !url.startsWith('/mcp?')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    await handleStatelessMcpRequest(req, res, createMcpServer)
  })

  const actualPort = await listen(http, host, port)
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/mcp`,
    close: async () => {
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}
