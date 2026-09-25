import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing'
import { fileURLToPath } from 'node:url'
import type OpenAI from 'openai'

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam
type Tool = OpenAI.Chat.Completions.ChatCompletionTool

export interface ToolCallRecord { name: string, args: unknown, isError: boolean, latencyMs: number }

export interface InvestigationResult {
  answer: string
  error?: string
  steps: number
  toolCalls: ToolCallRecord[]
  tokens: { prompt: number, completion: number }
  llmLatencyMs: number[]
  totalMs: number
  retries: number
}

const SYSTEM_PROMPT = `Voce e um SRE investigando um incidente. Use as ferramentas para consultar metricas (Prometheus),
logs (Loki) e traces (Tempo). Comece descobrindo os datasources. Baseie-se APENAS nas evidencias retornadas pelas
ferramentas; nao invente dados. Ao concluir, responda em portugues neste formato:
## Causa raiz
## Evidencias (cite metricas, logs e traces)
## Recomendacao`

const serverPath = fileURLToPath(new URL('../mcp-incident-sim/server.ts', import.meta.url))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withRetry<T> (fn: () => Promise<T>, onRetry: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { status?: number }).status
      if (attempt >= 3 || !(status === 429 || (status !== undefined && status >= 500))) throw err
      onRetry()
      await sleep(2000 * 2 ** attempt)
    }
  }
}

export interface InvestigateOptions {
  llm: OpenAI
  model: string
  scenario: string
  question: string
  maxSteps: number
}

/**
 * Uma investigacao = uma observation `agent`; as chamadas ao modelo (generation) e as ferramentas (tool)
 * ficam aninhadas nela. Tags e metadata (modelo, cenario) sao propagadas a todas as observations filhas.
 */
export async function investigate (opts: InvestigateOptions): Promise<InvestigationResult> {
  const attributes = { model: opts.model, scenario: opts.scenario, maxSteps: String(opts.maxSteps) }
  return await propagateAttributes({ tags: [opts.scenario, opts.model], metadata: attributes }, async () =>
    await startActiveObservation('investigate-incident', async (agent) => {
      // Input explicito: so a pergunta, nao os argumentos da funcao (o cliente LLM carrega a API key).
      agent.update({ input: opts.question, metadata: attributes })
      const result = await runInvestigation(opts)
      agent.update({
        output: result.answer,
        level: result.error ? 'ERROR' : 'DEFAULT',
        statusMessage: result.error,
        metadata: { steps: result.steps, retries: result.retries, toolCalls: result.toolCalls.length, totalMs: Math.round(result.totalMs) }
      })
      return result
    }, { asType: 'agent' })
  )
}

async function runInvestigation (opts: InvestigateOptions): Promise<InvestigationResult> {
  const started = performance.now()
  const result: InvestigationResult = { answer: '', steps: 0, toolCalls: [], tokens: { prompt: 0, completion: 0 }, llmLatencyMs: [], totalMs: 0, retries: 0 }

  // Um servidor MCP simulado por investigacao: isolamento total entre execucoes.
  const mcp = new Client({ name: 'eval-agent', version: '0.1.0' })
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...(process.env as Record<string, string>), SCENARIO: opts.scenario }
  }))

  try {
    const { tools: mcpTools } = await mcp.listTools()
    const tools: Tool[] = mcpTools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown> }
    }))
    const messages: Message[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.question }
    ]

    for (let step = 0; step < opts.maxSteps; step++) {
      result.steps = step + 1

      // Cada chamada ao modelo vira uma "generation" no Langfuse (latencia, tokens, entrada e saida).
      // Nome estavel (o passo vai no metadata) para poder filtrar/agregar por nome.
      const completion = await startActiveObservation('llm-call', async (gen) => {
        gen.update({ model: opts.model, modelParameters: { temperature: 0 }, input: messages, metadata: { step: step + 1 } })
        const t0 = performance.now()
        try {
          const res = await withRetry(
            async () => {
              const r = await opts.llm.chat.completions.create({ model: opts.model, messages, tools, temperature: 0 })
              // O OpenRouter as vezes responde 200 com um corpo de erro (sem `choices`), p.ex. provedor
              // sobrecarregado. Tratamos como 503 para cair na mesma politica de retentativa dos 5xx.
              const providerError = (r as { error?: { message?: string } }).error
              if (providerError ?? r.choices?.[0] === undefined) {
                const detail = providerError?.message ?? JSON.stringify(r).slice(0, 300)
                throw Object.assign(new Error(`provedor sem choices: ${detail}`), { status: 503 })
              }
              return r
            },
            () => { result.retries++ }
          )
          const latency = performance.now() - t0
          result.llmLatencyMs.push(latency)
          result.tokens.prompt += res.usage?.prompt_tokens ?? 0
          result.tokens.completion += res.usage?.completion_tokens ?? 0
          const cachedTokens = res.usage?.prompt_tokens_details?.cached_tokens
          const cost = (res.usage as { cost?: number } | undefined)?.cost // OpenRouter informa o custo real
          gen.update({
            output: res.choices[0]?.message,
            usageDetails: {
              input: res.usage?.prompt_tokens ?? 0,
              output: res.usage?.completion_tokens ?? 0,
              ...(cachedTokens ? { cached_tokens: cachedTokens } : {})
            },
            ...(typeof cost === 'number' ? { costDetails: { total: cost } } : {}),
            metadata: { step: step + 1, latencyMs: Math.round(latency), retries: result.retries }
          })
          return res
        } catch (err) {
          gen.update({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
          throw err
        }
      }, { asType: 'generation' })

      const msg = completion.choices?.[0]?.message
      if (!msg) throw new Error('Resposta do modelo sem choices')
      messages.push(msg)

      if (!msg.tool_calls?.length) {
        result.answer = msg.content ?? ''
        break
      }

      for (const call of msg.tool_calls) {
        if (call.type !== 'function') continue
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { /* argumentos invalidos: segue e deixa o MCP reportar */ }

        const output = await startActiveObservation(call.function.name, async (toolSpan) => {
          toolSpan.update({ input: args })
          const t0 = performance.now()
          const res = await mcp.callTool({ name: call.function.name, arguments: args })
          const text = (res.content as Array<{ type: string, text?: string }>).map((c) => c.text ?? '').join('\n')
          result.toolCalls.push({ name: call.function.name, args, isError: Boolean(res.isError), latencyMs: performance.now() - t0 })
          toolSpan.update({
            output: text,
            level: res.isError ? 'ERROR' : 'DEFAULT',
            statusMessage: res.isError ? text.slice(0, 200) : undefined,
            metadata: { latencyMs: Math.round(performance.now() - t0) }
          })
          return text
        }, { asType: 'tool' })
        messages.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }
    if (!result.answer) result.error = 'sem resposta final dentro de MAX_STEPS'
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    await mcp.close()
    result.totalMs = performance.now() - started
  }
  return result
}
