import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * **この組み立ての印**（追加・2026-10-05、ユーザー報告「更新したけど何も変わってない」）。
 *
 * 画面から banto を更新しても、開いていたページは読み込み直されず、古い画面のプログラムが動き続けていた。
 * 印をページに埋め、同じ印を `/banto-build` でも返す——ページが持つ印とサーバが返す印が違えば、
 * サーバの画面は新しくなっている（`lib/backend/frontend-build.ts`）。同じ commit から組み直しても
 * 中身は替わりうるので、組み立てた時刻も入れる
 */
function buildId(): string {
  if (process.env.BANTO_FRONTEND_BUILD) return process.env.BANTO_FRONTEND_BUILD;
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // git の外で組み立てた——時刻だけでも、組み直せば替わる
  }
  return `${commit}-${new Date().toISOString()}`;
}

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
  env: { NEXT_PUBLIC_BANTO_BUILD: buildId() },
  // LAN 内の他端末（携帯等）から dev サーバへアクセスするために要る
  // （Next 15.2+ の既定ブロックを解除。無いと HMR やアセット取得が壊れる）。
  // "127.0.0.1"はサンドボックス内での動作確認用に追加した（決定・2026-09-03）
  // ——外部公開URLのホスト名が変わったら、ここに追記する必要がある
  // （Next側の制約でワイルドカード全許可は不可、ホスト名を列挙する必要がある）。
  allowedDevOrigins: ["192.168.1.47", "*.local", "127.0.0.1", "banto.tjstkm.net"],
  /**
   * **画面を iframe に入れさせない**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
   * 公開先（`*.banto.tjstkm.net`、AI が動かすもの）は同じサイトなので、iframe の中にもログインの Cookie が付く
   * ——ログインした画面を透明に重ねて、承認や「端末を追加」を押させられる。Canvas の sandbox は別の口なので関係しない
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
