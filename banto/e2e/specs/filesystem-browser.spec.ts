// **FileSystem のファイルブラウザ**（モック `mock/` の FileExplorerView の本実装、2026-09-23）。
//
// 人が入口から開いて、AI を介さずに**見る・編集する・置く・持ち出す**。
// 規則14——「開けた」で終わらせず、画面が出している中身（ツリーの並び・プレビューの
// 見出しと表のセル・画像の大きさ・保存後のディスクの中身・ダウンロードされた中身）を
// 一つずつ見る。
//
// もう1本は AI の editFile——**結果が差分として会話に出て**、記録から組み直しても同じ差分が出る。
import { test, expect, type Frame, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { unzipSync } from "fflate";
import { SANDBOX_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

/** 本物の PNG（幅×高さ）。画面が画像として読めたかを naturalWidth で確かめるため。 */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(59, 91, 219);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Canvas の中の Module の HTML（内側の iframe）。サンドボックスの口の子。 */
async function moduleFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      () => {
        found = page.frames().find((f) => f.parentFrame()?.url().startsWith(SANDBOX_BASE_URL));
        return found !== undefined;
      },
      { timeout: 60_000, message: "Module の画面（内側の iframe）が出てこない" },
    )
    .toBe(true);
  return found!;
}

test("入口から開いたファイルブラウザで、見る・編集する・置く・持ち出す", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fsbrowser-"));
  mkdirSync(join(projectRoot, "docs"));
  mkdirSync(join(projectRoot, "public"));
  writeFileSync(
    join(projectRoot, "docs/README.md"),
    "# ファイルブラウザ\n\n本文です。\n\n| 項目 | 状態 |\n|---|---|\n| FileSystem | 進行中 |\n",
  );
  writeFileSync(join(projectRoot, "docs/budget.csv"), '項目,予算\nVault,120000\n"Shell, 共通",50000\n');
  writeFileSync(join(projectRoot, "docs/spec.pdf"), Buffer.from("%PDF-1.4\n%âã\n%%EOF\n", "latin1"));
  writeFileSync(join(projectRoot, "public/logo.png"), png(48, 32));
  writeFileSync(join(projectRoot, "notes.txt"), "持ち出すメモ\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // **「人が押した直後か」をこの試験の中から決められるようにする**（下の「確かめる」の段）。
  // ブラウザの一時的な操作の印（transient activation、約5秒）は、Playwright の操作や検査が
  // 立て直す——実測（2026-09-23）：前の spec の後だと、何も操作していない17秒の間ずっと
  // 立ったままだった（単独なら5秒で切れる）。**時間を置いて切れるのを待つ試験は安定しない**
  // ので、印を読む口だけを差し替えて「切れている」を作る。本物の人のクリックが入れ子の
  // iframe から banto の画面に印を立てることは、別に測って確かめた（ノート参照）
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const real = Object.getOwnPropertyDescriptor(UserActivation.prototype, "isActive")!;
    Object.defineProperty(UserActivation.prototype, "isActive", {
      get(this: UserActivation) {
        return (window as unknown as { __noActivation?: boolean }).__noActivation ? false : real.get!.call(this);
      },
    });
  });

  await openApp(page);
  await createProject(page, "E2E FS Browser", projectRoot);
  await waitForProjectModule(page, "E2E FS Browser", "filesystem");

  // ---- 入口から開く（AI には頼まない）-----------------------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /ファイル/ });
  await expect(entry).toContainText("この Project のファイルを見る・開く・編集する", { timeout: 30_000 });
  await entry.click();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });

  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const row = (path: string) => inner.locator(`.row[data-path="${path}"]`);
  const toast = (text: RegExp) => inner.getByTestId("toast").filter({ hasText: text });

  // 見出しに根、ツリーに実在の並び（フォルダが先）
  await expect(inner.getByTestId("root-path")).toContainText(basename(projectRoot), { timeout: 60_000 });
  await expect(inner.locator(".tree-body > .row")).toHaveText(["docs", "public", "notes.txt"]);

  // ---- Markdown：描かれた見出しと表、ソースへの切り替え -------------------
  await row("docs").click();
  await expect(row("docs/README.md")).toBeVisible();
  await row("docs/README.md").click();
  await expect(inner.getByTestId("open-path")).toHaveText("docs/README.md");
  const md = inner.getByTestId("viewer-markdown");
  await expect(md.locator("h1")).toHaveText("ファイルブラウザ");
  await expect(md.locator("td").first()).toHaveText("FileSystem");
  await inner.getByRole("tab", { name: "ソース" }).click();
  await expect(inner.getByTestId("viewer-source")).toContainText("# ファイルブラウザ");

  // ---- CSV：表で見て、表のまま直して保存 → ディスクに入っている -----------
  await row("docs/budget.csv").click();
  await expect(inner.getByTestId("viewer-sheet").locator("td").first()).toHaveText("Vault");
  await expect(inner.getByTestId("viewer-sheet").getByText("Shell, 共通")).toBeVisible();
  await inner.getByTestId("viewer-edit").click();
  await inner.getByLabel("2行2列").fill("130000");
  await inner.getByTestId("viewer-save").click();
  await expect(toast(/budget\.csv を保存しました/)).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(projectRoot, "docs/budget.csv"), "utf8")).toBe(
    '項目,予算\nVault,130000\n"Shell, 共通",50000\n',
  );
  await expect(inner.getByTestId("viewer-sheet").locator("td").nth(1)).toHaveText("130000");

  // ---- 画像は画像として、PDF は名前と大きさ --------------------------------
  await row("public").click();
  await row("public/logo.png").click();
  const img = inner.getByTestId("viewer-image").locator("img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => `${el.naturalWidth}x${el.naturalHeight}`)).toBe("48x32");
  await expect(inner.getByTestId("viewer-image")).toContainText("48×32・PNG");
  await row("docs/spec.pdf").click();
  await expect(inner.getByTestId("viewer-placeholder")).toContainText("PDF・");

  // ---- 新しいファイル → ディスクにできて、そのまま開いている --------------
  // 置き先は、いま開いているファイル（spec.pdf）のフォルダ＝ docs
  await inner.getByRole("button", { name: "新しいファイル" }).click();
  await inner.getByTestId("draft-input").fill("new-note.md");
  await inner.getByTestId("draft-input").press("Enter");
  await expect(row("docs/new-note.md")).toBeVisible({ timeout: 30_000 });
  await expect(inner.getByTestId("open-path")).toHaveText("docs/new-note.md");
  expect(readFileSync(join(projectRoot, "docs/new-note.md"), "utf8")).toBe("");

  // ---- アップロード：バイト列がそのまま置かれ、ツリーに出る ----------------
  const uploaded = png(8, 8);
  await inner.getByTestId("upload-open").click();
  await expect(inner.getByText("アップロード先：docs")).toBeVisible();
  await inner.locator('input[type="file"]').setInputFiles({ name: "up.png", mimeType: "image/png", buffer: uploaded });
  await expect(inner.getByTestId("upload-list")).toContainText("up.png");
  await inner.getByTestId("upload-confirm").click();
  await expect(toast(/1 件のファイルをアップロードしました/)).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(projectRoot, "docs/up.png")).equals(uploaded)).toBe(true);
  await expect(row("docs/up.png")).toBeVisible();

  // ---- ダウンロード（1件）：人が押した直後なので、確かめずに保存される ----
  await row("notes.txt").click();
  const [single] = await Promise.all([page.waitForEvent("download"), inner.getByTestId("download").click()]);
  expect(single.suggestedFilename()).toBe("notes.txt");
  expect(readFileSync(await single.path(), "utf8")).toBe("持ち出すメモ\n");
  await expect(page.getByTestId("canvas-download-confirm")).toHaveCount(0);

  // ---- まとめて ZIP：中身と名前 ------------------------------------------
  await row("docs/README.md").click();
  await row("docs/budget.csv").click({ modifiers: ["Control"] });
  await expect(inner.getByTestId("multi-summary")).toContainText("2 件を選択中");
  const [zip] = await Promise.all([page.waitForEvent("download"), inner.getByTestId("download").click()]);
  expect(zip.suggestedFilename()).toBe(`${basename(projectRoot)}-files.zip`);
  const files = unzipSync(new Uint8Array(readFileSync(await zip.path())));
  expect(Object.keys(files).sort()).toEqual(["docs/README.md", "docs/budget.csv"]);
  expect(Buffer.from(files["docs/budget.csv"]!).toString()).toContain("Vault,130000");

  // ---- 人の操作の直後でない保存の頼みは、banto の画面で確かめる ------------
  // 仕様（ui/download-file）は「host は保存の前に確かめるべき」と言う。印が切れている
  // 状態（冒頭の差し替え）で、画面に頼ませる
  const frame = await moduleFrame(page);
  await page.evaluate(() => ((window as unknown as { __noActivation?: boolean }).__noActivation = true));
  let unaskedSaved = false;
  page.once("download", () => (unaskedSaved = true));
  const askDownload = (id: number, name: string) =>
    frame.evaluate(
      ([id, name]) =>
        window.parent.postMessage(
          {
            jsonrpc: "2.0",
            id,
            method: "ui/download-file",
            params: { contents: [{ type: "resource", resource: { uri: `file:///${name}`, mimeType: "text/plain", text: "x" } }] },
          },
          "*",
        ),
      [id, name] as const,
    );
  await askDownload(90001, "unasked.txt");
  const confirm = page.getByTestId("canvas-download-confirm");
  await expect(confirm, "操作の直後でないのに、確かめる画面が出ない").toBeVisible({ timeout: 20_000 });
  await expect(confirm).toContainText("unasked.txt");
  expect(unaskedSaved, "確かめる前に保存した").toBe(false);
  const [asked] = await Promise.all([page.waitForEvent("download"), confirm.getByRole("button", { name: "ダウンロードする" }).click()]);
  expect(asked.suggestedFilename()).toBe("unasked.txt");
  // 「やめる」なら保存しない
  await askDownload(90002, "declined.txt");
  await expect(confirm).toContainText("declined.txt");
  let declinedSaved = false;
  page.once("download", () => (declinedSaved = true));
  await confirm.getByRole("button", { name: "やめる" }).click();
  await expect(confirm).toBeHidden();
  expect(declinedSaved, "やめたのに保存した").toBe(false);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("AI の editFile は、差分として会話に出る（記録から組み直しても同じ差分）", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fsdiff-"));
  writeFileSync(join(projectRoot, "notes.txt"), "one\ntwo\nfoo bar\nthree\n");

  await openApp(page);
  await createProject(page, "E2E FS Diff", projectRoot);
  await waitForProjectModule(page, "E2E FS Diff", "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "notes.txt の foo bar を foo baz に直して。" +
      fakeTurn({
        tools: [
          {
            server: "filesystem",
            name: "editFile",
            args: { path: "notes.txt", edits: [{ oldText: "foo bar", newText: "foo baz" }] },
          },
        ],
      }),
  );
  await composer.press("Enter");

  const expectDiff = async () => {
    const embed = page.locator('[data-testid="inline-module-view"][data-module="filesystem"]');
    await expect(embed).toBeVisible({ timeout: 120_000 });
    const diff = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    await expect(diff.getByTestId("diff-path")).toHaveText("notes.txt", { timeout: 60_000 });
    await expect(diff.getByTestId("diff-stat")).toHaveText("+1 -1");
    await expect(diff.locator('.diff-row[data-kind="remove"]')).toHaveText(["3-foo bar"]);
    await expect(diff.locator('.diff-row[data-kind="add"]')).toHaveText(["3+foo baz"]);
    await expect(diff.locator('.diff-row[data-kind="context"]')).toHaveCount(3);
  };
  await expectDiff();
  expect(readFileSync(join(projectRoot, "notes.txt"), "utf8")).toBe("one\ntwo\nfoo baz\nthree\n");

  // 記録から組み直す——ファイルを読み直さず、その時点の差分が出る
  writeFileSync(join(projectRoot, "notes.txt"), "全部書き換えた\n");
  await page.reload();
  await expectDiff();
});
