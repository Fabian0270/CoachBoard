import { defineConfig } from 'vitest/config'

// GitHub's Windows runners write files far more slowly than a dev machine: the
// first server-windows CI run (1.18.0) timed out in every test and hook that
// builds a database FILE, which take ~0.3 s here. There, and only there, the
// limits are generous — a test that really hangs still fails, just later.
const slowRunner = !!process.env.CI && process.platform === 'win32'

export default defineConfig({
  test: {
    // Only run TS sources — dist/ contains stale compiled copies of the tests.
    include: ['src/**/*.test.ts'],
    ...(slowRunner ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
})
