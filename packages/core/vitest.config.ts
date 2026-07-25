import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The core must run in a plain JS environment with no DOM shim: if a test
    // needs jsdom, something in the engine has grown a browser dependency.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
