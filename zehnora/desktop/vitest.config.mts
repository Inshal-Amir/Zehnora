import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { electron: path.resolve(__dirname, 'tests/stubs/electron.ts') } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
});
