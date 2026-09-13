import { defineConfig } from 'vitest/config'

/**
 * Unit tests run against the pure modules only (no Electron, no UI).
 *
 * The include list is deliberately explicit: `reference-projects/` contains
 * dozens of third-party checkouts with their own test suites, and the default
 * vitest glob would try to run all of them.
 */
export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/reference-projects/**', '**/.opencode/**', '**/release/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
  },
})
