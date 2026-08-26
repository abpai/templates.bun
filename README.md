# Bun Boilerplate

A strongly opinionated, agent-ready starter for Bun projects. It gives coding agents clear quality constraints, a documented exception protocol, and CI that prevents new lint debt.

It includes:

- Bun 1.3 or newer for runtime, bundling, and tests
- TypeScript 7 with strict, incremental type checking
- Prettier 3 with a content-based cache for fast repeat checks
- Oxlint correctness rules as hard, CI-blocking constraints
- Vendored anti-slop rules for low-evidence TypeScript and JavaScript patterns
- A directional complexity and anti-slop warning ratchet
- Build, test, coverage, format, and aggregate check scripts

## Quick start

```bash
bun install
bun run dev
```

Use the committed lockfile in CI and clean checkouts:

```bash
bun install --frozen-lockfile
bun run check
```

## Scripts

```bash
bun run dev           # run with watch mode
bun run start         # run once
bun run build         # bundle src/index.ts to dist/
bun run format        # write Prettier formatting
bun run lint          # run formatting and Oxlint checks
bun run lint:format   # check Prettier formatting (cached)
bun run lint:oxlint   # run correctness, complexity, and anti-slop rules
bun run lint:ratchet  # reject warning increases by file and rule
bun run lint:suppressions # validate added lint disable directives
bun run typecheck     # type-check application and tooling source
bun run test          # bun test
bun run test:changed  # only tests affected by uncommitted changes
bun run test:coverage # bun test with coverage
bun run test:watch    # bun test --watch
bun run check         # lint + typecheck + test
```

## Project layout

- `src/index.ts` - entry point (prints Hello, Bun!)
- `src/index.test.ts` - Bun test example
- `.prettierrc` - formatting rules
- `AGENTS.md` - agent workflow, enforcement levels, and exception policy
- `oxlint.config.ts` - the single source of truth for lint policy
- `tools/lint/` - ratchet and suppression-policy checks
- `tools/oxlint/anti-slop/` - vendored anti-slop Oxlint plugin
- `tsconfig.json` - strict TypeScript configuration

## Notes

- Commit `bun.lock` after dependency updates.
- This starter skips the ESLint runtime. Prettier, Oxlint, TypeScript, Bun tests, and the warning ratchet provide the default quality gate.
- Anti-slop is created by Dillon Mulroy in [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) and distributed under the MIT license.
- This template vendors a pinned upstream commit so projects can adapt the rules locally. See `tools/oxlint/anti-slop/UPSTREAM.md` for provenance.
