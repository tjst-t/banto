// **入力欄に画像を貼り付けて送る**（決定・2026-09-26、ユーザー要望）。
//
// 見るのは「貼れた」ではなく、**その画像が AI まで届いたこと**と、**画面が出しているものの中身**
// （規則14）：
// - 入力欄の小窓に、貼った画像そのもの（縦横）が出る
// - 偽 Runner が受け取った画像の形式とバイト数を発言にする——**貼ったバイト列と同じ数か**を見る
// - 送った発言に画像が付いて出る。host の記録には名前だけが残り、名前で同じバイト列が取れる
// - **リロードしても**、送った発言に同じ画像（縦横）が出る（host から取り直している）
// - 文字と画像が両方載ったクリップボード（Excel 等のコピー）は、文字として貼る
// - 画像でないものは添えず、入力欄に理由が出る
// - 文を書かずに画像だけでも送れる
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, openApp, confirmForkDialog, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Composer Image";

interface HostMessage {
  role: string;
  text: string;
  images?: Array<{ id: string; name?: string }>;
}

async function baseThreadId(page: Page): Promise<string> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json();
  return threads[0].id;
}

async function hostMessages(page: Page): Promise<HostMessage[]> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${await baseThreadId(page)}`, { headers: HEADERS })).json()).messages;
}

/**
 * 入力欄に貼り付ける。**本物の貼り付けと同じく、クリップボードの中身を持った paste イベント**を
 * 入力欄で起こす（OS のクリップボードは試験から触れない）。画像は canvas で作った PNG で、
 * 作ったバイト数を返す——AI に届いた数と比べるため
 */
async function paste(
  page: Page,
  content: { image?: { width: number; height: number }; text?: string; file?: { name: string; type: string } },
): Promise<number | undefined> {
  return page.getByPlaceholder(/に送る/).evaluate(async (el, c) => {
    const dt = new DataTransfer();
    let size: number | undefined;
    if (c.image) {
      const canvas = document.createElement("canvas");
      canvas.width = c.image.width;
      canvas.height = c.image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3366cc";
      ctx.fillRect(0, 0, c.image.width, c.image.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(4, 4, c.image.width / 2, c.image.height / 2);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      size = blob.size;
      dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    }
    if (c.file) dt.items.add(new File(["%PDF-1.4 not an image"], c.file.name, { type: c.file.type }));
    if (c.text) dt.setData("text/plain", c.text);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    const prevented = !el.dispatchEvent(event);
    // 既定の振る舞い（文字を入れる）は合成イベントでは起きない——止められていなければ、ブラウザが入れる分を入れる
    if (!prevented && c.text) {
      (el as HTMLTextAreaElement).focus();
      document.execCommand("insertText", false, c.text);
    }
    return size;
  }, content);
}

/** その img が**読み込み終わった実寸**（読めていなければ 0） */
async function naturalSize(img: ReturnType<Page["locator"]>): Promise<string> {
  return img.evaluate((el) => {
    const i = el as HTMLImageElement;
    return i.complete ? `${i.naturalWidth}x${i.naturalHeight}` : "0x0";
  });
}

test("貼り付けた画像が AI に届き、送った発言に付いて出て、リロードしても残る", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-image-")));
  const composer = page.getByPlaceholder(/に送る/);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  // 添えられる会話には ＋ が出る
  await expect(page.getByRole("button", { name: "Add Attachment" })).toBeVisible();

  // ---- 貼ると、入力欄の小窓にその画像が出る ------------------------------------
  const size = await paste(page, { image: { width: 64, height: 48 } });
  expect(size).toBeGreaterThan(0);
  const composerTile = page.locator(".aui-composer-attachments img");
  await expect(composerTile).toHaveCount(1);
  await expect.poll(() => naturalSize(composerTile)).toBe("64x48");
  await expect(page.getByTestId("composer-attachment-error")).toHaveCount(0);

  // ---- 送ると、AI に同じバイト列が画像として届く ------------------------------
  await composer.fill("この画像を見て");
  await composer.press("Enter");
  await expect(
    page.getByText(`受け取った画像: 1 枚（image/png ${size} バイト）`),
    "貼った画像が AI まで届いていない（または中身が変わった）",
  ).toBeVisible({ timeout: 60_000 });
  await expect(composerTile, "送ったのに入力欄に画像が残っている").toHaveCount(0);

  // 送った発言に画像が付いて出る
  const userImages = page.locator('[data-role="user"] .aui-attachment-tile img');
  await expect(userImages).toHaveCount(1);
  await expect.poll(() => naturalSize(userImages.first())).toBe("64x48");

  // host の記録には名前だけ——名前で同じバイト列が取れる
  await waitTurnEnded(page, await baseThreadId(page), 1);
  const [sent] = (await hostMessages(page)).filter((m) => m.role === "user");
  expect(sent!.text).toBe("この画像を見て");
  expect(sent!.images).toHaveLength(1);
  const stored = await page.request.get(`${CORE_BASE_URL}/api/images/${sent!.images![0]!.id}`, { headers: HEADERS });
  expect(stored.headers()["content-type"]).toBe("image/png");
  expect((await stored.body()).length).toBe(size);

  // ---- リロードしても、送った発言に同じ画像が出る（host から取り直す）---------
  await page.reload();
  await expect(page.getByText("この画像を見て")).toBeVisible({ timeout: 30_000 });
  const restored = page.locator('[data-role="user"] .aui-attachment-tile img');
  await expect(restored, "リロードしたら画像が消えた").toHaveCount(1);
  await expect.poll(() => naturalSize(restored.first()), { timeout: 15_000 }).toBe("64x48");
  expect(await restored.first().getAttribute("src"), "host から取り直していない").toMatch(/^blob:/);

  // ---- 文字と画像が両方あれば、文字として貼る（Excel の表などが画像に化けない）--
  await paste(page, { image: { width: 16, height: 16 }, text: "A1\tB1" });
  await expect(composer).toHaveValue("A1\tB1");
  await expect(page.locator(".aui-composer-attachments img"), "文字のあるコピーが画像になった").toHaveCount(0);
  await composer.fill("");

  // ---- 画像でないものは添えず、理由を出す -------------------------------------
  await paste(page, { file: { name: "notes.pdf", type: "application/pdf" } });
  await expect(page.getByTestId("composer-attachment-error")).toHaveText("添えられるのは画像（PNG・JPEG・GIF・WebP）だけです");
  await expect(page.locator(".aui-composer-attachments [role=button]")).toHaveCount(0);

  // ---- 画像だけでも送れる ------------------------------------------------------
  const onlySize = await paste(page, { image: { width: 32, height: 20 } });
  await expect(page.getByTestId("composer-attachment-error"), "添えられたのに前の理由が残っている").toHaveCount(0);
  await expect.poll(() => naturalSize(page.locator(".aui-composer-attachments img"))).toBe("32x20");
  await composer.press("Enter");
  await expect(page.getByText(`受け取った画像: 1 枚（image/png ${onlySize} バイト）`)).toBeVisible({ timeout: 60_000 });
  await waitTurnEnded(page, await baseThreadId(page), 2);
  const users = (await hostMessages(page)).filter((m) => m.role === "user");
  expect(users).toHaveLength(2);
  expect(users[1]!.text).toBe("");
  expect(users[1]!.images).toHaveLength(1);
  await expect(page.locator('[data-role="user"] .aui-attachment-tile img')).toHaveCount(2);

  // ---- 分けた先（Fork）にも、同じ画像が引き継がれる --------------------------------
  // **画面では確かめない**（改訂・2026-10-03）。Fork の画面は分ける前の親の会話を最後の1件（ここでは AI の返事）しか
  // 出さない（v4-frontend.md「Fork の画面では、分ける前の親の会話は最後の 1 件だけ出す」、99101d9c）ので、
  // 画像の付いた人の発言は Fork の面に出ない。引き継ぎそのものは host が親の記録を Fork に写す仕組みなので、そこを見る
  const baseUsers = (await hostMessages(page)).filter((m) => m.role === "user");
  await page.locator('[data-role="assistant"]').last().hover();
  await page.getByTestId("fork-from-message").last().click();
  await confirmForkDialog(page);
  await expect(page.getByRole("button", { name: /Base Thread に戻る$/ }), "Fork が開かない").toBeVisible({ timeout: 30_000 });
  const forkId = new URL(page.url()).searchParams.get("fork");
  expect(forkId, "Fork を開いた URL に Fork が無い").toBeTruthy();
  const forkMessages = (
    await (await page.request.get(`${CORE_BASE_URL}/api/threads/${forkId}`, { headers: HEADERS })).json()
  ).messages as HostMessage[];
  const forkUsers = forkMessages.filter((m) => m.role === "user");
  expect(
    forkUsers.map((m) => m.images?.map((i) => i.id) ?? []),
    "Fork に画像が引き継がれていない",
  ).toEqual(baseUsers.map((m) => m.images?.map((i) => i.id) ?? []));
  for (const m of forkUsers) {
    for (const image of m.images ?? []) {
      const got = await page.request.get(`${CORE_BASE_URL}/api/images/${image.id}`, { headers: HEADERS });
      expect(got.status(), "Fork の記録の画像が取れない").toBe(200);
    }
  }
});
