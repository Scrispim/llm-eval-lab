import OpenAI from 'openai'

// OpenRouter e compativel com a API da OpenAI: so trocamos a baseURL.
export function createOpenRouter (apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0 // retentativas sao feitas (e contadas) pelo agente, para nao poluir a latencia
  })
}

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  supported_parameters?: string[]
  pricing?: { prompt: string, completion: string }
}

export async function fetchModels (apiKey: string): Promise<OpenRouterModel[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`OpenRouter /models -> ${res.status}`)
  const body = await res.json() as { data: OpenRouterModel[] }
  return body.data
}

export const isFree = (m: OpenRouterModel): boolean =>
  m.id.endsWith(':free') || (m.pricing?.prompt === '0' && m.pricing?.completion === '0')

export const supportsTools = (m: OpenRouterModel): boolean =>
  m.supported_parameters?.includes('tools') ?? false
