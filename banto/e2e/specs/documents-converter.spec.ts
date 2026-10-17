// **変換役 `documents`（LibreOffice）**（Backlog #304、2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」）。
//
// FileSystem（Project のコンテナ）→ host の中継 → 変換役（同梱の道具用のコンテナ、中の root が1件ごとに bubblewrap で囲み、
// nobody で LibreOffice）の道を、本物の banto で通す。見るもの（規則14——返ってきた中身まで）：
//   1. 初めて使うときに自動で入れる。入れている間は「変換役を入れています」が返り、入れ終わると変換できる
//   2. docx・pptx・xlsx を PDF にできる（PDF の頭・ページの数）。xlsx は式の値が入った写しを作れる（`<v>` の値）
//   3. 文書の中の http:// と file:/// の画像を取りに行かない（待ち受けに1件も来ない・PDF に画像が無い。file:/// は
//      変換役の Module の置き場——コンテナの中には在るが、囲いの中からは見えないはずの場所——を指す）
//   4. 同じ中身は変換し直さない（2回目は cached）
//   5. 7MB を超えると理由が出る
//   6. 設定の Module の一覧で、変換役は使う前は「On demand」（起動のときに起こさない）、使った後は道具用のコンテナで「Running」
import { test, expect } from "../test-base.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { createProject, openApp, waitForProjectModule } from "../helpers.js";
import { makeFormulaXlsx, makeSlidesPptx, makeTrapDocx, redPng } from "../office-fixture.js";

// 初回は道具用のコンテナを作り、LibreOffice 一式（約600MB）を入れる——数分
test.setTimeout(900_000);

const PROJECT = "E2E 変換役";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

/** PDF のページの数（LibreOffice はページの辞書を圧縮しない） */
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
const imageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;

test("変換役：初めて使うときに入れ、docx・pptx・xlsx を PDF に、xlsx を計算し直し、外の画像は取りに行かず、同じ中身は変換し直さない", async ({ page }) => {
  // ---- 罠の待ち受け：文書の中の http:// の画像がここを指す。囲いの外の LibreOffice なら取りに来る ----
  const hits: string[] = [];
  const trap = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "image/png" }).end(redPng());
  });
  await new Promise<void>((r) => trap.listen(0, "0.0.0.0", r));
  const port = (trap.address() as AddressInfo).port;
  // 道具用のコンテナから届く host の住所（ブリッジの host 側を含む、外向きの IPv4 全部）
  const hostAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
  // file:/// の画像は変換役の Module の置き場を指す——コンテナの中には在るが、囲いの中には見せない
  const moduleDir = join(DATA_DIR, "modules", "documents");
  mkdirSync(moduleDir, { recursive: true, mode: 0o700 });
  const secret = join(moduleDir, "secret.png");
  writeFileSync(secret, redPng());

  const root = mkdtempSync(join(tmpdir(), "banto-e2e-documents-"));
  try {
    writeFileSync(
      join(root, "trap.docx"),
      makeTrapDocx("外の画像を指す文書", [...hostAddresses.map((a) => `http://${a}:${port}/trap.png`), `file://${secret}`]),
    );
    writeFileSync(join(root, "slides.pptx"), makeSlidesPptx(["一枚目のスライド", "二枚目のスライド"]));
    writeFileSync(join(root, "calc.xlsx"), makeFormulaXlsx());
    writeFileSync(join(root, "big.docx"), Buffer.alloc(7 * 1024 * 1024 + 1));

    await openApp(page);
    // ---- 6（前半）. 使う前の変換役は起きていない——画面には「On demand」 ----
    const settingsRow = async () => {
      await page.goto("/settings");
      await page.getByRole("button", { name: "Module", exact: true }).click();
      const tr = page.locator('[data-module="documents"]');
      await expect(tr, "設定の Module の一覧に変換役が無い").toBeVisible({ timeout: 60_000 });
      await expect(tr.locator("td").nth(1)).toHaveText("documents");
      await expect(tr.locator("td").nth(2)).toHaveText("Global");
      await expect(tr.locator("td").nth(3)).toHaveText("道具用のコンテナ");
      return page.getByTestId("module-state-documents");
    };
    await expect(await settingsRow()).toHaveText("On demand");
    const before = (await (await page.request.get(`${CORE_BASE_URL}/api/modules`, { headers })).json()) as Array<{ name: string; connected?: boolean }>;
    expect(before.find((m) => m.name === "documents")?.connected, "使う前から変換役が起きている").toBe(false);

    await openApp(page);
    await createProject(page, PROJECT, root);
    await waitForProjectModule(page, PROJECT, "filesystem");
    const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
    const projectId = projects.find((p) => p.name === PROJECT)!.id;

    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, {
        headers,
        data: { server: "filesystem", tool, arguments: args },
        timeout: 180_000,
      });
      return { status: res.status(), text: await res.text() };
    };
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const r = await call(tool, args);
      expect(r.status, `${tool} が失敗した：${r.text}`).toBe(200);
      const body = JSON.parse(r.text) as { content?: Array<{ text: string }>; isError?: boolean };
      expect(body.isError, `${tool} が失敗した：${r.text}`).toBeFalsy();
      return JSON.parse(body.content![0]!.text) as Record<string, unknown>;
    };
    const readConverted = async (path: string, to?: string) => {
      const r = await ok("readFileRange", { path, offset: 0, length: 4 * 1024 * 1024, converted: true, ...(to ? { to } : {}) });
      return Buffer.from(r.data as string, "base64");
    };

    // ---- 1. 初めて使う：入れている間は「入れています」、終われば変換できる ----
    const preparing = new Set<string>();
    let first: Record<string, unknown> = {};
    await expect
      .poll(
        async () => {
          first = await ok("convertDocument", { path: "trap.docx" });
          if (first.status === "preparing") preparing.add(String(first.message));
          return first.status;
        },
        { timeout: 840_000, intervals: [5_000] },
      )
      .toBe("converted");
    for (const m of preparing) expect(m).toMatch(/^変換役を(入れています（初回だけ、数分）|起こしています)。あとでもう一度読み直してください$/);
    expect(first).toMatchObject({ path: "trap.docx", target: "pdf", mimeType: "application/pdf", cached: false });

    // ---- 3. 外の画像を取りに行かない ----
    const trapPdf = await readConverted("trap.docx");
    expect(trapPdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(first.bytes).toBe(trapPdf.length);
    expect(pageCount(trapPdf)).toBe(1);
    expect(imageCount(trapPdf), "file:/// の画像が PDF に埋め込まれた（囲いの中から変換役の置き場が見えている）").toBe(0);
    expect(hits, "文書の中の http:// の画像を取りに来た（囲いの中からネットワークに出られる）").toEqual([]);

    // ---- 4. 同じ中身は変換し直さない ----
    const again = await ok("convertDocument", { path: "trap.docx" });
    expect(again).toMatchObject({ status: "converted", cached: true, bytes: trapPdf.length });
    expect(again.ms, "置き場から引いたのに変換した時間が付いている").toBeUndefined();

    // ---- 2. pptx・xlsx を PDF に、xlsx を計算し直す ----
    const slides = await ok("convertDocument", { path: "slides.pptx" });
    expect(slides).toMatchObject({ status: "converted", target: "pdf", cached: false });
    const slidesPdf = await readConverted("slides.pptx");
    expect(slidesPdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(slidesPdf), "スライドの枚数とページの数が違う").toBe(2);
    // 日本語は日本語の字形で（2026-10-17、ユーザー報告「中華フォントになる」——C.UTF-8 のときは Noto CJK の SC だった）
    const cjkFonts = [...new Set(slidesPdf.toString("latin1").match(/NotoS(?:ans|erif)CJK[a-z]+/g) ?? [])];
    expect(cjkFonts.length, "スライドの日本語に Noto CJK が使われていない").toBeGreaterThan(0);
    expect(cjkFonts.every((f) => f.endsWith("jp")), `日本語が日本語の字形で描かれていない：${cjkFonts.join("・")}`).toBe(true);

    const sheetPdf = await ok("convertDocument", { path: "calc.xlsx", to: "pdf" });
    expect(sheetPdf).toMatchObject({ status: "converted", target: "pdf", mimeType: "application/pdf" });
    expect((await readConverted("calc.xlsx", "pdf")).subarray(0, 5).toString()).toBe("%PDF-");

    const recalculated = await ok("convertDocument", { path: "calc.xlsx" });
    expect(recalculated).toMatchObject({
      status: "converted",
      target: "spreadsheet",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      cached: false,
    });
    const sheet = strFromU8(unzipSync(new Uint8Array(await readConverted("calc.xlsx")))["xl/worksheets/sheet1.xml"]!);
    expect(sheet, "B2*C2 の値が入っていない").toMatch(/<f[^>]*>B2\*C2<\/f><v>1200<\/v>/);
    expect(sheet, "SUM(D2,7) の値が入っていない").toMatch(/<f[^>]*>SUM\(D2,7\)<\/f><v>1207<\/v>/);

    // ---- 5. 7MB を超えると理由が出る ----
    const big = await call("convertDocument", { path: "big.docx" });
    expect(big.text).toContain("大きすぎて変換できません（7MB まで）");

    // ---- 6. 変換役は道具用のコンテナで、繋がっている ----
    const modules = (await (await page.request.get(`${CORE_BASE_URL}/api/modules`, { headers })).json()) as Array<{
      name: string;
      placement: string;
      connected?: boolean;
      toolsInstall?: unknown;
    }>;
    const documents = modules.find((m) => m.name === "documents");
    expect(documents, "変換役が Module の一覧に無い").toMatchObject({ placement: "tools-container", connected: true });
    expect(documents!.toolsInstall).toBeUndefined();
    await expect(await settingsRow()).toHaveText("Running");
    // 罠には最後まで誰も来ていない
    expect(hits).toEqual([]);
  } finally {
    trap.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(secret, { force: true });
  }
});
