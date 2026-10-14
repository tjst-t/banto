// **広い根は止めない。選ぶ前に見せる**（決定・2026-09-11、ユーザー）。
//
// 以前は「Project の根に home を指定すると、閉じ込める Module は起動しない」と
// していた（`landlock-guard-wiring`、2026-09-10）。**やめた**——home を根にして
// AI にいろいろやらせたい、という使い方を banto が禁じる理由が無い。
//
// 代わりに **2箇所で警告する**（Project を作るとき／その Project の Module を
// 選ぶとき）。閉じ込めが効かないこと、そこに何が入っているか（banto の合言葉・
// 記録・Claude の資格情報）を、選ぶ前に見せる。
//
// **いまの閉じ込めは Project のコンテナ**（変更・2026-09-25、Landlock をやめた）。
// 根を home にすると、home がまるごとコンテナに見える——警告が言うのはそのこと。
import { test, expect } from "../test-base.js";
import { homedir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const PROJECT_NAME = "E2E Wide Root Project";
/** banto のコードの置き場（monorepo の根、e2e の1つ上）を中に含むフォルダ */
const OUTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("home を根にしても Module は動く。ただし画面が警告する", async ({ page }) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  const project = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: PROJECT_NAME, root: homedir() },
    })
  ).json();
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

  // ---- 1. 閉じ込める Module も、ちゃんと立つ ------------------------------
  const prepared = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers })
  ).json();
  expect(prepared.connected, "home を根にしたら shell が立たない").toContain("shell");
  expect(prepared.connected, "home を根にしたら filesystem が立たない").toContain("filesystem");
  expect(prepared.connected).toContain("vault-local");

  // **「繋げませんでした」は出ない**——止めていないのだから
  const inbox = await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json();
  const failures = inbox.filter(
    (i: { kind: string; projectId?: string; title?: string }) =>
      i.projectId === project.id && (i.title ?? "").includes("繋げませんでした"),
  );
  expect(failures.length, "止めていないのに、繋げなかったお知らせが出ている").toBe(0);

  // ---- 2. その Project の Module 設定で警告が出る --------------------------
  await openApp(page);
  await page.goto(`/settings?project=${project.id}&section=project-modules`);
  const warning = page.getByTestId("wide-root-warning");
  await expect(warning, "広い根なのに、Module の設定で何も言わない").toBeVisible({
    timeout: 30_000,
  });
  // **何が入るのかまで言う**（規則14——「警告が出た」で終わらせない）。
  // 何が挙がるかは host の置き場による（この試験の host は dataDir が /tmp なので
  // banto の設定は入らない）——**具体名が1つ以上出ていること**を見る
  await expect(warning).toContainText("サンドボックスがほぼ機能しません");
  await expect(warning).toContainText(/認証情報|アクセストークン|データ/);

  // ---- 3. 新しい Project を作るときにも、選ぶ前に出る ----------------------
  await page.goto("/");
  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Root パス").fill(homedir());
  await expect(
    page.getByTestId("wide-root-warning"),
    "広い根を打っているのに、作る前に何も言わない",
  ).toBeVisible({ timeout: 15_000 });

  // 狭い根に打ち直したら消える（いつでも出ているわけではない）
  await page.getByLabel("Root パス").fill("/tmp/banto-e2e-narrow-root");
  await expect(page.getByTestId("wide-root-warning")).toHaveCount(0, { timeout: 15_000 });
});

// **根を変えたら、コンテナを起こし直してから使う**（バグ #292、2026-10-14 に HOME Project で起きた）。
//
// 根が home だと、banto のコードの置き場（~/.local/share/banto-release）のマウントは根のマウントの中に重なる。
// 以前は動いているコンテナで根の device を外して付け直していた——親を外すと中のマウントも一緒に外れ、Incus の設定には
// device が残るので付け直されず、コンテナの中の Module が全部「Connection closed」で起きられなかった。
// 試験では home の代わりに **banto のコードの置き場を中に含む根**（このリポジトリの1つ上）を使う——同じ重なり方になる
// （E2E を Shell から流すと HOME が Shell の置き場になり、home はコードを含まない）
test("home を根にした Project の根をその下へ変えても、Shell と FileSystem がすぐ使える", async ({ page }) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const project = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Wide Root Change", root: OUTER_ROOT },
    })
  ).json();
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

  const before = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers })
  ).json();
  expect(before.connected, "home を根にしたら shell が立たない").toContain("shell");

  // 古い根の下の新しい根（試験のあと消す）
  const narrow = mkdtempSync(join(OUTER_ROOT, ".banto-e2e-root-change-"));
  try {
    writeFileSync(join(narrow, "marker.txt"), "root-changed\n");
    const patched = await page.request.patch(`${CORE_BASE_URL}/api/projects/${project.id}`, {
      headers,
      data: { root: narrow },
    });
    expect(patched.status()).toBe(200);

    const after = await (
      await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers })
    ).json();
    expect(after.connected, `根を変えたら shell が立たない：${JSON.stringify(after)}`).toContain("shell");
    expect(after.connected, `根を変えたら filesystem が立たない：${JSON.stringify(after)}`).toContain("filesystem");

    const call = async (server: string, tool: string, args: Record<string, unknown>) => {
      const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/ui-tool-call`, {
        headers,
        data: { server, tool, arguments: args },
      });
      expect(res.status(), `${server}.${tool} が失敗した：${await res.text()}`).toBe(200);
      return JSON.stringify(await res.json());
    };
    // 新しい根で動いている（中から新しい根が見え、そこで打てる）
    expect(await call("filesystem", "listDirectory", { path: narrow })).toContain("marker.txt");
    expect(await call("shell", "runCommand", { command: "pwd; cat marker.txt" })).toContain("root-changed");
  } finally {
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/close`, { headers }).catch(() => undefined);
    rmSync(narrow, { recursive: true, force: true });
  }
});
