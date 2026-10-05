// **別の Module からサブエージェントを呼ぶ**（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」。Backlog の
// subagent-from-modules——Factory の前提）。
//
// Factory と同じ形の試験用 Module（`fixtures/relay-caller-module`：Project ごと・依存に subagent）を足し、AI にその tool を
// 呼ばせる。その Module が host の中継で `runSubagent` を呼ぶ。見るもの（規則14）：
//   1. 待つ形で 60 秒を越える仕事（[slow 70]）が、中継で切れずに結果まで返る（以前は 60 秒で -32001）
//   2. 待たない形は、返事が**呼んだ Module の受け口**に届く（返事の印が頼んだときのものと一致、lost でない）。
//      頼んだ Thread には何も届かない（Thread の返事待ちも出ない）
//   3. 返事を待っているうちに頼んだ先（Subagent）が止まると、呼んだ Module に「途中で終わりました」（lost）が届く
//      ——呼んだ Module も一緒に止まるが、host が残してから渡すので、次に立ったプロセスに渡る
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const MODULE = `e2e-relay-${Date.now()}`;
const PROJECT_NAME = "E2E Subagent From Module";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/relay-caller-module/server.js");

interface Reply {
  replyId: string;
  from: string;
  title: string;
  text: string;
  final: boolean;
  lost: boolean;
}
interface HostMessage {
  role: string;
  text: string;
  origin?: unknown;
}

let projectId = "";
let threadId = "";
let turns = 0;

async function replies(page: Page): Promise<Reply[]> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, {
    headers,
    data: { server: MODULE, tool: "listReplies", arguments: {} },
  });
  if (!res.ok()) return [];
  const outer = (await res.json()) as { content?: { text: string }[] };
  return JSON.parse(outer.content?.[0]?.text ?? "[]") as Reply[];
}

async function hostThread(page: Page): Promise<{ messages: HostMessage[]; awaitingReplies?: unknown[] }> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: HostMessage[];
    awaitingReplies?: unknown[];
  };
}

/** AI にこの Module の delegate を呼ばせ、ターンが終わるまで待つ。中継の承認が出たら許す。tool の結果を返す */
async function delegate(page: Page, prompt: string, background: boolean): Promise<string> {
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    `Module 経由で頼んで。` +
      // 本物の CLI と同じ諦め方（返事も進捗も 300 秒来なければ諦める・進捗で数え直す）。偽 Runner の既定は
      // MCP の 60 秒で進捗でも数え直さない——それでは banto の側を測れない
      fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: MODULE, name: "delegate", args: { prompt, background } }] }),
  );
  await composer.press("Enter");
  turns += 1;
  const want = turns;
  // 初回は中継の承認（この Module → subagent、subagent → Vault）が会話に出る
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    const assistants = (await hostThread(page)).messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBeGreaterThanOrEqual(want);
  }).toPass({ timeout: 200_000, intervals: [1000] });
  await waitTurnEnded(page, threadId, want, 60_000);
  const last = (await hostThread(page)).messages.filter((m) => m.role === "assistant").at(-1)!;
  return last.text;
}

/** 前の試験で作った Project の Base Thread を開く */
async function openProject(page: Page): Promise<void> {
  await openApp(page);
  await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
}

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
});

test("Module から待つ形で頼んだ 60 秒を越える仕事が、中継で切れずに結果まで返る", async ({ page }) => {
  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: {
      name: MODULE,
      launch: {
        command: "${nodeExec}",
        args: [SERVER],
        env: { BANTO_HOST_MCP_URL: "${hostRelayUrl}", BANTO_HOST_MCP_TOKEN: "${hostRelayToken}" },
      },
      meta: { satisfies: ["e2e-relay-caller"], dependsOn: [{ role: "subagent", required: true }], isolation: "subprocess", scope: "project" },
    },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-subagent-from-module-")));
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  await waitForProjectModule(page, PROJECT_NAME, MODULE);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  const started = Date.now();
  const text = await delegate(page, "[slow 70] 長い仕事", false);
  expect(Date.now() - started, "70 秒の仕事なのに早く終わった（待っていない）").toBeGreaterThan(65_000);
  expect(text, "待つ形の結果が返っていない（中継で切れた？）").toContain("受け取った：[slow 70] 長い仕事");
  expect(text).not.toMatch(/timed out|-32001/i);
});

test("Module から待たずに頼んだ仕事の返事は、呼んだ Module の受け口に届く——頼んだ Thread には届かない", async ({ page }) => {
  await openProject(page);
  const text = await delegate(page, "[slow 4] 短い仕事", true);
  const { replyId } = JSON.parse(text.slice(text.indexOf("{"))) as { replyId?: string };
  expect(replyId, `返事の印が呼んだ Module に見えない：${text}`).toMatch(/^rid_/);

  await expect
    .poll(async () => (await replies(page)).find((r) => r.replyId === replyId), { timeout: 90_000, message: "返事が受け口に届かない" })
    .toBeTruthy();
  const got = (await replies(page)).find((r) => r.replyId === replyId)!;
  expect(got).toMatchObject({ from: "subagent", final: true, lost: false });
  expect(got.title).toContain("終わりました");
  expect(JSON.parse(got.text)).toMatchObject({ stopReason: "end_turn" });

  // 頼んだ Thread には何も届かない（返事は Module 宛て）
  const thread = await hostThread(page);
  expect(thread.messages.filter((m) => m.origin), "Module 宛ての返事が Thread に届いている").toHaveLength(0);
  expect(thread.awaitingReplies ?? []).toEqual([]);
});

test("返事を待っているうちに頼んだ先が止まると、呼んだ Module に「途中で終わりました」が届く", async ({ page }) => {
  await openProject(page);
  const text = await delegate(page, "[slow 300] 終わらない仕事", true);
  const { replyId } = JSON.parse(text.slice(text.indexOf("{"))) as { replyId?: string };
  expect(replyId).toMatch(/^rid_/);

  // その Project の Module を立て直す（Subagent も、この Module も止まる）
  const res = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/container`, { headers, data: { nesting: true } });
  expect(res.ok()).toBe(true);
  // 返事はもう host に残っている（呼んだ Module もまだ止まっている）。Project の Module は使うときに立つので、
  // 画面が開いたときと同じく立ち上げを頼む——立ったら、残っていた返事が渡る
  await expect
    .poll(async () => (await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/modules/prepare`, { headers })).status(), {
      timeout: 60_000,
    })
    .toBeLessThan(400);
  await waitForProjectModule(page, PROJECT_NAME, MODULE);

  await expect
    .poll(async () => (await replies(page)).find((r) => r.replyId === replyId), { timeout: 120_000, message: "「途中で終わりました」が届かない" })
    .toBeTruthy();
  const got = (await replies(page)).find((r) => r.replyId === replyId)!;
  expect(got).toMatchObject({ from: "subagent", final: true, lost: true });
  expect(got.text).toContain("頼んだ先の Module が止まったため");
  // Thread には届かない
  expect((await hostThread(page)).messages.filter((m) => m.origin)).toHaveLength(0);
});
