import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A8 中后台控制台：独立构建产物，部署在 /console/ 前缀下（与 C 端 H5 分离）。
// 设计 token 目前落在 src/styles/tokens.css（A10 交付 packages/design-tokens 后替换数值，类名与 DOM 不变）。
export default defineConfig({
  base: '/console/',
  plugins: [react()],
  server: { port: 3100, host: '127.0.0.1' },
  preview: { port: 3100 },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
