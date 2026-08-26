import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const textDecoder = new TextDecoder()

export type Command = {
  command: string
  args: readonly string[]
  cwd: string
}

export type CommandResult = {
  exitCode: number
  stderr: string
  stdout: string
}

export type CommandRunner = (command: Command) => CommandResult

export type RatchetOptions = {
  baseRef?: string
  oxlintPath?: string
  repoRoot?: string
  run?: CommandRunner
}

type OxlintDiagnostic = {
  code?: string
  file?: string
  filename?: string
  path?: string
  rule?: string
  severity?: string
}

type OxlintReport = {
  diagnostics?: OxlintDiagnostic[]
}

type WarningCounts = Map<string, number>

export type RatchetResult = {
  changedFiles: number
  mergeBase: string
}

function decode(output: Uint8Array | undefined): string {
  return output === undefined ? '' : textDecoder.decode(output)
}

function defaultRun({ command, args, cwd }: Command): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  })

  return {
    exitCode: result.exitCode,
    stderr: decode(result.stderr),
    stdout: decode(result.stdout),
  }
}

function runGit(run: CommandRunner, repoRoot: string, args: readonly string[]): CommandResult {
  const result = run({ args, command: 'git', cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result
}

function normalizePath(filename: string, cwd: string): string {
  const absoluteFilename = isAbsolute(filename) ? filename : resolve(cwd, filename)
  return relative(cwd, absoluteFilename).split(sep).join('/').replace(/^\.\//, '')
}

function diagnosticFilename(diagnostic: OxlintDiagnostic): string | undefined {
  return diagnostic.filename ?? diagnostic.file ?? diagnostic.path
}

function diagnosticRule(diagnostic: OxlintDiagnostic): string {
  return diagnostic.code ?? diagnostic.rule ?? 'unknown-rule'
}

function warningCounts(report: OxlintReport, cwd: string): WarningCounts {
  const counts: WarningCounts = new Map()

  for (const diagnostic of report.diagnostics ?? []) {
    if (diagnostic.severity?.toLowerCase() !== 'warning') continue

    const filename = diagnosticFilename(diagnostic)
    if (filename === undefined) continue

    const key = `${normalizePath(filename, cwd)}\0${diagnosticRule(diagnostic)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return counts
}

function scanDiagnostics(report: OxlintReport, cwd: string): Array<{ file: string; rule: string }> {
  return (report.diagnostics ?? []).flatMap((diagnostic) => {
    const filename = diagnosticFilename(diagnostic)
    return filename === undefined
      ? []
      : [{ file: normalizePath(filename, cwd), rule: diagnosticRule(diagnostic) }]
  })
}

function parseReport(result: CommandResult, label: string): OxlintReport {
  try {
    const report: OxlintReport = JSON.parse(result.stdout)
    return report
  } catch {
    throw new Error(`${label} Oxlint scan did not produce JSON: ${result.stderr.trim()}`)
  }
}

function runOxlint(
  run: CommandRunner,
  oxlintPath: string,
  cwd: string,
  label: string,
): OxlintReport {
  const result = run({ args: ['.', '--format', 'json'], command: oxlintPath, cwd })
  const report = parseReport(result, label)
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      `${label} Oxlint scan failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    )
  }
  if (result.exitCode === 1 && (report.diagnostics?.length ?? 0) === 0) {
    throw new Error(`${label} Oxlint scan failed without diagnostics: ${result.stderr.trim()}`)
  }
  if (result.exitCode === 1 && scanDiagnostics(report, cwd).length === 0) {
    throw new Error(
      `${label} Oxlint scan has a configuration or execution diagnostic: ${result.stderr.trim()}`,
    )
  }
  return report
}

/** Maps each changed HEAD path to its corresponding base path, if it has one. */
export function changedPaths(nameStatus: string): Map<string, string | undefined> {
  const paths = new Map<string, string | undefined>()
  const tokens = nameStatus.split('\0')

  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++]
    if (status === undefined || status === '') continue

    if (status.startsWith('R')) {
      recordRename(paths, tokens[index++], tokens[index++])
      continue
    }

    recordPath(paths, status, tokens[index++])
  }

  return paths
}

function recordRename(
  paths: Map<string, string | undefined>,
  basePath: string | undefined,
  headPath: string | undefined,
): void {
  if (basePath !== undefined && headPath !== undefined) paths.set(headPath, basePath)
}

function recordPath(
  paths: Map<string, string | undefined>,
  status: string,
  path: string | undefined,
): void {
  if (path === undefined || status.startsWith('D')) return
  paths.set(path, status.startsWith('A') || status.startsWith('C') ? undefined : path)
}

function copyHeadPolicy(repoRoot: string, baseWorktree: string): void {
  const sourceConfig = join(repoRoot, 'oxlint.config.ts')
  const sourceTools = join(repoRoot, 'tools', 'oxlint')
  if (!existsSync(sourceConfig) || !existsSync(sourceTools)) {
    throw new Error('Oxlint policy is incomplete: expected oxlint.config.ts and tools/oxlint/')
  }

  cpSync(sourceConfig, join(baseWorktree, 'oxlint.config.ts'), { force: true })
  const destinationTools = join(baseWorktree, 'tools', 'oxlint')
  rmSync(destinationTools, { force: true, recursive: true })
  mkdirSync(join(baseWorktree, 'tools'), { recursive: true })
  cpSync(sourceTools, destinationTools, { force: true, recursive: true })
}

function baseWorktreePath(repoRoot: string): string {
  const repository = resolve(repoRoot)
  // Unique per process so concurrent runs cannot remove each other's worktree mid-scan.
  const baseWorktree = resolve(repository, '.cache', `ratchet-base-${process.pid}`)
  if (!relative(repository, baseWorktree).startsWith('.cache/ratchet-base-')) {
    throw new Error('Ratchet base worktree must remain inside the repository')
  }
  return baseWorktree
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path)
}

function registeredWorktrees(run: CommandRunner, repoRoot: string): Set<string> {
  const output = runGit(run, repoRoot, ['worktree', 'list', '--porcelain']).stdout
  return new Set(
    output
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonicalPath(line.slice('worktree '.length))),
  )
}

function removeBaseWorktree(run: CommandRunner, repoRoot: string, baseWorktree: string): void {
  const registered = registeredWorktrees(run, repoRoot).has(canonicalPath(baseWorktree))
  const present = existsSync(baseWorktree)
  if (!registered && !present) return
  if (!registered) {
    throw new Error(
      `Refusing to remove ${baseWorktree}: it exists but is not a registered Git worktree. Remove it manually.`,
    )
  }

  const result = run({
    args: ['worktree', 'remove', '--force', baseWorktree],
    command: 'git',
    cwd: repoRoot,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not remove ratchet base worktree at ${baseWorktree}: ${result.stderr.trim()}`,
    )
  }
}

function prepareBaseWorktree(
  run: CommandRunner,
  repoRoot: string,
  mergeBase: string,
  baseWorktree: string,
): void {
  removeBaseWorktree(run, repoRoot, baseWorktree)

  mkdirSync(join(repoRoot, '.cache'), { recursive: true })
  runGit(run, repoRoot, ['worktree', 'add', '--detach', '--force', baseWorktree, mergeBase])
  try {
    copyHeadPolicy(repoRoot, baseWorktree)
  } catch (error) {
    removeBaseWorktree(run, repoRoot, baseWorktree)
    throw error
  }
}

function countForFileRule(counts: WarningCounts, file: string, rule: string): number {
  return counts.get(`${file}\0${rule}`) ?? 0
}

function reportNewWarnings(
  changed: Map<string, string | undefined>,
  baseWarnings: WarningCounts,
  headWarnings: WarningCounts,
): string[] {
  const failures: string[] = []
  for (const [headPath, basePath] of changed) {
    const prefix = `${headPath}\0`
    for (const [headKey, headCount] of headWarnings) {
      if (!headKey.startsWith(prefix)) continue
      const rule = headKey.slice(prefix.length)
      const baseCount = basePath === undefined ? 0 : countForFileRule(baseWarnings, basePath, rule)
      if (headCount > baseCount) {
        failures.push(`- ${headPath} [${rule}]: ${baseCount} -> ${headCount} warnings`)
      }
    }
  }
  return failures
}

// The copied plugin directory must stay ignored by the policy. A diagnostic under it means
// the base scan is linting the plugin source, which would corrupt the comparison.
function assertBasePluginIsIgnored(report: OxlintReport, baseWorktree: string): void {
  const pluginDiagnostics = scanDiagnostics(report, baseWorktree).filter(({ file }) =>
    file.startsWith('tools/oxlint/'),
  )
  if (pluginDiagnostics.length === 0) return

  const details = pluginDiagnostics.map(({ file, rule }) => `- ${file} [${rule}]`).join('\n')
  throw new Error(`Base scan must have zero diagnostics under tools/oxlint/:\n${details}`)
}

function collectChangedPaths(
  run: CommandRunner,
  repoRoot: string,
  mergeBase: string,
  baseWorktree: string,
): Map<string, string | undefined> {
  const changed = changedPaths(
    runGit(run, repoRoot, ['diff', '--name-status', '-z', '-M', mergeBase]).stdout,
  )
  const baseWorktreeRelative = normalizePath(baseWorktree, repoRoot)
  const untracked = runGit(run, repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).stdout
  for (const path of untracked.split('\0')) {
    if (path !== '' && !path.startsWith(`${baseWorktreeRelative}/`)) changed.set(path, undefined)
  }
  return changed
}

function assertNoNewWarnings(
  changed: Map<string, string | undefined>,
  baseReport: OxlintReport,
  baseWorktree: string,
  headReport: OxlintReport,
  repoRoot: string,
): void {
  const failures = reportNewWarnings(
    changed,
    warningCounts(baseReport, baseWorktree),
    warningCounts(headReport, repoRoot),
  )
  if (failures.length > 0) throw new Error(`Oxlint ratchet failed:\n${failures.join('\n')}`)
}

export function runRatchet(options: RatchetOptions = {}): RatchetResult {
  const run = options.run ?? defaultRun
  const repoRoot = resolve(
    options.repoRoot ?? runGit(run, process.cwd(), ['rev-parse', '--show-toplevel']).stdout.trim(),
  )
  const baseRef = options.baseRef ?? 'origin/main'
  const mergeBase = runGit(run, repoRoot, ['merge-base', baseRef, 'HEAD']).stdout.trim()
  const baseWorktree = baseWorktreePath(repoRoot)
  const oxlintPath = options.oxlintPath ?? join(repoRoot, 'node_modules', '.bin', 'oxlint')

  prepareBaseWorktree(run, repoRoot, mergeBase, baseWorktree)
  try {
    const baseReport = runOxlint(run, oxlintPath, baseWorktree, 'Base')
    assertBasePluginIsIgnored(baseReport, baseWorktree)
    const headReport = runOxlint(run, oxlintPath, repoRoot, 'HEAD')
    const changed = collectChangedPaths(run, repoRoot, mergeBase, baseWorktree)
    assertNoNewWarnings(changed, baseReport, baseWorktree, headReport, repoRoot)
    return { changedFiles: changed.size, mergeBase }
  } finally {
    removeBaseWorktree(run, repoRoot, baseWorktree)
  }
}

function parseArgs(arguments_: readonly string[]): RatchetOptions {
  let baseRef: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) continue
    if (argument === '--base') {
      baseRef = arguments_[index + 1]
      if (baseRef === undefined) throw new Error('--base requires a ref')
      index += 1
    } else if (argument.startsWith('--base=')) {
      baseRef = argument.slice('--base='.length)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return { baseRef }
}

if (import.meta.main) {
  try {
    const result = runRatchet(parseArgs(Bun.argv.slice(2)))
    console.log(`Oxlint ratchet passed for ${result.changedFiles} changed file(s).`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
