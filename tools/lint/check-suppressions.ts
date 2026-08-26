import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseSync } from 'oxc-parser'

const DEFAULT_BASE = 'origin/main'
const SAFETY_MARKER = '-- SAFETY:'
// Oxlint honors a directive only at the start of a comment. The parser supplies real comments,
// so prose, strings, and template contents that mention one are not directives.
const DIRECTIVE_PATTERN = /^\s*((?:oxlint|eslint)-disable(?:(?:-next)?-line)?)\b(.*)$/u
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

// Changes to these paths alter what the lint gate enforces, so the summary calls them out.
const POLICY_PATHS = [
  '.github/workflows',
  'oxlint.config.ts',
  'package.json',
  'tools/lint',
  'tools/oxlint',
  'tsconfig.json',
  'tsconfig.tools.json',
]

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
  policyChanges: string[]
  suppressions: Suppression[]
  violations: SuppressionViolation[]
}

interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

type CommandRunner = (arguments_: string[]) => CommandResult
type FileReader = (file: string) => string

function commandOutput(arguments_: string[]): CommandResult {
  const result = Bun.spawnSync({ cmd: ['git', ...arguments_], stderr: 'pipe', stdout: 'pipe' })

  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

function gitOrThrow(arguments_: string[], run: CommandRunner): string {
  const result = run(arguments_)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || 'git command failed without an error message'
    throw new Error(`git ${arguments_.join(' ')} failed: ${detail}`)
  }

  return result.stdout
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file))
}

function isPolicyPath(file: string): boolean {
  return POLICY_PATHS.some((path) => file === path || file.startsWith(`${path}/`))
}

/** Extracts only added source lines and their new-file locations from a unified git diff. */
export function parseAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = []
  let file: string | undefined
  let newLine = 0
  let inHunk = false

  for (const rawLine of diff.split('\n')) {
    // CRLF content would otherwise hide the line end from every pattern below.
    const line = rawLine.replace(/\r$/u, '')

    if (line.startsWith('+++ ')) {
      // Git appends a tab after paths that contain spaces.
      const path = line.slice(4).replace(/\t$/u, '')
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

function directiveMatch(comment: string): RegExpExecArray | null {
  return DIRECTIVE_PATTERN.exec(comment)
}

function safetyReason(rest: string, markerIndex: number): string {
  if (markerIndex === -1) {
    return ''
  }

  return rest
    .slice(markerIndex + SAFETY_MARKER.length)
    .replace(/\*\/\s*$/u, '')
    .trim()
}

function inspectDirective(line: AddedLine): Inspection {
  const match = directiveMatch(line.content)
  if (!match) {
    return undefined
  }

  const directive = match[1] ?? ''
  const rest = match[2] ?? ''
  // Both -line and -next-line end in "-line"; anything else is file-level.
  if (!directive.endsWith('-line')) {
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

  const reason = safetyReason(rest, markerIndex)
  if (!reason) {
    return {
      violation: violation(line, `${directive} must include a nonempty ${SAFETY_MARKER} reason`),
    }
  }

  return { suppression: { file: line.file, line: line.line, reason, rules } }
}

function lineAtOffset(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function commentsOnAddedLines(lines: AddedLine[], read: FileReader): AddedLine[] {
  const addedByFile = new Map<string, Set<number>>()
  for (const { file, line } of lines) {
    if (isSourceFile(file)) {
      const added = addedByFile.get(file) ?? new Set<number>()
      added.add(line)
      addedByFile.set(file, added)
    }
  }

  return [...addedByFile].flatMap(([file, added]) => {
    const source = read(file)
    return parseSync(file, source).comments.flatMap((comment) => {
      const line = lineAtOffset(source, comment.start)
      return added.has(line) ? [{ content: comment.value, file, line }] : []
    })
  })
}

/** Validates directives in parser-confirmed comments that start on added source lines. */
export function inspectAddedSuppressions(lines: AddedLine[], read: FileReader): CheckResult {
  const suppressions: Suppression[] = []
  const violations: SuppressionViolation[] = []

  for (const line of commentsOnAddedLines(lines, read)) {
    const inspection = inspectDirective(line)
    if (inspection && 'suppression' in inspection) {
      suppressions.push(inspection.suppression)
    } else if (inspection) {
      violations.push(inspection.violation)
    }
  }

  return { policyChanges: [], suppressions, violations }
}

function suppressionsMarkdown(suppressions: Suppression[]): string[] {
  if (suppressions.length === 0) {
    return []
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
  ]
}

function policyChangesMarkdown(policyChanges: string[]): string[] {
  if (policyChanges.length === 0) {
    return []
  }

  return ['## Lint policy files changed', '', ...policyChanges.map((file) => `- ${file}`), '']
}

export function summaryMarkdown(
  result: Pick<CheckResult, 'policyChanges' | 'suppressions'>,
): string {
  const lines = [
    ...suppressionsMarkdown(result.suppressions),
    ...policyChangesMarkdown(result.policyChanges),
  ]
  return lines.length === 0 ? '' : lines.join('\n')
}

export async function appendStepSummary(
  summaryPath: string | undefined,
  result: Pick<CheckResult, 'policyChanges' | 'suppressions'>,
): Promise<void> {
  const summary = summaryMarkdown(result)
  if (summaryPath && summary) {
    await appendFile(summaryPath, `${summary}\n`)
  }
}

/**
 * Compares the working tree (tracked changes plus untracked files) with the merge base, the
 * same scope the ratchet uses, so a local run sees exactly what CI will see after a commit.
 */
export function checkSuppressions(
  base = DEFAULT_BASE,
  run: CommandRunner = commandOutput,
  read: FileReader = readSource,
): CheckResult {
  const mergeBase = gitOrThrow(['merge-base', base, 'HEAD'], run).trim()
  if (!mergeBase) {
    throw new Error(`git merge-base ${base} HEAD returned no commit`)
  }

  const diff = gitOrThrow(
    ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--unified=0', mergeBase, '--'],
    run,
  )
  const trackedPolicyChanges = gitOrThrow(
    ['diff', '--name-only', mergeBase, '--', ...POLICY_PATHS],
    run,
  )
    .split('\n')
    .filter(Boolean)
  const untracked = gitOrThrow(['ls-files', '--others', '--exclude-standard', '-z'], run)
    .split('\0')
    .filter(Boolean)

  const lines = [
    ...parseAddedLines(diff),
    ...untracked.filter(isSourceFile).flatMap((file) =>
      read(file)
        .split('\n')
        .map((_, index) => ({ content: '', file, line: index + 1 })),
    ),
  ]
  const policyChanges = [...trackedPolicyChanges, ...untracked.filter(isPolicyPath)]

  return { ...inspectAddedSuppressions(lines, read), policyChanges }
}

function parseBase(arguments_: string[]): string {
  if (arguments_.length === 0) {
    return DEFAULT_BASE
  }
  if (arguments_.length === 1 && arguments_[0]?.startsWith('--base=')) {
    return arguments_[0].slice('--base='.length)
  }
  if (arguments_.length === 2 && arguments_[0] === '--base' && arguments_[1]) {
    return arguments_[1]
  }

  throw new Error('Usage: bun tools/lint/check-suppressions.ts [--base <git-ref>]')
}

async function main(): Promise<void> {
  const result = checkSuppressions(parseBase(Bun.argv.slice(2)))
  await appendStepSummary(Bun.env.GITHUB_STEP_SUMMARY, result)

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
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
