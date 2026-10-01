// **この画面が始めていないターンでも、Module の画面が会話に出る**（追加・2026-09-29、実機で発覚）。
//
// 届いたもの（サブエージェントの結果・Fork の最初の指示・公開の結果）で host が始めたターンや、別の画面で送った
// ターンに、この画面は「あとから乗る」（`followRunningTurn`）。そのターンの中で AI が画面つきの tool
// （Publish の承認など）を呼んでも、**会話に画面が出ず、リロードすると出た**——画面は「どの tool が画面を
// 持つか」の一覧を、自分で送るときにしか聞いていなかった（`adapter.ts` の `ensureUiTools`）。
import { test, expect } from "../test-base.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Followed Inline";

test("あとから乗ったターンで呼ばれた画面つきの tool も、リロードせずに会話に画面が出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-followed-inline-"));
  const marker = `followed-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, marker), "見えているはず\n");

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");
  // 開き直した直後の画面（まだ一度も自分で送っていない）——再起動のあとに人が開いた状態と同じ
  await page.reload();
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 60_000 });

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json()
  )[0].id;

  // **この画面の外で**ターンを始める（届いたもので host が始める・別の画面で送る、と同じ）。少し流してから tool を呼ぶ
  // ——画面が乗るのを待つ間に tool が終わってしまわないように
  const ctrl = new AbortController();
  const running = fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      prompt:
        "直下の一覧を取って。" +
        fakeTurn({
          say: "一覧を取ります。",
          streamMs: 6_000,
          tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }],
          then: "取りました。",
        }),
      permissionMode: "bypassPermissions",
    }),
    signal: ctrl.signal,
  }).then((r) => r.text());

  try {
    const embed = page.locator('[data-testid="inline-module-view"]');
    await expect(embed, "あとから乗ったターンの画面つきの tool が、会話に画面を出さない").toBeVisible({ timeout: 90_000 });
    await expect(embed).toHaveAttribute("data-module", "filesystem");
    const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    await expect(inner.getByText(marker)).toBeVisible({ timeout: 60_000 });
    await running;
  } finally {
    ctrl.abort();
  }
});
