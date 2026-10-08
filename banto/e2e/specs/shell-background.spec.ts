// **Shell で待たずに流したコマンドが、終わったら会話に届いて AI が起きる**（決定・2026-10-07、ユーザー。
// v4-modules.md §2.3「待たない形」、Backlog #224）。本番と同じ経路：host → **コンテナの中の** Shell → コンテナの中の
// systemd のユーザー単位（`systemd-run --user`）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 待たずに流すと、最初のターンはすぐ終わる（コマンドはまだ動いている）。返事に commandId と outputFile
//   2. サイドバーの Base Thread の行に、カードの題（AI が付けた呼び名 label）の印。押すと一覧に shell の1件——
//      題は呼び名、説明はコマンド（2026-10-08、ユーザー要望——コマンドの文字そのままを題にしない）
//   3. AI が listCommands で一覧を見ると、そのコマンドが running（呼び名つき）
//   4. 終わると、開いたままの画面に「shell から届きました」の札。題は「コマンドが終わりました：<呼び名>」、本文は
//      終了コードが先頭・出力の末尾（コマンドの文字には無い、走らせて初めて出る語）。AI が起きて、届いた出力を読んで返す
//   5. 印が消える。出力のファイルは次の runCommand で読める
//   6. もう1本（呼び名なし）流すと、印と一覧の題はコマンド・説明は出さない（同じ文を2行並べない）。cancelCommand で
//      止めると、「コマンドを止めました：<コマンド>」が届いて AI が起きる。一覧は cancelled
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Shell Background";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
// 「〜」と返して、をコマンドの文字に書かずに出力にだけ出す（「」を printf の8進で作る）——AI（偽 Runner）がその語で
// 返せば、**届いた出力**を読んだことになる（コマンドの文字から拾ったのではない）
const OPEN = "$(printf '\\343\\200\\214')";
const CLOSE = "$(printf '\\343\\200\\215')";
const LONG_COMMAND = `sleep 20; echo "${OPEN}流したコマンドの出力を読みました${CLOSE}と返して"; echo $((6*7))-computed`;
const LONG_LABEL = "長い計算を待たずに流す";
const CANCEL_COMMAND = "echo cancel-me-started; sleep 300";

interface HostMessage {
  role: string;
  text: string;
  origin?: { from: string; title: string; hop: number };
}

async function hostMessages(page: Page, threadId: string): Promise<HostMessage[]> {
  return ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { messages: HostMessage[] })
    .messages;
}

async function sendTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(text);
  await composer.press("Enter");
}

test.afterAll(async ({ request }) => {
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

test("待たずに流したコマンドは、終わると開いたままの会話に届いて AI が起き、止めると「止めました」が届く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-shell-bg-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const line = sidebar.getByTestId("thread-background");

  // ---- 1. 待たずに流す ----------------------------------------------------------------------------------
  await sendTurn(
    page,
    "長いコマンドを待たずに流して。" +
      fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: LONG_COMMAND, runInBackground: true, label: LONG_LABEL } }] }),
  );
  const first = await waitTurnEnded(page, threadId, 1, 120_000);
  const started = JSON.parse(first.messages.filter((m) => m.role === "assistant").at(-1)!.text) as {
    commandId: string;
    status: string;
    outputFile: string;
    note: string;
  };
  expect(started.status).toBe("running");
  expect(started.note).toContain("待たずに流しました");
  expect(started.outputFile.endsWith(`/commands/${started.commandId}/output.log`), started.outputFile).toBe(true);
  expect((await hostMessages(page, threadId)).some((m) => m.origin), "待たずに流したのに、もう届いている").toBe(false);

  // ---- 2. サイドバーの印（カードの題＝呼び名、説明＝コマンド） ------------------------------------------------------
  await expect(line, "Base Thread の行にバックグラウンドの印が出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(line).toHaveText(LONG_LABEL);
  await line.click();
  const list = page.getByTestId("background-list");
  await expect(list).toContainText("バックグラウンドで動いているもの（1）");
  const item = list.getByTestId("background-item");
  await expect(item).toHaveCount(1);
  await expect(item.locator("span").first(), "一覧の題が呼び名ではない").toHaveText(LONG_LABEL);
  await expect(item.getByTestId("background-item-description"), "一覧の説明がコマンドではない").toHaveText(/^sleep 20; echo/);
  // 1分たっていなければ「いま頼んだ」（「いまに頼んだ」と出ていた、2026-10-07）
  await expect(item).toContainText(/shell・(いま頼んだ|\d+分前に頼んだ)/);
  await expect(item).not.toContainText("いまに");
  await page.keyboard.press("Escape");

  // ---- 3. AI が一覧を見る（この Thread の分）--------------------------------------------------------------------
  await sendTurn(page, "流したコマンドの一覧を見せて。" + fakeTurn({ tools: [{ server: "shell", name: "listCommands", args: {} }] }));
  const listed = await waitTurnEnded(page, threadId, 2, 60_000);
  const commands = (JSON.parse(listed.messages.filter((m) => m.role === "assistant").at(-1)!.text) as {
    commands: Array<{ commandId: string; status: string; command: string; cwd: string; label?: string }>;
  }).commands;
  expect(commands.map((c) => [c.commandId, c.status, c.cwd, c.label, c.command])).toEqual([
    [started.commandId, "running", ".", LONG_LABEL, LONG_COMMAND],
  ]);

  // ---- 4. 終わると届き、AI が起きる（開いたままの画面で）---------------------------------------------------------
  const card = page.getByTestId("delivered-message");
  await expect(card, "届いたものが、開いたままの画面に出ない").toBeVisible({ timeout: 90_000 });
  await expect(card).toHaveAttribute("data-from", "shell");
  await expect(card).toContainText("shell から届きました");
  await expect(card.getByTestId("delivered-title")).toHaveText(`コマンドが終わりました：${LONG_LABEL}`);
  await waitTurnEnded(page, threadId, 3, 90_000);
  const messages = await hostMessages(page, threadId);
  const delivered = messages.filter((m) => m.origin);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.origin).toMatchObject({ from: "shell", hop: 1, title: `コマンドが終わりました：${LONG_LABEL}` });
  expect(delivered[0]!.text.startsWith('{"exitCode":0,'), delivered[0]!.text.slice(0, 60)).toBe(true);
  const body = JSON.parse(delivered[0]!.text) as { status: string; commandId: string; tail: string; outputFile: string; label?: string };
  expect(body.status).toBe("exited");
  expect(body.label).toBe(LONG_LABEL);
  expect(body.commandId).toBe(started.commandId);
  expect(body.tail, "出力の末尾が届いていない").toContain("42-computed");
  // AI は届いた出力（コマンドの文字には無い「」）を読んで返した
  const replies = messages.filter((m) => m.role === "assistant");
  // （偽 Runner は「〜」と返して、の語を拾う。JSON の引用符から拾うので頭に余分が付くことがある——中身で見る）
  expect(replies.at(-1)!.text, "AI が届いた出力を読んでいない").toContain("流したコマンドの出力を読みました");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("流したコマンドの出力を読みました", { timeout: 30_000 });

  // ---- 5. 印が消える。出力のファイルは次の runCommand で読める ------------------------------------------------
  await expect(line, "届いたのに印が残っている").toHaveCount(0, { timeout: 30_000 });
  await sendTurn(
    page,
    "出力のファイルを読んで。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: `tail -n 1 '${body.outputFile}'` } }] }),
  );
  const read = await waitTurnEnded(page, threadId, 4, 60_000);
  expect((JSON.parse(read.messages.filter((m) => m.role === "assistant").at(-1)!.text) as { stdout: string }).stdout).toBe("42-computed\n");

  // ---- 6. もう1本流して止める ----------------------------------------------------------------------------------
  await sendTurn(
    page,
    "止めるコマンドを流して。" +
      fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: CANCEL_COMMAND, runInBackground: true } }] }),
  );
  const second = await waitTurnEnded(page, threadId, 5, 120_000);
  const toCancel = JSON.parse(second.messages.filter((m) => m.role === "assistant").at(-1)!.text) as { commandId: string };
  // 呼び名なし：印と一覧の題はコマンド、説明は出さない（題と同じ文を2行並べない）
  await expect(line).toHaveText(CANCEL_COMMAND, { timeout: 30_000 });
  await line.click();
  await expect(item).toHaveCount(1);
  await expect(item.locator("span").first()).toHaveText(CANCEL_COMMAND);
  await expect(item.getByTestId("background-item-description"), "題と同じ文の説明を出している").toHaveCount(0);
  await expect(item).toContainText(/shell・(いま頼んだ|\d+分前に頼んだ)/);
  await page.keyboard.press("Escape");
  await sendTurn(
    page,
    "さっきのを止めて。" + fakeTurn({ tools: [{ server: "shell", name: "cancelCommand", args: { commandId: toCancel.commandId } }] }),
  );
  // 止めたターン（6）と、「止めました」で起きたターン（7）
  await waitTurnEnded(page, threadId, 7, 120_000);
  const afterCancel = await hostMessages(page, threadId);
  const cancelReport = afterCancel.filter((m) => m.origin).at(-1)!;
  expect(cancelReport.origin!.title).toBe(`コマンドを止めました：${CANCEL_COMMAND}`);
  const cancelBody = JSON.parse(cancelReport.text) as { status: string; tail: string; commandId: string };
  expect(cancelBody).toMatchObject({ status: "cancelled", commandId: toCancel.commandId });
  expect(cancelBody.tail).toContain("cancel-me-started");
  const cancelledAnswer = JSON.parse(
    afterCancel.filter((m) => m.role === "assistant").at(-2)!.text,
  ) as { ok: boolean; status: string };
  expect(cancelledAnswer).toMatchObject({ ok: true, status: "cancelled" });
  await expect(page.getByTestId("delivered-title").last()).toHaveText(`コマンドを止めました：${CANCEL_COMMAND}`, { timeout: 30_000 });
  await expect(line, "止めたのに印が残っている").toHaveCount(0, { timeout: 30_000 });

  await sendTurn(page, "一覧をもう一度。" + fakeTurn({ tools: [{ server: "shell", name: "listCommands", args: {} }] }));
  const last = await waitTurnEnded(page, threadId, 8, 60_000);
  const finalList = (JSON.parse(last.messages.filter((m) => m.role === "assistant").at(-1)!.text) as {
    commands: Array<{ commandId: string; status: string; exitCode?: number | null; label?: string }>;
  }).commands;
  expect(finalList.map((c) => [c.commandId, c.status, c.label])).toEqual([
    [toCancel.commandId, "cancelled", undefined],
    [started.commandId, "exited", LONG_LABEL],
  ]);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
