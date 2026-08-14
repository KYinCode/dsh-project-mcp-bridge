// Minimal stdio MCP server for local development and the v4 test plan.
//
// Wire it up with:
//   .dsh/mcp.json -> { "mcpServers": { "test": { "command": "node",
//     "args": ["examples/test-server.mjs"], "idleTimeoutMs": 4000 } } }
//
// Tools:
//   echo(text)   -> returns the text
//   add(a, b)    -> returns the sum
//   fail()       -> always returns an isError result
//   sleep(ms)    -> waits ms, then returns "slept" (timing / busy-guard tests)
//
// The process is intentionally dumb and stateless: each spawned instance is
// indistinguishable from any other, so process-count checks in the test plan
// (lazy connect, idle disconnect, per-session isolation) can rely on the
// command line alone. For scripted tests, if TEST_SERVER_PIDFILE is set in
// the environment, every instance appends one "pid,parentPid,timestamp"
// line to that file on startup (survives the bridge's env scrubbing — the
// name matches no credential or DSH_* pattern).
import { appendFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

if (process.env.TEST_SERVER_PIDFILE) {
  appendFile(process.env.TEST_SERVER_PIDFILE, `${process.pid},${process.ppid},${Date.now()}\n`).catch(() => {})
}

const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Return the given text verbatim',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'add',
      description: 'Add two numbers and return the sum',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    },
    {
      name: 'fail',
      description: 'Always fail with an error result',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'sleep',
      description: 'Wait ms milliseconds, then return "slept"',
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args?.text ?? '') }] }
    case 'add':
      return { content: [{ type: 'text', text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] }
    case 'fail':
      return { content: [{ type: 'text', text: 'intentional failure' }], isError: true }
    case 'sleep': {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(args?.ms ?? 0))))
      return { content: [{ type: 'text', text: 'slept' }] }
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
