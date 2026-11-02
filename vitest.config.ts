import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
