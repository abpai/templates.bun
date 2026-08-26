# Agent development policy

This is a strongly opinionated template for agent-ready Bun projects.
`oxlint.config.ts` is the single source of truth for lint policy.

## Before committing

- Run `bun run check`.
- Run `bun run lint:ratchet` and `bun run lint:suppressions` when `origin/main` is available. Use `--base <ref>` for another target.

## Enforcement

- `error` rules are hard constraints and block CI.
- `warn` rules are directional guidance. Findings must not increase per file and rule.
- New files must have zero directional findings.
- Do not weaken or remove a rule globally to make a change pass.

## Exceptions

- Prefer changing the design over suppressing a hard constraint.
- For a one-off exception, use the smallest line-level scope:
  `// oxlint-disable-next-line <rule> -- SAFETY: <invariant or reason>`
- Never use file-level `oxlint-disable` or `eslint-disable` directives.
- Every added disable directive must name its rule and include a nonempty `-- SAFETY:` reason.
- Use the exact namespaced rule id, for example `anti-slop/no-unsafe-dictionary-type`. An id without the `anti-slop/` prefix suppresses nothing and CI reports it as unused.
- The `SAFETY:` comment that `require-safety-comment-for-type-assertion` needs is not detected above `export const x = value as T`. Write a plain `const` with the comment, then export it on a separate line.
- CI lists every new suppression automatically. No separate PR-body list is required.
- For a recurring boundary pattern, add a narrow `overrides` entry in `oxlint.config.ts` instead of repeated line suppressions. Explain that config override in the PR.
