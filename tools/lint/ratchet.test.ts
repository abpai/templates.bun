import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { changedPaths, type Command, type CommandResult, runRatchet } from './ratchet'

const temporaryRepositories: string[] = []
const repositoryRoot = join(import.meta.dir, '..', '..')

function runCommand({ command, args, cwd }: Command): CommandResult {
  const result = Bun.spawnSync([command, ...args], { cwd, stderr: 'pipe', stdout: 'pipe' })
  const decoder = new TextDecoder()
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
}

function makeRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'oxlint-ratchet-'))
  temporaryRepositories.push(repository)
  mkdirSync(join(repository, 'src'), { recursive: true })
  mkdirSync(join(repository, 'tools', 'oxlint'), { recursive: true })
  mkdirSync(join(repository, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(repository, 'src', 'existing.ts'), 'export const existing = 1\n')
  writeFileSync(join(repository, 'oxlint.config.ts'), 'export default {}\n')
  writeFileSync(join(repository, 'tools', 'oxlint', 'plugin.ts'), 'export {}\n')
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
    expect(oxlintCalls.map(({ cwd }) => cwd)).toEqual([
      join(repository, '.cache', 'ratchet-base'),
      repository,
    ])
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
      const isBaseScan = command.cwd === join(repository, '.cache', 'ratchet-base')
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          diagnostics: isBaseScan
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
    expect(changedPaths('R100\0src/old.ts\0src/new.ts\0')).toEqual(
      new Map([['src/new.ts', 'src/old.ts']]),
    )
  })

  test('rejects base diagnostics under tools', () => {
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
              filename: join(command.cwd, 'tools', 'lint', 'ratchet.ts'),
              severity: 'warning',
            },
          ],
        }),
      }
    }

    expect(() => runRatchet({ baseRef: 'HEAD', repoRoot: repository, run })).toThrow(
      'Base scan must have zero diagnostics under tools/',
    )
  })

  test('runs the installed policy against the repository with --base HEAD', () => {
    const baseWorktree = join(repositoryRoot, '.cache', 'ratchet-base')
    expect(existsSync(baseWorktree)).toBe(false)

    expect(runRatchet({ baseRef: 'HEAD', repoRoot: repositoryRoot }).mergeBase).toMatch(
      /^[0-9a-f]{40}$/,
    )

    expect(existsSync(baseWorktree)).toBe(false)
  })
})
