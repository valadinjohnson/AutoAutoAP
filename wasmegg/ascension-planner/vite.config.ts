import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // vite.config.ts is evaluated before vite loads .env files, so `process.env` here holds only
  // what the shell exported -- a VITE_PREVIEW_HOSTS written into .env.local would be invisible.
  // loadEnv reads those files explicitly, so one .env.local configures both the build (VITE_*
  // inlined into the bundle) and `vite preview` (the hostnames below). A real shell variable
  // still wins, so a one-off `VITE_PREVIEW_HOSTS=... pnpm serve` keeps working.
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };

  return {
    base: '/ascension-planner/',
    resolve: {
      tsconfigPaths: true,
      // `lib` and `ui` are workspace packages that declare their own vue/pinia. pnpm keys a
      // package directory by its resolved peers, so a single differing peer -- typescript 6.0.2
      // for this workspace, 6.0.3 for lib -- produces two physically distinct vue and pinia
      // directories. Vite's dev-time dep optimizer collapses them by bare specifier, so dev is
      // fine; the production build follows the real paths and ships two Vue runtimes and two
      // Pinia registries. Components from `ui` then run on the other runtime: `app.use(pinia)`
      // registers on one instance while `useEidsStore()` reads `activePinia` from the other, the
      // store call throws, and Vue drops that subtree silently -- the Player ID form simply is
      // not in the DOM, with no visible error. Force one copy of each.
      dedupe: ['vue', 'pinia'],
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
    // Supplied out of band so no one's private hostname ends up in the repo -- either in the
    // gitignored .env.local next to this file, or for a one-off:
    //   VITE_PREVIEW_HOSTS=egg.example.org pnpm serve
    // Comma-separate for several. Unset keeps the safe localhost-only default.
    preview: {
      host: true,
      allowedHosts:
        env.VITE_PREVIEW_HOSTS?.split(',')
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
  };
});