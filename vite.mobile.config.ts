import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Mobile builds (REQ-E-1): two bundles from one config, selected by the
 * MOBILE_BUNDLE env var — `app` (dist-mobile/, served by the tenant at
 * /app/) and `login` (dist-mobile-login/, served by the control plane at /).
 * Dev mode (`vite --config vite.mobile.config.ts --port 5176`) serves both
 * entries at once; 5175 stays reserved for the desktop dev server.
 *
 * No electron plugins here: this config never touches the desktop main or
 * preload bundles.
 */

// Same cliPort/hmr pattern as vite.config.ts: a `--port` CLI override must
// realign the HMR port too, otherwise the HMR client points at whatever else
// listens on the stale port and reloads forever.
const cliPort = process.argv.join(' ').match(/(?:^|\s)--port[= ](\d+)/)?.[1];
const devPort = Number(process.env.IDBOTS_MOBILE_VITE_DEV_PORT || cliPort || 5176);
const mobileBundle = process.env.MOBILE_BUNDLE || 'app';
const isProductionBuild = process.env.NODE_ENV === 'production';

const appHtml = path.resolve(__dirname, 'src/mobile/app/index.html');
const loginHtml = path.resolve(__dirname, 'src/mobile/login/index.html');

/** Dev-only: serve / and /login without leaving the mobile entries. */
function mobileDevEntriesPlugin() {
  return {
    name: 'idbots-mobile-dev-entries',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url === '/' || url === '/index.html') {
          req.url = '/src/mobile/app/index.html';
        } else if (url === '/login' || url === '/login/' || url === '/login/index.html') {
          req.url = '/src/mobile/login/index.html';
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // `vite preview` also runs with command === 'serve': it must NOT get the
  // dev-server root/base, otherwise dist-mobile is served at '/' and /app/
  // only answers through the HTML fallback (JS requests then 404). Detect
  // preview explicitly and treat it exactly like a production build.
  const isDevServer = command === 'serve' && !process.argv.includes('preview');
  return {
  // Build and preview: root at the bundle's own directory so index.html lands
  // directly in dist-mobile/ and dist-mobile-login/ (the C2/C3 integration
  // contract: the tenant serves dist-mobile/index.html at /app/, the control
  // plane serves dist-mobile-login/index.html at / and /login). This also
  // stops the desktop public/ folder (IM icons etc.) from being copied into
  // the mobile bundles. Dev keeps the repo root so both entries share one
  // server.
  root: isDevServer ? __dirname : path.resolve(__dirname, 'src/mobile', mobileBundle === 'app' ? 'app' : 'login'),
  plugins: [react(), ...(isDevServer ? [mobileDevEntriesPlugin()] : [])],
  base: isDevServer ? '/' : mobileBundle === 'app' ? '/app/' : '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, mobileBundle === 'app' ? 'dist-mobile' : 'dist-mobile-login'),
    emptyOutDir: true,
    sourcemap: false,
    // The budget check (scripts/check-mobile-budgets.mjs) computes each
    // entry's initial-asset closure from the manifest (isEntry + imports).
    manifest: true,
    rollupOptions: {
      input:
        isDevServer
          ? { app: appHtml, login: loginHtml }
          : mobileBundle === 'app'
            ? appHtml
            : loginHtml,
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, '/');
          if (!modulePath.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(modulePath)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    hmr: {
      port: devPort,
    },
  },
  clearScreen: false,
  };
});
