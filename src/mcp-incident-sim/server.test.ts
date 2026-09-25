import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

// Teste ponta a ponta: sobe o servidor MCP de verdade e fala com ele como um cliente MCP.
test('servidor MCP simulado lista ferramentas e responde com evidencias gravadas', async () => {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.ts', import.meta.url))],
    env: { ...(process.env as Record<string, string>), SCENARIO: 'db-leaky-connections' }
  }))
  try {
    const { tools } = await client.listTools()
    assert.ok(tools.some((t) => t.name === 'query_loki_logs'))

    const res = await client.callTool({ name: 'query_loki_logs', arguments: { datasourceUid: 'loki', logql: '{service_name="x"} |= "error"' } })
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
    assert.match(text, /timeout exceeded when trying to connect/)
    assert.ok(!res.isError)
  } finally {
    await client.close()
  }
})
