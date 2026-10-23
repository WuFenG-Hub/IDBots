import { defineConfig, devices } from '@playwright/test';

/**
 * REQ-E-26 — mobile e2e suite. Runs against a dev server the runner scripts
 * provide: `scripts/run-mobile-e2e.mjs` (mock bridge, port 5196) or
 * `scripts/run-mobile-e2e-gateway.mjs` (real gateway harness, port 5197,
 * gateway specs only). Set E2E_BASE_URL to point at a server you started
 * yourself.
 *
 * Two device profiles: iPhone 14 (WebKit) and Pixel 7 (Chromium). Screenshots
 * are captured on failure automatically; specs additionally attach an
 * explicit screenshot per screen via testInfo.attach.
 */

export default defineConfig({
  testDir: './e2e/mobile',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  workers: 2,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5196',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iphone14',
      use: { ...devices['iPhone 14'] },
    },
    {
      name: 'pixel7',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
