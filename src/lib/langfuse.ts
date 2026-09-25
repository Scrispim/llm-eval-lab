import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseClient } from '@langfuse/client'

// Liga o tracing (OpenTelemetry -> Langfuse) e cria o client usado por datasets/experimentos.
// As credenciais vem de LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.
const spanProcessor = new LangfuseSpanProcessor()
const sdk = new NodeSDK({ spanProcessors: [spanProcessor] })
sdk.start()

export const langfuse = new LangfuseClient()

// Sem isso, spans e scores ainda em buffer se perdem quando o processo termina.
export async function flushLangfuse (): Promise<void> {
  await spanProcessor.forceFlush()
  await langfuse.flush()
  await sdk.shutdown()
}
