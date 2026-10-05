// **サブエージェントに待たずに頼んだ仕事の途中で host が落ちても、起き直したら続いて、頼んだ Thread に結果が届く**
// （追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の「2. Module の仕事を続ける」）。
//
// 自前の host（`own-host.ts`）で、偽のエージェントの仕事（runInBackground）が tool の途中のところで host を SIGKILL で
// 落とし、起こし直す。見るもの（規則14）：
//   - 起き直した host が Subagent に続けるかを聞き、Subagent が続けると答える（札は返事待ちのまま、続けると答えた時刻が付く）
//   - 続けている間、サイドバーのバックグラウンドの一覧に「起こし直しのあと続けています」が出る
//   - Subagent が会話を続きから開き、「途中で切れました。実行中だった tool：…」を送り、その結果が**同じ札で**頼んだ
//     Thread に届く（「途中で終わりました」は届かない）。AI が起きて続きをやる
//   - 届いたら、バックグラウンドの印も走っている仕事の記録も消える
//   - **前の走行のエージェントとその子は、続ける前に止まる**——SIGKILL のあとも、コンテナの中に残って走り続ける（実測）。
//     続けている間に居るエージェントは続けた1本だけ（2026-10-05、Fable のレビュー）
import { test, expect, type Page } from "../test-base.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Resume";
// [child 120]：claude-agent-acp が CLI を子で起こすのと同じ形（ACP の管が切れても子は走り続ける）
const PROMPT = "[child 120] [slow 60] [then-slow 8] 長い仕事";

/** この worktree の偽のエージェントと、その子（会話の id つき）。ホストから見える（コンテナはカーネルを分けない） */
function agentProcesses(): { agents: number[]; children: string[] } {
  const lines = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n");
  const here = join(import.meta.dirname, "..", "..");
  return {
    agents: lines.filter((l) => l.includes(`${here}/packages/modules/subagent/dist/testing/fake-agent.js`)).map((l) => Number(l.trim().split(/\s+/)[0])),
    children: lines.filter((l) => l.includes("fake-agent-child")).map((l) => l.trim()),
  };
}

interface HostThread {
  id: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string }>;
  lastTurn?: { cause: string; outcome?: string };
}

async function api<T>(host: OwnHost, path: string): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!res.ok) throw new Error(`${path} が ${res.status}`);
  return (await res.json()) as T;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

test("待たずに頼んだサブエージェントの仕事の途中で host が落ちても、起き直したら続いて結果が頼んだ Thread に届く", async ({ page }) => {
  await withOwnHost(async (host) => {
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-subagent-resume-")));
    const project = (await api<Array<{ id: string; name: string }>>(host, "/api/projects")).find((p) => p.name === PROJECT_NAME)!;
    const threadId = (await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`))[0]!.id;
    const thread = () => api<HostThread>(host, `/api/threads/${threadId}`);
    const runningDir = join(host.dataDir, "modules", `subagent-${project.id}`, "running");
    const runningFiles = () => (existsSync(runningDir) ? readdirSync(runningDir).filter((f) => f.endsWith(".json")) : []);

    // ---- 待たずに頼む ----------------------------------------------------------------------------------
    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill(
      "サブエージェントに待たずに頼んで。" +
        fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: PROMPT, runInBackground: true } }] }),
    );
    await composer.press("Enter");
    // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）
    await expect(async () => {
      const allow = page.getByRole("button", { name: "許可する" });
      if ((await allow.count()) > 0) await allow.last().click();
      await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 180_000 });
    await expect.poll(async () => (await thread()).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");
    // 仕事が tool の途中まで進み、走っている記録に残った
    await expect
      .poll(
        () => runningFiles().map((f) => (JSON.parse(readFileSync(join(runningDir, f), "utf8")) as { toolsInFlight: Array<{ title: string }> }).toolsInFlight.map((t) => t.title)),
        { timeout: 60_000, message: "走っている仕事の記録に tool が残らない" },
      )
      .toEqual([["sleep 60"]]);
    expect((await thread()).awaitingReplies?.map((r) => r.moduleName)).toEqual(["subagent"]);
    // 記録の pid はコンテナの中の番号（pid の名前空間が違う）——ホストから見た番号で数える
    const before = JSON.parse(readFileSync(join(runningDir, runningFiles()[0]!), "utf8")) as { sessionId: string; agentProcess?: { pid: number } };
    expect(before.agentProcess?.pid, "走っている記録にエージェントの pid が無い").toBeGreaterThan(1);
    expect(agentProcesses().agents, "試験の前提：走っているエージェントが1本").toHaveLength(1);
    const oldPid = agentProcesses().agents[0]!;
    expect(agentProcesses().children.filter((c) => c.includes(before.sessionId)), "試験の前提：エージェントの子").toHaveLength(1);

    // ---- host が落ちて、起き直す --------------------------------------------------------------------------
    await host.stop("SIGKILL");
    // 落ちたあとも、前の走行のエージェントと子はコンテナの中に残っている（実測——これを続ける前に止める）
    await new Promise((r) => setTimeout(r, 2_000));
    expect(agentProcesses().agents, "host が落ちたらエージェントも消えた（試験の前提が崩れた）").toContain(oldPid);
    await host.start();

    // Subagent が続けると答えた（札は返事待ちのまま、続けると答えた時刻が付く）
    await expect
      .poll(async () => (await thread()).awaitingReplies?.map((r) => Boolean(r.keptAt)), { timeout: 120_000, message: "続けると答えない" })
      .toEqual([true]);
    // 続けている間、サイドバーに「起こし直しのあと続けています」
    const line = page.locator('[data-sidebar="sidebar"]').getByTestId("thread-background");
    await expect(line, "起き直したあとバックグラウンドの印が出ない").toHaveText("fake に頼んだ仕事", { timeout: 60_000 });
    await line.click();
    const item = page.getByTestId("background-list").getByTestId("background-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("fake に頼んだ仕事");
    await expect(item.getByTestId("background-item-kept")).toHaveText(/^起こし直しのあと続けています（(いま|\d+分前)から）$/);
    // 続けている間：前の走行のエージェントと子は居ない。居るのは続けた1本だけ
    await expect.poll(() => agentProcesses().agents.length, { timeout: 30_000, message: "続けたエージェントが走っていない" }).toBe(1);
    const now = agentProcesses();
    expect(now.agents, "前の走行のエージェントが残っている（同じ会話を2本が書く）").not.toContain(oldPid);
    expect(now.children.filter((c) => c.includes(before.sessionId)), "前の走行のエージェントの子が残っている").toEqual([]);
    await page.keyboard.press("Escape");

    // ---- 同じ札で結果が届き、AI が起きる ------------------------------------------------------------------
    await expect
      .poll(async () => (await thread()).messages.filter((m) => m.origin?.from === "subagent").map((m) => m.origin!.title), {
        timeout: 120_000,
        message: "結果が届かない",
      })
      .toEqual(["Fake Agent（試験用） の仕事が終わりました"]);
    const done = await thread();
    const delivered = done.messages.find((m) => m.origin?.from === "subagent")!;
    expect(delivered.text).toContain(
      "受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 60——結果は分かりません",
    );
    expect(delivered.text).toContain('"resumedAfterRestart":true');
    expect(done.messages.some((m) => /途中で終わりました/.test(m.origin?.title ?? "")), "「途中で終わりました」も届いた").toBe(false);
    await expect.poll(async () => (await thread()).lastTurn, { timeout: 60_000 }).toMatchObject({ cause: "delivery", outcome: "completed" });
    expect((await thread()).awaitingReplies ?? []).toEqual([]);
    expect(runningFiles(), "届けたのに走っている記録が残っている").toEqual([]);
    expect(host.log()).toMatch(/前の走行の返事待ち（subagent・Thread [^）]+）→ 続けると答えた/);

    // 画面：届いたものの札に、続けた結果が出る。バックグラウンドの印は消える
    const card = page.getByTestId("delivered-message").filter({ hasText: "subagent から届きました" });
    await expect(card, "届いたものが画面に出ない").toHaveCount(1, { timeout: 60_000 });
    await expect(card).toContainText("Fake Agent（試験用） の仕事が終わりました");
    await expect(line, "届いたのにバックグラウンドの印が残っている").toHaveCount(0, { timeout: 30_000 });
  });
});

// **Module が中継で頼んだ仕事も続ける**（追加・2026-10-05、決定——Factory が中継で頼んだ Subagent の仕事が起こし直しで
// 必ず失われないように。アーキ仕様 §2.5「2.」・§4.2「Module 宛ての返事」）。Factory と同じ形の試験用 Module
// （`fixtures/relay-caller-module`）が待たずに頼んだ仕事の途中で host を落とし、起き直したら、返事が「途中で終わりました」
// ではなく続けた結果として**呼んだ Module の受け口**に届く（同じ返事の印）。頼んだ Thread には何も届かない
test("Module が中継で待たずに頼んだサブエージェントの仕事も、host が落ちて起き直したら続いて、呼んだ Module に結果が届く", async ({ page }) => {
  const MODULE = `e2e-relay-${Date.now()}`;
  const NAME = "E2E Subagent Resume From Module";
  const SERVER = join(import.meta.dirname, "../fixtures/relay-caller-module/server.js");
  await withOwnHost(async (host) => {
    const h = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const added = await fetch(`${host.apiUrl}/api/modules`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        name: MODULE,
        launch: { command: "${nodeExec}", args: [SERVER], env: { BANTO_HOST_MCP_URL: "${hostRelayUrl}", BANTO_HOST_MCP_TOKEN: "${hostRelayToken}" } },
        // 呼び元も「起こし直しても続けられる」と名乗る——名乗らない呼び元の札は、頼んだ先に問わず「途中で終わりました」になる
        // （改訂・2026-10-05、アーキ仕様 §2.5「2.」。名乗らないときは単体 `turn-continuation.test.ts` が見る）
        meta: {
          satisfies: ["e2e-relay-caller"],
          dependsOn: [{ role: "subagent", required: true }],
          isolation: "subprocess",
          scope: "project",
          resumesAfterRestart: true,
        },
      }),
    });
    expect(added.status, `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, NAME, mkdtempSync(join(tmpdir(), "banto-e2e-subagent-resume-module-")));
    const project = (await api<Array<{ id: string; name: string }>>(host, "/api/projects")).find((p) => p.name === NAME)!;
    const threadId = (await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`))[0]!.id;
    const thread = () => api<HostThread>(host, `/api/threads/${threadId}`);
    const runningDir = join(host.dataDir, "modules", `subagent-${project.id}`, "running");
    const runningTools = () =>
      existsSync(runningDir)
        ? readdirSync(runningDir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => (JSON.parse(readFileSync(join(runningDir, f), "utf8")) as { toolsInFlight: Array<{ title: string }> }).toolsInFlight.map((t) => t.title))
        : [];
    const replies = async () => {
      const res = await fetch(`${host.apiUrl}/api/projects/${project.id}/ui-tool-call`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ server: MODULE, tool: "listReplies", arguments: {} }),
      });
      if (!res.ok) return [];
      const outer = (await res.json()) as { content?: { text: string }[] };
      return JSON.parse(outer.content?.[0]?.text ?? "[]") as Array<{ replyId: string; text: string; final: boolean; lost: boolean }>;
    };

    // ---- Module 経由で待たずに頼む（中継の承認が会話に出る）--------------------------------------------------
    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill(
      "Module 経由で頼んで。" +
        fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: MODULE, name: "delegate", args: { prompt: "[child 120] [slow 60] 中継で頼んだ仕事", background: true } }] }),
    );
    await composer.press("Enter");
    await expect(async () => {
      const allow = page.getByRole("button", { name: "許可する" });
      if ((await allow.count()) > 0) await allow.last().click();
      expect((await thread()).lastTurn?.outcome).toBe("completed");
    }).toPass({ timeout: 200_000, intervals: [1000] });
    const said = (await thread()).messages.filter((m) => m.role === "assistant").at(-1)!.text;
    const replyId = (JSON.parse(said.slice(said.indexOf("{"))) as { replyId?: string }).replyId;
    expect(replyId, `返事の印が呼んだ Module に見えない：${said}`).toMatch(/^rid_/);
    await expect.poll(runningTools, { timeout: 60_000, message: "走っている仕事の記録に tool が残らない" }).toEqual([["sleep 60"]]);
    expect(agentProcesses().agents, "試験の前提：走っているエージェントが1本").toHaveLength(1);
    const oldPid = agentProcesses().agents[0]!;

    // ---- host が落ちて、起き直す --------------------------------------------------------------------------
    await host.stop("SIGKILL");
    await host.start();

    // 呼んだ Module の受け口に、続けた結果が届く（同じ返事の印・lost ではない）
    await expect
      .poll(async () => (await replies()).filter((r) => r.replyId === replyId), { timeout: 120_000, message: "返事が呼んだ Module に届かない" })
      .toHaveLength(1);
    const [got] = (await replies()).filter((r) => r.replyId === replyId);
    expect(got).toMatchObject({ final: true, lost: false });
    expect(got!.text).toContain("受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 60");
    expect(host.log()).toMatch(new RegExp(`前の走行の返事待ち（subagent・呼び元 ${MODULE}）→ 続けると答えた`));
    // 頼んだ Thread には何も届かない。前の走行のエージェントは残っていない
    expect((await thread()).messages.filter((m) => m.origin).map((m) => m.origin!.from)).toEqual([]);
    expect(agentProcesses().agents, "前の走行のエージェントが残っている").not.toContain(oldPid);
    expect(runningTools(), "届けたのに走っている記録が残っている").toEqual([]);
  });
});
