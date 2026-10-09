// **仕事の組と天井**（決定・2026-10-08〜09、ユーザー。`docs/specs/v4-security.md` §1 の段2a）。
//
// 見るもの（規則14——「組に入った」で終わらせず、本当に食い尽くしたときに Module が生き残るところまで）：
//   1. コンテナを用意すると、仕事の組の天井（コンテナのメモリの 75%）が中に置かれ、上限を変えると書き直される
//   2. Shell のコマンドは走る。待たない形は仕事の組（banto-work-jobs.slice）で、カーネルに先に止められる値（500）で動く
//      ——待つ形も組に入れるが、入れ子のコンテナ（この E2E）では systemd が incus exec のプロセスを組へ移せず入れられない
//      （そのときも今までどおり走ることを見る。待つ形が組に入ることは、入れ子でない Project のコンテナで実測した）
//   3. 待たない形のコマンドがメモリを食い尽くすと、仕事の組の天井で止められ、Shell は答え続ける
import { test, expect, type Page } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Work Slice";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const WORK_EVENTS = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/banto.slice/banto-work.slice/memory.events";

/** AI が通る経路そのもの（代理サーバ）で、待つ形の runCommand を呼ぶ */
async function runCommand(projectId: string, command: string): Promise<{ stdout: string; exitCode: number | null }> {
  const client = new Client({ name: "e2e-work-slice", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${CORE_BASE_URL}/agent-relay/shell-${projectId}`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "runCommand", arguments: { command, timeout: 120 } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
    return JSON.parse(text) as { stdout: string; exitCode: number | null };
  } finally {
    await client.close();
  }
}

/** banto の外（Incus）から、コンテナの中のファイルを読む——host の自己申告を信じない（規則1） */
function catInContainer(projectId: string, path: string): string {
  const r = spawnSync("incus", ["exec", `banto-${projectId}`, "--", "cat", path], { encoding: "utf8", input: "" });
  return r.status === 0 ? r.stdout : `(読めない: ${r.stderr.trim()})`;
}

/** 会話の偽の AI に、待たない形で流させる。返ったコマンドの出力のファイル */
async function runInBackground(page: Page, threadId: string, command: string, expectDelivered: number): Promise<string> {
  // 前に流したものの「終わりました」が届くと AI が起きてターンが増える——届いた数だけターンが終わってから、いまの発言を数える
  type T = { messages: Array<{ role: string; origin?: unknown }>; lastTurn?: { outcome?: string } };
  const read = async () => (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as T;
  await expect
    .poll(
      async () => {
        const t = await read();
        const delivered = t.messages.filter((m) => m.origin).length;
        if (delivered < expectDelivered) return `届いたのが ${delivered} 件（待っているのは ${expectDelivered} 件）`;
        return t.lastTurn && !t.lastTurn.outcome ? "ターンが走っている" : "ok";
      },
      { timeout: 60_000 },
    )
    .toBe("ok");
  const before = (await read()).messages.filter((m) => m.role === "assistant").length;
  const turn = before + 1;
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("待たずに流して。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command, runInBackground: true } }] }));
  await composer.press("Enter");
  const done = await waitTurnEnded(page, threadId, turn, 120_000);
  const started = JSON.parse(done.messages.filter((m) => m.role === "assistant").at(-1)!.text) as { status: string; outputFile: string };
  expect(started.status).toBe("running");
  return started.outputFile;
}

test.afterAll(async ({ request }) => {
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

test("仕事の組：天井がコンテナに置かれ、Shell のコマンドは組の中で動き、食い尽くすと組の天井で止められて Shell は生き残る", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-work-slice-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  // ---- 1. 天井：上限を 1 GiB にすると、仕事の組は 768 MiB ----
  const set = await page.request.put(`${CORE_BASE_URL}/api/projects/${project.id}/container/limits`, {
    headers,
    data: { memoryMiB: 1024, cpus: null, processes: null },
  });
  expect(set.ok()).toBe(true);
  await expect
    .poll(() => catInContainer(project.id, "/etc/systemd/user/banto-work.slice"), { timeout: 30_000, message: "天井が書き直される" })
    .toContain(`MemoryMax=${768 * 1024 * 1024}`);

  // ---- 2. 待つ形は（組に入れられなくても）走り、待たない形は仕事の組で先に止められる値で動く ----
  expect((await runCommand(project.id, "echo 待つ形も走ります")).stdout).toContain("待つ形も走ります");
  const whereFile = await runInBackground(page, threadId, "cat /proc/self/cgroup; cat /proc/self/oom_score_adj", 0);
  await expect
    .poll(async () => (await runCommand(project.id, `cat '${whereFile}'`)).stdout, { timeout: 30_000, message: "仕事の組で動いていない" })
    .toMatch(/banto-work-jobs\.slice\/banto-shell-[^\n]*\n500/);

  // ---- 3. 食い尽くすと、仕事の組の天井で止められ、Shell は答え続ける ----
  await runInBackground(page, threadId, `/usr/local/bin/node -e "const a=[];for(;;)a.push(Buffer.alloc(64<<20,1))"`, 1);
  await expect
    .poll(() => catInContainer(project.id, WORK_EVENTS), { timeout: 60_000, message: "仕事の組の天井で止められた" })
    .toMatch(/oom_kill [1-9]/);
  expect((await runCommand(project.id, "echo まだ答えます")).stdout, "Shell は生き残っている").toContain("まだ答えます");
});
