import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface FixtureEntry {
  tool: string
  /** Regex (case-insensitive) testada contra os argumentos serializados. Vazio = casa sempre. */
  when: string
  result: string
}

export interface ScenarioFixtures {
  scenario: string
  entries: FixtureEntry[]
}

export function loadFixtures (scenario: string): ScenarioFixtures {
  const path = fileURLToPath(new URL(`../../fixtures/${scenario}/tools.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as ScenarioFixtures
}

/**
 * Escolhe a resposta gravada para uma chamada de ferramenta.
 * Regra: a primeira entrada da ferramenta cujo `when` casa com os argumentos vence;
 * entradas com `when` vazio funcionam como fallback da ferramenta.
 */
export function matchFixture (fixtures: ScenarioFixtures, tool: string, args: unknown): string | undefined {
  const haystack = JSON.stringify(args ?? {})
  const candidates = fixtures.entries.filter((e) => e.tool === tool)
  const specific = candidates.find((e) => e.when !== '' && new RegExp(e.when, 'i').test(haystack))
  return (specific ?? candidates.find((e) => e.when === ''))?.result
}

export const toolNames = (f: ScenarioFixtures): string[] => [...new Set(f.entries.map((e) => e.tool))]
