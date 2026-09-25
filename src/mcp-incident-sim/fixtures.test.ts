import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadFixtures, matchFixture, toolNames } from './fixtures.ts'

const f = loadFixtures('db-leaky-connections')

test('escolhe a entrada especifica quando o argumento casa', () => {
  const r = matchFixture(f, 'query_prometheus', { expr: 'sum by (http_route, http_status_code) (increase(http_server_duration_milliseconds_count[15m]))' })
  assert.match(r ?? '', /"500"|http_status_code/)
})

test('usa o fallback (when vazio) quando nada especifico casa', () => {
  assert.ok(matchFixture(f, 'list_datasources', {}))
})

test('retorna undefined para ferramenta sem fixture', () => {
  assert.equal(matchFixture(f, 'ferramenta_inexistente', {}), undefined)
})

test('expoe as tres familias de sinais', () => {
  const names = toolNames(f)
  assert.ok(names.some((n) => n.includes('prometheus')) && names.some((n) => n.includes('loki')) && names.some((n) => n.startsWith('tempo')))
})

// As fixtures sao gravadas de uma maquina de desenvolvimento e vao para um repositorio publico:
// nao podem carregar caminhos do usuario nem o IP real da rede local de quem gravou.
test('fixtures nao vazam caminhos pessoais nem IP de rede local', () => {
  const raw = JSON.stringify(f)
  assert.ok(!raw.includes('/Users/'), 'caminho de usuario')
  assert.ok(!/\b(192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.test(raw), 'IP de rede local')
})
