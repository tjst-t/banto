// **前に居た場所へ戻す——差分で写す**（Backlog `move-back-rsync` #289・`move-back-stale-claude-record` #288、
// `docs/specs/v4-security.md` §1「前に居た場所へ戻す——差分で写す」）。
//
// 起こし直しを見ないが、本物の Claude の CLI を偽の Anthropic API に当てるので自前の host（`own-host.ts`）を使う
// ——偽の Runner は会話の記録を書かないので、#288（同じ根へ戻すと移す前の古い記録が勝ち、向こうで話した分を忘れる）は
// 本物の CLI でしか見えない。SSH で入れる相手（`ssh-host.ts`）を実行場所として登録する。
//
// 見るもの（規則14——「移せた」で終わらせず、写した中身・記録・モデルに届いた履歴まで見る）：
//   1. この機械（根 R）→ 別のサーバ → この機械（同じ R）と移せる。2回目は差分だけ（見積もりの差分の件数が小さい・消すものも
//      数える）。戻した R は向こうと同じ中身（足したファイルが来て、向こうで消したファイルは消える）。Module の置き場は
//      退かせない。previousLocations から R が外れ、向こうが足される
//   2. 戻ったあとのターンの要求（＝モデルが見る履歴）に、向こうで話した内容が含まれる。移す前の古い記録は退かせてある
//   3. 空でなく前に居た場所でもないフォルダは、見積もりでも押しても断られる
//   4. もう一度向こうへ移した（向こうも前に居た場所——差分で）あと、R を触ってから R へ戻そうとすると、見積もりの画面に
//      「上書きされる・消えるファイル」と承知のチェックが出て、承知なしでは押せない（HTTP も 409）。承知して押すと上書きされる
//   5. 閉じた Project の根の中へは移せる（#290——根が R の上にある閉じた Project があっても R へ戻せる）。閉じた Project の根
//      そのもの・それを含むフォルダへは断られる（写しで閉じた Project のフォルダを壊さない）
import { test, expect, type Page } from "../test-base.js";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FRONTEND_BASE_URL } from "../config.js";
import { openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { withSshHost, type SshHost } from "../ssh-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
// 初めての回は SSH の相手の土台を作り、向こうへ banto のコード（約 1GB）を送る
test.setTimeout(2_400_000);

interface HostProject {
  id: string;
  root: string;
  runtime?: string;
  move?: { to: { runtime: string; root: string } };
  previousLocations?: Array<{ runtime: string; root: string; movedAt?: string }>;
}
interface MoveStatus {
  move?: unknown;
  progress?: { phase: string; copiedBytes: number; reason?: string };
}
interface Estimate {
  blockers: string[];
  size: { files: number; bytes: number };
  returning?: {
    movedAt?: string;
    diff?: { files: number; bytes: number; deleted: number };
    overwritten: { count: number; head: string[] };
  };
}

// ── 偽の Anthropic API ────────────────────────────────────────────────────────────────────────────
// 本物の CLI が送ってきた要求（＝モデルが見る履歴）を全部とっておき、短い文で返す

interface ApiRequest {
  path: string;
  /** その要求の会話（各発言の文を1つにつないだもの） */
  messages: Array<{ role: string; text: string }>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string; content?: unknown }) =>
      b.type === "text" ? (b.text ?? "") : b.type === "tool_result" ? textOf(b.content) : "",
    )
    .join(" ");
}

async function startFakeApi(): Promise<{ url: string; requests: ApiRequest[]; seen: string[]; close: () => Promise<void> }> {
  const requests: ApiRequest[] = [];
  /** 受けた要求の全部（メソッドとパス） */
  const seen: string[] = [];
  let seq = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: unknown }> } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof body;
      } catch {
        // 本文の無い要求
      }
      const path = req.url ?? "";
      seen.push(`${req.method} ${path}`);
      if (!path.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake" } }));
        return;
      }
      if (path.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const messages = (body.messages ?? []).map((m) => ({ role: m.role, text: textOf(m.content) }));
      requests.push({ path, messages });
      const n = ++seq;
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
      const said = /合言葉は ([a-z]+-\d+)/.exec(lastUser)?.[1];
      const text = said ? `覚えました：${said}` : `ack(${messages.length})`;
      const id = `msg_fake_${n}`;
      const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("偽の API の待ち受けを読めません");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── host との口 ────────────────────────────────────────────────────────────────────────────────────

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
async function callTool(host: OwnHost, connName: string, tool: string, args: Record<string, unknown>, ctx: { projectId: string; threadId: string }) {
  const client = new Client({ name: "e2e-runtime-move-back", version: "0.0.0" }, { capabilities: {} });
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

/** ターンを1本最後まで。SSE の終わりまで読む */
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

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** 試験を流している側の Claude Code の環境（本物の CLI に持ち込まない） */
const OUTER_CLAUDE_ENV = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|ANTHROPIC_.*)$/.test(k));

test("前に居た場所へ戻すと差分で写り、向こうで話した内容を覚えていて、触った元は承知しないと上書きされない", async ({ page }) => {
  const name = `mb-${randomBytes(3).toString("hex")}`;
  const alias = `e2e-mb-${Date.now()}`;
  // R は、閉じた Project の根（base）の中に置く（5）
  const base = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-back-")));
  const root = join(base, "proj");
  mkdirSync(root);
  const other = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-move-other-")));
  writeFileSync(join(other, "someone.txt"), "ほかの人のもの\n");
  writeFileSync(join(root, "hello.txt"), "元の機械で書いた\n");
  writeFileSync(join(root, "gone.txt"), "向こうで消す\n");
  mkdirSync(join(root, "sub"));
  for (let i = 0; i < 20; i++) writeFileSync(join(root, "sub", `f${i}.txt`), `変えないファイル ${i}\n`);
  const fakeApi = await startFakeApi();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-move-back-cred-"));
  try {
    await withSshHost(async (sshHost: SshHost) => {
      const remoteRoot = `/home/${sshHost.user}/work/back`;
      await withOwnHost(
        async (own) => {
          const claudeDir = join(own.dataDir, "..", "claude");
          // ---- 実行場所の登録と Project ---------------------------------------------------------------
          await uiToolCall(own, "vault-directory", "createAlias", {
            implementation: "vault-local",
            name: alias,
            kind: "ssh-identity",
            value: readFileSync(sshHost.identityFile, "utf8"),
            note: "E2E の SSH の相手",
          });
          const target = { name, host: sshHost.address, user: sshHost.user, port: sshHost.port, identity: alias };
          const scanned = await api<{ hostKey: unknown }>(own, "/api/runtimes/scan", { method: "POST", body: target });
          expect(scanned.status, JSON.stringify(scanned.body)).toBe(200);
          const registered = await api(own, "/api/runtimes", { method: "POST", body: { runtime: target, hostKey: scanned.body.hostKey } });
          expect(registered.status, JSON.stringify(registered.body)).toBe(201);
          const projectName = `E2E 戻す ${name}`;
          const created = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: projectName, root } });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          const projectId = created.body.id;
          const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
          const ctx = { projectId, threadId };
          const project = async () => (await api<HostProject[]>(own, "/api/projects")).body.find((p) => p.id === projectId)!;
          const status = async () => (await human<MoveStatus>(page, own, "GET", `/api/projects/${projectId}/runtime-move`)).body;
          const estimate = async (runtime: string, at: string) =>
            human<Estimate>(
              page,
              own,
              "GET",
              `/api/projects/${projectId}/runtime-move/estimate?runtime=${encodeURIComponent(runtime)}&root=${encodeURIComponent(at)}`,
            );
          const waitMoved = async (runtime: string) => {
            await expect
              .poll(async () => {
                const p = await project();
                if (p.move) return `移している途中（${JSON.stringify((await status()).progress)}）`;
                const progress = (await status()).progress;
                if (progress?.phase === "failed") return `移せなかった：${progress.reason}`;
                return p.runtime ?? "host-container";
              }, { timeout: 900_000, intervals: [2000], message: "移し終わらない" })
              .toBe(runtime);
          };
          const hostModules = () => readdirSync(join(own.dataDir, "modules")).filter((n) => n.includes(projectId));
          /** その文を最後の user の発言に持つ、本物の CLI が送った要求（ターンの本体の要求。CLI は後ろに system の添え書きを足す） */
          const requestFor = (said: string) =>
            fakeApi.requests.filter((r) => [...r.messages].reverse().find((m) => m.role === "user")?.text.includes(said)).at(-1);

          await login(page, own);

          // ---- この機械で最初の会話（本物の CLI が記録を書く） --------------------------------------------
          const first = await sendTurn(own, threadId, "最初の話。合言葉は apple-17");
          const session = (await api<{ resumePoint?: string }>(own, `/api/threads/${threadId}`)).body.resumePoint!;
          expect(session, "会話の id ができていない").toBeTruthy();
          expect(
            requestFor("合言葉は apple-17"),
            `本物の CLI が偽の API を呼んでいない（偽の API が受けた要求：${fakeApi.seen.join("・")}／${JSON.stringify(fakeApi.requests).slice(0, 1500)}／ターン：${first.slice(-1500)}）`,
          ).toBeTruthy();
          const rootRecords = join(claudeDir, "projects", encode(root));
          expect(readFileSync(join(rootRecords, `${session}.jsonl`), "utf8")).toContain("apple-17");

          // ---- 1. この機械 → 別のサーバ（ふつうに写す） --------------------------------------------------
          const toRemote = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
            runtime: `remote:${name}`,
            root: "~/work/back",
          });
          expect(toRemote.status, JSON.stringify(toRemote.body)).toBe(202);
          await waitMoved(`remote:${name}`);
          expect((await project()).root).toBe(remoteRoot);

          // 向こうで話す（記録は host の runner-cwd のフォルダに足される）。向こうでファイルを足し、消す
          await sendTurn(own, threadId, "向こうで話した。合言葉は kiwi-42");
          const remoteTurn = requestFor("合言葉は kiwi-42");
          expect(remoteTurn?.messages.map((m) => m.text).join("\n"), "向こうのターンが会話の続きになっていない").toContain("apple-17");
          const w = await callTool(own, `shell-${projectId}`, "runCommand", { command: "echo 向こうで足した > where.txt && rm gone.txt" }, ctx);
          expect(w.isError, w.text).toBe(false);
          expect((await sshHost.ssh(`cat ${remoteRoot}/where.txt; test -e ${remoteRoot}/gone.txt && echo 残っている || echo 消えた`)).stdout).toBe(
            "向こうで足した\n消えた\n",
          );

          // ---- 3. 空でなく、前に居た場所でもないフォルダは断る ------------------------------------------------
          const refusedEstimate = await estimate("host-container", other);
          expect(refusedEstimate.status, JSON.stringify(refusedEstimate.body)).toBe(200);
          expect(refusedEstimate.body.blockers).toEqual([
            `移す先のフォルダ ${other} は空ではありません（まだ無いか空のフォルダか、この Project が前に居た場所を選んでください）`,
          ]);
          expect(refusedEstimate.body.returning).toBeUndefined();
          const refused = await human<{ error: string }>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, { runtime: "host-container", root: other });
          expect(refused.status).toBe(409);
          expect(refused.body.error).toContain("空ではありません");
          expect((await project()).move, "断ったのに移し始めた").toBeUndefined();
          expect(readdirSync(other), "断ったフォルダに触った").toEqual(["someone.txt"]);

          // ---- 5. 閉じた Project：根が R の上（base）・根そのもの（base/same）・根を含むフォルダ（base/up の下が根） --------
          const closedProject = async (label: string, at: string) => {
            mkdirSync(at, { recursive: true });
            const c = await api<HostProject>(own, "/api/projects", { method: "POST", body: { name: `E2E 閉じた ${label} ${name}`, root: at } });
            expect(c.status, JSON.stringify(c.body)).toBe(201);
            const closed = await api(own, `/api/projects/${c.body.id}/close`, { method: "POST" });
            expect(closed.status, JSON.stringify(closed.body)).toBe(200);
            return `E2E 閉じた ${label} ${name}`;
          };
          await closedProject("上", base);
          const sameName = await closedProject("同じ", join(base, "same"));
          const insideName = await closedProject("中", join(base, "up", "inner"));
          // 根のフォルダを消しておく（base/up を空にして、「空ではありません」より先に重なりで断られるのを見る）
          rmSync(join(base, "up", "inner"), { recursive: true });
          for (const [at, closedName, closedRoot] of [
            [join(base, "same"), sameName, join(base, "same")],
            [join(base, "up"), insideName, join(base, "up", "inner")],
          ] as const) {
            const message = `移す先 ${at} が Project「${closedName}」の根（${closedRoot}）と重なります`;
            const e = await estimate("host-container", at);
            expect(e.status, JSON.stringify(e.body)).toBe(200);
            expect(e.body.blockers).toEqual([message]);
            const r = await human<{ error: string }>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, { runtime: "host-container", root: at });
            expect(r.status, JSON.stringify(r.body)).toBe(409);
            expect(r.body.error).toContain(message);
            expect((await project()).move, "断ったのに移し始めた").toBeUndefined();
          }
          // 閉じた Project「上」の根（base）の中の R へは戻せる——下の 1 の見積もりの blockers が空で、押すと戻る

          // ---- 1. 別のサーバ → この機械の同じ根（前に居た場所——差分で） ----------------------------------------
          const back = await estimate("host-container", root);
          expect(back.status, JSON.stringify(back.body)).toBe(200);
          expect(back.body.blockers).toEqual([]);
          expect(back.body.returning?.overwritten).toEqual({ count: 0, head: [] });
          const diff = back.body.returning?.diff;
          expect(diff, "差分を測っていない").toBeTruthy();
          // 変わったのは where.txt（足した）と gone.txt（消した）と Module の置き場の少し——変えない 20 件は送らない
          expect(diff!.files, `差分が大きすぎる：${JSON.stringify(diff)}（全部 ${back.body.size.files} 件）`).toBeLessThan(back.body.size.files - 20);
          expect(diff!.files).toBeGreaterThanOrEqual(1);
          expect(diff!.deleted, "向こうで消したファイルを消す数に入れていない").toBeGreaterThanOrEqual(1);
          const started = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, { runtime: "host-container", root });
          expect(started.status, JSON.stringify(started.body)).toBe(202);
          await waitMoved("host-container");
          const returned = await project();
          expect(returned.root).toBe(root);
          expect(returned.previousLocations?.map((l) => `${l.runtime}:${l.root}`), "戻した場所が前に居た場所に残っている").toEqual([`remote:${name}:${remoteRoot}`]);
          expect(readFileSync(join(root, "where.txt"), "utf8")).toBe("向こうで足した\n");
          expect(existsSync(join(root, "gone.txt")), "向こうで消したファイルが残っている").toBe(false);
          expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("元の機械で書いた\n");
          expect(readdirSync(join(root, "sub")).length).toBe(20);
          expect(hostModules().filter((n) => n.includes(".before-")), "前に居た場所の Module の置き場を退かせた").toEqual([]);
          expect(hostModules()).toContain(`shell-${projectId}`);

          // ---- 2. 戻ったあと、向こうで話した内容を覚えている（#288） ---------------------------------------
          // 移す前の古い記録（apple だけ）は退かせ、向こうの続きの記録（kiwi まで）が入っている
          expect(readFileSync(join(rootRecords, `${session}.jsonl`), "utf8")).toContain("kiwi-42");
          const aside = readdirSync(rootRecords).filter((n) => n.startsWith(`${session}.jsonl.before-`));
          expect(aside, "古い記録を退かせていない").toHaveLength(1);
          expect(readFileSync(join(rootRecords, aside[0]!), "utf8")).not.toContain("kiwi-42");
          await sendTurn(own, threadId, "戻ってきた。向こうで言った合言葉を覚えている？");
          const backTurn = requestFor("向こうで言った合言葉を覚えている？");
          expect(backTurn, "戻ったあとのターンが偽の API に届いていない").toBeTruthy();
          const seen = backTurn!.messages.map((m) => m.text).join("\n");
          expect(seen, "戻ったあと、向こうで話した内容を忘れている").toContain("合言葉は kiwi-42");
          expect(seen).toContain("合言葉は apple-17");

          // ---- 4. もう一度向こうへ（向こうも前に居た場所——差分で）→ 元を触る → 戻すには承知が要る ----------------------
          const again = await estimate(`remote:${name}`, "~/work/back");
          expect(again.status, JSON.stringify(again.body)).toBe(200);
          expect(again.body.blockers).toEqual([]);
          expect(again.body.returning?.overwritten.count).toBe(0);
          const toRemoteAgain = await human<HostProject>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
            runtime: `remote:${name}`,
            root: "~/work/back",
          });
          expect(toRemoteAgain.status, JSON.stringify(toRemoteAgain.body)).toBe(202);
          await waitMoved(`remote:${name}`);
          expect((await project()).previousLocations?.map((l) => `${l.runtime}:${l.root}`)).toEqual([`host-container:${root}`]);

          // 元（この機械の R）を、移したあとに触る（mtime は移した時刻より後になるように少し待つ）
          await new Promise((r) => setTimeout(r, 1500));
          writeFileSync(join(root, "hello.txt"), "移したあとに元で書き換えた\n");
          writeFileSync(join(root, "host-edit.txt"), "移したあとに元で足した\n");

          const touched = await estimate("host-container", root);
          expect(touched.body.blockers).toEqual([]);
          expect(touched.body.returning?.overwritten.count).toBe(2);
          expect([...(touched.body.returning?.overwritten.head ?? [])].sort()).toEqual([join(root, "hello.txt"), join(root, "host-edit.txt")]);
          // 承知なしでは断る
          const noAck = await human<{ error: string; code?: string; overwritten?: { count: number } }>(page, own, "POST", `/api/projects/${projectId}/runtime-move`, {
            runtime: "host-container",
            root,
          });
          expect(noAck.status, JSON.stringify(noAck.body)).toBe(409);
          expect(noAck.body.code).toBe("overwrite-not-acknowledged");
          expect(noAck.body.overwritten?.count).toBe(2);
          expect(noAck.body.error).toContain("変わったファイルが 2 件あります");
          expect((await project()).move, "承知していないのに移し始めた").toBeUndefined();
          expect(readFileSync(join(root, "host-edit.txt"), "utf8"), "断ったのに元を書き換えた").toBe("移したあとに元で足した\n");

          // 画面：設定「一般」→「別の実行場所へ移す…」。押す前の段に一覧と承知のチェック。承知しないと押せない
          await openApp(page, own.url);
          await page.goto(`/settings?project=${projectId}&section=project-general&bantoHost=${own.url}`);
          const runtimeBox = page.getByTestId("project-runtime");
          await expect(runtimeBox).toHaveAttribute("data-runtime", `remote:${name}`, { timeout: 30_000 });
          await runtimeBox.getByTestId("project-runtime-move").click();
          const dialog = page.getByTestId("move-runtime-dialog");
          await dialog.getByTestId("move-to-select").click();
          await page.locator('[data-testid="move-to-option"][data-runtime="host-container"]').click();
          await dialog.locator("#move-path").fill(root);
          await dialog.getByTestId("move-next").click();
          const review = dialog.getByTestId("move-review");
          await expect(review).toBeVisible({ timeout: 120_000 });
          await expect(review.getByTestId("move-blockers")).toHaveCount(0);
          await expect(review.getByTestId("move-diff")).toHaveText(/^前に居た場所へ戻します。差分で写す：\d+ 件・[\d.]+ (B|KB|MB)/);
          const overwrittenBox = review.getByTestId("move-overwritten");
          await expect(overwrittenBox).toContainText("上書きされる・消えるファイル：2 件");
          // 並びは find の順（名前順とは限らない）——件数を待ってから中身で見る
          await expect(overwrittenBox.getByTestId("move-overwritten-file")).toHaveCount(2);
          expect((await overwrittenBox.getByTestId("move-overwritten-file").allInnerTexts()).sort()).toEqual([join(root, "hello.txt"), join(root, "host-edit.txt")].sort());
          await expect(dialog.getByTestId("move-start")).toBeDisabled();
          await review.getByTestId("move-overwrite-ack").check();
          await expect(dialog.getByTestId("move-start")).toBeEnabled();
          await dialog.getByTestId("move-start").click();
          const done = dialog.getByTestId("move-done");
          await expect(done).toBeVisible({ timeout: 900_000 });
          await expect(done.getByTestId("move-done-root")).toHaveText(root);

          // 承知したので上書きされた（向こうと同じ中身）
          expect((await project()).runtime ?? "host-container").toBe("host-container");
          expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("元の機械で書いた\n");
          expect(existsSync(join(root, "host-edit.txt")), "あとから足したファイルが残っている").toBe(false);
          expect(readFileSync(join(root, "where.txt"), "utf8")).toBe("向こうで足した\n");
          expect((await project()).previousLocations?.map((l) => `${l.runtime}:${l.root}`)).toEqual([`remote:${name}:${remoteRoot}`]);
          // 戻ったあとも会話は続く（向こうの分も含めて）
          await sendTurn(own, threadId, "もう一度戻った。合言葉は lemon-7");
          const lastSeen = requestFor("合言葉は lemon-7")!.messages.map((m) => m.text).join("\n");
          expect(lastSeen).toContain("合言葉は kiwi-42");
          expect(lastSeen).toContain("向こうで言った合言葉を覚えている？");
        },
        {
          // **本物の CLI を偽の API に当てる**（偽の Runner は会話の記録を書かない）
          unsetEnv: OUTER_CLAUDE_ENV,
          env: {
            BANTO_FAKE_RUNNER: "",
            ANTHROPIC_BASE_URL: fakeApi.url,
            ANTHROPIC_API_KEY: "sk-ant-e2e-fake",
            CLAUDE_SECURESTORAGE_CONFIG_DIR: securestorage,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_AUTOUPDATER: "1",
          },
        },
      );
    });
  } finally {
    await fakeApi.close();
    rmSync(base, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(securestorage, { recursive: true, force: true });
  }
});
