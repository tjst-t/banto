// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4「承認をすべて自動で許可する」）。
//
// 見ること（画面と host の記録で）：
//   1. Project の設定の「一般」にスイッチがあり、説明に「Vault の秘密の取り出し・公開も含めて」人に聞かずに通ると書いてある。
//      オンにすると入力欄に「自動で許可中」の印が出る
//   2. オンの Project では、AI の tool の確認（permissionMode が default でも）・Module 間中継の確認（秘密を返す resolveAlias
//      も）・Project をまたぐメッセージの確認が、**人の操作なしで**通る。中身まで届く（秘密の値がコマンドへ・メッセージが
//      宛先の Fork へ）。会話には答え済みのカードが「回答：自動で許可しました（…）」で残り、受信箱に未解決は残らない
//   3. **覚えない**：中継の grant（`relay.grant_created`）は増えず、宛先の「受け取ってよい Project」にも足さない。
//      中継の記録（`relay.call_recorded`）の理由に「自動で許可」と残る
//   4. オフに戻すと印が消え、また聞かれる（tool の確認も、中継の確認も）
import { test, expect } from "../test-base.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { createProject, fakeTurn, openApp, openToolCards, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Auto Approve Project";
const RECEIVER = "E2E Auto Approve Receiver";
/** 中継が通ったときにしか画面に出ない値 */
const SECRET = `AUTO-OK-${Date.now()}`;
const ALIAS = `e2e-auto-${Date.now()}`;
const AUTO_ANSWER = "回答：自動で許可しました（承認をすべて自動で許可する がオン）";
const AUTO_REASON = "自動で許可（承認をすべて自動で許可する がオン）";

/** Event Store に積まれた中継の記録（監査の本体） */
function relayEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(DATA_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"relay.'))
    .map((line) => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
    .filter((e) => e.type.startsWith("relay."));
}

test("オンの Project では tool・中継・Project をまたぐメッセージの確認が人の操作なしで通り、会話に「自動で許可」と残る。覚えず、切ればまた聞く", async ({
  page,
}) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Vault に alias を1つ置く（人の管理操作なので画面の口から）
  const created = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers,
    data: { server: "vault-local", tool: "createAlias", arguments: { name: ALIAS, kind: "secret", value: SECRET } },
  });
  expect(created.ok()).toBe(true);

  // 宛先の Project（API で作る——id を AI の台本に書くため）
  const receiver = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: RECEIVER, root: mkdtempSync(join(tmpdir(), "banto-e2e-auto-recv-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${receiver.id}/threads`, { headers });

  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-auto-"));
  writeFileSync(join(projectRoot, "one.txt"), "ひとつめ\n");
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{
    id: string;
    name: string;
    acceptMessagesFrom?: string[];
  }>;
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId: string = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as Array<{
      id: string;
    }>
  )[0]!.id;
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");

  // **毎回聞くモードにする**——tool の確認が出るはずのところを、スイッチが通すことを見る
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({ timeout: 15_000 });
  // 既定はオフ——印は出ない
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveCount(0);

  // --- 1. 設定でオンにする ---
  await page.goto(`/p/${project.id}?settings=1&project=${project.id}&section=project-general`);
  const toggle = page.getByTestId("project-auto-approve");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("project-auto-approve-description")).toContainText(
    "Vault の秘密の取り出し・公開も含めて、この Project の AI が頼んだものは人に聞かずに通ります",
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // 真実は host（画面の表示だけで確かめない）
  await expect
    .poll(async () => ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/auto-approve`, { headers })).json()) as { enabled: boolean }).enabled)
    .toBe(true);

  await page.goto(`/p/${project.id}`);
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({ timeout: 15_000 });

  const sinceSeq = Math.max(0, ...relayEvents().map((e) => e.seq));
  const mine = () => relayEvents().filter((e) => e.seq > sinceSeq);

  // --- 2. 人の操作なしで通る ---
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "読んで、秘密を echo して、あちらに知らせてください。" +
      fakeTurn({
        tools: [
          { server: "filesystem", name: "readFile", args: { path: "one.txt" } },
          { server: "shell", name: "runCommand", args: { command: 'echo "got=$MY"', envSecrets: { MY: ALIAS } } },
          { server: "banto-thread", name: "send_message", args: { projectId: receiver.id, title: "知らせ", text: "終わりました" } },
        ],
        then: "全部終わりました。",
      }),
  );
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "全部終わりました。" })).toBeVisible({
    timeout: 120_000,
  });
  // 中身まで届いている（規則14——「止まらなかった」ではなく）。承認を求めるカードではない tool のカードは
  // 自動で開かない（v4-frontend.md「答え方」の改訂・2026-10-06）ので、押して開いてから結果を見る
  await openToolCards(page, "mcp__shell__runCommand");
  await openToolCards(page, "mcp__filesystem__readFile");
  await expect(page.getByText(`got=${SECRET}`).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/ひとつめ/).first()).toBeVisible();

  // 会話に答え済みのカード——どれも「自動で許可しました」。答える口は出ていない
  const cards = page.locator('[data-role="judgment-card"]');
  for (const what of [
    "tool呼び出しの承認: mcp__filesystem__readFile",
    "tool呼び出しの承認: mcp__shell__runCommand",
    "shell が vault-directory の lookupAlias",
    "shell が vault-local の resolveAlias",
    "Project をまたぐメッセージの確認",
  ]) {
    const card = cards.filter({ hasText: what });
    await expect(card.first(), `「${what}」のカードが会話に残っていない`).toBeVisible();
    await expect(card.first()).toContainText(AUTO_ANSWER);
  }
  const shown = await cards.allInnerTexts();
  for (const text of shown) expect(text, "自動で許可していないカードがある").toContain(AUTO_ANSWER);
  await expect(page.getByRole("button", { name: "許可する" })).toHaveCount(0);
  expect(shown.join("\n"), "カードに秘密の値が出ている").not.toContain(SECRET);

  // 受信箱に未解決は残らない
  const open = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ kind: string }>;
  expect(open.filter((i) => i.kind === "judgment"), "受信箱に未解決の判断待ちが残っている").toHaveLength(0);

  // 3. 覚えない——grant は増えず、記録の理由に「自動で許可」
  const events = mine();
  expect(events.filter((e) => e.type === "relay.grant_created"), "自動で通したものを grant として覚えた").toHaveLength(0);
  const resolved = events.filter((e) => e.type === "relay.call_recorded" && e.payload.name === "resolveAlias");
  expect(resolved.length).toBeGreaterThanOrEqual(1);
  for (const e of resolved) {
    expect(e.payload.allowed).toBe(true);
    expect(e.payload.reason, "記録に「自動で許可」と分かる理由が無い").toBe(AUTO_REASON);
    expect(JSON.stringify(e.payload)).not.toContain(SECRET);
  }
  // メッセージは届き（宛先に新しい Fork）、「受け取ってよい Project」には足していない
  const after = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as typeof projects;
  expect(after.find((p) => p.id === receiver.id)?.acceptMessagesFrom ?? [], "自動で通したのに受け取ってよい Project に足した").toEqual([]);
  const recvThreads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${receiver.id}/threads`, { headers })).json()) as Array<{
    kind: string;
    title?: string;
  }>;
  expect(recvThreads.some((t) => t.kind === "fork" && t.title === "知らせ"), "メッセージが宛先に届いていない").toBe(true);
  await waitTurnEnded(page, threadId, 1, 120_000);

  // --- 4. オフに戻すと、また聞く ---
  await page.goto(`/p/${project.id}?settings=1&project=${project.id}&section=project-general`);
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.goto(`/p/${project.id}`);
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveCount(0);

  await composer.fill(
    "もう一度 echo してください。" +
      fakeTurn({
        tools: [{ server: "shell", name: "runCommand", args: { command: 'echo "again=$MY"', envSecrets: { MY: ALIAS } } }],
        then: "二度目が終わりました。",
      }),
  );
  await composer.press("Enter");
  // tool の確認を人に聞く
  const toolCard = page.locator('[data-role="judgment-card"]').filter({ hasText: "tool呼び出しの承認: mcp__shell__runCommand" });
  await expect(toolCard.getByRole("button", { name: "許可する" })).toBeVisible({ timeout: 60_000 });
  await toolCard.getByRole("button", { name: "許可する" }).click();
  await expect(toolCard).toContainText("回答：許可する");
  // 中継の確認も人に聞く（覚えていないので、前のターンで通した組み合わせでも）
  const relayCard = page.locator('[data-role="judgment-card"]').filter({ hasText: "shell が vault-directory の lookupAlias" }).last();
  await expect(relayCard.getByRole("button", { name: "拒否する" })).toBeVisible({ timeout: 60_000 });
  // 人に聞く形の注記（自動で通したときの注記ではない）。Shell はコンテナの中なので、対象つきの言い方になる
  await expect(relayCard).toContainText("許可すると、この Project では同じ組み合わせ");
  await relayCard.getByRole("button", { name: "拒否する" }).click();
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "二度目が終わりました。" })).toBeVisible({
    timeout: 120_000,
  });
  // 閉じたカードの中は見えないので、開いてから「出ていない」を見る（閉じたままだと何も見ていない）
  await openToolCards(page, "mcp__shell__runCommand");
  await expect(page.getByText(`again=${SECRET}`)).toHaveCount(0);
  expect(mine().filter((e) => e.type === "relay.grant_created")).toHaveLength(0);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);

  // **後の spec に受信箱を持ち越さない**——メッセージが届いた知らせ・レビュー待ちが残ると、受信箱の数を見る spec
  // （inbox.spec）が狂い、そこで残った判断待ちが次の spec まで落とした（2026-10-05、続けて回して踏んだ）
  await expect
    .poll(
      async () => {
        const left = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ id: string; kind: string }>;
        for (const item of left) {
          if (item.kind === "notice" || item.kind === "review") {
            await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
          }
        }
        return left.length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
});
