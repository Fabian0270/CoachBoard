import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only run TS sources — dist/ contains stale compiled copies of the tests.
    include: ['src/**/*.test.ts'],
  },
})
