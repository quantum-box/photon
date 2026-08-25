import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'cargo run --bin photon-server',
      cwd: '../..',
      // Override both server database inputs so an inherited Engine-specific
      // URL cannot bypass this fresh E2E database.
      env: {
        DATABASE_URL: 'sqlite::memory:',
        PHOTON_ENGINE_DATABASE_URL: 'sqlite::memory:',
      },
      url: 'http://127.0.0.1:3001/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
