import { defineConfig } from 'oxlint'
import policy from '../../../oxlint.config.ts'

// Reuse the root policy so rule options and severities cannot drift between
// the main scan and the fixture harness. Only the scan surface changes here.
export default defineConfig({
  ...policy,
  // Each fixture isolates one rule, so the native correctness category is off.
  categories: {
    correctness: 'off',
  },
  // The root policy ignores this whole directory. Without this reset the
  // harness lints zero files and several assertions still pass.
  ignorePatterns: [],
  jsPlugins: [{ name: 'anti-slop', specifier: './index.ts' }],
})
