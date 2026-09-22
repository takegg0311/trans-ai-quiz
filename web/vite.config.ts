import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * 出題者用と回答者用を 1 プロジェクト 2 エントリで持つ。
 * 別プロジェクトにすると WebSocket のメッセージ型と phase 定義が
 * 二重管理になるため。
 */
export default defineConfig({
  plugins: [react()],
  // AI 参加者の制御（useAiPlayer）を検証する。前問の文章で押してしまう
  // 不具合が実機で出たため、同種の退行をテストで止める。
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  server: {
    host: true,
    // 開発時はバックエンドを別プロセスで動かし、ここから中継する。
    // 同一オリジンに見えるので CORS の設定が要らない。
    proxy: {
      '/api': 'http://localhost:8000',
      '/quiz_data': 'http://localhost:8000',
      '/sound': 'http://localhost:8000',
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        host: resolve(__dirname, 'host.html'),
        player: resolve(__dirname, 'player.html'),
      },
    },
  },
});
