import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 押下規則（decision.ts）と自動早押しの非同期制御（useAutoBuzz.ts）を
  // 検証する。規則はサーバ側にも同じものがあり、pytest だけでは
  // 片方を変えたときに気づけない。
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  server: {
    host: true,
    // Jev 判定だけはバックエンドを経由する。API キーをフロントのバンドルへ
    // 埋め込めないため。server が起動していなければ自動早押しが無効になる
    // だけで、手動の早押しと回答は従来どおり動く。
    //
    // 中継するのは /api/jev と /api/llm。問題データ（/quiz_data）と
    // ジングル（/sound）は PoC 自身が public から配信している。
    //
    // /api/jev は早押しの判定、/api/llm は AI が押したときの回答に使う。
    proxy: {
      '/api/llm': {
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
      '/api/jev': {
        target: 'http://localhost:8000',
        // server が起動していないのは異常ではなく、想定した縮退状態。
        // 既定では ECONNREFUSED が 500 として返るが、実際には上流が
        // 応答しないだけなので 502 を返す。
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
