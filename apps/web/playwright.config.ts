import { defineConfig, devices } from '@playwright/test';

/* End-to-end tests against the production build (vite preview).
 * WebKit runs only when INKSLIDE_E2E_WEBKIT=1 (it needs system libraries
 * that Playwright's Linux build may not find, e.g. on Fedora).
 * INKSLIDE_E2E_PORT picks another preview port (parallel worktrees). */
const port = Number(process.env.INKSLIDE_E2E_PORT) || 4173;
const projects = [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }];
if (process.env.INKSLIDE_E2E_WEBKIT === '1') projects.push({ name: 'webkit', use: { ...devices['Desktop Safari'] } });

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}/`,
    viewport: { width: 1280, height: 800 },
  },
  projects,
  webServer: {
    command: `npx vite build --logLevel warn && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
