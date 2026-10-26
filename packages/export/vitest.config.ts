import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // PDF.js and the stress test take seconds; the default 5 s fails on a busy machine.
    testTimeout: 30_000,
  },
});
