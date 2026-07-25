/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Tests that touch the engine boot a real WASM kernel and a real PGlite
    // database. That is the point — they used to run against a stub that threw
    // on every call — but it costs seconds per file under parallel load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
