// E2E専用のポート・パス定数。テストとglobal-setupの両方から参照する
// ——真実は一箇所（規則3）、同じ値をあちこちに書き写さない。
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **1回の実行を、他の実行から切り離す印**（決定・2026-09-10、`e2e-run-isolation`）。
 *
 * 以前は core の port も dataDir も固定だった。**共有ワークツリーで別のセッションが
 * 同時に E2E を回すと、同じ core・同じ受信箱を2つの実行が奪い合う**——2026-09-09 に
 * 実際に1回分が無効になった。実行ごとに違う port・違う置き場を使う。
 *
 * 値は**最初に読んだプロセスが決めて env に置き**、webServer（別プロセス）と
 * worker はそれを引き継ぐ——同じ実行の中では必ず同じ値になる。
 */
const RUN_ID = (process.env.BANTO_E2E_RUN_ID ??= String(process.pid));

/** 実行ごとに違う port を選ぶ。**衝突したら Playwright が止まる**（黙って相乗りしない）。 */
function portForRun(offsetInRun: number): number {
  // 4740〜4939 の 100 枠を、実行ごとに**3つずつ**使う（core・sandbox・frontend）
  const slot = Number(RUN_ID) % 66;
  return 4740 + slot * 3 + offsetInRun;
}

export const CORE_PORT = portForRun(0);
// Module の画面を隔離するサンドボックス（§6.2）。**画面とは別オリジン**
// でなければならないので、E2E でも別ポートで立てる
export const SANDBOX_PORT = portForRun(1);

// **フロントも E2E 専用に起こす**（訂正・2026-09-13、ユーザー指摘
// 「E2E のテスト環境は、私が触る環境とは別に立てるべきでは」）。
//
// 以前はここに「Next 16 はディレクトリごとに1つしか dev サーバを許さない
// （別 port でも二重起動を拒否する）」と書いて、**人が使っている 4175 を
// そのまま借りて**いた。**その前提は成り立っていない**——別 port で2つ目を
// 起こして両方 200 で動くことを実測した（2026-09-13）。
//
// 借りていた実害：開発中に `npm run build` を回すと、**動いているサーバが
// 配っているビルドとディスクの中身が食い違う**。画面はチャンクを取れず
// ページ全体を再読み込みし、`app-shell-persist`（外枠が作り直されない）が
// 落ちる。**人の画面を壊しながら試験していた**。
//
// なので **port は実行ごとに分け、ビルド成果物は人のものと分ける**。
export const FRONTEND_PORT = portForRun(2);

/**
 * フロントのビルド成果物の置き場。**人の `.next` を書き換えない**。
 *
 * **相対パスの固定名**にする（訂正・2026-09-13、踏んだので）。絶対パスを
 * `distDir` に渡すと Next は**プロジェクト相対として解釈して
 * `apps/frontend/tmp/...` を作り**、さらに `tsconfig.json` の `include` に
 * その置き場を**実行のたびに書き足す**——リポジトリが実行ごとに汚れていく。
 *
 * 実行ごとに分けないぶん、**同じワークツリーで2つの E2E を同時に回すと
 * ビルドを奪い合う**。port とデータは分かれているので混ざりはしないが、
 * ここは承知のうえの割り切り（そのかわりビルドキャッシュが効いて速い）。
 */
export const FRONTEND_DIST_DIR = ".next-e2e";

// dataDirとconfig.jsonの置き場は重なってはいけない（bootstrap.tsのassertNoOverlap、
// §9の事故対策）——なので兄弟ディレクトリに分ける。
//
// **リポジトリの中には置かない**（改訂・2026-09-10、landlock-guard-wiring）。
// 開発時のモノレポでは Module に「モノレポの根」を読み取り許可している
// （npm workspaces が node_modules を根に hoist するため、`derive.ts` の
// moduleInstallDirs）。ここに banto のデータ置き場があると、**Module が
// banto 自身の Event Store を読める**——本番（`~/.local/share/banto`）には
// 無い形で、試験環境だけが緩くなる。ルールセットの検査（assertRulesetIsSafe）が
// これを実際に拒否したので、置き場のほうを本番と同じ関係（リポジトリの外）にした。
const E2E_TMP = join(tmpdir(), "banto-e2e", RUN_ID);
export const DATA_DIR = join(E2E_TMP, "data");
export const CONFIG_PATH = join(E2E_TMP, "config", "config.json");
export const AUTH_TOKEN = "e2e-fixed-token";
export const PORT = CORE_PORT;

export const SANDBOX_BASE_URL = `http://127.0.0.1:${SANDBOX_PORT}`;
export const CORE_BASE_URL = `http://127.0.0.1:${CORE_PORT}`;
export const FRONTEND_BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
