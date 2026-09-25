import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keywordCoverage, noForbiddenClaims, signalCoverage } from './index.ts'
import type { InvestigationResult } from '../harness/agent.ts'

const groups = [['pool', 'conexoes'], ['timeout', 'esgot'], ['release', 'vazamento']]

test('keywordCoverage ignora acentos e caixa', () => {
  assert.equal(keywordCoverage('O POOL de conexões esgotou por vazamento', groups), 1)
})

test('keywordCoverage e parcial quando faltam grupos', () => {
  assert.equal(keywordCoverage('problema no pool', groups), 1 / 3)
})

test('noForbiddenClaims zera quando afirma causa proibida', () => {
  assert.equal(noForbiddenClaims('parece falta de memoria (OOM)', ['oom']), 0)
  assert.equal(noForbiddenClaims('pool esgotado', ['oom']), 1)
})

test('signalCoverage conta so ferramentas bem-sucedidas', () => {
  const call = (name: string, isError = false) => ({ name, args: {}, isError, latencyMs: 1 })
  const r = { toolCalls: [call('query_prometheus'), call('query_loki_logs', true), call('tempo_get-trace')] } as unknown as InvestigationResult
  assert.equal(signalCoverage(r, ['metrics', 'logs', 'traces']), 2 / 3)
})
