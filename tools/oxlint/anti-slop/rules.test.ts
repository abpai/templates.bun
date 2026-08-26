import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const ruleNames = [
  'no-chained-type-assertions',
  'no-conditional-empty-object-spread',
  'no-known-value-widening',
  'no-module-mocking',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
] as const

interface Diagnostic {
  readonly code: string
  readonly filename: string
}

interface OxlintReport {
  readonly diagnostics: readonly Diagnostic[]
  readonly number_of_files: number
  readonly number_of_rules: number
}

const repositoryRoot = join(import.meta.dir, '../../..')
const fixturesDirectory = join(import.meta.dir, '__fixtures__')
const configPath = join(import.meta.dir, 'fixtures.config.ts')
const oxlintPath = join(repositoryRoot, 'node_modules/.bin/oxlint')

const result = Bun.spawnSync({
  cmd: [oxlintPath, '--config', configPath, '--format', 'json', fixturesDirectory],
  cwd: repositoryRoot,
  stderr: 'pipe',
  stdout: 'pipe',
})

const stdout = result.stdout.toString()
const stderr = result.stderr.toString()

if (stdout.length === 0) {
  throw new Error(`Oxlint fixture run produced no JSON output. ${stderr}`)
}

const report = JSON.parse(stdout) as OxlintReport

function fixtureDiagnostics(ruleName: string, fixtureName: 'invalid' | 'valid') {
  const suffix = [ruleName, `${fixtureName}.fixture.ts`].join('/')
  return report.diagnostics.filter((diagnostic) =>
    diagnostic.filename.replaceAll('\\', '/').endsWith(suffix),
  )
}

describe('anti-slop Oxlint plugin', () => {
  test('runs every fixture in one Oxlint invocation', () => {
    expect(report.number_of_files).toBe((ruleNames.length + 1) * 2)
    expect(report.number_of_rules).toBe(ruleNames.length + 1)
  })

  test('complexity uses a maximum of 10 with the modified switch variant', () => {
    expect(fixtureDiagnostics('complexity', 'invalid').map(({ code }) => code)).toContain(
      'eslint(complexity)',
    )
    expect(fixtureDiagnostics('complexity', 'valid')).toEqual([])
  })

  for (const ruleName of ruleNames) {
    test(`${ruleName} reports only its invalid fixture`, () => {
      const expectedCode = `anti-slop(${ruleName})`
      expect(fixtureDiagnostics(ruleName, 'invalid').map(({ code }) => code)).toContain(
        expectedCode,
      )
      expect(fixtureDiagnostics(ruleName, 'valid')).toEqual([])
    })
  }
})
