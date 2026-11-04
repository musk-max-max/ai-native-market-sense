import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 同源部署：生产由 server.mjs 把 /v1 反代到 api；本地 dev 由 Vite proxy 完成同样的事。
// 前端代码里没有任何 API 地址常量，避免把部署拓扑写进页面。
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8081';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/v1': { target: API_PROXY_TARGET, changeOrigin: false },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    reportCompressedSize: true,
    // 首屏预算 200KB gzip（AC-9）。超预算先砍功能，不砍标识与免责。
    chunkSizeWarningLimit: 220,
    rollupOptions: {
      output: {
        // 第三方框架单独成 chunk：合规扫描据此区分「框架自带的键名常量」与业务代码。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
