# Repository guide

This is an agent-ready Bun starter. See `README.md` for the project layout and commands.
`oxlint.config.ts` and CI own the quality policy.

Before handing off a change:

- Run `bun run check`.
- When `origin/main` is available, also run `bun run lint:ratchet` and `bun run lint:suppressions`.

If a lint exception is necessary, use the smallest line-level scope and a concrete reason:

```ts
// oxlint-disable-next-line <full-rule-id> -- SAFETY: <reason>
```

Call out intentional changes to `oxlint.config.ts`, `tools/lint/`, `tools/oxlint/`, or the quality workflow for human review.
