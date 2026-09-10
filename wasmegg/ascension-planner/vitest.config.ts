import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      // The search core (src/search/*) reaches the workspace packages the app itself uses —
      // `lib/artifacts` pulls in `lib`'s Inventory/colleggtible tables. vite.config.ts resolves
      // these through tsconfig paths + pnpm workspace links; vitest needs them spelled out, the same
      // way vite.search.config.ts does for the Node harness.
      lib: new URL('../../lib', import.meta.url).pathname,
      ui: new URL('../../ui', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    },
  },
});
