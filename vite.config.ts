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
const devPort = Number(process.env.IDBOTS_VITE_DEV_PORT || 5175);
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
