import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// apps/web は tsc の project references グラフに入れない（vite が型もビルドも持つ）。
//
// host（apps/host）は別ポートで動く（例：serve --port 4301）。開発時は /api を
// そこへ素通しする——ブラウザからは同一オリジンに見えるので CORS の設定が要らない。
// 向き先は VITE_HOST_URL で変えられる。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4173,
    proxy: {
      '/api': {
        target: process.env['VITE_HOST_URL'] ?? 'http://localhost:4300',
        changeOrigin: true,
      },
    },
  },
});
