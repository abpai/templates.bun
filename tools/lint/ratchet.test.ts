import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { changedPaths, type Command, type CommandResult, runRatchet } from './ratchet'

const temporaryRepositories: string[] = []
const repositoryRoot = join(import.meta.dir, '..', '..')
const realOxlint = join(repositoryRoot, 'node_modules', '.bin', 'oxlint')

// Minimal policy with one directional rule. Every function with a branch has complexity 2.
const POLICY = `export default {
  categories: { correctness: 'off' },
  ignorePatterns: ['.cache/**'],
  rules: { 'eslint/complexity': ['warn', { max: 1 }] },
}
`

function branchy(name: string): string {
  return `export function ${name}(value: number) {\n  if (value > 0) return 1\n  return 0\n}\n`
}

function runCommand({ command, args, cwd }: Command): CommandResult {
  const result = Bun.spawnSync([command, ...args], { cwd, stderr: 'pipe', stdout: 'pipe' })
  const decoder = new TextDecoder()
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
}

function writeFiles(repository: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true })
    writeFileSync(join(repository, path), content)
  }
}

function makeRepository(files: Record<string, string> = {}): string {
  const repository = mkdtempSync(join(tmpdir(), 'oxlint-ratchet-'))
  temporaryRepositories.push(repository)
  mkdirSync(join(repository, 'node_modules', '.bin'), { recursive: true })
  writeFiles(repository, {
    'oxlint.config.ts': 'export default {}\n',
    'src/existing.ts': 'export const existing = 1\n',
    'tools/oxlint/plugin.ts': 'export {}\n',
    ...files,
  })
  runCommand({ command: 'git', args: ['init', '--quiet'], cwd: repository })
  runCommand({ command: 'git', args: ['add', '.'], cwd: repository })
  runCommand({
    command: 'git',
    args: [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '--quiet',
      '-m',
      'base',
    ],
    cwd: repository,
  })
  return repository
}

function isBaseWorktree(repository: string, cwd: string): boolean {
  return cwd.startsWith(join(repository, '.cache', 'ratchet-base-'))
}

function leftoverWorktrees(repository: string): string[] {
  const cache = join(repository, '.cache')
  try {
    return readdirSync(cache).filter((entry) => entry.startsWith('ratchet-base-'))
  } catch {
    return []
  }
}

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true })
  }
})

describe('runRatchet', () => {
  test('uses HEAD as the base and invokes the root Oxlint binary once per scan', () => {
    const repository = makeRepository()
    const invocations: Command[] = []
    const rootOxlint = join(repository, 'node_modules', '.bin', 'oxlint')
    const run = (command: Command): CommandResult => {
      invocations.push(command)
      if (command.command !== rootOxlint) return runCommand(command)
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ diagnostics: [] }),
      }
    }

    expect(runRatchet({ baseRef: 'HEAD', repoRoot: repository, run }).changedFiles).toBe(0)

    const oxlintCalls = invocations.filter(({ command }) => command === rootOxlint)
    expect(oxlintCalls).toHaveLength(2)
    expect(isBaseWorktree(repository, oxlintCalls[0]?.cwd ?? '')).toBe(true)
    expect(oxlintCalls[1]?.cwd).toBe(repository)
    expect(invocations.some(({ args }) => args.join(' ') === 'merge-base HEAD HEAD')).toBe(true)
  })

  test('rejects warnings in index and untracked changes', () => {
    const repository = makeRepository()
    writeFileSync(join(repository, 'src', 'existing.ts'), 'export const existing = 2\n')
    runCommand({ command: 'git', args: ['add', 'src/existing.ts'], cwd: repository })
    writeFileSync(join(repository, 'src', 'new.ts'), 'export const newValue = 1\n')
    const rootOxlint = join(repository, 'node_modules', '.bin', 'oxlint')
    const run = (command: Command): CommandResult => {
      if (command.command !== rootOxlint) return runCommand(command)
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          diagnostics: isBaseWorktree(repository, command.cwd)
            ? []
            : [
                {
                  code: 'eslint(complexity)',
                  filename: join(repository, 'src', 'existing.ts'),
                  severity: 'warning',
                },
                {
                  code: 'eslint(complexity)',
                  filename: join(repository, 'src', 'new.ts'),
                  severity: 'warning',
                },
              ],
        }),
      }
    }

    expect(() => runRatchet({ baseRef: 'HEAD', repoRoot: repository, run })).toThrow(
      'src/new.ts [eslint(complexity)]: 0 -> 1 warnings',
    )
  })

  test('maps renamed files from their base path', () => {
    expect(changedPaths('R100\0src/old.ts\0src/new.ts\0M\0src/c.ts\0')).toEqual(
      new Map([
        ['src/new.ts', 'src/old.ts'],
        ['src/c.ts', 'src/c.ts'],
      ]),
    )
  })

  test('rejects base diagnostics under the copied plugin directory', () => {
    const repository = makeRepository()
    const rootOxlint = join(repository, 'node_modules', '.bin', 'oxlint')
    const run = (command: Command): CommandResult => {
      if (command.command !== rootOxlint) return runCommand(command)
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          diagnostics: [
            {
              code: 'eslint(no-console)',
              filename: join(command.cwd, 'tools', 'oxlint', 'plugin.ts'),
              severity: 'warning',
            },
          ],
        }),
      }
    }

    expect(() => runRatchet({ baseRef: 'HEAD', repoRoot: repository, run })).toThrow(
      'Base scan must have zero diagnostics under tools/oxlint/',
    )
  })

  test('compares real Oxlint warnings between the merge base and the working tree', () => {
    const repository = makeRepository({
      'oxlint.config.ts': POLICY,
      'src/existing.ts': branchy('one'),
    })
    const options = { baseRef: 'HEAD', oxlintPath: realOxlint, repoRoot: repository }
    const existing = join(repository, 'src', 'existing.ts')

    writeFileSync(existing, branchy('one') + branchy('two'))
    expect(() => runRatchet(options)).toThrow(
      'src/existing.ts [eslint(complexity)]: 1 -> 2 warnings',
    )

    writeFileSync(existing, branchy('one'))
    expect(runRatchet(options).changedFiles).toBe(0)

    writeFileSync(existing, 'export const existing = 1\n')
    expect(runRatchet(options).changedFiles).toBe(1)

    writeFileSync(join(repository, 'src', 'new.ts'), branchy('three'))
    expect(() => runRatchet(options)).toThrow('src/new.ts [eslint(complexity)]: 0 -> 1 warnings')

    expect(leftoverWorktrees(repository)).toEqual([])
  })
})
