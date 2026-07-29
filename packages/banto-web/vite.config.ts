import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// D6: vite — React のビルド／開発サーバに標準的な選択肢。決定12（React直接import）の帰結。

/** 番頭ホスト。リバースプロキシ配下でも公開ポート1つで完結させるため、WSをここで中継する。 */
const BANTO_HOST = process.env["BANTO_HOST_URL"] ?? "http://localhost:4100";

/**
 * Vite は DNS リバインディング対策で Host ヘッダを検査する。リバースプロキシ
 * （Caddy 等）のサブドメイン経由で開く場合は、そのドメインを許可する必要がある。
 * `.example.net` のように先頭ドットで書くとサブドメイン全体を許可できる。
 * カンマ区切りで複数指定可。`true` にすると検査を無効化する（信頼できる網でのみ）。
 */
const allowedHostsEnv = process.env["BANTO_WEB_ALLOWED_HOSTS"];
const allowedHosts =
  allowedHostsEnv === "true"
    ? true
    : (allowedHostsEnv ?? ".ndev.tjstkm.net")
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    // コンテナ外へ公開する（リバースプロキシから届くようにする）
    host: true,
    allowedHosts,
    // WS をこのサーバ経由で番頭ホストへ中継する。UI は同一オリジンの `/ws` に繋げばよく、
    // プロキシ配下でも公開が1ポートで済む（番頭ホストを別途公開しなくてよい）。
    proxy: {
      "/ws": { target: BANTO_HOST, ws: true, changeOrigin: true },
    },
  },
});
