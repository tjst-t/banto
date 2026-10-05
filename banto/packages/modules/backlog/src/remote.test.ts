// 送る・取ってくるの順番——Repositories が引き受けたらそれだけ、引き受けなければリポジトリの git の設定、
// 中継が断ったら理由を添えて自分の git。呼び出しの印は中継に渡す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RelayingRemote, hostRelayCall, type RelayCall } from "./remote.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

/** origin（bare）と、backlog ブランチに1コミットあるリポジトリ */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "backlog-remote-"));
  const bare = mkdtempSync(join(tmpdir(), "backlog-remote-origin-"));
  git(bare, "init", "-q", "--bare");
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "code");
  git(root, "remote", "add", "origin", bare);
  git(root, "update-ref", "refs/heads/backlog", git(root, "commit-tree", git(root, "mktree"), "-m", "b"));
  return { root, bare };
}

function fakeRelay(answer: (name: string, args: Record<string, unknown>) => { text: string; isError?: boolean } | Error) {
  const calls: Array<{ name: string; args: Record<string, unknown>; callId?: string }> = [];
  const relay: RelayCall = async (name, args, callId) => {
    calls.push({ name, args, ...(callId ? { callId } : {}) });
    if (name === "relayListTargets") return { text: JSON.stringify([{ name: "repositories", roles: ["repositories"] }]), isError: false };
    const a = answer(name, args);
    if (a instanceof Error) throw a;
    return { text: a.text, isError: a.isError === true };
  };
  return { relay, calls };
}

test("Repositories が引き受けたら、自分の git では送らない（呼び出しの印を中継に渡す）", async () => {
  const { root, bare } = repo();
  const { relay, calls } = fakeRelay(() => ({ text: JSON.stringify({ handled: true, ok: true, message: "送りました" }) }));
  const r = await new RelayingRemote(root, relay).push("backlog", "call-7");
  assert.deepEqual(r, { ok: true, via: "repositories" });
  assert.deepEqual(calls.map((c) => [c.name, c.callId]), [["relayListTargets", "call-7"], ["relayCallTool", "call-7"]]);
  assert.deepEqual(calls[1]!.args, { targetModule: "repositories", name: "push_branch", arguments: { branch: "backlog" } });
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/backlog"), "自分の git でも送った");

  // 引き受けて断った——自分では試し直さない
  const refused = fakeRelay(() => ({ text: JSON.stringify({ handled: true, ok: false, message: "送り先を変える設定があります" }) }));
  assert.deepEqual(await new RelayingRemote(root, refused.relay).push("backlog"), { ok: false, via: "repositories", message: "送り先を変える設定があります" });
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/backlog"));

  // 取ってくる：origin にまだ無い
  const absent = fakeRelay(() => ({ text: JSON.stringify({ handled: true, ok: true, absent: true, message: "まだ無い" }) }));
  assert.deepEqual(await new RelayingRemote(root, absent.relay).fetch("backlog"), { ok: true, via: "repositories", absent: true });
  assert.equal(absent.calls[1]!.args.name, "fetch_branch");
});

test("引き受けない・中継が断った・Repositories が居ないときは、リポジトリの git の設定のまま送る", async () => {
  const { root, bare } = repo();
  const notMine = fakeRelay(() => ({ text: JSON.stringify({ handled: false, reason: "このリポジトリは Repositories の一覧にありません" }) }));
  assert.deepEqual(await new RelayingRemote(root, notMine.relay).push("backlog"), { ok: true, via: "git" });
  assert.equal(git(bare, "rev-parse", "refs/heads/backlog"), git(root, "rev-parse", "refs/heads/backlog"));

  // 中継が断った（承認されなかった）——自分の git で試し、失敗したら両方の理由を言う
  git(root, "remote", "set-url", "origin", join(tmpdir(), `backlog-remote-gone-${Date.now()}`));
  const denied = fakeRelay(() => new Error("backlog から repositories の push_branch への中継は許可されていません：人が断りました"));
  const r = await new RelayingRemote(root, denied.relay).push("backlog");
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /（Repositories に頼めませんでした（.*人が断りました）/);

  // 中継が無い（Repositories に頼めない banto）——自分の git だけ
  git(root, "remote", "set-url", "origin", bare);
  assert.deepEqual(await new RelayingRemote(root, undefined).fetch("backlog"), { ok: true, via: "git" });
  assert.deepEqual(await new RelayingRemote(root, undefined).fetch("nothing"), { ok: true, via: "git", absent: true });
  // 呼べる相手に Repositories が居ない
  const none: RelayCall = async (name) => ({ text: name === "relayListTargets" ? "[]" : "", isError: false });
  assert.deepEqual(await new RelayingRemote(root, none).push("backlog"), { ok: true, via: "git" });
});

// **中継が断っても、接続は切らない**（追加・2026-10-05、docs/notes/2026-10-05-relay-stale-card.md）。以前は断られたら
// 繋ぎ直していたので、同じ接続で人の承認を待っていた別の書き込みの中継まで切れ、host にはそのカードだけが残った
test("hostRelayCall：1本が断られても、同じ接続で待っている別の1本は切れない", async () => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let waiting!: () => void;
  const isWaiting = new Promise<void>((r) => (waiting = r));
  let sessions = 0;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer((req, res) => {
    void (async () => {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let t = sid ? transports.get(sid) : undefined;
      if (!t) {
        const server = new Server({ name: "host-relay", version: "0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        server.setRequestHandler(CallToolRequestSchema, async (r) => {
          if ((r.params.arguments as { name?: string }).name === "fetch_branch") {
            waiting();
            await released;
            return { content: [{ type: "text", text: "WAITED" }] };
          }
          throw new Error("中継は許可されていません：人が答える前に終わりました");
        });
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions += 1;
            transports.set(id, created);
          },
        });
        await server.connect(created);
        t = created;
      }
      await t.handleRequest(req, res);
    })();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  try {
    const call = hostRelayCall(`http://127.0.0.1:${(http.address() as AddressInfo).port}/relay`, "t");
    const pending = call("relayCallTool", { name: "fetch_branch" }, "call-1");
    await isWaiting;
    await assert.rejects(call("relayCallTool", { name: "push_branch" }, "call-2"), /許可されていません/);
    release();
    assert.deepEqual(await pending, { text: "WAITED", isError: false }, "断られた1本と一緒に、待っていた1本が切れた");
    assert.equal(sessions, 1, "断られただけで繋ぎ直した");
  } finally {
    http.closeAllConnections();
    http.close();
  }
});
