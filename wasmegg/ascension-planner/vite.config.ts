import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/ascension-planner/',
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [vue(), vueJsx()],
  build: {
    chunkSizeWarningLimit: 2000,
  },

  // `vite preview` refuses any request whose Host header it does not recognise -- DNS-rebinding
  // protection -- and localhost is the only name it knows by default. Put a reverse proxy or a
  // Cloudflare tunnel in front of it and every request comes back "Blocked request. This host is
  // not allowed", which looks like a broken app and is really a one-line config gap.
  //
  // Supplied at run time so no one's private hostname ends up in the repo:
  //   VITE_PREVIEW_HOSTS=egg.example.org pnpm serve
  // Comma-separate for several. Unset keeps the safe localhost-only default.
  preview: {
    host: true,
    allowedHosts:
      process.env.VITE_PREVIEW_HOSTS?.split(',')
        .map(h => h.trim())
        .filter(Boolean) ?? [],
  },

  server: {
    host: true,
    forwardConsole: {
      unhandledErrors: true,
      logLevels: ['warn', 'error'],
    },
  },
});
