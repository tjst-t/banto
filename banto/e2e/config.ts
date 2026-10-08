// E2E専用のポート・パス定数。テストとglobal-setupの両方から参照する
// ——真実は一箇所（規則3）、同じ値をあちこちに書き写さない。
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * 既定の並列の数（2026-10-08 に測って決めた。経緯は `docs/notes/2026-10-08-e2e-parallel.md`）。この機械（4 コア・
 * 11.6GiB）で同じ 18 本を流して 1 本：787 秒・2 本：534 秒・3 本：532 秒（どれも全部通った）。3 本は CPU が詰まり
 * （/proc/pressure/cpu の some が平均 60%）、spec 1本ずつが遅くなるだけで回は縮まなかった
 */
export const DEFAULT_WORKERS = 2;
/** 1回に使う port の枠（画面1つ＋core ごとに4つ）に収まる上限 */
const MAX_WORKERS = 6;

/**
 * **worker ごとに core を1本持つ**（追加・2026-10-08、`docs/notes/2026-10-08-e2e-parallel.md`）。
 *
 * spec ファイルは worker に配られて並んで走る。全 worker が1つの core を共有すると、受信箱・Project の一覧・
 * banto 全体の Module を奪い合う（2026-09-10 に workers を 1 にした理由）。そこで **worker の数だけ core を起こし**
 * （`playwright.config.ts` の webServer）、worker は自分の番号（Playwright が渡す `TEST_PARALLEL_INDEX`。worker が
 * 落ちて作り直されても同じ番号）の core だけを相手にする。core の側は webServer が渡す `BANTO_E2E_CORE_INDEX` で
 * 自分の番号を知る。主プロセス（番号を持たない）では 0 番の値になる——回の全部の core を見たいところ
 * （回の終わりの片づけ・webServer）は `coreDataDir(i)` などを `CORE_COUNT` だけ回す。
 *
 * **定数の名前は変えない**（65 の spec が module の読み込み時に import している）。値の決め方だけを番号ごとにする。
 */
export const CORE_COUNT = coreCountFromEnv();
export const CORE_INDEX = Number(process.env.BANTO_E2E_CORE_INDEX ?? process.env.TEST_PARALLEL_INDEX ?? "0");
if (!Number.isInteger(CORE_INDEX) || CORE_INDEX < 0 || CORE_INDEX >= CORE_COUNT) {
  // `--workers`（`-j`）で worker を増やすと、core の無い番号の worker ができる——黙って 0 番の core に相乗りしない
  throw new Error(
    `[e2e] worker ${CORE_INDEX} 番の core がありません（core は ${CORE_COUNT} 本）。` +
      `並列の数は --workers ではなく BANTO_E2E_WORKERS で変えてください`,
  );
}

function coreCountFromEnv(): number {
  const raw = process.env.BANTO_E2E_WORKERS;
  if (raw === undefined || raw === "") return DEFAULT_WORKERS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS) {
    throw new Error(`[e2e] BANTO_E2E_WORKERS は 1〜${MAX_WORKERS} の整数で（いま「${raw}」）`);
  }
  return n;
}

/**
 * 実行ごとに違う port を選ぶ。**衝突したら Playwright が止まる**（黙って相乗りしない）。
 *
 * 4740〜4939 の枠を、実行ごとに **25 ずつ**使う（8 枠）：先頭が画面、その後ろに core ごとに4つ
 * （core・sandbox・MCP Registry の偽物・npm registry の偽物）。同じ機械の回は機械全体のロック（`run-lock.ts`）で
 * 1回ずつなので、枠がぶつかるのはロックを外して重ねたときだけ
 */
const RUN_PORT_BASE = 4740 + (Number(RUN_ID) % 8) * 25;
function corePort(index: number, offsetInCore: number): number {
  return RUN_PORT_BASE + 1 + index * 4 + offsetInCore;
}

export const CORE_PORT = corePort(CORE_INDEX, 0);
// Module の画面を隔離するサンドボックス（§6.2）。**画面とは別オリジン**
// でなければならないので、E2E でも別ポートで立てる
export const SANDBOX_PORT = corePort(CORE_INDEX, 1);

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
// 画面は回に1本（core が何本でも、`?bantoHost=` で繋ぐ先を選べる）
export const FRONTEND_PORT = RUN_PORT_BASE;

/**
 * **試験用の MCP Registry**（追加・2026-09-21、`registry-fixture.ts`）。
 *
 * **本物の registry を叩かない**（規則6）——一覧の中身は毎日変わるので、
 * 並び順の検査が外の都合で落ちる。core と同じプロセスで立てる。
 */
export const REGISTRY_PORT = corePort(CORE_INDEX, 2);
export const REGISTRY_BASE_URL = `http://127.0.0.1:${REGISTRY_PORT}`;

/**
 * **試験用の npm registry**（追加・2026-09-21、`npm-registry-fixture.ts`）。
 *
 * registry から入れた Module を**実際に取ってきて繋ぐ**ところまで見るのに要る。
 * 本物の npm を叩くと、外の都合で落ちる試験になる（規則6）。
 */
export const NPM_REGISTRY_PORT = corePort(CORE_INDEX, 3);
export const NPM_REGISTRY_BASE_URL = `http://127.0.0.1:${NPM_REGISTRY_PORT}`;

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
// 開発時のモノレポでは Module に「モノレポの根」を読み取り専用で見せている
// （npm workspaces が node_modules を根に hoist するため。いまは Project のコンテナに
// 読み取り専用でマウントする）。ここに banto のデータ置き場があると、**Module が
// banto 自身の Event Store を読める**——本番（`~/.local/share/banto`）には
// 無い形で、試験環境だけが緩くなる。なので置き場は本番と同じ関係（リポジトリの外）にする。
/**
 * **Project の Module はコンテナの中で動く**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。E2E は
 * incus グループが効いたプロセスで回す（付いていなければ主プロセスが `sudo -n -E -u <自分>` で自分を起こし直す
 * ——`incus-access.ts`。`sg incus` は主グループを変えるので使わない）。
 *
 * **置き場をホームの下に置く**：権限を絞った Incus の区画は、ホームの下しかコンテナに見せられない。Project の根も
 * Module の置き場もコンテナに見せるので、E2E の置き場ごとホームの下に置き、**`TMPDIR` もそこへ向ける**——spec は
 * Project の根を `tmpdir()` の下に作っている（84 か所）ので、spec を書き換えずに済む
 */
export const E2E_BASE = join(homedir(), ".cache", "banto-e2e");
/** 回の置き場（Playwright の pid）。その下に core ごとの置き場 `w<番号>` を置く */
export const RUN_DIR = join(E2E_BASE, RUN_ID);
/** core ごとの置き場。真実は一箇所——回の終わりの片づけ（全部の core）もここから引く */
export function coreDir(index: number): string {
  return join(RUN_DIR, `w${index}`);
}
/** その番号の core のデータの置き場（コンテナの札 `user.banto.owner` はこれ） */
export function coreDataDir(index: number): string {
  return join(coreDir(index), "data");
}
/** その番号の core の待ち受け（主プロセスが webServer の起動を確かめる・片づけ役に渡す） */
export function coreBaseUrl(index: number): string {
  return `http://127.0.0.1:${corePort(index, 0)}`;
}
const E2E_TMP = coreDir(CORE_INDEX);
process.env.TMPDIR = join(E2E_TMP, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
export const DATA_DIR = coreDataDir(CORE_INDEX);
/**
 * **Shell のホームへ写す元**（追加・2026-09-23）。本物の人のホーム（`~/.gitconfig`）を
 * 試験に使わない——実行ごとの置き場に偽のホームを作る（`start-core.ts`）。
 */
export const SHELL_HOME_SOURCE = join(E2E_TMP, "user-home");

/**
 * **本体の Claude ログインの代わり**（Claude のログインの中継が読む。契約の種類を Project 設定・サブエージェントの
 * 画面に出す）と、**鍵の取り込み元**（OpenCode の `auth.json` に当たるもの）も偽物にする（追加・2026-09-24）
 * ——人の `~/.claude`・`~/.local/share/opencode` を試験が読まないように
 */
export const CLAUDE_RELAY_CREDENTIALS = join(E2E_TMP, "claude-relay-credentials.json");
export const SUBAGENT_IMPORT_FILE = join(E2E_TMP, "subagent-import-auth.json");
/** 取り込み元に置いてある鍵（試験がその sha256 を突き合わせる） */
export const SUBAGENT_IMPORTED_KEY = "e2e-imported-key-7Q2";
export const CONFIG_PATH = join(E2E_TMP, "config", "config.json");
/**
 * **画面から banto を更新する**（追加・2026-10-04、`self-update.spec.ts`）。本物の systemd も人の置き場
 * （`~/.local/share/banto-release`）も使わない——置き場・偽の systemctl・動いているコードの場所を実行ごとの
 * 置き場に向ける。中身（repo.git・版のフォルダ・偽の systemctl）は spec が作る。作るまでは「準備が済んでいない」
 */
export const SELF_UPDATE_DIR = join(E2E_TMP, "self-update");
export const RELEASE_DIR = join(SELF_UPDATE_DIR, "release");
export const FAKE_SYSTEMCTL = join(SELF_UPDATE_DIR, "systemctl");
/** Repositories のアカウントのための偽の GitHub の行き先（core のプロセスが書き、spec が読む——`github-login-fixture.ts`） */
export const GITHUB_LOGIN_FIXTURE_FILE = join(E2E_TMP, "github-login-fixture.json");
/** 偽の Infisical の行き先と資格情報（core のプロセスが書き、自前の host が読む——`infisical-fixture.ts`） */
export const INFISICAL_FIXTURE_FILE = join(E2E_TMP, "infisical-fixture.json");

/**
 * **claude CLI 自身の置き場**。E2E は**人の `~/.claude` を一切書き換えない**
 * （決定・2026-09-16、ユーザー指摘）。
 *
 * Runner は claude CLI を子プロセスとして起こす。CLI は**cwd ごとに
 * 「プロジェクト」を作り**、会話の記録を `<config>/projects/<cwd を潰した名前>/`
 * に書く。spec は毎回 `mkdtemp` で違う作業ディレクトリを作るので、
 * **1回の E2E で spec の本数だけプロジェクトが増える**——11日で 4198 件溜まり、
 * 人が使っている CloudCLI のプロジェクト一覧がそれで埋まった（2026-09-16 に実測）。
 *
 * 溜まったものを定期的に消す形にはしない——**人の環境に書いてから片づける**
 * かぎり、片づけ漏れも、走っている最中の一覧汚染も残る。**そもそも書かない**。
 *
 * ここは実行ごと（`E2E_TMP` の下）なので、`removeStaleRuns()` が1日で回収する。
 */
export const CLAUDE_CONFIG_DIR = join(E2E_TMP, "claude");

/**
 * **資格情報の置き場も、人のものを見せない**（改訂・2026-10-08）。
 *
 * 以前は `CLAUDE_SECURESTORAGE_CONFIG_DIR` で人の `~/.claude` を指し、`global-setup.ts` がそこに
 * `.credentials.json` があるかを走る前に確かめていた（無いと全 spec が「AI が何も返さない」で落ちたため）。
 * **2026-09-20 から E2E は実 LLM を使わない**（`fake-runner.ts`）——Runner の発言・選べるモデルは偽物が返し、
 * サブエージェントも偽物（`BANTO_SUBAGENT_FAKE_AGENT`、設定画面が読むログインは `SUBAGENT_CLAUDE_CREDENTIALS`）。
 * 取り消しの手前探し（`findRewindBeforePrompt`）は記録のファイルを読むだけで、認証は要らない。
 * なので資格情報は要らず、確かめは「人のホームに無いと始まらない」だけの障害になっていた（サブエージェント・
 * Factory は偽のホームで回すので毎回止まった）。
 *
 * 置き場は**この回の CLI の置き場そのもの**（資格情報は置かない）。どこかに本物の CLI を起こす道が残っていても、
 * 人のアカウントで黙って推論せず `Not logged in` で落ちる——実 LLM を使わない約束が破れたことが見える（規則2）。
 */
export const CLAUDE_CREDENTIALS_DIR = CLAUDE_CONFIG_DIR;
export const AUTH_TOKEN = "e2e-fixed-token";
export const PORT = CORE_PORT;

export const SANDBOX_BASE_URL = `http://127.0.0.1:${SANDBOX_PORT}`;
/** **node の側から** core を叩く住所（Bearer の機械の口）。ブラウザからは `CORE_BROWSER_URL` */
export const CORE_BASE_URL = `http://127.0.0.1:${CORE_PORT}`;
/**
 * **ブラウザが開く住所は localhost**（改訂・2026-10-03、人のログイン）。パスキー（WebAuthn）は IP アドレスを
 * RP ID に取れない（127.0.0.1 では「invalid domain」、実測）。画面と core を同じ名前（localhost）にそろえる
 * ——ログインの Cookie は名前ごと（ポートを問わない）なので、画面のポートから core のポートへの要求にも付く
 */
export const FRONTEND_BASE_URL = `http://localhost:${FRONTEND_PORT}`;
export const CORE_BROWSER_URL = `http://localhost:${CORE_PORT}`;
/** 画面のサーバが待ち受ける住所（起動の確かめに使う。node の localhost は ::1 を先に引くことがある） */
export const FRONTEND_LISTEN_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
