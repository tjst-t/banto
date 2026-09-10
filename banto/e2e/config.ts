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
  // 4740〜4939 の 100 枠を、実行ごとに2つずつ使う（core と sandbox）
  const slot = Number(RUN_ID) % 100;
  return 4740 + slot * 2 + offsetInRun;
}

export const CORE_PORT = portForRun(0);
// Module の画面を隔離するサンドボックス（§6.2）。**画面とは別オリジン**
// でなければならないので、E2E でも別ポートで立てる
export const SANDBOX_PORT = portForRun(1);

// **4175 は 2026-09-07 から本番ビルド（`npm run build` + `npm run start`）**。
// 開発モードのままだと初回表示 2.39s・メインスレッドの詰まり 1.11s だったのが、
// 本番ビルドで 0.97s・0.34s になったため（実測、docs/notes/2026-09-07-...）。
// **画面を直したら `npm run build` してから E2E を回すこと**——さもないと
// 古いビルドを試験することになる（規則1——確かめずに通ったことにしない）。
//
// Next 16はディレクトリごとに1つしかdevサーバを許さない（別portでも二重起動を
// 拒否する）——なので専用portを別に起こすのではなく、既存の
// （4175、常時起動している前提）をそのまま使う。frontend自体はブラウザの
// localStorageに保存したhost/tokenで接続先を切り替えるだけなので、
// テストの隔離はcore側（port・dataDir）だけで足りる
export const FRONTEND_PORT = 4175;

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
