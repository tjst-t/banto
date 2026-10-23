// **メタ Project の設定**（アーキ仕様 §4.6、Backlog #538）——設定の「メタ Project」の節で選んだものが host の状態を変える。
//
// 見ること（画面と host の記録の両方で、規則14）：
//   1. 節はメタ Project の設定にだけ出る（普通の Project には出ない）
//   2. 管理対象の候補はサイドバーと同じ並び（グループなし → グループの見出しの下 → スリープ中）。自分自身・ほかのメタ Project は出ない
//   3. 管理対象にすると host の managedProjectIds に入り、その Project 用の専用 Fork が立ってサイドバーに出る。外すと閉じて
//      サイドバーから消え、選び直すと同じ Fork が開き直る（2本目を立てない）
//   4. release の扱いを切り替えると host の meta-release が変わり、読み込み直しても画面は host のまま
//   5. host が断ったら理由を出し、表示は host の値のまま
//
// Backlog の置き場（tasks.json・Gist）はメタ Project の節ではなく Backlog Module 自身の設定面で選ぶ——そちらは backlog.spec.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "../test-base.js";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const A = "E2E メタ管理 A";
const B = "E2E メタ管理 B";
const C = "E2E メタ管理 C";
const META = "E2E メタ Project";
const OTHER_META = "E2E ほかのメタ Project";
const GROUP = "E2E メタ管理グループ";

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** 画面から作るときと同じく Base Thread を持たせる——無いと画面の一覧に入らない */
async function makeProject(name: string, kind?: "meta"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-meta-"));
  const created = await api<{ id: string }>("POST", "/api/projects", { name, root, ...(kind ? { kind } : {}) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const base = await api("POST", `/api/projects/${created.body.id}/threads`);
  expect(base.status, JSON.stringify(base.body)).toBe(201);
  return created.body.id;
}

interface HostThread {
  id: string;
  kind: string;
  title?: string;
  status: string;
  managedProjectId?: string;
}
const managedOf = async (id: string) =>
  (await api<Array<{ id: string; managedProjectIds?: string[] }>>("GET", "/api/projects")).body.find((p) => p.id === id)!.managedProjectIds ?? [];
const dedicatedForks = async (id: string) =>
  (await api<HostThread[]>("GET", `/api/projects/${id}/threads`)).body.filter((t) => t.kind === "fork" && t.managedProjectId);
const releaseOf = async (id: string) => (await api<{ release: string }>("GET", `/api/projects/${id}/meta-release`)).body.release;

function row(page: Page, projectId: string) {
  return page.locator(`[data-testid="meta-managed-row"][data-project-id="${projectId}"]`);
}

test("メタ Project の設定で選んだ管理対象と release の扱いが host に書かれ、専用 Fork がサイドバーに出入りする", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const a = await makeProject(A);
  const b = await makeProject(B);
  const c = await makeProject(C);
  const meta = await makeProject(META, "meta");
  const otherMeta = await makeProject(OTHER_META, "meta");
  const group = await api<{ id: string }>("POST", "/api/project-groups", { name: GROUP });
  expect(group.status, JSON.stringify(group.body)).toBe(201);
  expect((await api("PUT", `/api/projects/${b}/group`, { groupId: group.body.id })).status).toBe(200);
  const slept = await api("POST", `/api/projects/${c}/sleep`);
  expect(slept.status, JSON.stringify(slept.body)).toBe(200);

  await openApp(page);

  // ---- 1. 普通の Project の設定には節が無い --------------------------------------------------------------------
  await page.goto(`/p/${a}?settings=1&project=${a}&section=project-general`);
  await expect(page.getByTestId("project-general-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "メタ Project", exact: true })).toHaveCount(0);

  // ---- 2. メタ Project の設定：「一般」の次に節があり、候補はサイドバーと同じ並び ------------------------------------
  await page.goto(`/p/${meta}?settings=1&project=${meta}&section=project-general`);
  await expect(page.getByTestId("project-general-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "メタ Project", exact: true }).click();
  const panel = page.getByTestId("meta-project-panel");
  await expect(panel.getByRole("heading", { name: "メタ Project", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("meta-managed-section")).toContainText("管理対象の Project");

  // 自分自身・ほかのメタ Project は出ない
  await expect(row(page, a)).toBeVisible({ timeout: 30_000 });
  await expect(row(page, meta)).toHaveCount(0);
  await expect(row(page, otherMeta)).toHaveCount(0);
  // A はグループの外・B はグループの見出しの下・C はスリープ中
  await expect(panel.locator('[data-testid="meta-managed-group"]').locator(`[data-project-id="${a}"]`)).toHaveCount(0);
  await expect(panel.getByTestId("meta-managed-sleeping").locator(`[data-project-id="${a}"]`)).toHaveCount(0);
  const groupBox = panel.locator(`[data-testid="meta-managed-group"][data-group-id="${group.body.id}"]`);
  await expect(groupBox.getByTestId("meta-managed-group-name")).toHaveText(GROUP);
  await expect(groupBox.getByTestId("meta-managed-name")).toHaveText([B]);
  await expect(panel.getByTestId("meta-managed-sleeping")).toContainText("スリープ中");
  await expect(panel.getByTestId("meta-managed-sleeping").locator(`[data-project-id="${c}"]`).getByTestId("meta-managed-name")).toHaveText(C);
  // 並び：A（グループなし）が B（グループ）より上、B が C（スリープ中）より上
  const y = async (id: string) => (await row(page, id).boundingBox())!.y;
  expect(await y(a)).toBeLessThan(await y(b));
  expect(await y(b)).toBeLessThan(await y(c));

  for (const [id, name] of [
    [a, A],
    [b, B],
    [c, C],
  ] as const) {
    await expect(row(page, id).getByTestId("meta-managed-name")).toHaveText(name);
    await expect(row(page, id).getByTestId("meta-managed-state")).toHaveText("管理していない");
    await expect(row(page, id).getByTestId("meta-managed-switch")).toHaveAttribute("aria-checked", "false");
  }
  expect(await managedOf(meta)).toEqual([]);
  expect(await dedicatedForks(meta)).toEqual([]);

  // ---- 3. 管理対象にする・外す・選び直す ---------------------------------------------------------------------------
  const sidebarForks = page.getByTestId("sidebar-fork-name");

  await row(page, a).getByTestId("meta-managed-switch").click();
  await expect(row(page, a).getByTestId("meta-managed-state")).toHaveText("専用 Fork を1本持つ", { timeout: 30_000 });
  await expect(row(page, a).getByTestId("meta-managed-switch")).toHaveAttribute("aria-checked", "true");
  expect(await managedOf(meta)).toEqual([a]);
  const forksAfterA = await dedicatedForks(meta);
  expect(forksAfterA.map((t) => [t.title, t.managedProjectId, t.status])).toEqual([[A, a, "active"]]);
  const forkA = forksAfterA[0]!.id;
  await expect(sidebarForks.filter({ hasText: A })).toHaveCount(1, { timeout: 30_000 });

  await row(page, c).getByTestId("meta-managed-switch").click();
  await expect(row(page, c).getByTestId("meta-managed-state")).toHaveText("専用 Fork を1本持つ", { timeout: 30_000 });
  expect(await managedOf(meta)).toEqual([a, c]);
  expect((await dedicatedForks(meta)).map((t) => [t.title, t.managedProjectId, t.status])).toEqual([
    [A, a, "active"],
    [C, c, "active"],
  ]);
  await expect(sidebarForks.filter({ hasText: C })).toHaveCount(1, { timeout: 30_000 });
  await expect(row(page, b).getByTestId("meta-managed-state")).toHaveText("管理していない");

  // 外す：A の専用 Fork は閉じ、サイドバーから消える
  await row(page, a).getByTestId("meta-managed-switch").click();
  await expect(row(page, a).getByTestId("meta-managed-state")).toHaveText("管理していない", { timeout: 30_000 });
  await expect(row(page, a).getByTestId("meta-managed-switch")).toHaveAttribute("aria-checked", "false");
  expect(await managedOf(meta)).toEqual([c]);
  expect((await dedicatedForks(meta)).map((t) => [t.id === forkA, t.managedProjectId, t.status])).toEqual([
    [true, a, "closed"],
    [false, c, "active"],
  ]);
  await expect(sidebarForks.filter({ hasText: A })).toHaveCount(0, { timeout: 30_000 });
  await expect(sidebarForks.filter({ hasText: C })).toHaveCount(1);

  // 選び直す：同じ Fork が開き直る（2本目を立てない）
  await row(page, a).getByTestId("meta-managed-switch").click();
  await expect(row(page, a).getByTestId("meta-managed-state")).toHaveText("専用 Fork を1本持つ", { timeout: 30_000 });
  expect(await managedOf(meta)).toEqual([c, a]);
  const forksAgain = await dedicatedForks(meta);
  expect(forksAgain.filter((t) => t.managedProjectId === a).map((t) => [t.id, t.status])).toEqual([[forkA, "active"]]);
  await expect(sidebarForks.filter({ hasText: A })).toHaveCount(1, { timeout: 30_000 });

  // ---- 4. release の扱い --------------------------------------------------------------------------------------------
  const release = panel.getByTestId("meta-release-section");
  await expect(release).toContainText("release（main → release の取り込み）");
  await expect(release.getByTestId("meta-release-state")).toHaveText("任せる");
  await expect(release.getByTestId("meta-release-description")).toHaveText("このメタ Project に任せます（既定）。");
  await expect(release.getByTestId("meta-release-switch")).toHaveAttribute("aria-checked", "true");
  expect(await releaseOf(meta)).toBe("delegate");

  await release.getByTestId("meta-release-switch").click();
  await expect(release.getByTestId("meta-release-state")).toHaveText("人に残す", { timeout: 30_000 });
  await expect(release.getByTestId("meta-release-description")).toHaveText(
    "人に残します——release への取り込みは、このメタ Project の AI が自分では決めません。",
  );
  await expect(release.getByTestId("meta-release-switch")).toHaveAttribute("aria-checked", "false");
  expect(await releaseOf(meta)).toBe("human");

  // 読み込み直しても host のまま（管理対象も）
  await page.reload();
  await expect(panel.getByTestId("meta-release-state")).toHaveText("人に残す", { timeout: 30_000 });
  await expect(row(page, a).getByTestId("meta-managed-state")).toHaveText("専用 Fork を1本持つ");
  await expect(row(page, b).getByTestId("meta-managed-state")).toHaveText("管理していない");
  await expect(row(page, c).getByTestId("meta-managed-state")).toHaveText("専用 Fork を1本持つ");

  await panel.getByTestId("meta-release-switch").click();
  await expect(panel.getByTestId("meta-release-state")).toHaveText("任せる", { timeout: 30_000 });
  expect(await releaseOf(meta)).toBe("delegate");

  // ---- 5. host が断ったら理由を出し、表示は host の値のまま -------------------------------------------------------
  await page.route(`**/api/projects/${meta}/managed-projects`, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "試しに断った" }) }),
  );
  await row(page, b).getByTestId("meta-managed-switch").click();
  await expect(page.getByText(/管理対象の Project を保存できませんでした: .*試しに断った/)).toBeVisible({ timeout: 30_000 });
  await expect(row(page, b).getByTestId("meta-managed-state")).toHaveText("管理していない");
  await expect(row(page, b).getByTestId("meta-managed-switch")).toHaveAttribute("aria-checked", "false");
  await page.unroute(`**/api/projects/${meta}/managed-projects`);
  expect(await managedOf(meta)).toEqual([c, a]);

  expect(pageErrors).toEqual([]);

  // 後の spec の画面に残さない
  for (const id of [meta, otherMeta, a, b, c]) await api("POST", `/api/projects/${id}/close`);
  await api("DELETE", `/api/project-groups/${group.body.id}`);
});
