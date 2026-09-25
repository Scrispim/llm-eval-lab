import type { Evaluation } from '@langfuse/client'
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing'
import type OpenAI from 'openai'
import type { InvestigationResult } from '../harness/agent.ts'
import { normalize } from '../lib/text.ts'

export interface Expected {
  rootCause: string
  rootCauseKeywordGroups: string[][]
  forbiddenKeywords: string[]
  expectedSignals: Array<'metrics' | 'logs' | 'traces'>
}

const SIGNAL_OF_TOOL = (tool: string): 'metrics' | 'logs' | 'traces' | undefined =>
  tool.includes('prometheus') ? 'metrics' : tool.includes('loki') ? 'logs' : tool.startsWith('tempo') ? 'traces' : undefined

/** Fracao dos grupos de palavras-chave (causa raiz) presentes na resposta. Barato e deterministico. */
export function keywordCoverage (answer: string, groups: string[][]): number {
  if (groups.length === 0) return 1
  const text = normalize(answer)
  const hit = groups.filter((g) => g.some((k) => text.includes(normalize(k)))).length
  return hit / groups.length
}

/** 1 se a resposta NAO afirma nenhuma causa proibida (diagnostico errado), 0 caso contrario. */
export function noForbiddenClaims (answer: string, forbidden: string[]): number {
  const text = normalize(answer)
  return forbidden.some((k) => text.includes(normalize(k))) ? 0 : 1
}

/** Fracao dos sinais esperados (metricas/logs/traces) que o agente de fato consultou. */
export function signalCoverage (result: InvestigationResult, expected: Array<'metrics' | 'logs' | 'traces'>): number {
  if (expected.length === 0) return 1
  const used = new Set(result.toolCalls.filter((c) => !c.isError).map((c) => SIGNAL_OF_TOOL(c.name)))
  return expected.filter((s) => used.has(s)).length / expected.length
}

export function codeScorers (output: InvestigationResult, expected: Expected): Evaluation[] {
  return [
    { name: 'completed', value: output.answer && !output.error ? 1 : 0, comment: output.error, dataType: 'NUMERIC' },
    { name: 'root_cause_keywords', value: keywordCoverage(output.answer, expected.rootCauseKeywordGroups), dataType: 'NUMERIC' },
    { name: 'no_forbidden_claims', value: noForbiddenClaims(output.answer, expected.forbiddenKeywords), dataType: 'NUMERIC' },
    { name: 'signal_coverage', value: signalCoverage(output, expected.expectedSignals), dataType: 'NUMERIC' }
  ]
}

/** Latencia, custo de passos e tokens tambem viram scores, para o Langfuse agregar por modelo. */
export function performanceScores (output: InvestigationResult): Evaluation[] {
  return [
    { name: 'latency_total_ms', value: Math.round(output.totalMs), dataType: 'NUMERIC' },
    { name: 'latency_llm_avg_ms', value: Math.round(avg(output.llmLatencyMs)), dataType: 'NUMERIC' },
    { name: 'steps', value: output.steps, dataType: 'NUMERIC' },
    { name: 'tokens_total', value: output.tokens.prompt + output.tokens.completion, dataType: 'NUMERIC' },
    { name: 'retries', value: output.retries, comment: 'tentativas por 429/5xx (fila do provedor, nao e lentidao do modelo)', dataType: 'NUMERIC' }
  ]
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** LLM-as-judge: compara a resposta com a causa raiz esperada. Use um juiz mais forte que os avaliados. */
export async function llmJudge (llm: OpenAI, judgeModel: string, answer: string, expected: Expected): Promise<Evaluation> {
  const prompt = `Voce e um avaliador rigoroso. Compare a RESPOSTA com a CAUSA RAIZ ESPERADA.
Dê nota de 0 a 1: 1 = identifica a causa raiz correta e o mecanismo; 0.5 = parcial/vaga; 0 = errada ou inventada.
Responda SOMENTE JSON: {"score": <numero>, "reasoning": "<uma frase>"}

CAUSA RAIZ ESPERADA:
${expected.rootCause}

RESPOSTA:
${answer || '(vazia)'}`
  // Se o juiz falhar, deixamos a excecao subir: o Langfuse descarta o evaluator que falha,
  // e o modelo avaliado nao e punido por um erro de infraestrutura do juiz.
  // O juiz roda depois do span do item do experimento, entao vira um trace proprio, marcado com a tag `judge`.
  return await propagateAttributes({ tags: ['judge'], metadata: { judgeModel } }, async () =>
    await startActiveObservation('judge-root-cause', async (gen) => {
      gen.update({ model: judgeModel, modelParameters: { temperature: 0 }, input: [{ role: 'user', content: prompt }] })
      const res = await llm.chat.completions.create({ model: judgeModel, temperature: 0, messages: [{ role: 'user', content: prompt }] })
      const raw = res.choices?.[0]?.message?.content ?? ''
      gen.update({
        output: res.choices?.[0]?.message ?? res,
        usageDetails: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 }
      })
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { score: number, reasoning: string }
      return { name: 'judge_root_cause', value: Math.min(1, Math.max(0, Number(parsed.score))), comment: parsed.reasoning, metadata: { judgeModel }, dataType: 'NUMERIC' } satisfies Evaluation
    }, { asType: 'generation' })
  )
}
