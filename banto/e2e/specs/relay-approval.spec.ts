// Module 間中継の初回承認ゲートと監査（アーキ仕様 §2.5・v4-frontend.md
// 「Module 間中継の承認（入れ子の承認）」）。
//
// 見るのは4つ：
//   1. **初回だけ**人に聞く——Shell が Vault の resolveAlias を呼ぶ手前で止まる
//   2. `bypassPermissions` でも出る（AI への信用と、Project の配線への信用は別の軸）
//   3. 許可すると中継が通り、**秘密の値が実際にコマンドへ届く**（規則14——
//      「カードを押せた」で終わらせず、画面に出る中身まで見る）
//   4. 2回目は聞かれない（同じ Project 内で自動許可）。記録は Event Store に残る
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Relay Approval Project";
/** 「中継が通ったときにしか画面に出ない」一意な値。 */
const SECRET = `RELAY-OK-${Date.now()}`;
const ALIAS = `e2e-relay-${Date.now()}`;

const PROMPT =
  `shell の runCommand を、command に \`echo "got=$MY"\`、envSecrets に {"MY": "${ALIAS}"} を渡して` +
  "1回だけ実行してください。返ってきた stdout をそのまま書いてください。";

/** Event Store に積まれた中継の記録（監査の本体）。 */
function relayEvents(): Array<{ type: string; payload: Record<string, unknown> }> {
  const raw = readFileSync(join(DATA_DIR, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.includes('"relay.'))
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type.startsWith("relay."));
}

test("Module 間の中継は初回だけ人に聞き、許可すると通る——記録は Event Store に残る", async ({
  page,
}) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-relay-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Vault に alias を1つ置く（人の管理操作＝admin 可視性なので、画面の口から）
  const created = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    data: {
      server: "vault",
      tool: "createAlias",
      arguments: { name: ALIAS, kind: "secret", scope: "project", value: SECRET },
    },
  });
  expect(created.ok()).toBe(true);

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })
  ).json();
  const threadId: string = threads[0].id;
  /** ターンが**終わった**数（assistant の発言は終わってから記録される）。
   *  走行中に次を送っても composer は受け取らないので、ここで区切る。 */
  const finishedTurns = async () => {
    const thread = (await (
      await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })
    ).json()) as { messages: { role: string }[] };
    return thread.messages.filter((m) => m.role === "assistant").length;
  };

  // **確認を全部飛ばすモードにする**——それでも中継の確認は出る、が見たいこと
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /bypassPermissions/ }).click();
  await page.getByRole("button", { name: "この会話で有効にする" }).click();
  await expect(page.getByRole("button", { name: /permissionMode（現在：bypassPermissions）/ })).toBeVisible({
    timeout: 15_000,
  });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(PROMPT);
  await composer.press("Enter");

  // 1. 中継の手前で止まる（bypassPermissions でも出る）
  const card = page.locator('[data-role="judgment-card"]').first();
  await expect(card.getByText(/shell が vault の resolveAlias を呼ぼうとしています/)).toBeVisible({
    timeout: 120_000,
  });
  // **何を承認するのかが、答える前に見えている**（§6.0）
  await expect(card.getByText(/"呼び出し元": "shell"/)).toBeVisible();
  await expect(card.getByText(/"宛先": "vault"/)).toBeVisible();
  // **値は出さない**（§2.5——記録に残るのは宛名まで）
  await expect(card.getByText(SECRET)).toHaveCount(0);

  // まだ中継されていない＝コマンドは走っていない
  await expect(page.getByText(`got=${SECRET}`)).toHaveCount(0);

  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  // 2. 許可すると中継が通り、**秘密の値が実際にコマンドへ届く**
  await expect(page.getByText(`got=${SECRET}`).first()).toBeVisible({ timeout: 180_000 });

  // 3. 2回目は聞かれない（同じ Project 内で自動許可）
  await expect.poll(finishedTurns, { timeout: 120_000, message: "1ターン目が終わるまで" }).toBe(1);
  await composer.fill(PROMPT);
  await composer.press("Enter");
  await expect
    .poll(
      () => relayEvents().filter((e) => e.type === "relay.call_recorded").length,
      { timeout: 180_000, message: "2回目の中継が記録されるまで" },
    )
    .toBeGreaterThanOrEqual(2);
  // 判断待ちのカードは最初の1枚だけのまま
  await expect(page.locator('[data-role="judgment-card"]')).toHaveCount(1);
  const openJudgments = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  expect(
    openJudgments.filter((i: { kind: string; source?: string }) => i.source === "relay"),
  ).toHaveLength(0);

  // 4. 記録（監査）——許可は1回、呼び出しは毎回、値は残っていない
  const events = relayEvents();
  const grants = events.filter((e) => e.type === "relay.grant_created");
  expect(grants).toHaveLength(1);
  expect(grants[0]!.payload).toMatchObject({
    callerModule: "shell",
    targetModule: "vault",
    kind: "tool",
    name: "resolveAlias",
  });
  const calls = events.filter((e) => e.type === "relay.call_recorded");
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const call of calls) {
    expect(call.payload.allowed).toBe(true);
    expect(call.payload.ok).toBe(true);
    expect(JSON.stringify(call.payload)).not.toContain(SECRET);
  }

  expect(pageErrors).toEqual([]);
});
