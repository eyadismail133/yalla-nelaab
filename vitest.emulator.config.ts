import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/*.emulator.test.ts', 'apps/**/*.emulator.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@game/shared': r('./packages/shared/src/index.ts'),
      '@game/rounds': r('./packages/rounds/src/index.ts'),
      '@game/engine': r('./packages/engine/src/index.ts'),
    },
  },
});
