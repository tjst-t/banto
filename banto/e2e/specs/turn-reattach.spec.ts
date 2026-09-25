// **開き直しても、走っているものは見える**（`turn-stream-reattach`、2026-09-10）。
//
// 実測（2026-09-10、直す前）：走行中にリロードすると、**出力どころか「走っている」
// ことすら画面から消える**——ターンのイベント列は `POST …/messages` の応答の中に
// しか無く、接続が切れたら戻る先が無かった。人からは「送ったのに何も起きていない」。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Turn Reattach Project";

/** host がそのターンを走らせているか——`GET …/stream` は走っていなければ `idle`、走っていれば `attached` を最初に返す */
async function turnIsRunning(threadId: string): Promise<boolean> {
  const ctrl = new AbortController();
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${threadId}/stream`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    signal: ctrl.signal,
  });
  try {
    const { value } = await res.body!.getReader().read();
    return new TextDecoder().decode(value).includes('"type":"attached"');
  } finally {
    ctrl.abort();
  }
}

test("走行中にリロードしても、そのターンに繋ぎ直して続きが見える", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-reattach-"));
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()
  )[0].id;

  // 少し長めのターンを始める（リロードする隙を作る）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "1 から 60 までの数字を並べて出して。" +
      // **走行中にリロードする試験**なので、ターンが続いている必要がある
      // ——本物のモデルが1トークンずつ返す時間の幅を模す
      fakeTurn({ say: Array.from({ length: 60 }, (_, i) => String(i + 1)).join("\n"), streamMs: 30_000 }),
  );
  await composer.press("Enter");

  // **host がそのターンを走らせ始めるまで待つ**（改訂・2026-09-25、規則6）。以前は Enter から 2.5 秒と
  // 決め打ちしていたが、送る前に画面は Module の用意（画面つき tool の一覧）を待つ——Project のコンテナが
  // 初めて起きる回はこれが 2.8 秒を越え、**送る前に開き直していた**（ターンが始まらず、帯も出ない）。
  // 見たいのは「走行中に開き直す」なので、走っていることを host に聞いてから開き直す
  await expect
    .poll(() => turnIsRunning(threadId), { timeout: 30_000, message: "送ったターンが host で始まらない" })
    .toBe(true);

  // **走行中に開き直す**
  await page.reload();

  // 繋ぎ直した帯が出て、走っていることが分かる
  const band = page.locator('[data-testid="reattached-turn"]');
  await expect(band, "開き直したら、走っていることが画面から消えた").toBeVisible({ timeout: 30_000 });
  await expect(band.getByText(/このターンは走っています/)).toBeVisible();

  // **中身も戻る**——そのターンがここまでに出したものが見える（規則14）。
  //
  // **どれだけ出ているかは数えない**（改訂・2026-09-11、規則6）。以前は
  // 「60 文字以上」で見ていたが、**どれだけ出るかは AI 次第**——前置きだけ先に
  // 出して本文を最後にまとめて出す走りだと、待ちが尽きるまで増えない
  // （実測：45 文字で止まって落ちた）。見るのは「この帯がそのターンの出力を
  // 運んでいるか」であって、量ではない。終わったあとの中身は下で見る。
  const LABEL = "このターンは走っています";
  await expect
    .poll(
      async () => {
        if ((await band.count()) === 0) return "ended"; // 先に終わった（下で中身を見る）
        return (await band.innerText()).replace(LABEL, "").trim().length > 0 ? "shown" : "empty";
      },
      { timeout: 60_000, message: "そのターンの出力が帯に戻るまで" },
    )
    .not.toBe("empty");

  // ターンが終わったら帯は消え、会話の記録に置き換わる
  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })
        ).json();
        return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
      },
      { timeout: 120_000, message: "ターンが終わるまで" },
    )
    .toBe(1);
  await expect(band, "終わったのに帯が残っている").toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("60").first(), "記録から会話が戻っていない").toBeVisible({ timeout: 30_000 });
});
