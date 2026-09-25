import { loadEnv } from '../lib/env.ts'
import { fetchModels, isFree, supportsTools } from '../lib/openrouter.ts'

// Descobre modelos gratuitos que suportam tool calling (necessario para o agente usar o MCP).
const key = process.env.OPENROUTER_API_KEY ?? loadEnv().OPENROUTER_API_KEY
const models = (await fetchModels(key)).filter((m) => isFree(m) && supportsTools(m))
console.log(`${models.length} modelos gratuitos com tool calling:\n`)
for (const m of models.sort((a, b) => b.context_length - a.context_length)) {
  console.log(`${m.id.padEnd(60)} ctx=${m.context_length}`)
}
