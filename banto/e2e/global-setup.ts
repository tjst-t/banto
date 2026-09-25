// core（packages/core）をE2E専用のdataDir・portで起動するための下ごしらえ。
// 実データ・本番トークンと完全に分離する（メモリ「実機検証は別データディレクトリの
// ホストで」と同じ原則、BANTO_CONFIG_PATHはbootstrap.tsの上書き機構）。
// 毎回まっさらな状態から始める——前回の実行が残っているとテストが
// 「たまたま前回のデータが残っていたから通った」になりかねない。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CONFIG_PATH,
  DATA_DIR,
  E2E_BASE,
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
  removeStaleContainers();
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

/**
 * **前の回が残したコンテナを片づける**（追加・2026-09-25）。ふつうは終わるときに消す（`global-teardown.ts`）が、
 * 途中で止めた回や、終わる瞬間に host がまだコンテナを触っていた回（`Instance is busy`）は残る。
 * **別のセッションが同時に回している E2E のものは消さない**——その回がもう走っていない（置き場が消えた、
 * または印の pid が生きていない）ものだけを消す
 */
function removeStaleContainers(): void {
  const listed = spawnSync("incus", ["query", `/1.0/instances?recursion=1&project=${incusProject()}`], { encoding: "utf8", input: "" });
  if (listed.status !== 0) throw new Error(`[e2e] コンテナの一覧を読めません（incus グループが効いていない？）：${listed.stderr.trim()}`);
  const all = JSON.parse(listed.stdout) as { name: string; config?: Record<string, string> }[];
  for (const c of all) {
    const owner = c.config?.["user.banto.owner"];
    if (!owner || !owner.startsWith(`${E2E_BASE}/`) || !runIsOver(owner)) continue;
    const r = spawnSync("incus", ["delete", "--force", c.name], { encoding: "utf8", input: "" });
    console.log(`[e2e] 前の回が残したコンテナ ${c.name} を消した${r.status === 0 ? "" : `（失敗：${r.stderr.trim()}）`}`);
  }
}

/** その置き場の回が終わっているか。回の印は Playwright の pid（`config.ts` の RUN_ID） */
function runIsOver(owner: string): boolean {
  if (!existsSync(owner)) return true;
  const pid = Number(owner.slice(E2E_BASE.length + 1).split("/")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM は「居るが他人のもの」——生きている扱いにする
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function incusProject(): string {
  const r = spawnSync("incus", ["project", "get-current"], { encoding: "utf8", input: "" });
  if (r.status !== 0) throw new Error(`[e2e] Incus に繋がりません（incus グループが効いていない？）：${r.stderr.trim()}`);
  return encodeURIComponent(r.stdout.trim());
}
