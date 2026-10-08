// **spec ファイルが替わるたびに、banto を「回の始めの姿」に戻す**（追加・2026-10-01、広げた・2026-10-08、ユーザー）。
//
// 2026-10-08 に広げた理由：spec は自分の Project を畳まず、目録から入れた Module も外さず、受信箱も片づけない。
// 1回のフル E2E で Project が約 146 個たまり、受信箱（banto 全体で1つ）には前の spec の判断待ち・お知らせが並び、
// `installInfisical` で入れた2本目の Vault が後ろの spec まで残った——落ちた 11 件のうち 10 件の根がこれだった
// （受信箱のバッジが 1 のはずが 4、「Vault は1本」が2本、設定の面のボタンが出ずに 300 秒待つ）。spec はどれも単独で
// 回せる前提なので、替わり目で次のものを戻す：
//   1. 開いている Project を全部畳む（コンテナの有無に関わらず）。この回のコンテナは消す（下の「使い回しにはしない」）
//   2. banto 全体の Module のうち、回の始めに無かったものを外し、止めた・動かしたものは回の始めの状態に戻す
//   3. 受信箱：答えていない判断待ちは断り、お知らせ・レビュー待ちは見たにする（`helpers.ts` の `settleInbox`）
//   4. banto 全体の Vault（vault-local）の alias のうち、回の始めに無かったものを消す（追加・2026-10-08——subagent-settings が
//      途中で落ちて既定の鍵を消さずに残し、次の subagent.spec の続きの依頼がその鍵を拾って承認待ちのまま落ちた）
// 戻せなかったものは理由つきで落とす（Module・Project）か警告する（受信箱の、答えられない判断待ち）——黙って続けない。
//
// **beforeAll より先に戻す**：Playwright の自動の fixture はテストにしか付かず、beforeAll はその前に走る。spec の
// beforeAll が目録から入れた Module（backlog・factory 等）を、後から「回の始めに無かったもの」として外してしまう
// ので、ここで書き出す `test.beforeAll` は、spec の関数の前に同じ戻しを挟む。
//
// 以下はもとの説明（Project のコンテナの片づけ、2026-10-01）。
//
// Project のコンテナは Project ごとに1台（`banto-<Project の id>`）で、Project を畳むまで動き続ける。spec は
// それぞれ自分の Project を作って畳まないので、1回のフル E2E で約 50 台が**同時に**動いたままになり、
// Project のコンテナ（入れ子の Incus）を圧迫していた。回の終わりの片づけ（`run-reaper.ts`）だけでは、
// 走っている間の台数は減らない。
//
// **使い回しにはしない**——コンテナは Project の閉じ込めそのもの（根のマウント・中に入れた道具・Docker の
// 入れ子の設定）なので、別の Project 同士で共有すると、試験が本番と違う形になる。
//
// やり方：どの spec もここの `test` を使う（`@playwright/test` の代わり）。自動の fixture が、テストの
// 始まりに「前のテストと spec ファイルが違う」と気づいたら、それまでの Project のコンテナを片づける：
//   1. Project が開いていれば、core に畳ませる（POST close）——core が Module を落とし、コンテナを止め、
//      「用意できたコンテナ」の台帳から外す。直接消すと core が Module の死を見て起こし直し、コンテナを
//      作り直してしまう
//   2. コンテナを消す
// **畳んだまま開き直さない**。開き直すと、次の spec の画面がその Project を開いてコンテナを起こし直し（冷えた
// 起動で数秒）、その陰で保存の要求が遅れて、保存を待たない試験が落ちた（archive-tabs・sidebar-reorder-rename、
// 2026-10-01 に実測）。畳んだままなら、次の spec はほぼ「その spec だけを回したとき」と同じ姿から始まる
// ——spec はどれも単独で回せるように書かれている。
// banto 全体用のコンテナ（Project に結びつかないもの）は spec をまたいで使うので触らない。
// 片づけのせいで落ちているかを切り分けたいときは BANTO_E2E_KEEP_SPEC_CONTAINERS=1 で止められる（回の終わりの片づけは残る）。
//
// 「前の spec ファイル」は回の置き場のファイルに覚える——Playwright はテストが落ちると worker を作り直すので、
// worker の中の変数だと、同じ spec の続きを別の spec と取り違える。
//
// **戻すのは自分の core だけ**（追加・2026-10-08、worker ごとに core を持つ——`config.ts` の CORE_COUNT）。CORE_BASE_URL・
// DATA_DIR はこの worker の番号の core のもので、覚えるファイル（前の spec・回の始めの Module・alias）もその core の置き場
// （`w<番号>`）に置く。作り直された worker は同じ番号を受け取るので、同じファイルの続きから読む
import { test as base, type BrowserContext, type TestInfo } from "@playwright/test";
import { containerNameFor } from "@banto/container";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, CORE_BROWSER_URL, DATA_DIR, FRONTEND_BASE_URL } from "./config.ts";
import { writeLoginLink } from "../packages/core/dist/auth/login-links.js";
import { containerLog, listOwnedContainers, removeContainers } from "./containers.ts";
import { settleInbox } from "./helpers.ts";

export * from "@playwright/test";

const LAST_SPEC_FILE = join(dirname(DATA_DIR), "last-spec-file");
/** 回の始めの banto 全体の Module（名前と、使うかどうか）。worker は落ちると作り直されるので、変数ではなくファイルに */
const MODULES_BASELINE_FILE = join(dirname(DATA_DIR), "instance-modules-baseline.json");
/** 回の始めの vault-local の alias（グループと名前）。同じ理由でファイルに */
const ALIASES_BASELINE_FILE = join(dirname(DATA_DIR), "vault-aliases-baseline.json");

/**
 * **どのテストも、ログインした状態で始まる**（追加・2026-10-03、人のログイン）。host のコマンド
 * （`scripts/login-link.mjs`）と同じ札をデータ置き場に置き、ブラウザの文脈から引き換える——Cookie はその文脈に
 * 入る。ログインしていない画面を見たいテストは `test.use({ loggedIn: false })`
 */
export async function loginContext(context: BrowserContext): Promise<void> {
  const { code } = await writeLoginLink(DATA_DIR);
  const res = await context.request.post(`${CORE_BROWSER_URL}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`[e2e] ログインできませんでした：${res.status()} ${await res.text()}`);
}

const extended = base.extend<{ resetAtSpecBoundary: void; loggedIn: boolean }>({
  loggedIn: [true, { option: true }],
  context: async ({ context, loggedIn }, use) => {
    if (loggedIn) await loginContext(context);
    await use(context);
  },
  resetAtSpecBoundary: [
    async ({}, use, testInfo) => {
      await resetIfNewSpec(testInfo);
      await use();
      if (testInfo.status !== testInfo.expectedStatus) await attachContainerLogs(testInfo);
    },
    { auto: true, timeout: 180_000 },
  ],
});

/**
 * spec の `test.beforeAll` の前にも、替わり目の戻しを挟む（上の「beforeAll より先に戻す」）。Playwright は関数の
 * 文字列から使う fixture を読む（最初の引数の分割代入）ので、包んだ関数の toString は spec の関数のものを返す
 */
type HookFn = (fixtures: Record<string, unknown>, testInfo: TestInfo) => unknown;
const originalBeforeAll = extended.beforeAll.bind(extended) as (...args: unknown[]) => void;
extended.beforeAll = ((...args: unknown[]) => {
  const fn = args.pop() as HookFn;
  const wrapped: HookFn = async (fixtures, testInfo) => {
    await resetIfNewSpec(testInfo);
    return fn(fixtures, testInfo);
  };
  wrapped.toString = () => fn.toString();
  originalBeforeAll(...args, wrapped);
}) as typeof extended.beforeAll;

export const test = extended;

async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${CORE_BASE_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function apiJson<T>(path: string): Promise<T> {
  const res = await api(path);
  if (!res.ok) throw new Error(`[e2e] ${path} を読めません：${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type InstanceModule = { name: string; enabled: boolean };

/** 前のテストと spec ファイルが違えば戻す。回の最初の spec では、戻す先（回の始めの Module）を覚えるだけ */
async function resetIfNewSpec(testInfo: TestInfo): Promise<void> {
  const last = existsSync(LAST_SPEC_FILE) ? readFileSync(LAST_SPEC_FILE, "utf8") : null;
  if (last === testInfo.file) return;
  if (last === null) {
    const modules = await apiJson<InstanceModule[]>("/api/modules");
    writeFileSync(MODULES_BASELINE_FILE, JSON.stringify(modules.map(({ name, enabled }) => ({ name, enabled }))));
    writeFileSync(ALIASES_BASELINE_FILE, JSON.stringify(await vaultAliases()));
  } else {
    if (!process.env.BANTO_E2E_KEEP_SPEC_CONTAINERS) await closeProjects();
    await restoreInstanceModules();
    await removeAddedAliases();
    const left = await settleInbox();
    if (left.length > 0) {
      console.warn(`[e2e] 前の spec の受信箱を片づけきれなかった——この spec の受信箱の数がずれうる: ${left.join(" / ")}`);
    }
  }
  writeFileSync(LAST_SPEC_FILE, testInfo.file);
}

/**
 * 開いている Project を全部畳み、この回の Project のコンテナを消す。
 * 畳むと core が Module を落としてコンテナを止め、「用意できたコンテナ」の台帳から外す
 */
async function closeProjects(): Promise<void> {
  const projects = await apiJson<{ id: string; name: string; status: "active" | "closed" }[]>("/api/projects");
  for (const project of projects.filter((p) => p.status === "active")) {
    const closed = await api(`/api/projects/${project.id}/close`, "POST");
    if (!closed.ok) throw new Error(`[e2e] Project「${project.name}」（${project.id}）を畳めません：${closed.status} ${await closed.text()}`);
  }
  const byContainer = new Set(projects.map((p) => containerNameFor(p.id)));
  const mine = listOwnedContainers().filter((c) => c.owner === DATA_DIR && byContainer.has(c.name));
  const failed = removeContainers(mine.map((c) => c.name), () => {});
  if (failed.length > 0) throw new Error(`[e2e] 前の spec のコンテナを消せませんでした：${failed.join(", ")}`);
}

/** banto 全体の Module を回の始めの姿に戻す。外せない・戻せないものは理由つきで落とす */
async function restoreInstanceModules(): Promise<void> {
  const baseline = JSON.parse(readFileSync(MODULES_BASELINE_FILE, "utf8")) as InstanceModule[];
  const before = new Map(baseline.map((m) => [m.name, m.enabled]));
  const now = await apiJson<InstanceModule[]>("/api/modules");
  const problems: string[] = [];
  for (const m of now) {
    const wasEnabled = before.get(m.name);
    if (wasEnabled === undefined) {
      const res = await api(`/api/modules/${encodeURIComponent(m.name)}`, "DELETE");
      if (!res.ok) problems.push(`${m.name} を外せない（${res.status} ${await res.text()}）`);
    } else if (wasEnabled !== m.enabled) {
      const res = await api(`/api/modules/${encodeURIComponent(m.name)}`, "PUT", { enabled: wasEnabled });
      if (!res.ok) problems.push(`${m.name} を${wasEnabled ? "使う" : "止める"}に戻せない（${res.status} ${await res.text()}）`);
    }
  }
  const missing = baseline.filter((m) => !now.some((n) => n.name === m.name)).map((m) => m.name);
  if (missing.length > 0) problems.push(`回の始めにあった ${missing.join("・")} が無くなっている（ここでは戻せない）`);
  if (problems.length > 0) throw new Error(`[e2e] 前の spec の Module を回の始めの姿に戻せません：${problems.join(" / ")}`);
}

type VaultAlias = { name: string; group?: string };

/** vault-local を人の管理面の口（`/api/ui-tool-call`）で呼ぶ。失敗は理由つきで投げる */
async function vaultLocal(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await api("/api/ui-tool-call", "POST", { server: "vault-local", tool, arguments: args });
  const body = (await res.json().catch(() => null)) as { isError?: boolean; content?: { type: string; text?: string }[] } | null;
  const text = body?.content?.find((c) => c.type === "text")?.text ?? "";
  if (!res.ok || !body || body.isError) throw new Error(`[e2e] vault-local の ${tool} が失敗：${res.status} ${text || JSON.stringify(body)}`);
  return text;
}

async function vaultAliases(): Promise<VaultAlias[]> {
  return (JSON.parse(await vaultLocal("listAliases", {})) as VaultAlias[]).map(({ name, group }) => ({ name, group }));
}

/** vault-local の alias のうち、回の始めに無かったものを消す。消せないものは理由つきで落とす */
async function removeAddedAliases(): Promise<void> {
  const key = (a: VaultAlias) => `${a.group ?? ""}/${a.name}`;
  const baseline = new Set((JSON.parse(readFileSync(ALIASES_BASELINE_FILE, "utf8")) as VaultAlias[]).map(key));
  const problems: string[] = [];
  for (const alias of (await vaultAliases()).filter((a) => !baseline.has(key(a)))) {
    try {
      await vaultLocal("deleteAlias", { name: alias.name });
    } catch (err) {
      problems.push(`${key(alias)}（${(err as Error).message}）`);
    }
  }
  if (problems.length > 0) throw new Error(`[e2e] 前の spec が Vault に置いた alias を消せません：${problems.join(" / ")}`);
}

/**
 * **落ちたテストに、この回のコンテナの起動の記録を添える**（追加・2026-10-08）。コンテナが起きないと core は
 * 「起こせなかった」としか言わず、理由（`incusd forkstart` 等）は Incus の側にしか無い——wide-root が
 * それで落ちても、手がかりが残らなかった。この回のコンテナ全部の `incus info --show-log` を付ける。
 * **動いているものも含める**——core は起こせなかったコンテナを5秒ごとに起こし直すので、落ちた瞬間に一覧を読むと
 * `Running` に見えることがある（wide-root で実測、動いていないものだけに絞ったら何も付かなかった）。替わり目に前の
 * spec のコンテナは消えているので、数台で済む
 */
async function attachContainerLogs(testInfo: TestInfo): Promise<void> {
  let mine;
  try {
    mine = listOwnedContainers().filter((c) => c.owner === DATA_DIR);
  } catch (err) {
    await testInfo.attach("incus-show-log", { body: `コンテナの一覧を読めません：${(err as Error).message}`, contentType: "text/plain" });
    return;
  }
  for (const c of mine) {
    await testInfo.attach(`incus-show-log-${c.name}`, { body: `状態：${c.status}\n\n${containerLog(c.name)}`, contentType: "text/plain" });
  }
}
