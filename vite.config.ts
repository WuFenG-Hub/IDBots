import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import os from 'os';
import { createRequire } from 'node:module';

// https://vitejs.dev/config/
// Override both the HTTP and HMR port for parallel checkouts (e.g. git
// worktrees) via IDBOTS_VITE_DEV_PORT; the main checkout keeps 5175.
// A `--port` CLI override must realign the HMR port too: vite's CLI flag only
// changes server.port, and a stale hmr.port would point renderer HMR at
// whatever else listens on that port (another checkout's dev server), which
// vite rejects by token and the client answers with an endless reload loop.
const cliPort = process.argv.join(' ').match(/(?:^|\s)--port[= ](\d+)/)?.[1];
const devPort = Number(process.env.IDBOTS_VITE_DEV_PORT || cliPort || 5175);
const isProductionBuild = process.env.NODE_ENV === 'production';
const shouldUseVitePolling = process.env.IDBOTS_VITE_USE_POLLING === '1';

// In dev, keep MetaApp installs (community auto-installs triggered by Bot
// Browser opens) outside the repository so the working tree stays clean.
// MetaAppManager syncs the repo's bundled apps into this root on startup and
// packaged builds keep using the Electron userData dir instead.
if (!isProductionBuild && !process.env.IDBOTS_METAAPPS_ROOT) {
  process.env.IDBOTS_METAAPPS_ROOT = path.join(os.homedir(), '.idbots', 'dev-METAAPPs');
}
const require = createRequire(import.meta.url);
const { createElectronMainExternalPredicate } = require('./scripts/electron-main-externals.cjs');
const { createDepsCacheBusterPlugin } = require('./scripts/vite-deps-cache-buster.cjs');
const electronMainExternal = createElectronMainExternalPredicate();

export default defineConfig({
  plugins: [
    createDepsCacheBusterPlugin(),
    react(),
    electron([
      {
        // 主进程入口文件
        entry: 'src/main/main.ts',
        vite: {
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: {
              external: electronMainExternal,
            },
          },
        },
        onstart() {},
      },
      {
        // 预加载脚本入口文件
        entry: 'src/main/preload.ts',
        vite: {
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
          },
        },
        onstart() {},
      },
    ]),
    renderer(),
  ],
  base: process.env.NODE_ENV === 'development' ? '/' : './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: !isProductionBuild,
    minify: isProductionBuild ? 'esbuild' : false,
    rollupOptions: {
      output: {
        // Split the vendor tables that dominate the renderer bundle into
        // long-lived chunks, so the startup chunk holds app code + the shell
        // and a dependency bump only invalidates the chunk it touched.
        // `vendor-bot-browser` stays off the startup path entirely: the only
        // importers are the lazily loaded Bot Browser surface and its adapter.
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, '/');
          if (!modulePath.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(modulePath)) return 'vendor-react';
          if (/\/node_modules\/(@reduxjs|react-redux|redux|reselect|immer|use-sync-external-store)\//.test(modulePath)) return 'vendor-redux';
          if (/\/node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|react-syntax-highlighter|refractor|prismjs|highlight\.js|katex|micromark[^/]*|mdast[^/]*|hast[^/]*|unist[^/]*|vfile[^/]*|unified|bail|trough|devlop|is-plain-obj|property-information|comma-separated-tokens|space-separated-tokens|trim-lines|zwitch|ccount|character-entities[^/]*|decode-named-character-reference|html-url-attributes|longest-streak|markdown-table|escape-string-regexp|estree-[^/]+|style-to-object|web-namespaces|parse-entities|parse5[^/]*|entities|domhandler|domutils|domelementtype|hastscript|html-void-elements|stringify-entities)\//.test(modulePath)) return 'vendor-markdown';
          if (/\/node_modules\/@openagentinternet\//.test(modulePath)) return 'vendor-bot-browser';
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
    watch: {
      usePolling: shouldUseVitePolling,
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
      ],
    },
  },
  optimizeDeps: {
    exclude: ['electron'],
  },
  clearScreen: false,
}); 
