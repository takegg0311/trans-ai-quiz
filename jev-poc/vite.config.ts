import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  server: {
    host: true,
    // 判定だけはバックエンドを経由する。API キーをフロントのバンドルへ
    // 埋め込めないため。server が起動していなければ枠が無効になる。
    proxy: {
      '/api/judge': {
        target: 'http://localhost:8000',
        configure: (proxy) => {
          proxy.on('error', (_error, _request, response) => {
            if ('writeHead' in response && !response.headersSent) {
              response.writeHead(502, { 'Content-Type': 'application/json' });
              response.end('{"error":"server not running"}');
            }
          });
        },
      },
    },
  },
});
