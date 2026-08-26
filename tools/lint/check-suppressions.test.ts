import { describe, expect, test } from 'bun:test'

import {
  appendStepSummary,
  checkSuppressions,
  inspectAddedSuppressions,
  parseAddedLines,
  summaryMarkdown,
  type Suppression,
} from './check-suppressions'

const sampleDiff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1,10 @@
+// SAFETY: An ordinary plugin comment is not a lint directive.
+// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: The boundary validates this value.
+typeof input === 'string'
+/* eslint-disable-line no-console, @typescript-eslint/no-explicit-any -- SAFETY: CLI output and a typed adapter are intentional. */
+console.log(input as any)
+// eslint-disable no-console -- SAFETY: File-wide suppression is not allowed.
+// oxlint-disable no-console -- SAFETY: File-wide suppression is not allowed.
+// eslint-disable-line -- SAFETY: Rules are required.
+// eslint-disable-next-line no-alert -- SAFETY:
+// eslint-disable-line no-alert
`

describe('check-suppressions', () => {
  test('parses added lines with their new-file locations', () => {
    expect(parseAddedLines(sampleDiff).map(({ file, line }) => ({ file, line }))).toEqual([
      { file: 'src/example.ts', line: 1 },
      { file: 'src/example.ts', line: 2 },
      { file: 'src/example.ts', line: 3 },
      { file: 'src/example.ts', line: 4 },
      { file: 'src/example.ts', line: 5 },
      { file: 'src/example.ts', line: 6 },
      { file: 'src/example.ts', line: 7 },
      { file: 'src/example.ts', line: 8 },
      { file: 'src/example.ts', line: 9 },
      { file: 'src/example.ts', line: 10 },
    ])
  })

  test('accepts scoped line suppressions with a rule and SAFETY reason', () => {
    const result = inspectAddedSuppressions(parseAddedLines(sampleDiff))

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
    ])
    expect(result.violations.map((item) => item.message)).toEqual([
      'eslint-disable is file-level; use only -line or -next-line directives',
      'oxlint-disable is file-level; use only -line or -next-line directives',
      'eslint-disable-line must name at least one rule',
      'eslint-disable-next-line must include a nonempty -- SAFETY: reason',
      'eslint-disable-line must include a nonempty -- SAFETY: reason',
    ])
  })

  test('ignores ordinary SAFETY comments and directive-like string contents', () => {
    expect(
      inspectAddedSuppressions([
        {
          content: '// SAFETY: This is a plugin-specific invariant.',
          file: 'src/example.ts',
          line: 1,
        },
        {
          content: "const example = '// oxlint-disable no-console'",
          file: 'src/example.ts',
          line: 2,
        },
      ]),
    ).toEqual({ suppressions: [], violations: [] })
  })

  test('uses the merge base and diff through an injected git runner', () => {
    const commands: string[][] = []
    const result = checkSuppressions('base-ref', (arguments_) => {
      commands.push(arguments_)
      if (arguments_[0] === 'merge-base') {
        return { exitCode: 0, stderr: '', stdout: 'abc123\n' }
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout:
          'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+// oxlint-disable-line no-console -- SAFETY: Test output.\n',
      }
    })

    expect(commands).toEqual([
      ['merge-base', 'base-ref', 'HEAD'],
      ['diff', '--no-ext-diff', '--unified=0', 'abc123...HEAD', '--'],
    ])
    expect(result.violations).toEqual([])
    expect(result.suppressions).toHaveLength(1)
  })

  test('formats and appends compliant suppressions to the GitHub step summary', async () => {
    const suppressions: Suppression[] = [
      { file: 'src/example.ts', line: 2, reason: 'A | B is intentional.', rules: ['no-console'] },
    ]
    expect(summaryMarkdown(suppressions)).toContain(
      '| src/example.ts:2 | no-console | A \\| B is intentional. |',
    )

    const path = `${Bun.env.TMPDIR ?? '/tmp'}/check-suppressions-${crypto.randomUUID()}.md`
    await appendStepSummary(path, suppressions)
    expect(await Bun.file(path).text()).toContain('## Added lint suppressions')
  })
})
