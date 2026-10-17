import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    // apps/web is included for its non-React tests — the registry guards that keep the client
    // in step with the round-type registry. Component rendering is not tested here; there is
    // no DOM environment configured and these assertions do not need one.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.emulator.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@game/shared': r('./packages/shared/src/index.ts'),
      '@game/rounds': r('./packages/rounds/src/index.ts'),
      '@game/engine': r('./packages/engine/src/index.ts'),
    },
  },
});
