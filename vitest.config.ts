import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch the network: the live client is always exercised with a mocked fetch.
    globals: false,
    testTimeout: 20_000,
  },
});
