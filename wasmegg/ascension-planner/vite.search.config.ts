import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Bundles scripts/fastsearch.ts into a single Node-runnable ESM file.
 *
 * Node 24 strips TypeScript natively, but it will not resolve the `@/` and `lib`
 * aliases the app's source uses everywhere, and there is no vite-node binary in
 * this workspace. Running the source through vite in SSR mode reuses the app's
 * own module resolution, so the harness imports the exact same simulation code
 * the browser build does - which is the whole point of the exercise.
 *
 * ssr.noExternal is set so workspace packages get bundled rather than left as
 * bare imports Node would fail to resolve at runtime.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      lib: fileURLToPath(new URL('../../lib', import.meta.url)),
      ui: fileURLToPath(new URL('../../ui', import.meta.url)),
    },
  },
  ssr: {
    noExternal: true,
    target: 'node',
  },
  build: {
    ssr: 'scripts/fastsearch.ts',
    outDir: 'dist-search',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'fastsearch.js' },
    },
  },
});
