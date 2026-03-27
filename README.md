# Bun Boilerplate

Minimal Bun project starter with:

- Bun runtime + test runner
- TypeScript out of the box
- Prettier for formatting
- Simple scripts for dev/format/typecheck/test/check

## Quick start

```bash
bun install
bun run dev
```

## Scripts

```bash
bun run dev        # run with watch mode
bun run start      # run once
bun run format     # prettier write
bun run typecheck  # tsc --noEmit
bun run test       # bun test
bun run test:watch # bun test --watch
bun run build      # bun build ./src/index.ts --outdir ./dist
bun run check      # prettier check + typecheck + test
```

## Project layout

- `src/index.ts` – entry point (prints Hello, world!)
- `.prettierrc` – formatting rules

## Notes

- After `bun install`, Bun will create `bun.lock` (recommended to commit).
- This starter intentionally skips ESLint. For many small Bun projects, `prettier + tsc + bun test` is enough.
