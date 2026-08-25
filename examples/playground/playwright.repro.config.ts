import { defineConfig, devices } from '@playwright/test'

// Repro config: points at an already-running photon-server (PORT=3101) and
// vite (PHOTON_DEV_PORT=5273, PHOTON_PROXY_TARGET=http://127.0.0.1:3101).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5273',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.spec\.ts/,
    },
  ],
})
