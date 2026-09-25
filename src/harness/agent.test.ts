import { test } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import { investigate } from './agent.ts'
import { codeScorers, type Expected } from '../scorers/index.ts'

// LLM falso e roteirizado: 1) consulta logs, 2) consulta metricas, 3) responde.
function fakeLlm (): OpenAI {
  const script = [
    { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_loki_logs', arguments: '{"datasourceUid":"loki","logql":"{service_name=\\"x\\"} |= \\"error\\""}' } }] },
    { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'query_prometheus', arguments: '{"datasourceUid":"prometheus","startTime":"now","expr":"sum by (http_route, http_status_code) (increase(http_server_duration_milliseconds_count[15m]))"}' } }] },
    { content: 'Causa raiz: o pool de conexoes esgotou (timeout) porque nao ha release() das conexoes.' }
  ]
  let i = 0
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', ...script[i++] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) } }
  } as unknown as OpenAI
}

test('agente executa o loop LLM -> ferramenta MCP -> resposta e coleta metricas', async () => {
  const r = await investigate({ llm: fakeLlm(), model: 'fake', scenario: 'db-leaky-connections', question: 'investigue', maxSteps: 5 })
  assert.equal(r.error, undefined)
  assert.equal(r.steps, 3)
  assert.deepEqual(r.toolCalls.map((c) => c.name), ['query_loki_logs', 'query_prometheus'])
  assert.ok(r.toolCalls.every((c) => !c.isError))
  assert.equal(r.tokens.prompt, 300)
  assert.equal(r.llmLatencyMs.length, 3)
  assert.match(r.answer, /pool/)

  const expected: Expected = {
    rootCause: '', rootCauseKeywordGroups: [['pool'], ['timeout'], ['release']], forbiddenKeywords: ['oom'], expectedSignals: ['metrics', 'logs', 'traces']
  }
  const byName = Object.fromEntries(codeScorers(r, expected).map((e) => [e.name, e.value]))
  assert.equal(byName.completed, 1)
  assert.equal(byName.root_cause_keywords, 1)
  assert.equal(byName.signal_coverage, 2 / 3) // nao consultou traces
})

test('agente reporta erro quando estoura MAX_STEPS sem resposta final', async () => {
  const looping = { chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'list_datasources', arguments: '{}' } }] } }] }) } } } as unknown as OpenAI
  const r = await investigate({ llm: looping, model: 'fake', scenario: 'db-leaky-connections', question: 'q', maxSteps: 2 })
  assert.match(r.error ?? '', /MAX_STEPS/)
  assert.equal(r.steps, 2)
})
