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
// **検査そのものは残っている**——「導出が勝手に広がった」場合（PATH の親が
// 紛れ込む等）はいまも起動を止める。人が選んだ根だけが免除される
// （単体試験：`packages/landlock/src/guard.test.ts`）。
import { test, expect } from "@playwright/test";
import { homedir } from "node:os";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const PROJECT_NAME = "E2E Wide Root Project";

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
  expect(prepared.connected).toContain("vault");

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
  await expect(warning).toContainText("閉じ込めが効きません");
  await expect(warning).toContainText(/資格情報|合言葉|記録/);

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
