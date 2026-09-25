import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadFixtures, matchFixture } from './fixtures.ts'

/**
 * "Grafana falso": expoe as mesmas ferramentas do mcp-grafana (nomes e argumentos principais),
 * mas responde com evidencias GRAVADAS de um incidente real. Todos os modelos avaliados veem
 * exatamente os mesmos dados, entao a unica variavel do benchmark e o modelo.
 *
 * Cenario escolhido por env: SCENARIO=db-leaky-connections
 */
const scenario = process.env.SCENARIO ?? 'db-leaky-connections'
const fixtures = loadFixtures(scenario)

const server = new McpServer({ name: 'incident-sim', version: '0.1.0' })

const ds = z.string().describe('UID do datasource (use list_datasources para descobrir)')

interface ToolDef {
  name: string
  description: string
  shape: z.ZodRawShape
}

const tools: ToolDef[] = [
  { name: 'list_datasources', description: 'Lista os datasources do Grafana (Prometheus, Loki, Tempo) com seus UIDs.', shape: {} },
  { name: 'list_loki_label_names', description: 'Lista os nomes de labels disponiveis no Loki.', shape: { datasourceUid: ds } },
  { name: 'list_loki_label_values', description: 'Lista os valores de um label do Loki (ex.: service_name).', shape: { datasourceUid: ds, labelName: z.string() } },
  { name: 'list_prometheus_metric_names', description: 'Lista nomes de metricas do Prometheus, opcionalmente filtrando por regex.', shape: { datasourceUid: ds, regex: z.string().optional() } },
  {
    name: 'query_prometheus',
    description: 'Executa uma consulta PromQL.',
    shape: { datasourceUid: ds, expr: z.string().describe('Expressao PromQL'), startTime: z.string().describe("Ex.: 'now' ou 'now-1h'"), queryType: z.enum(['instant', 'range']).optional(), stepSeconds: z.number().optional(), endTime: z.string().optional() }
  },
  {
    name: 'query_loki_logs',
    description: 'Executa uma consulta LogQL (logs ou metricas de logs).',
    shape: { datasourceUid: ds, logql: z.string().describe('Expressao LogQL'), limit: z.number().optional(), direction: z.enum(['forward', 'backward']).optional(), startRfc3339: z.string().optional(), endRfc3339: z.string().optional(), queryType: z.enum(['instant', 'range']).optional(), step: z.number().optional() }
  },
  { name: 'query_loki_stats', description: 'Estatisticas (streams, entradas, bytes) de um seletor LogQL.', shape: { datasourceUid: ds, logql: z.string(), startRfc3339: z.string().optional(), endRfc3339: z.string().optional() } },
  { name: 'tempo_traceql-search', description: 'Busca traces no Tempo com TraceQL, ex.: { status = error }.', shape: { datasourceUid: ds, query: z.string(), limit: z.number().optional() } },
  { name: 'tempo_get-trace', description: 'Retorna um trace completo (spans, atributos, excecoes) pelo trace_id.', shape: { datasourceUid: ds, trace_id: z.string() } }
]

for (const def of tools) {
  server.registerTool(def.name, { description: def.description, inputSchema: def.shape }, async (args: Record<string, unknown>) => {
    const result = matchFixture(fixtures, def.name, args)
    if (result === undefined) {
      return { isError: true, content: [{ type: 'text' as const, text: 'Sem dados para esta consulta no cenario simulado.' }] }
    }
    return { content: [{ type: 'text' as const, text: result }] }
  })
}

await server.connect(new StdioServerTransport())
