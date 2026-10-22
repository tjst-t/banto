// **Vault の書き出しと取り込み**（決定・2026-10-22、仕様 v4-modules.md §2.1「書き出しと取り込み」）。
//
// 本物の banto を通して、人が管理画面から：
//   1. vault-local の秘密を合言葉で暗号化したファイルに書き出す（端末に保存される。ファイルに値が平文で出ない）
//   2. 別の Vault（同じ vault-local をもう1本、別の置き場で立てる）に、そのファイルを取り込む
//      ——合言葉違いは断られ、何も入らない
//   3. 取り込んだ先で値が使える（Vault に直接聞く）
// 画面の欄に合言葉が残らないことも見る。
import { test, expect } from "../test-base.js";
import type { FrameLocator, Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openPaletteEntry } from "../helpers.js";
import { openBundle } from "../../packages/vault-kit/dist/bundle-crypto.js";

test.setTimeout(300_000);

const SECOND_VAULT = "vault-local-bundle";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function uiCall(page: Page, server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, { headers, data: { server, tool, arguments: args } });
  const body = await res.text();
  try {
    const outer = JSON.parse(body) as { content?: { text: string }[]; isError?: boolean };
    return { text: outer.content?.[0]?.text ?? body, ok: res.ok() && outer.isError !== true };
  } catch {
    return { text: body, ok: false };
  }
}

async function inputsWithValue(canvas: FrameLocator): Promise<string[]> {
  return canvas.locator("input:not([type=file]), textarea").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter(Boolean));
}

test("管理画面から秘密を書き出し、別の Vault に取り込むと、値が使える", async ({ page }) => {
  const stamp = Date.now();
  const alias = `e2e-bundle-${stamp}`;
  const group = `e2e-bundle-g-${stamp}`;
  const secret = `BUNDLE-SECRET-${stamp}`;
  const pass = `e2e passphrase ${stamp}`;

  // 取り込む先：同じ vault-local をもう1本、別の置き場で（vault-directory.spec.ts と同じ立て方）
  await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: {
      name: SECOND_VAULT,
      launch: {
        command: "${nodeExec}",
        args: ["${monorepoRoot}/packages/modules/vault-local/dist/server.js"],
        env: { BANTO_VAULT_DATA_DIR: `\${dataDir}/vault-bundle-${stamp}` },
      },
      meta: { satisfies: ["vault"], dependsOn: [], isolation: "subprocess", scope: "instance", handlesSecrets: true },
    },
  });
  try {
    await openApp(page);
    await createProject(page, "E2E Vault の書き出し", mkdtempSync(join(tmpdir(), "banto-e2e-vault-bundle-")));
    // 書き出す秘密（vault-local の、どこにも紐付いていないグループ）
    const created = await uiCall(page, "vault-directory", "createAlias", {
      implementation: "vault-local",
      name: alias,
      kind: "secret",
      value: secret,
      group,
      note: "書き出しの試験",
    });
    expect(created.ok, created.text).toBe(true);

    await openPaletteEntry(page, /Vault を管理/);
    await expect(page.getByText(/^Canvas — vault-directory$/)).toBeVisible({ timeout: 60_000 });
    const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    await expect(canvas.getByText("接続している実装")).toBeVisible({ timeout: 60_000 });

    // ---- 1. 書き出す ------------------------------------------------------------------------------------------
    await canvas.getByRole("button", { name: "書き出す…" }).click();
    await expect(canvas.locator("#dlg-export")).toBeVisible();
    await canvas.locator("#export-vault").selectOption("vault-local");
    // 確認が合わなければ断る（窓口を呼ばない）
    await canvas.locator("#export-pass").fill(pass);
    await canvas.locator("#export-pass2").fill(pass + "x");
    await canvas.locator("#export-submit").click();
    await expect(canvas.locator("#export-error")).toHaveText("確認の合言葉が一致しません");
    await canvas.locator("#export-pass2").fill(pass);
    const downloaded = page.waitForEvent("download", { timeout: 120_000 });
    await canvas.locator("#export-submit").click();
    // 準備に時間がかかって「操作の直後」でなくなったら、banto が保存してよいか確かめる
    const confirm = page.getByTestId("canvas-download-confirm");
    const which = await Promise.race([downloaded.then(() => "saved" as const), confirm.waitFor({ timeout: 120_000 }).then(() => "ask" as const)]);
    if (which === "ask") await confirm.getByRole("button", { name: "ダウンロードする" }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(/^banto-vault-vault-local-\d{4}-\d{2}-\d{2}\.banto-vault\.json$/);
    const file = join(mkdtempSync(join(tmpdir(), "banto-e2e-vault-bundle-file-")), download.suggestedFilename());
    await download.saveAs(file);
    const text = readFileSync(file, "utf8");
    expect(text, "書き出したファイルに値が平文で出た").not.toContain(secret);
    expect(text).not.toContain(alias);
    expect(JSON.parse(text)).toMatchObject({ format: "banto-vault-export", version: 1, kdf: { name: "scrypt" }, cipher: { name: "aes-256-gcm" } });
    await expect(canvas.locator("#dlg-bundle-result")).toBeVisible({ timeout: 30_000 });
    await expect(canvas.locator("#bundle-result-title")).toHaveText("書き出しました");
    await expect(canvas.locator("#bundle-result-summary")).toContainText("件の秘密を書き出しました");
    await canvas.locator("#dlg-bundle-result").getByRole("button", { name: "閉じる" }).click();
    expect(await inputsWithValue(canvas), "合言葉が画面の欄に残っている").not.toContain(pass);

    // ---- 2. 取り込む（合言葉違い → 正しい合言葉）-----------------------------------------------------------------
    await canvas.getByRole("button", { name: "取り込む…" }).click();
    await expect(canvas.locator("#dlg-import")).toBeVisible();
    await canvas.locator("#import-vault").selectOption(SECOND_VAULT);
    await canvas.locator("#import-file").setInputFiles(file);
    await canvas.locator("#import-pass").fill("wrong passphrase!!");
    await canvas.locator("#import-submit").click();
    await expect(canvas.locator("#import-error")).toContainText("開けません", { timeout: 60_000 });
    const none = await uiCall(page, SECOND_VAULT, "listAliases", {});
    expect((JSON.parse(none.text) as Array<{ name: string }>).map((a) => a.name), "合言葉違いなのに取り込んだ").not.toContain(alias);

    await canvas.locator("#import-pass").fill(pass);
    await canvas.locator("#import-submit").click();
    await expect(canvas.locator("#dlg-import"), "取り込めずに小窓が開いたまま").toBeHidden({ timeout: 60_000 });
    await expect(canvas.locator("#bundle-result-title")).toHaveText("取り込みました");
    await expect(canvas.locator("#bundle-result-list")).toContainText(`作った：${group} / ${alias}`);
    await expect(canvas.locator("#bundle-result-hint")).toContainText("どの Project にも紐付いていません");
    await canvas.locator("#dlg-bundle-result").getByRole("button", { name: "閉じる" }).click();
    expect(await inputsWithValue(canvas), "合言葉が画面の欄に残っている").not.toContain(pass);

    // ---- 3. 取り込んだ先で値が使える ------------------------------------------------------------------------------
    const listed = JSON.parse((await uiCall(page, SECOND_VAULT, "listAliases", {})).text) as Array<{ name: string; group: string; note?: string }>;
    const found = listed.find((a) => a.name === alias);
    expect(found, `取り込んだ先（${SECOND_VAULT}）に無い`).toBeTruthy();
    expect(found!.group).toBe(group);
    expect(found!.note).toBe("書き出しの試験");
    // 値は Vault の中にある——取り込んだ先から書き出し直して、開いた中身の値を比べる（resolveAlias は画面からは呼べない口）
    const again = await uiCall(page, "vault-directory", "exportBundle", { implementation: SECOND_VAULT, passphrase: pass });
    expect(again.ok, again.text).toBe(true);
    const opened = (await openBundle((JSON.parse(again.text) as { bundle: string }).bundle, pass)) as {
      entries: Array<{ name: string; group: string; value: string }>;
    };
    const entry = opened.entries.find((e) => e.name === alias && e.group === group);
    expect(entry, "取り込んだ先から書き出し直した束に無い").toBeTruthy();
    expect(Buffer.from(entry!.value, "base64").toString("utf8"), "取り込んだ値が元と違う").toBe(secret);

    // もう一度取り込むと、既定では飛ばす
    await canvas.getByRole("button", { name: "取り込む…" }).click();
    await canvas.locator("#import-vault").selectOption(SECOND_VAULT);
    await canvas.locator("#import-file").setInputFiles(file);
    await canvas.locator("#import-pass").fill(pass);
    await expect(canvas.locator("#import-conflict")).toHaveValue("skip");
    await canvas.locator("#import-submit").click();
    await expect(canvas.locator("#bundle-result-list")).toContainText(`飛ばした：${group} / ${alias}（既にある（飛ばしました））`, { timeout: 60_000 });
    await canvas.locator("#dlg-bundle-result").getByRole("button", { name: "閉じる" }).click();
  } finally {
    await uiCall(page, "vault-directory", "deleteAlias", { implementation: "vault-local", name: alias, group });
    await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(SECOND_VAULT)}`, { headers });
  }
});
