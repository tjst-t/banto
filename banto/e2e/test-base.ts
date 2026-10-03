// **spec ファイルが替わるたびに、前の spec の Project のコンテナを片づける**（追加・2026-10-01、ユーザー）。
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
import { test as base, type BrowserContext } from "@playwright/test";
import { containerNameFor } from "@banto/container";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, CORE_BROWSER_URL, DATA_DIR, FRONTEND_BASE_URL } from "./config.ts";
import { writeLoginLink } from "../packages/core/dist/auth/login-links.js";
import { listOwnedContainers, removeContainers } from "./containers.ts";

export * from "@playwright/test";

const LAST_SPEC_FILE = join(dirname(DATA_DIR), "last-spec-file");

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

export const test = base.extend<{ releasePreviousSpecContainers: void; loggedIn: boolean }>({
  loggedIn: [true, { option: true }],
  context: async ({ context, loggedIn }, use) => {
    if (loggedIn) await loginContext(context);
    await use(context);
  },
  releasePreviousSpecContainers: [
    async ({}, use, testInfo) => {
      const last = existsSync(LAST_SPEC_FILE) ? readFileSync(LAST_SPEC_FILE, "utf8") : null;
      if (last !== null && last !== testInfo.file && !process.env.BANTO_E2E_KEEP_SPEC_CONTAINERS) await releaseProjectContainers();
      if (last !== testInfo.file) writeFileSync(LAST_SPEC_FILE, testInfo.file);
      await use();
    },
    { auto: true, timeout: 120_000 },
  ],
});

async function api(path: string, method = "GET"): Promise<Response> {
  return fetch(`${CORE_BASE_URL}${path}`, { method, headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
}

/** この回の Project のコンテナを全部片づける（開いている Project は畳む） */
async function releaseProjectContainers(): Promise<void> {
  const res = await api("/api/projects");
  if (!res.ok) throw new Error(`[e2e] Project の一覧を読めません：${res.status}`);
  const projects = (await res.json()) as { id: string; status: "active" | "closed" }[];
  const byContainer = new Map(projects.map((p) => [containerNameFor(p.id), p]));
  const mine = listOwnedContainers().filter((c) => c.owner === DATA_DIR && byContainer.has(c.name));
  for (const c of mine) {
    const project = byContainer.get(c.name)!;
    if (project.status === "active") {
      // 畳むと core が Module を落としてコンテナを止める
      const closed = await api(`/api/projects/${project.id}/close`, "POST");
      if (!closed.ok) throw new Error(`[e2e] Project ${project.id} を畳めません：${closed.status}`);
    }
  }
  const failed = removeContainers(mine.map((c) => c.name), () => {});
  if (failed.length > 0) throw new Error(`[e2e] 前の spec のコンテナを消せませんでした：${failed.join(", ")}`);
}
