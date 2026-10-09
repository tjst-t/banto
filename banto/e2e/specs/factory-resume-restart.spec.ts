// **Factory の1件が実装の段の途中で host が落ちても、起き直したら流し直して最後まで進む**（追加・2026-10-07、Backlog の
// resume-factory。v4-modules.md §4.5「記録と再開」・アーキ仕様 §2.5「起こし直しをまたいで続ける」の「2.」）。
//
// 自前の host（`own-host.ts`）で、本物の Subagent・Backlog・Factory を Project のコンテナで動かし、エージェントだけ偽物
// （`factory.spec.ts` と同じ組み立て）。実装役のサブエージェントが tool の途中（sleep）のところで host を SIGKILL で落とし、
// 起こし直す。見るもの（規則14）：
//   - 起き直した host が Factory（頼んだ Thread 宛ての札）と Subagent（Factory 宛ての札）に問い、両方「続ける」と答える
//   - 前の走行のエージェントとその子は止まり、居るのは続けた1本だけ。続けた結果が**同じ返事の印で** Factory の受け口に
//     届く（lost ではない）
//   - Factory が記録から流し直し、終わった段を繰り返さず（どの段も「始めた」は1回・実装役に頼んだのは1回）、テスト・
//     レビュー・マージまで進む。Backlog が done・main に入る・worktree とブランチが片づく
//   - 頼んだ Thread に最後の知らせ（「Factory の実行が終わりました」）が届き、札は片づく。「途中で終わりました」・
//     「止まりました」は届かない
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { createProject, openApp, fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(480_000);

const PROJECT_NAME = "E2E Factory Resume";
const TASK = "e2e-resume";
// 実装役の最初の頼み：子を起こし（claude-agent-acp が CLI を子で起こすのと同じ形）、tool を1つ始めて長く待つ。続けたとき
// （同じ会話の次の頼み）は 8 秒の tool のあとコミットする。レビュー役の頼みには [slow]・[child] は効かない（fake-agent）
const BODY = "[child 300] [slow 600] [then-slow 8] [then-commit resumed.txt]";

interface HostMessage {
  seq: number;
  role: string;
  text: string;
  origin?: { from: string; title: string };
}
interface HostThread {
  messages: HostMessage[];
  awaitingReplies?: Array<{ moduleName: string; keptAt?: string }>;
  lastTurn?: { cause: string; outcome?: string };
}

/** この worktree の偽のエージェントと、その子（会話の id つき）。ホストから見える（コンテナはカーネルを分けない） */
/**
 * そのプロセスがその Project のコンテナ（`banto-<id>`）の中で動いているか。`/proc/<pid>/cwd` や environ はコンテナの
 * 中のプロセスだと読めない（EACCES、実測）が、cgroup は読める——コンテナの中のものは `lxc.payload.banto-<id>` の下にある
 */
function inProjectContainer(pid: number, projectId: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(`banto-${projectId}`);
  } catch {
    return false;
  }
}

function agentProcesses(projectId: string): { agents: number[]; children: string[] } {
  const lines = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n");
  const here = join(import.meta.dirname, "..", "..");
  return {
    // **この Project の分だけ数える**（2026-10-09、並列化）。機械全体の ps なので、もう1つの worker が同時に走らせている
    // エージェントまで数えて「1本のはずが2本」で落ちていた
    agents: lines
      .filter((l) => l.includes(`${here}/packages/modules/subagent/dist/testing/fake-agent.js`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => inProjectContainer(pid, projectId)),
    children: lines.filter((l) => l.includes("fake-agent-child")).map((l) => l.trim()),
  };
}

async function api<T>(host: OwnHost, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`${path} が ${res.status}：${await res.text()}`);
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

test("Factory の1件が実装の段の途中で host が落ちても、起き直したら流し直して Subagent の返事を受け、main まで進む", async ({ page }) => {
  await withOwnHost(async (host) => {
    for (const id of ["backlog", "factory"]) await api(host, `/api/modules/catalog/${id}`, { method: "POST", body: JSON.stringify({ name: id }) });
    const root = mkdtempSync(join(tmpdir(), "banto-e2e-factory-resume-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "README"), "e2e\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, PROJECT_NAME, root);
    const project = (await api<Array<{ id: string; name: string }>>(host, "/api/projects")).find((p) => p.name === PROJECT_NAME)!;
    const threadId = (await api<Array<{ id: string }>>(host, `/api/projects/${project.id}/threads`))[0]!.id;
    const thread = () => api<HostThread>(host, `/api/threads/${threadId}`);
    const delivered = async () => (await thread()).messages.filter((m) => m.origin).map((m) => `${m.origin!.from}：${m.origin!.title}`);
    for (const m of ["subagent", "backlog", "factory"]) {
      await expect
        .poll(
          async () => {
            const modules = await api<Array<{ name: string; connected?: boolean; error?: string }>>(host, `/api/projects/${project.id}/modules`);
            const target = modules.find((x) => x.name === m);
            return target?.connected === true ? "ok" : (target?.error ?? "まだ繋がっていない");
          },
          { timeout: 120_000, message: `${m} が立ち上がらない` },
        )
        .toBe("ok");
    }
    const uiCall = async (server: string, tool: string, args: Record<string, unknown>) => {
      const body = await api<{ content?: { text: string }[]; isError?: boolean }>(host, `/api/projects/${project.id}/ui-tool-call`, {
        method: "POST",
        body: JSON.stringify({ server, tool, arguments: args }),
      });
      expect(body.isError, `${server}.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
      return body.content?.[0]?.text ?? "";
    };
    const backlogStatus = () =>
      (JSON.parse(git("show", "backlog:tasks.json")) as { items: Array<{ id: string; status: string }> }).items.find((i) => i.id === TASK)?.status;
    const subagentRunning = join(host.dataDir, "modules", `subagent-${project.id}`, "running");
    const runningRecords = () =>
      existsSync(subagentRunning)
        ? readdirSync(subagentRunning)
            .filter((f) => f.endsWith(".json"))
            .map((f) => JSON.parse(readFileSync(join(subagentRunning, f), "utf8")) as { id: string; sessionId?: string; toolsInFlight: Array<{ title: string }> })
        : [];
    const factoryData = join(host.dataDir, "modules", `factory-${project.id}`);
    const moduleReplies = () => {
      const file = join(host.dataDir, "delivery", "module-replies.json");
      return existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { awaiting: Array<{ replyId: string; toModule: string }>; pending: Array<{ toConn: string }> })
        : { awaiting: [], pending: [] };
    };

    await uiCall("factory", "setSettings", {
      settings: { testCommand: "test -f resumed.txt", implementer: { agent: "fake" }, reviewer: { agent: "fake" } },
    });
    await uiCall("backlog", "boardCreateItem", { id: TASK, kind: "task", title: "続きから入れる", body: BODY, status: "ready" });

    // ---- AI が runFactory で流す（承認はその会話で出る）---------------------------------------------------------
    const composer = page.getByPlaceholder(/に送る/);
    await composer.fill(
      "Factory で流して。" + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: "factory", name: "runFactory", args: { items: [TASK] } }] }),
    );
    await composer.press("Enter");
    await expect(async () => {
      const allow = page.getByRole("button", { name: "許可する" });
      if ((await allow.count()) > 0) await allow.last().click();
      expect((await thread()).lastTurn?.outcome).toBe("completed");
    }).toPass({ timeout: 240_000, intervals: [1000] });
    const said = (await thread()).messages.filter((m) => m.role === "assistant").at(-1)!.text;
    expect(said, `流せていない：${said}`).toContain("流しました");
    const { runId } = JSON.parse(said.slice(said.indexOf("{"))) as { runId: string };
    const journalFile = join(factoryData, "runs", runId, `${TASK}.jsonl`);

    // 実装役の仕事が tool の途中まで進んだ。Thread は Factory の札を、Factory は Subagent の返事を待っている
    await expect
      .poll(() => runningRecords().map((r) => r.toolsInFlight.map((t) => t.title)), { timeout: 60_000, message: "実装役の仕事が tool まで進まない" })
      .toEqual([["sleep 600"]]);
    const [record] = runningRecords();
    expect((await thread()).awaitingReplies?.map((r) => r.moduleName)).toEqual(["factory"]);
    expect(backlogStatus()).toBe("in-progress");
    const launchedBefore = readFileSync(journalFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { n: number; phase: string; key?: string; replyId?: string });
    const implementerReplyId = launchedBefore.find((l) => l.phase === "launched")?.replyId;
    expect(implementerReplyId, "実装役に頼んだ返事の印が記録に無い").toMatch(/^rid_/);
    expect(moduleReplies().awaiting.map((a) => [a.toModule, a.replyId]), "host が Factory 宛ての返事待ちを残していない").toEqual([["factory", implementerReplyId]]);
    expect(agentProcesses(project.id).agents, "試験の前提：走っているエージェントが1本").toHaveLength(1);
    const oldPid = agentProcesses(project.id).agents[0]!;
    expect(agentProcesses(project.id).children.filter((c) => c.includes(record!.sessionId!)), "試験の前提：エージェントの子").toHaveLength(1);

    // ---- host が落ちて、起き直す --------------------------------------------------------------------------
    await host.stop("SIGKILL");
    await new Promise((r) => setTimeout(r, 2_000));
    expect(agentProcesses(project.id).agents, "host が落ちたらエージェントも消えた（試験の前提が崩れた）").toContain(oldPid);
    await host.start();

    // host が Factory と Subagent に問い、両方「続ける」と答えた
    await expect
      .poll(() => host.log(), { timeout: 150_000, message: "Factory が続けると答えない" })
      .toMatch(new RegExp(`前の走行の返事待ち（factory・Thread ${threadId}）→ 続けると答えた`));
    expect(host.log()).toMatch(/前の走行の返事待ち（subagent・呼び元 factory）→ 続けると答えた/);
    expect((await thread()).awaitingReplies?.map((r) => Boolean(r.keptAt)), "Thread の札が「続けています」にならない").toEqual([true]);
    // 続けている間：前の走行のエージェントと子は居ない。居るのは続けた1本だけ
    await expect.poll(() => agentProcesses(project.id).agents.length, { timeout: 60_000, message: "続けたエージェントが走っていない" }).toBe(1);
    const now = agentProcesses(project.id);
    expect(now.agents, "前の走行のエージェントが残っている（同じ会話を2本が書く）").not.toContain(oldPid);
    expect(now.children.filter((c) => c.includes(record!.sessionId!)), "前の走行のエージェントの子が残っている").toEqual([]);

    // ---- 流し直して最後まで進み、頼んだ Thread に最後の知らせが届く ----------------------------------------------
    await expect
      .poll(delivered, { timeout: 180_000, message: "終わったことが会話に届かない" })
      .toContainEqual("factory：Factory の実行が終わりました（取り込み 1／1 件）");
    const titles = await delivered();
    expect(titles, "最後の知らせのほかに届いたものがある（途中で終わりました・止まりました）").toEqual([
      "factory：Factory の実行が終わりました（取り込み 1／1 件）",
    ]);
    // 最後の知らせの中身：その実行の1件が取り込まれた（done）
    const finalText = (await thread()).messages.find((m) => m.origin?.from === "factory")!.text;
    const finalBody = JSON.parse(finalText.slice(finalText.indexOf("{"), finalText.lastIndexOf("}") + 1)) as {
      runId: string;
      items: Array<{ task: string; status: string; stage: string; result?: string }>;
    };
    expect(finalBody.runId).toBe(runId);
    expect(finalBody.items.map((i) => [i.task, i.status, i.stage, i.result])).toEqual([[TASK, "done", "終わった", "取り込みました"]]);
    await expect.poll(async () => (await thread()).lastTurn, { timeout: 60_000 }).toMatchObject({ cause: "delivery", outcome: "completed" });
    expect((await thread()).awaitingReplies ?? [], "最後の知らせのあとも札が残っている").toEqual([]);

    // Subagent の返事は同じ印で、続けた結果として Factory の受け口に届いた
    const reply = JSON.parse(readFileSync(join(factoryData, "replies", `${implementerReplyId}.json`), "utf8")) as { final: boolean; lost: boolean; text: string };
    expect(reply).toMatchObject({ final: true, lost: false });
    expect(reply.text).toContain('"resumedAfterRestart":true');
    expect(reply.text).toContain("受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 600");
    expect(runningRecords(), "届けたのに走っている記録が残っている").toEqual([]);
    // host の返事待ち・渡す前の返事に Factory 宛てのものが残っていない（レビュー役の返事も渡し終えた）
    const { awaiting, pending } = moduleReplies();
    expect({ awaiting, pending }, "Factory 宛ての返事待ちか渡す前の返事が残っている").toEqual({ awaiting: [], pending: [] });

    // 終わった段は繰り返していない：どの段も「始めた」は1回、実装役に頼んだのは1回（レビュー役も1回）
    const lines = readFileSync(journalFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { n: number; phase: string; key?: string; replyId?: string });
    const starts = lines.filter((l) => l.phase === "start");
    expect(new Set(starts.map((l) => l.n)).size, "同じ番号の段を2回始めた").toBe(starts.length);
    expect(starts.map((l) => l.key)).toEqual([
      "stage:始める",
      "backlog:in-progress",
      "worktree",
      "stage:実装",
      "agent:implementer",
      "commits-ahead",
      "stage:テスト",
      "test",
      "stage:レビュー",
      "agent:reviewer",
      "stage:マージ",
      "rebase",
      "test",
      "fast-forward",
      "backlog:done",
      "cleanup",
    ]);
    const launched = lines.filter((l) => l.phase === "launched");
    expect(launched, "サブエージェントに頼み直した").toHaveLength(2);
    expect(launched[0]!.replyId).toBe(implementerReplyId);
    expect(lines.filter((l) => l.phase === "end").every((l) => (l as { ok?: boolean }).ok), "失敗した段がある").toBe(true);

    // main に入り、Backlog が done、worktree とブランチが片づいた
    expect(existsSync(join(root, "resumed.txt")), "main（Project の作業ツリー）に入っていない").toBe(true);
    expect(git("log", "--format=%s", "main")).toContain("fake: resumed.txt");
    expect(backlogStatus()).toBe("done");
    expect(existsSync(join(root, ".worktrees", `factory-${TASK}`)), "worktree が残っている").toBe(false);
    expect(git("branch", "--list", `factory/${TASK}`).trim()).toBe("");
    const runs = JSON.parse(await uiCall("factory", "getRuns", {})) as { runs: Array<{ runId: string; finishedAt?: string; notifyErrors?: string[]; items: Array<{ status: string }> }> };
    const run = runs.runs.find((r) => r.runId === runId)!;
    expect(run.items.map((i) => i.status)).toEqual(["done"]);
    expect(run.notifyErrors ?? [], "知らせられなかったことがある").toEqual([]);
  });
});
