import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,extension,backend,spikes}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
