// core（packages/core）をE2E専用のdataDir・portで起動するための下ごしらえ。
// 実データ・本番トークンと完全に分離する（メモリ「実機検証は別データディレクトリの
// ホストで」と同じ原則、BANTO_CONFIG_PATHはbootstrap.tsの上書き機構）。
// 毎回まっさらな状態から始める——前回の実行が残っているとテストが
// 「たまたま前回のデータが残っていたから通った」になりかねない。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_PATH,
  DATA_DIR,
  PORT,
  AUTH_TOKEN,
  SANDBOX_PORT,
  SANDBOX_BASE_URL,
  FRONTEND_BASE_URL,
  CLAUDE_CONFIG_DIR,
  CLAUDE_CREDENTIALS_DIR,
} from "./config.ts";

export default function globalSetup(): void {
  removeStaleRuns();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(dirname(CONFIG_PATH), { recursive: true, force: true });
  rmSync(CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  assertCredentialsReadable();
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        dataDir: DATA_DIR,
        port: PORT,
        authToken: AUTH_TOKEN,
        // Module の画面（§6.2）。埋め込みを許すのは E2E の画面だけ
        sandboxPort: SANDBOX_PORT,
        sandboxPublicUrl: SANDBOX_BASE_URL,
        allowedEmbedderOrigins: [FRONTEND_BASE_URL],
      },
      null,
      2,
    ),
  );
}

/**
 * **認証がどこから来るかを、走る前に確かめる**（2026-09-16）。
 *
 * `CLAUDE_CONFIG_DIR` を実行ごとの置き場に移すと、claude CLI は認証も
 * そちらから読もうとする。`CLAUDE_SECURESTORAGE_CONFIG_DIR` で本物を
 * 指しそこねると、**全 spec が「AI が何も返さない」という形で落ちる**
 * ——原因が認証だと画面からは分からない。ここで止めて理由を出す（規則2）。
 */
function assertCredentialsReadable(): void {
  const credentials = join(CLAUDE_CREDENTIALS_DIR, ".credentials.json");
  if (existsSync(credentials)) return;
  throw new Error(
    `[e2e] claude CLI の資格情報が見つかりません: ${credentials}\n` +
      `E2E は記録を ${CLAUDE_CONFIG_DIR} に隔離し、認証だけ ` +
      `CLAUDE_SECURESTORAGE_CONFIG_DIR（既定は ~/.claude）から読みます。` +
      `置き場が違うなら CLAUDE_SECURESTORAGE_CONFIG_DIR を指定してください。`,
  );
}

/**
 * **前の実行の置き場を片づける**（`e2e-run-isolation`、2026-09-10）。実行ごとに
 * 別のディレクトリを使うようにしたので、放っておくと `/tmp` に溜まり続ける。
 * **走っているかもしれない実行には触らない**——1日より古いものだけ消す。
 */
function removeStaleRuns(): void {
  const runsRoot = dirname(dirname(DATA_DIR));
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return; // まだ1回も走っていない
  }
  for (const entry of entries) {
    const path = join(runsRoot, entry);
    try {
      if (statSync(path).mtimeMs < dayAgo) rmSync(path, { recursive: true, force: true });
    } catch {
      // 消せないものは放っておく——片づけで試験を止めない
    }
  }
}
