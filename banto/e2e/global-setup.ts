// core（packages/core）をE2E専用のdataDir・portで起動するための下ごしらえ。
// 実データ・本番トークンと完全に分離する（メモリ「実機検証は別データディレクトリの
// ホストで」と同じ原則、BANTO_CONFIG_PATHはbootstrap.tsの上書き機構）。
// 毎回まっさらな状態から始める——前回の実行が残っているとテストが
// 「たまたま前回のデータが残っていたから通った」になりかねない。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removeContainers, staleOwnedContainers } from "./containers.ts";
import {
  CONFIG_PATH,
  CORE_INDEX,
  DATA_DIR,
  E2E_BASE,
  PORT,
  AUTH_TOKEN,
  SANDBOX_PORT,
  SANDBOX_BASE_URL,
  FRONTEND_BASE_URL,
  CLAUDE_CONFIG_DIR,
  FAKE_SYSTEMCTL,
  RELEASE_DIR,
  SELF_UPDATE_DIR,
  SELF_UPDATE_GITHUB_URL,
  CHATS_DIR,
} from "./config.ts";
import { removeTree } from "./remove-tree.ts";

export default function globalSetup(): void {
  // 前の回の片づけは回に1度（core は worker の数だけ同時に起きる。同じコンテナを何本もが消しに行かない）
  if (CORE_INDEX === 0) {
    removeStaleRuns();
    removeStaleContainers();
  }
  removeTree(DATA_DIR);
  rmSync(dirname(CONFIG_PATH), { recursive: true, force: true });
  rmSync(CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  rmSync(SELF_UPDATE_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
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
        // 画面のオリジン（人のログイン：Cookie の要求の Origin・パスキー・CORS・ログインのリンク）
        uiOrigin: FRONTEND_BASE_URL,
        // 画面からの更新の置き場（人のものを読まない。中身は self-update.spec.ts が作る）
        releaseDir: RELEASE_DIR,
        // 試験だけの差し替え（本番の config には書かない項目）：偽の systemctl と、動いているコードは試験の置き場の
        // `current/banto`（版を替えると、host が見る「今の版」も替わる）
        // 組み立て済みの版は偽の GitHub（self-update.spec.ts が立てる）に聞く
        testOnlySelfUpdate: {
          systemctl: FAKE_SYSTEMCTL,
          codeDir: join(RELEASE_DIR, "current", "banto"),
          prebuiltBase: `${SELF_UPDATE_GITHUB_URL}/dl`,
          githubApi: `${SELF_UPDATE_GITHUB_URL}/runs`,
        },
        // 試験だけ：しばらく開いていない Project の時計を「15日後」の時刻で回す口（sidebar-idle-sleep.spec.ts）
        testOnlyIdleCheck: true,
        // 試験だけ：読むだけの印を付けた会話を立てる口（read-only-runs.spec.ts。見回りがまだ無いので試験が作る）
        testOnlyReadOnlyThreads: true,
        // 試験だけ：チャットの置き場（chat.spec.ts。人の ~/banto/chats に作らない）
        testOnlyChatsDir: CHATS_DIR,
      },
      null,
      2,
    ),
  );
}

/**
 * **前の実行の置き場を片づける**（`e2e-run-isolation`、2026-09-10）。実行ごとに
 * 別のディレクトリを使うようにしたので、放っておくと `/tmp` に溜まり続ける。
 * **走っているかもしれない実行には触らない**——1日より古いものだけ消す。
 */
function removeStaleRuns(): void {
  const runsRoot = E2E_BASE;
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
      if (statSync(path).mtimeMs < dayAgo) removeTree(path);
    } catch {
      // 消せないものは放っておく——片づけで試験を止めない
    }
  }
}

/**
 * **前の回が残したコンテナを片づける**（追加・2026-09-25）。ふつうは終わるときに消す（`global-teardown.ts`）が、
 * 途中で止めた回や、終わる瞬間に host がまだコンテナを触っていた回（`Instance is busy`）は残る。
 * **別のセッションが同時に回している E2E のものは消さない**——その回がもう走っていない（置き場が消えた、
 * または印の pid が生きていない）ものだけを消す。
 *
 * **HOME に依らず拾う**（改訂・2026-10-01）。以前は自分の `E2E_BASE`（`~/.cache/banto-e2e`）の下のものだけを
 * 見ていたので、サブエージェント（偽のホーム）が回して残したものは、人の Shell から回した次の回が拾えなかった。
 * ふつうは回が終われば片づけ役（`run-reaper.ts`）が消すので、ここはその片づけ役ごと殺されたときの受け皿
 */
function removeStaleContainers(): void {
  removeContainers(staleOwnedContainers(DATA_DIR), (line) => console.log(`${line}（前の回が残したもの）`), 1);
}
