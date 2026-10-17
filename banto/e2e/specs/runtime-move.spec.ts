// **Project を別の実行場所へ移す**（Backlog `runtime-move-core`、`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」）。
//
// 起こし直しを見るので自前の host（`own-host.ts`）を使い、SSH で入れる相手（`ssh-host.ts`）を実行場所として登録する。
// 画面（移す先を選ぶ・押す前の画面）は Backlog `runtime-move-ui`——ここは人のセッションの API で押す。
//
// 見るもの（規則14——「移せた」で終わらせず、写した中身・記録・向こうの systemd・元に残ったものまで見る）：
//   1. 動いている Service があれば断る（見積もりにも出る）。止めれば移せる
//   2. この機械のコンテナ → 別のサーバ：移す最中のターンは 409。移したあと、同じ会話の続きでターンが通り（resume が同じ id）、
//      「移した」の知らせが会話の頭に積まれ、Shell が新しい根で動く。git の worktree が新しい根を指す。Claude の会話の記録が
//      新しい作業ディレクトリのフォルダに写る。移した先で Service は起きない（落ちて止まっていたものも、止めたものも）。元は残る
//   3. 別のサーバ → この機械のコンテナ：同じく続き、Shell が新しい根で動く。前に残した Module の置き場は退かせてある。向こうの元は残る
//   4. 写す途中で banto を落とすと、起き直したときに写しかけが片づき（移す先の根が消え、退かせた置き場は戻る）、failed が積まれ、
//      受信箱に出る。Project は元のまま
import { test, expect, type Page } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { RUNTIME_KEYS_GROUP, withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(2_400_000);

interface HostProject {
  id: string;
  root: string;
  runtime?: string;
  move?: { to: { runtime: string; root: string } };
  previousLocations?: Array<{ runtime: string; root: string }>;
}
interface HostThread {
  id: string;
  resumePoint?: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  deliveries?: Array<{ from: string; title: string; text: string }>;
}
interface MoveStatus {
  move?: unknown;
  progress?: { phase: string; copiedBytes: number; reason?: string };
}

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/** 人のセッションで（移す口は人の画面だけ） */
async function human<T>(page: Page, host: OwnHost, method: "GET" | "POST", path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await page.context().request.fetch(`${host.url}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** 人の管理操作（banto 全体の Module を画面と同じ口で呼ぶ） */
async function uiToolCall(host: OwnHost, server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{ isError?: boolean; content?: Array<{ text?: string }> }>(host, "/api/ui-tool-call", {
    method: "POST",
    body: { server, tool, arguments: args },
  });
  const text = r.body?.content?.[0]?.text ?? "";
  expect(r.status, `${server} の ${tool}：${JSON.stringify(r.body).slice(0, 500)}`).toBe(200);
  expect(r.body.isError, `${server} の ${tool}：${text}`).not.toBe(true);
  return text;
}

/** AI が通る経路そのもの（代理サーバ）で、その Project の Module の tool を呼ぶ */
async function callTool(
  host: OwnHost,
  connName: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectId: string; threadId: string },
): Promise<{ text: string; isError: boolean }> {
  const client = new Client({ name: "e2e-runtime-move", version: "0.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${host.apiUrl}/agent-relay/${connName}`), {
      requestInit: {
        headers: { authorization: `Bearer ${host.token}`, "x-banto-project-id": ctx.projectId, "x-banto-thread-id": ctx.threadId },
      },
    }),
  );
  try {
    const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
  } finally {
    await client.close();
  }
}

/** ターンを1本最後まで（承認は聞かない形で）。SSE の終わりまで読む */
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<string> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
  return text;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

test("この機械のコンテナと別のサーバのあいだで Project を移せ、続きのターンが通り、動いている Service は断り、写す途中で落ちたら片づく", async ({ page }) => {
  const name = `mv-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-mv-${Date.now()}`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-")));
  const backRoot = join(dirname(root), `banto-e2e-move-back-${randomBytes(3).toString("hex")}`);
  writeFileSync(join(root, "hello.txt"), "元の機械で書いた\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "deep.txt"), "深いところ\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "最初"]);
  git(root, ["worktree", "add", "-q", "-b", "wt", ".worktrees/wt"]);
  try {
    await withSshHost(async (sshHost: SshHost) => {
      const remoteHome = `/home/${sshHost.user}`;
      const remoteRoot = `${remoteHome}/work/moved`;
      await withOwnHost(
        async (own) => {
          const claudeDir = join(dirname(own.dataDir), "claude");
          // ---- 実行場所の登録と Project（登録の画面は remote-runtime-registry.spec.ts で見ている） ----------------
          await uiToolCall(own, "vault-directory", "createAlias", {
            implementation: "vault-local",
            name: alias,
            kind: "ssh-identity",
            group: RUNTIME_KEYS_GROUP,
            value: readFileSync(sshHost.identityFile, "utf8"),
            note: "E2E の SSH の相手",
          });
          const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
          const scanned = await api<{ hostKey: unknown }>(own, "/api/runtimes/scan", { method: "POST", body: target });
          expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
          const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
          expect(registered.status, JSON.stringify(registered.body)).toBe(201);
          expect((await api(own, "/api/modules/catalog/service", { method: "POST", body: { name: "service" } })).status).toBeLessThan(300);
          const created = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: `E2E 移す ${name}`, root } });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          const projectId = created.body.id;
          const threadRes = await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" });
          const threadId = threadRes.body.id;
          const ctx = { projectId, threadId };
          const project = async () => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === projectId)!;
          const thread = async () => (await api<HostThread>(own, `/api/threads/${threadId}`)).body;
          const status = async () => (await human<MoveStatus>(page, own, "GET", `/api/projects/${projectId}/runtime-move`)).body;
          const waitMoved = async (runtime: string) => {
            await expect
              .poll(async () => {
                const p = await project();
                if (p.move) return `移している途中（${JSON.stringify((await status()).progress)}）`;
                return p.runtime ?? "host-container";
              }, { timeout: 900_000, intervals: [2000], message: "移し終わらない" })
              .toBe(runtime);
          };
          const events = () => readFileSync(join(own.dataDir, "events.jsonl"), "utf8");

          await login(page, own);

          // 最初の会話（この会話を移したあとも続ける）
          await sendTurn(own, threadId, `はじめまして。${fakeTurn({ say: "はじめまして。" })}`);
          const session = (await thread()).resumePoint!;
          expect(session, "会話の id ができていない").toBeTruthy();
          // CLI の記録の置き場に、この会話の記録があるとする（偽の Runner は書かない）。移すときに写るかを見る
          const records = (cwd: string) => join(claudeDir, "projects", encode(cwd));
          mkdirSync(join(records(root), session, "subagents"), { recursive: true });
          writeFileSync(join(records(root), `${session}.jsonl`), '{"note":"会話の記録"}\n');
          writeFileSync(join(records(root), session, "subagents", "agent-1.jsonl"), "{}\n");
          writeFileSync(join(records(root), "someone-else.jsonl"), "{}\n");

          // ---- 1. 動いている Service があれば断る ---------------------------------------------------------
          // 入れ子のコンテナでは logind に繋がらない——ユーザーの systemd を root で起こしておく（e2e の罠）
          const um = await callTool(own, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
          expect(um.isError, um.text).toBe(false);
          const ticker = await callTool(own, `service-${projectId}`, "startService", { name: "ticker", command: "while true; do sleep 1; done" }, ctx);
          expect(ticker.isError, ticker.text).toBe(false);
          // 落ちて止まったもの（自動起動のまま）：動いてはいないので移せるが、移した先で起きてはいけない
          const crasher = await callTool(own, `service-${projectId}`, "startService", { name: "crasher", command: "exit 3" }, ctx);
          expect(crasher.isError, crasher.text).toBe(false);
          await expect
            .poll(async () => {
              const r = await callTool(own, `service-${projectId}`, "listServices", {}, ctx);
              return (JSON.parse(r.text) as { services: Array<{ name: string; state: string }> }).services.map((s) => `${s.name}:${s.state}`);
            }, { timeout: 60_000 })
            .toEqual(["crasher:crashed", "ticker:running"]);

          const toRemote = { runtime: `remote:${name}`, root: "~/work/moved" };
          const estimate = await human<{ running: Array<{ kind: string; label: string }>; blockers: string[]; size: { files: number }; copiesClaudeRecords: boolean; notMoved: string[]; rebuild: string[] }>(
            page,
            own,
            "GET",
            `/api/projects/${projectId}/runtime-move/estimate?runtime=${encodeURIComponent(toRemote.runtime)}&root=${encodeURIComponent(toRemote.root)}`,
          );
          expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
          expect(estimate.body.running.map((r) => r.label)).toEqual(["Service「ticker」が動いています"]);
          expect(estimate.body.blockers.join("／")).toContain("動いているものがあります");
          expect(estimate.body.size.files, "写す件数が数えられていない").toBeGreaterThan(3);
          expect(estimate.body.copiesClaudeRecords).toBe(true);
          expect(estimate.body.notMoved.join("・")).toContain("Docker のイメージ");
          const refused = await human<{ error: string }>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, toRemote);
          expect(refused.status).toBe(409);
          expect(refused.body.error).toContain("Service「ticker」が動いています");
          expect((await project()).move, "断ったのに移し始めた").toBeUndefined();
          // 機械の合言葉では押せない（人の画面だけ）
          expect((await api(own, `/api/projects/${projectId}/runtime-move`, { method: "POST", body: toRemote })).status).toBe(403);

          const stopped = await callTool(own, `service-${projectId}`, "stopService", { name: "ticker" }, ctx);
          expect(stopped.isError, stopped.text).toBe(false);

          // ---- 2. この機械のコンテナ → 別のサーバ ------------------------------------------------------------
          const started = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, toRemote);
          expect(started.status, JSON.stringify(started.body)).toBe(202);
          expect(started.body.move?.to).toEqual({ runtime: toRemote.runtime, root: remoteRoot });
          // 移す最中のターンは 409（理由つき）
          const during = await api<{ error: string; code: string }>(own, `/api/threads/${threadId}/messages`, { method: "POST", body: { prompt: "いま送る" } });
          expect(during.status).toBe(409);
          expect(during.body.code).toBe("project-moving");
          await waitMoved(toRemote.runtime);
          expect((await status()).progress?.phase).toBe("done");
          const moved = await project();
          expect(moved.root).toBe(remoteRoot);
          expect(moved.previousLocations).toEqual([expect.objectContaining({ runtime: "host-container", root })]);
          expect(events()).toContain('"type":"project.runtime_move_started"');
          expect(events()).toContain('"type":"project.runtime_moved"');

          // 写した中身：ファイル・git・worktree が新しい根を指す
          expect((await sshHost.ssh(`cat ${remoteRoot}/hello.txt ${remoteRoot}/sub/deep.txt`)).stdout).toBe("元の機械で書いた\n深いところ\n");
          expect((await sshHost.ssh(`git -C ${remoteRoot} log --format=%s`)).stdout.trim()).toBe("最初");
          expect((await sshHost.ssh(`cat ${remoteRoot}/.git/worktrees/wt/gitdir`)).stdout.trim()).toBe(`${remoteRoot}/.worktrees/wt/.git`);
          expect((await sshHost.ssh(`git -C ${remoteRoot}/.worktrees/wt rev-parse --abbrev-ref HEAD`)).stdout.trim()).toBe("wt");
          // 元は残る
          expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("元の機械で書いた\n");
          expect(readdirSync(join(own.dataDir, "modules")).filter((n) => n.endsWith(projectId)), "元の Module の置き場が消えた").toEqual(
            expect.arrayContaining([`shell-${projectId}`, `service-${projectId}`]),
          );
          // Claude の会話の記録：この会話の分だけ、新しい作業ディレクトリ（host の Project ごとの空のフォルダ）のフォルダへ
          const runnerCwd = join(own.dataDir, "runner-cwd", projectId);
          expect(readFileSync(join(records(runnerCwd), `${session}.jsonl`), "utf8")).toBe('{"note":"会話の記録"}\n');
          expect(existsSync(join(records(runnerCwd), session, "subagents", "agent-1.jsonl"))).toBe(true);
          expect(existsSync(join(records(runnerCwd), "someone-else.jsonl")), "人の別の会話まで写した").toBe(false);
          expect(existsSync(join(records(root), `${session}.jsonl`)), "元の記録が消えた").toBe(true);

          // 「移した」の知らせが会話に届いて（まだ積んでいない）、次のターンの頭に積まれる
          const pending = (await thread()).deliveries ?? [];
          expect(pending.map((d) => d.from)).toEqual(["banto"]);
          expect(pending[0]!.text).toContain(`root は ${remoteRoot} になりました`);
          expect(pending[0]!.text).toContain("Service は止めてあります");

          // 続きのターン：同じ会話を続け、Shell は新しい根で動く（初回は向こうへコードを送る）
          await sendTurn(
            own,
            threadId,
            `続けて。${fakeTurn({ saySession: true, tools: [{ server: "shell", name: "runCommand", args: { command: "pwd > where.txt" } }], then: "向こうで続けました。" })}`,
          );
          const afterRemote = await thread();
          const tail = afterRemote.messages.slice(-3);
          expect(tail.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual(["delivered:banto", "user", "assistant"]);
          expect(tail[0]!.text).toContain(`root は ${remoteRoot} になりました`);
          expect(tail[2]!.text, "同じ会話の続きになっていない").toContain(`resume=${session}`);
          expect(tail[2]!.text).toContain("向こうで続けました。");
          expect((await sshHost.ssh(`cat ${remoteRoot}/where.txt`)).stdout.trim(), "Shell が新しい根で動いていない").toBe(remoteRoot);

          // 移した先で Service は起きない（落ちて止まっていたものも止めたものも、止めておきたいのまま）
          const remoteServices = await callTool(own, `service-${projectId}`, "listServices", {}, ctx);
          expect(remoteServices.isError, remoteServices.text).toBe(false);
          const listed = (JSON.parse(remoteServices.text) as { services: Array<{ name: string; desired: string; state: string }> }).services;
          expect(listed.map((s) => `${s.name}:${s.desired}`)).toEqual(["crasher:stopped", "ticker:stopped"]);
          const units = await sshHost.ssh(
            `XDG_RUNTIME_DIR=/run/user/${sshHost.uid} systemctl --user list-units --no-legend --plain --state=active,activating 'banto-*' | awk '{print $1}'`,
          );
          expect(units.stdout.split("\n").filter((u) => /^banto-(ticker|crasher)/.test(u)), "移した先で Service が起きた").toEqual([]);

          // 画面にも、知らせと続きが出る
          await openApp(page, own.url);
          await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
          await expect(page.getByTestId("delivered-message").last()).toContainText("Project を別の実行場所へ移しました", { timeout: 30_000 });
          await expect(page.locator('[data-role="assistant"]').last()).toContainText(`resume=${session}`);

          // ---- 3. 別のサーバ → この機械のコンテナ（新しいフォルダへ） ------------------------------------------
          const back = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
            runtime: "host-container",
            root: backRoot,
          });
          expect(back.status, JSON.stringify(back.body)).toBe(202);
          await waitMoved("host-container");
          expect((await project()).root).toBe(backRoot);
          expect(readFileSync(join(backRoot, "where.txt"), "utf8").trim()).toBe(remoteRoot);
          expect(git(backRoot, ["log", "--format=%s"])).toBe("最初");
          expect(readFileSync(join(backRoot, ".git", "worktrees", "wt", "gitdir"), "utf8").trim()).toBe(`${backRoot}/.worktrees/wt/.git`);
          // 前に残した Module の置き場は退かせてある（消さない）
          const hostModules = readdirSync(join(own.dataDir, "modules"));
          expect(hostModules.some((n) => n.startsWith(`shell-${projectId}.before-`)), "残っていた置き場を退かせていない").toBe(true);
          // 向こうの元は残る
          expect((await sshHost.ssh(`cat ${remoteRoot}/hello.txt`)).stdout).toBe("元の機械で書いた\n");
          // Claude の会話の記録は新しい根のフォルダへ
          expect(existsSync(join(records(backRoot), `${session}.jsonl`)), "戻したときに会話の記録を写していない").toBe(true);

          await sendTurn(
            own,
            threadId,
            `戻って続けて。${fakeTurn({ saySession: true, tools: [{ server: "shell", name: "runCommand", args: { command: "pwd > where-back.txt" } }], then: "戻って続けました。" })}`,
          );
          const afterBack = await thread();
          const backTail = afterBack.messages.slice(-3);
          expect(backTail[0]!.origin?.from).toBe("banto");
          expect(backTail[0]!.text).toContain(`root は ${backRoot} になりました`);
          expect(backTail[2]!.text, "戻したあと同じ会話の続きになっていない").toContain(`resume=${session}`);
          expect(readFileSync(join(backRoot, "where-back.txt"), "utf8").trim(), "Shell が戻した根で動いていない").toBe(backRoot);

          // ---- 4. 写す途中で banto を落とすと、起き直したときに片づく -------------------------------------------
          // 戻したコンテナは起こし直されている——Service を止めておくのにユーザーの systemd が要る（入れ子では root で起こす）
          const um2 = await callTool(own, `shell-${projectId}`, "runCommand", { command: "sudo -n systemctl start user@$(id -u).service" }, ctx);
          expect(um2.isError, um2.text).toBe(false);
          writeFileSync(join(backRoot, "big.bin"), randomBytes(48 * 1024 * 1024));
          const second = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
            runtime: `remote:${name}`,
            root: "~/work/moved-again",
          });
          expect(second.status, JSON.stringify(second.body)).toBe(202);
          await expect
            .poll(async () => {
              const p = (await status()).progress;
              return p?.phase === "copying" && p.copiedBytes > 8 * 1024 * 1024 ? "copying" : JSON.stringify(p);
            }, { timeout: 300_000, intervals: [500], message: "写し始めない" })
            .toBe("copying");
          // 落とす前：移す先の根はできていて、向こうに残っていた Module の置き場（1回目に写したもの）は退かせてある
          expect((await sshHost.ssh(`test -d ${remoteHome}/work/moved-again && echo ある`)).stdout.trim()).toBe("ある");
          expect((await sshHost.ssh(`ls -1 ${remoteHome}/.local/share/banto-remote/*/modules`)).stdout).toContain(`shell-${projectId}.before-`);
          await own.stop("SIGKILL");
          await own.start();
          await expect
            .poll(async () => ((await project()).move ? "移している途中のまま" : "片づいた"), { timeout: 300_000, intervals: [1000] })
            .toBe("片づいた");
          const after = await project();
          expect(after.runtime).toBe("host-container");
          expect(after.root).toBe(backRoot);
          expect(events()).toMatch(/"type":"project\.runtime_move_failed".*途中で止まりました/);
          // 写しかけの根は消え、退かせた Module の置き場は戻った
          expect((await sshHost.ssh(`test -e ${remoteHome}/work/moved-again && echo 残っている || echo 無い`)).stdout.trim()).toBe("無い");
          const remoteModules = (await sshHost.ssh(`ls -1 ${remoteHome}/.local/share/banto-remote/*/modules`)).stdout;
          expect(remoteModules).toContain(`shell-${projectId}\n`);
          expect(remoteModules, "退かせた置き場を戻していない").not.toContain(".before-");
          // 受信箱に出る
          await expect
            .poll(async () =>
              (await api<Array<{ title?: string; detail?: string; projectId?: string }>>(own, "/api/inbox")).body
                .filter((n) => n.projectId === projectId && /移せませんでした/.test(n.title ?? ""))
                .map((n) => n.detail ?? ""),
            )
            .toEqual([expect.stringContaining("途中で止まりました")]);
          // 元のままで会話が続く
          await sendTurn(own, threadId, `まだここ？${fakeTurn({ saySession: true })}`);
          expect((await thread()).messages.at(-1)!.text).toContain(`resume=${session}`);
        },
        // 写す途中で落とすために、写す速さを抑える（ほかの写しも遅くなるが、どれも小さい）
        { env: { BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC: String(8 * 1024 * 1024) } },
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(backRoot, { recursive: true, force: true });
  }
});
