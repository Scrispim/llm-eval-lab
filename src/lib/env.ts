import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY ausente'),
  MODELS: z.string().default('').transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean)),
  JUDGE_MODEL: z.string().default(''),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, 'LANGFUSE_PUBLIC_KEY ausente'),
  LANGFUSE_SECRET_KEY: z.string().min(1, 'LANGFUSE_SECRET_KEY ausente'),
  LANGFUSE_BASE_URL: z.string().default('https://cloud.langfuse.com'),
  REPEATS: z.coerce.number().int().min(1).default(3),
  MAX_STEPS: z.coerce.number().int().min(1).default(15),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).default(1)
})

export type Env = z.infer<typeof schema>

export function loadEnv (): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.message}`).join('\n')
    throw new Error(`Configuracao invalida (veja .env.example):\n${problems}`)
  }
  return parsed.data
}
