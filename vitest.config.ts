import { defineConfig } from 'vitest/config'

// Two tiers:
//   • *.unit.test.ts        — pure functions, no DB, run everywhere (incl. CI)
//   • *.integration.test.ts — hit the real dev/staging MySQL, run locally
//
// `npm test`              → unit only
// `npm run test:all`      → unit + integration (requires .env)
// `npm run test:coverage` → unit only with coverage

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['tests/_setup/env.ts'],
    globalTeardown: ['tests/_setup/globalTeardown.ts'],
    include: ['tests/**/*.test.ts'],
    // Vitest picks tests up via `include`. The two npm scripts pass
    // `--testNamePattern` and `--exclude` respectively to slice further.
    testTimeout: 10_000,
    hookTimeout: 20_000,
    // Integration tests share DB state — run serially to avoid races.
    pool: 'forks',
    fileParallelism: false,
  },
})
