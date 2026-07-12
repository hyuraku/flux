import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ command }) => {
  // 本番ビルドで PartyKit ホストが未設定だと、実行時に localhost へ黙って
  // フォールバックして「繋がらないのにエラーも出ない」状態になる。
  // そうしたバンドルをそもそもデプロイできないよう、ビルド時に失敗させる。
  // （ローカルで `vite build` する場合も VITE_PARTYKIT_HOST の指定が必要）
  if (command === 'build' && !process.env.VITE_PARTYKIT_HOST) {
    throw new Error(
      'VITE_PARTYKIT_HOST must be set for production builds. ' +
        'Set it to your PartyKit host (e.g. flux.hyuraku.partykit.dev), ' +
        'or "localhost:1999" for a local preview build.'
    );
  }

  return {
    plugins: [react()],
    base: process.env.GITHUB_PAGES ? '/flux/' : '/',
    resolve: {
      alias: {
        '@': resolve(__dirname, './src/client'),
      },
    },
    build: {
      target: 'es2022',
      minify: 'terser',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            router: ['react-router'],
            state: ['zustand'],
          },
        },
      },
    },
  };
});
