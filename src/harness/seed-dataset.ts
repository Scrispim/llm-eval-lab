import { loadEnv } from '../lib/env.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

loadEnv()
const { langfuse, flushLangfuse } = await import('../lib/langfuse.ts')

interface DatasetFile {
  name: string
  description: string
  items: Array<{ id: string, input: unknown, expectedOutput: unknown, metadata?: Record<string, unknown> }>
}

const file = JSON.parse(readFileSync(fileURLToPath(new URL('../../dataset/incidents.json', import.meta.url)), 'utf8')) as DatasetFile

await langfuse.api.datasets.create({ name: file.name, description: file.description })
for (const item of file.items) {
  // `id` fixo torna o seed idempotente: rodar de novo atualiza o item em vez de duplicar.
  await langfuse.api.datasetItems.create({ datasetName: file.name, id: item.id, input: item.input, expectedOutput: item.expectedOutput, metadata: item.metadata })
  console.log(`item ${item.id} ok`)
}
console.log(`dataset "${file.name}" pronto (${file.items.length} itens)`)
await flushLangfuse()
