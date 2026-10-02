import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests must never touch the network: every test runs against recorded
    // fixtures in ./fixtures or inline synthetic payloads.
  },
});
