import { appendFile } from 'node:fs/promises'

const DEFAULT_BASE = 'origin/main'
const SAFETY_MARKER = '-- SAFETY:'
const DIRECTIVE_PATTERN =
  /^\s*(?:\/\/|\/\*|\*)\s*((?:oxlint|eslint)-disable(?:(?:-next)?-line)?)(.*)$/u

export interface AddedLine {
  file: string
  line: number
  content: string
}

export interface Suppression {
  file: string
  line: number
  rules: string[]
  reason: string
}

export interface SuppressionViolation {
  file: string
  line: number
  message: string
}

export interface CheckResult {
  suppressions: Suppression[]
  violations: SuppressionViolation[]
}

interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

type CommandRunner = (arguments_: string[]) => CommandResult

function commandOutput(arguments_: string[]): CommandResult {
  const result = Bun.spawnSync({ cmd: ['git', ...arguments_], stderr: 'pipe', stdout: 'pipe' })

  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

function gitOrThrow(arguments_: string[], run: CommandRunner): string {
  const result = run(arguments_)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || 'git command failed without an error message'
    throw new Error(`git ${arguments_.join(' ')} failed: ${detail}`)
  }

  return result.stdout
}

/** Extracts only added source lines and their new-file locations from a unified git diff. */
export function parseAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = []
  let file: string | undefined
  let newLine = 0
  let inHunk = false

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      file = path === '/dev/null' ? undefined : path.replace(/^b\//u, '')
      continue
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }

    if (!inHunk || !file || line.startsWith('\\')) {
      continue
    }

    if (line.startsWith('+')) {
      addedLines.push({ content: line.slice(1), file, line: newLine })
      newLine += 1
    } else if (!line.startsWith('-')) {
      newLine += 1
    }
  }

  return addedLines
}

function ruleNames(value: string): string[] {
  return value
    .trim()
    .replace(/\*\/\s*$/u, '')
    .split(/[\s,]+/u)
    .filter(Boolean)
}

function violation(line: AddedLine, message: string): SuppressionViolation {
  return { file: line.file, line: line.line, message }
}

type Inspection = { suppression: Suppression } | { violation: SuppressionViolation } | undefined

function inspectDirective(line: AddedLine): Inspection {
  const match = DIRECTIVE_PATTERN.exec(line.content)
  if (!match) {
    return undefined
  }

  const [, directive = '', rest = ''] = match
  if (!directive.endsWith('-line') && !directive.endsWith('-next-line')) {
    return {
      violation: violation(
        line,
        `${directive} is file-level; use only -line or -next-line directives`,
      ),
    }
  }

  const markerIndex = rest.indexOf(SAFETY_MARKER)
  const rules = ruleNames(markerIndex === -1 ? rest : rest.slice(0, markerIndex))
  if (rules.length === 0) {
    return { violation: violation(line, `${directive} must name at least one rule`) }
  }

  const reason =
    markerIndex === -1
      ? ''
      : rest
          .slice(markerIndex + SAFETY_MARKER.length)
          .replace(/\*\/\s*$/u, '')
          .trim()
  if (!reason) {
    return {
      violation: violation(line, `${directive} must include a nonempty ${SAFETY_MARKER} reason`),
    }
  }

  return { suppression: { file: line.file, line: line.line, reason, rules } }
}

/** Validates only lint directives, never ordinary comments that happen to contain SAFETY:. */
export function inspectAddedSuppressions(lines: AddedLine[]): CheckResult {
  const suppressions: Suppression[] = []
  const violations: SuppressionViolation[] = []

  for (const line of lines) {
    const inspection = inspectDirective(line)
    if (inspection && 'suppression' in inspection) {
      suppressions.push(inspection.suppression)
    } else if (inspection) {
      violations.push(inspection.violation)
    }
  }

  return { suppressions, violations }
}

export function summaryMarkdown(suppressions: Suppression[]): string {
  if (suppressions.length === 0) {
    return ''
  }

  const rows = suppressions.map(
    ({ file, line, reason, rules }) =>
      `| ${file}:${line} | ${rules.join(', ')} | ${reason.replaceAll('|', '\\|')} |`,
  )

  return [
    '## Added lint suppressions',
    '',
    '| File | Rule | SAFETY reason |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

export async function appendStepSummary(
  summaryPath: string | undefined,
  suppressions: Suppression[],
): Promise<void> {
  const summary = summaryMarkdown(suppressions)
  if (summaryPath && summary) {
    await appendFile(summaryPath, `${summary}\n`)
  }
}

export function checkSuppressions(
  base = DEFAULT_BASE,
  run: CommandRunner = commandOutput,
): CheckResult {
  const mergeBase = gitOrThrow(['merge-base', base, 'HEAD'], run).trim()
  if (!mergeBase) {
    throw new Error(`git merge-base ${base} HEAD returned no commit`)
  }

  const diff = gitOrThrow(
    ['diff', '--no-ext-diff', '--unified=0', `${mergeBase}...HEAD`, '--'],
    run,
  )
  return inspectAddedSuppressions(parseAddedLines(diff))
}

function parseBase(arguments_: string[]): string {
  if (arguments_.length === 0) {
    return DEFAULT_BASE
  }
  if (arguments_.length === 2 && arguments_[0] === '--base' && arguments_[1]) {
    return arguments_[1]
  }

  throw new Error('Usage: bun tools/lint/check-suppressions.ts [--base <git-ref>]')
}

async function main(): Promise<void> {
  const result = checkSuppressions(parseBase(Bun.argv.slice(2)))
  await appendStepSummary(Bun.env.GITHUB_STEP_SUMMARY, result.suppressions)

  if (result.violations.length > 0) {
    console.error(`Lint suppression check failed (${result.violations.length}):`)
    for (const item of result.violations) {
      console.error(`- ${item.file}:${item.line}: ${item.message}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Lint suppression check passed: ${result.suppressions.length} added directive(s).`)
}

if (import.meta.main) {
  await main()
}
