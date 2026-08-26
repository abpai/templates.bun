import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  appendStepSummary,
  checkSuppressions,
  inspectAddedSuppressions,
  parseAddedLines,
  summaryMarkdown,
  type Suppression,
} from './check-suppressions'

// The sample lives outside this source file so the suppression gate does not inspect it.
const sampleDiff = readFileSync(join(import.meta.dir, '__fixtures__', 'suppressions.diff'), 'utf8')
  // Line 16 of the sample is stored with a CRLF ending.
  .replace(
    '+const crlf = 1 // oxlint-disable-line no-console\n',
    '+const crlf = 1 // oxlint-disable-line no-console\r\n',
  )
const sampleLines = parseAddedLines(sampleDiff)

function sampleSource(file: string): string {
  return sampleLines
    .filter((line) => line.file === file)
    .map(
      ({ content, line }) =>
        `${content}${file === 'src/example.ts' && line === 16 ? '\r\n' : '\n'}`,
    )
    .join('')
}

describe('check-suppressions', () => {
  test('parses added lines with their new-file locations', () => {
    const lines = sampleLines
    expect(lines.filter(({ file }) => file === 'src/example.ts')).toHaveLength(20)
    expect(lines[0]).toEqual({
      content: '// SAFETY: An ordinary plugin comment is not a lint directive.',
      file: 'src/example.ts',
      line: 1,
    })
    expect(lines[15]?.content).toBe('const crlf = 1 // oxlint-disable-line no-console')
    expect(lines.at(-1)?.file).toBe('src/my file.ts')
  })

  test('accepts leading and trailing line suppressions with a rule and SAFETY reason', () => {
    const result = inspectAddedSuppressions(sampleLines, sampleSource)

    expect(result.suppressions).toEqual([
      {
        file: 'src/example.ts',
        line: 2,
        reason: 'The boundary validates this value.',
        rules: ['anti-slop/no-runtime-typeof'],
      },
      {
        file: 'src/example.ts',
        line: 4,
        reason: 'CLI output and a typed adapter are intentional.',
        rules: ['no-console', '@typescript-eslint/no-explicit-any'],
      },
      {
        file: 'src/example.ts',
        line: 11,
        reason: 'Parsed at the boundary.',
        rules: ['anti-slop/require-safety-comment-for-type-assertion'],
      },
      {
        file: 'src/example.ts',
        line: 15,
        reason: 'A comment after a string still counts.',
        rules: ['no-console'],
      },
      {
        file: 'src/example.ts',
        line: 17,
        reason: 'The parser must inspect every comment on this line.',
        rules: ['no-alert'],
      },
    ])
    expect(result.violations.map((item) => `${item.file}:${item.line}: ${item.message}`)).toEqual([
      'src/example.ts:6: eslint-disable is file-level; use only -line or -next-line directives',
      'src/example.ts:7: oxlint-disable is file-level; use only -line or -next-line directives',
      'src/example.ts:8: eslint-disable-line must name at least one rule',
      'src/example.ts:9: eslint-disable-next-line must include a nonempty -- SAFETY: reason',
      'src/example.ts:10: eslint-disable-line must include a nonempty -- SAFETY: reason',
      'src/example.ts:12: oxlint-disable-line must include a nonempty -- SAFETY: reason',
      'src/example.ts:16: oxlint-disable-line must include a nonempty -- SAFETY: reason',
      'src/my file.ts:1: oxlint-disable-line must include a nonempty -- SAFETY: reason',
    ])
  })

  test('ignores prose, string contents, and non-source files', () => {
    const result = inspectAddedSuppressions(sampleLines, sampleSource)
    const flagged = new Set([...result.suppressions, ...result.violations].map(({ line }) => line))

    // Line 13 is prose mentioning a directive, line 14 quotes one inside a string.
    expect(flagged.has(13)).toBe(false)
    expect(flagged.has(14)).toBe(false)
    expect(flagged.has(19)).toBe(false)
    expect(result.violations.some(({ file }) => file === 'README.md')).toBe(false)
  })

  test('scans tracked changes and untracked source files against the merge base', () => {
    const commands: string[][] = []
    const result = checkSuppressions(
      'base-ref',
      (arguments_) => {
        commands.push(arguments_)
        if (arguments_[0] === 'merge-base') {
          return { exitCode: 0, stderr: '', stdout: 'abc123\n' }
        }
        if (arguments_[0] === 'ls-files') {
          return { exitCode: 0, stderr: '', stdout: 'src/new.ts\0notes.md\0tools/lint/x.ts\0' }
        }
        if (arguments_[1] === '--name-only') {
          return { exitCode: 0, stderr: '', stdout: 'oxlint.config.ts\n' }
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout:
            'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+// oxlint-disable-line no-console -- SAFETY: Test output.\n',
        }
      },
      (file) =>
        file === 'a.ts'
          ? '// oxlint-disable-line no-console -- SAFETY: Test output.\n'
          : `// ${file}\n// oxlint-disable-line no-alert\n`,
    )

    expect(commands.map((command) => command.filter((part) => part !== 'abc123'))).toEqual([
      ['merge-base', 'base-ref', 'HEAD'],
      ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--unified=0', '--'],
      expect.arrayContaining(['diff', '--name-only', 'oxlint.config.ts']),
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ])
    expect(result.suppressions).toHaveLength(1)
    expect(result.violations.map(({ file, line }) => `${file}:${line}`)).toEqual([
      'src/new.ts:2',
      'tools/lint/x.ts:2',
    ])
    expect(result.policyChanges).toEqual(['oxlint.config.ts', 'tools/lint/x.ts'])
  })

  test('formats suppressions and policy changes into the GitHub step summary', async () => {
    const suppressions: Suppression[] = [
      { file: 'src/example.ts', line: 2, reason: 'A | B is intentional.', rules: ['no-console'] },
    ]
    const summary = summaryMarkdown({ policyChanges: ['oxlint.config.ts'], suppressions })
    expect(summary).toContain('| src/example.ts:2 | no-console | A \\| B is intentional. |')
    expect(summary).toContain('## Lint policy files changed\n\n- oxlint.config.ts')
    expect(summaryMarkdown({ policyChanges: [], suppressions: [] })).toBe('')

    const path = `${Bun.env.TMPDIR ?? '/tmp'}/check-suppressions-${crypto.randomUUID()}.md`
    await appendStepSummary(path, { policyChanges: [], suppressions })
    expect(await Bun.file(path).text()).toContain('## Added lint suppressions')
  })
})
