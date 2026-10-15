// **同梱の道具用のコンテナ**（Backlog #309、2026-10-15、`docs/specs/v4-security.md` §1 の4つ目の箱）。
//
// 試しの同梱 Module（目録の `tools-probe`、画面の目録には出ない）を入れて起こし、見るもの（規則14——中から見える値まで）：
//   1. 道具用のコンテナで起きる（host の置き場の語が tools-container・繋がっている・中から見て BANTO_IN_CONTAINER）
//   2. 名乗ったパッケージ（jq）が入っていて、中で使える
//   3. 中で sudo できない（パスワード無しの sudo を外してある）
//   4. 設定の Module の一覧に「道具用のコンテナ」「Running」と出る。画面の目録（Module を追加）には出ない
import { test, expect } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.setTimeout(600_000);

const MODULE = "tools-probe";

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

test("試しの同梱 Module が道具用のコンテナで起き、名乗ったパッケージが入り、中で sudo できない", async ({ page }) => {
  // 画面の目録には出ない（試験のための同梱 Module）
  const catalog = await api<Array<{ id: string }>>("/api/modules/catalog");
  expect(catalog.body.map((e) => e.id), "試しの Module が画面の目録に出ている").not.toContain("tools-probe");

  const added = await api<{ ok?: boolean; error?: string }>(`/api/modules/catalog/tools-probe`, {
    method: "POST",
    body: JSON.stringify({ name: MODULE }),
  });
  expect(added.status, added.body.error).toBe(200);
  try {
    const listed = await api<Array<{ name: string; origin: string; placement: string }>>("/api/modules");
    const row = listed.body.find((m) => m.name === MODULE);
    expect(row, "入れた Module が一覧に無い").toBeTruthy();
    expect(row!.origin).toBe("bundled");
    expect(row!.placement).toBe("tools-container");

    // ---- 起こして、中から見えるものを聞く（初回はコンテナを作り、apt で jq を入れる——数分かかることがある） ----
    const called = await api<{ content?: Array<{ text: string }>; error?: string }>("/api/ui-tool-call", {
      method: "POST",
      body: JSON.stringify({ server: MODULE, tool: "inspect", arguments: {} }),
    });
    expect(called.status, `道具用のコンテナの Module を呼べない：${JSON.stringify(called.body)}`).toBe(200);
    const inside = JSON.parse(called.body.content![0]!.text) as {
      uid: number;
      inContainer: boolean;
      sudo: { allowed: boolean; output: string };
      packages: Record<string, boolean>;
      jq: string;
    };
    expect(inside.inContainer, "コンテナの外で起きている").toBe(true);
    expect(inside.packages, "名乗ったパッケージが入っていない").toEqual({ jq: true });
    expect(inside.jq, "入れた jq が中で動かない").toMatch(/^jq-\d/);
    expect(inside.sudo.allowed, `中で sudo できてしまう：${inside.sudo.output}`).toBe(false);
    expect(inside.sudo.output).toMatch(/password is required|not allowed|may not run sudo/);

    // ---- host の状態：繋がっていて、入れている途中でも失敗でもない ----
    const after = await api<Array<{ name: string; connected: boolean; error?: string; toolsInstall?: unknown }>>("/api/modules");
    const now = after.body.find((m) => m.name === MODULE)!;
    expect(now.connected).toBe(true);
    expect(now.error).toBeUndefined();
    expect(now.toolsInstall).toBeUndefined();

    // ---- 画面：設定の Module の一覧に置き場と状態が出る ----
    await openApp(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Module", exact: true }).click();
    const tr = page.locator(`[data-module="${MODULE}"]`);
    await expect(tr, "一覧に出ていない").toBeVisible({ timeout: 60_000 });
    await expect(tr.locator("td").nth(1)).toHaveText("tools-probe");
    await expect(tr.locator("td").nth(2)).toHaveText("Global");
    await expect(tr.locator("td").nth(3)).toHaveText("道具用のコンテナ");
    await expect(page.getByTestId(`module-state-${MODULE}`)).toHaveText("Running");
    // 入れられなかったときだけの操作は出ていない
    await page.getByTestId(`module-menu-${MODULE}`).click();
    await expect(page.getByTestId(`module-tools-retry-${MODULE}`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    // 画面の「Module を追加」の目録にも出ない
    await page.getByRole("button", { name: "Module を追加" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).not.toContainText("道具用のコンテナの確かめ");
  } finally {
    await api(`/api/modules/${MODULE}`, { method: "DELETE" });
  }
});
