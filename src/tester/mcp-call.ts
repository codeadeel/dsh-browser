import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [mcpUrl, toolName, jsonArgs = '{}'] = process.argv.slice(2)
if (!mcpUrl || !toolName) {
  console.error('usage: tsx src/tester/mcp-call.ts <mcp-url> <tool-name> [json-args]')
  process.exit(2)
}

let args: unknown
try {
  args = JSON.parse(jsonArgs)
} catch {
  console.error('json-args must be valid JSON')
  process.exit(2)
}

const client = new Client({ name: 'dsh-browser-call', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
await client.connect(transport)
const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> })
console.log(JSON.stringify(result, null, 2))
await client.close()
