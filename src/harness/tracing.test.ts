import { test } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { LangfuseOtelSpanAttributes } from '@langfuse/core'
import { LangfuseSpanProcessor } from '@langfuse/otel'

// Processor real do Langfuse (aplica os atributos propagados), so que exportando para a memoria.
const exporter = new InMemorySpanExporter()
const processor = new LangfuseSpanProcessor({ publicKey: 'pk-test', secretKey: 'sk-test', exporter, exportMode: 'immediate' })
new NodeTracerProvider({ spanProcessors: [processor] }).register()

const { investigate } = await import('./agent.ts')

function fakeLlm (): OpenAI {
  const script = [
    { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_datasources', arguments: '{}' } }] },
    { content: 'Causa raiz: pool esgotado.' }
  ]
  let i = 0
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', ...script[i++] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }) } }
  } as unknown as OpenAI
}

test('trace: agent > generations + tools, nomes estaveis, tags/metadata e custo', async () => {
  await investigate({ llm: fakeLlm(), model: 'fake/model', scenario: 'db-leaky-connections', question: 'investigue', maxSteps: 5 })
  await processor.forceFlush()
  const spans = exporter.getFinishedSpans()
  const A = LangfuseOtelSpanAttributes
  const byName = (n: string) => spans.filter((s) => s.name === n)

  const [agent] = byName('investigate-incident')
  assert.ok(agent, 'observation agent existe')
  assert.equal(agent.attributes[A.OBSERVATION_TYPE], 'agent')
  assert.equal(agent.attributes[A.OBSERVATION_INPUT], 'investigue') // so a pergunta

  const gens = byName('llm-call')
  assert.equal(gens.length, 2, 'nome estavel, sem numero do passo')
  for (const g of gens) {
    assert.equal(g.attributes[A.OBSERVATION_TYPE], 'generation')
    assert.equal(g.attributes[A.OBSERVATION_MODEL], 'fake/model')
    assert.equal(g.parentSpanContext?.spanId, agent.spanContext().spanId, 'generation aninhada no agent')
    assert.ok(g.attributes[A.OBSERVATION_USAGE_DETAILS])
    assert.ok(g.attributes[A.OBSERVATION_COST_DETAILS])
    assert.deepEqual(g.attributes[A.TRACE_TAGS], ['db-leaky-connections', 'fake/model'])
    assert.equal(g.attributes[`${A.TRACE_METADATA}.scenario`], 'db-leaky-connections')
  }

  const [tool] = byName('list_datasources')
  assert.ok(tool, 'observation tool existe')
  assert.equal(tool.attributes[A.OBSERVATION_TYPE], 'tool')
  assert.equal(tool.parentSpanContext?.spanId, agent.spanContext().spanId, 'tool irma da generation, filha do agent')
})
