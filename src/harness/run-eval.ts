import { loadEnv } from '../lib/env.ts'
import { createOpenRouter } from '../lib/openrouter.ts'
import { percentile } from '../lib/text.ts'
import { investigate, type InvestigationResult } from './agent.ts'
import { codeScorers, llmJudge, performanceScores, type Expected } from '../scorers/index.ts'
import { mkdirSync, writeFileSync } from 'node:fs'

const env = loadEnv()
if (env.MODELS.length === 0) throw new Error('Defina MODELS no .env (veja: npm run models)')
// Importado depois do loadEnv: o Langfuse le as credenciais do ambiente ao iniciar.
const { langfuse, flushLangfuse } = await import('../lib/langfuse.ts')

const DATASET = 'incident-rca'
const llm = createOpenRouter(env.OPENROUTER_API_KEY)
const dataset = await langfuse.dataset.get(DATASET)
console.log(`dataset "${DATASET}": ${dataset.items.length} itens | modelos: ${env.MODELS.join(', ')} | repeticoes: ${env.REPEATS}\n`)

interface Row { model: string, repeat: number, scores: Record<string, number>, ok: boolean }
const rows: Row[] = []
const batch = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

for (const model of env.MODELS) {
  for (let repeat = 1; repeat <= env.REPEATS; repeat++) {
    const result = await dataset.runExperiment({
      name: `rca/${model}`,
      runName: `${model} | ${batch} | r${repeat}`,
      description: 'Investigacao de causa raiz com MCP de incidentes simulados',
      metadata: { model, repeat, judgeModel: env.JUDGE_MODEL || null, maxSteps: env.MAX_STEPS },
      maxConcurrency: env.MAX_CONCURRENCY,
      task: async (item) => {
        const input = item.input as { scenario: string, question: string }
        return await investigate({ llm, model, scenario: input.scenario, question: input.question, maxSteps: env.MAX_STEPS })
      },
      evaluators: [
        async ({ output, expectedOutput }) => codeScorers(output as InvestigationResult, expectedOutput as Expected),
        async ({ output }) => performanceScores(output as InvestigationResult),
        ...(env.JUDGE_MODEL
          ? [async ({ output, expectedOutput }: { output: unknown, expectedOutput?: unknown }) =>
              await llmJudge(llm, env.JUDGE_MODEL, (output as InvestigationResult).answer, expectedOutput as Expected)]
          : [])
      ]
    })
    for (const item of result.itemResults) {
      const scores = Object.fromEntries(item.evaluations.map((e) => [e.name, Number(e.value)]))
      rows.push({ model, repeat, scores, ok: scores.completed === 1 })
    }
    console.log(`  ${model} r${repeat}: ${result.itemResults.length} itens avaliados`)
  }
}

// Resumo por modelo: acuracia media e latencia p50/p95 (so execucoes concluidas entram na latencia).
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const col = (rs: Row[], k: string): number[] => rs.map((r) => r.scores[k]).filter((v): v is number => v !== undefined && !Number.isNaN(v))
const fmt = (n: number, d = 2): string => (Number.isNaN(n) ? '  -' : n.toFixed(d))

console.log('\n' + ['modelo'.padEnd(46), 'ok', 'kw', 'judge', 'sinais', 'lat p50', 'lat p95', 'retries'].join('  '))
const summary = env.MODELS.map((model) => {
  const rs = rows.filter((r) => r.model === model)
  const done = rs.filter((r) => r.ok)
  const line = {
    model,
    completed: mean(col(rs, 'completed')),
    keywords: mean(col(done, 'root_cause_keywords')),
    judge: mean(col(done, 'judge_root_cause')),
    signals: mean(col(done, 'signal_coverage')),
    latencyP50: percentile(col(done, 'latency_total_ms'), 50),
    latencyP95: percentile(col(done, 'latency_total_ms'), 95),
    retries: mean(col(rs, 'retries'))
  }
  console.log([model.padEnd(46), fmt(line.completed), fmt(line.keywords), fmt(line.judge), fmt(line.signals), fmt(line.latencyP50, 0).padStart(7), fmt(line.latencyP95, 0).padStart(7), fmt(line.retries, 1)].join('  '))
  return line
})

mkdirSync('results', { recursive: true })
writeFileSync(`results/${batch}.json`, JSON.stringify({ batch, summary, rows }, null, 2))
console.log(`\nresumo salvo em results/${batch}.json | detalhes no Langfuse: Datasets > ${DATASET} > Runs`)
await flushLangfuse()
