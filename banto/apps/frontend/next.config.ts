import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * **ビルド成果物の置き場を分けられるようにする**（追加・2026-09-13、
   * ユーザー指摘「E2E のテスト環境は、触る環境とは別に立てるべきでは」）。
   *
   * E2E はこれまで**人が使っているフロント（4175）をそのまま借りて**いた
   * （`reuseExistingServer: true`）。借りているので、開発中に `npm run build`
   * を回すたびに**動いているサーバのビルドとディスクの中身が食い違い**、
   * 画面がチャンクを取れずページ全体を再読み込みする——`app-shell-persist`
   * が落ちたのはこれ。**人の画面を壊しながら試験していた。**
   *
   * 既定は `.next` のまま（人の環境は何も変わらない）。E2E だけが別を指す。
   */
  distDir: process.env.BANTO_NEXT_DIST_DIR ?? ".next",
  // LAN 内の他端末（携帯等）から dev サーバへアクセスするために要る
  // （Next 15.2+ の既定ブロックを解除。無いと HMR やアセット取得が壊れる）。
  // "127.0.0.1"はサンドボックス内での動作確認用に追加した（決定・2026-09-03）
  // ——外部公開URLのホスト名が変わったら、ここに追記する必要がある
  // （Next側の制約でワイルドカード全許可は不可、ホスト名を列挙する必要がある）。
  allowedDevOrigins: ["192.168.1.47", "*.local", "127.0.0.1", "banto.tjstkm.net"],
};

export default nextConfig;
