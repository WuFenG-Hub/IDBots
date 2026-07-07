import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import { createRequire } from 'node:module';

// https://vitejs.dev/config/
const devPort = 5175;
const isProductionBuild = process.env.NODE_ENV === 'production';
const shouldUseVitePolling = process.env.IDBOTS_VITE_USE_POLLING === '1';
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
