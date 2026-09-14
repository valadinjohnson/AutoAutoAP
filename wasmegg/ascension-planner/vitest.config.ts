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
    // collector/ is a standalone Cloudflare Worker with no build step, so its tests live next to
    // it and are plain .js. They run here rather than in a separate command so `pnpm test` is
    // still the one thing that has to pass.
    include: ['src/**/*.{test,spec}.ts', 'collector/**/*.spec.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    },
  },
});
