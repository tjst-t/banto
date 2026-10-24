// 読むだけの GitHub の tool（2026-10-20、Backlog #424。アーキ仕様 §4.4）。**偽の GitHub（本物の HTTP）へ**。
// 見るのは：AI に見せる読むだけの印・呼んだ Project のリポジトリの Issue・PR・CI を台帳のアカウントで読める・トークンは返事に
// 出ない・決めた欄の外（owner・repo・URL）は GitHub にも Vault にも行かずに断る・台帳に無い／origin が台帳と違う／刻印が
// 無い・食い違うものは断る・アカウントの無い行は鍵なしで公開のものだけ読める・本文は長さを切る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CALLER_META_KEY, CALL_ID_META_KEY, EFFECT_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { BODY_LIMIT } from "./github-read.js";
import { httpGithub } from "./github.js";
import { LedgerStore } from "./ledger.js";
import type { ProjectSummary } from "./repositories.js";
import { createRepositoriesServer } from "./server.js";
import { MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

const TOKEN = "ghp_github_read_secret_Q7x";
const SHA = "a".repeat(40);
const TOOLS = ["listIssues", "getIssue", "listPullRequests", "getPullRequest", "listCiRuns", "getCiRun"];

interface World {
  gh: FakeGithub;
  client: Client;
  vault: MemoryVault;
  store: LedgerStore;
  dir: string;
  project: ProjectSummary;
  /** AI のターンからの呼び出し（刻印は Project） */
  call(name: string, args?: Record<string, unknown>, stamp?: unknown): Promise<{ isError: boolean; text: string; json?: Record<string, unknown> }>;
}

async function withWorld(opts: { account?: boolean; private?: boolean }, fn: (w: World) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-ghread-")));
  const gh = await startFakeGithub();
  const vault = new MemoryVault();
  const dataDir = join(home, ".data");
  const store = new LedgerStore(dataDir);
  const dir = join(home, "notes");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/alice/notes.git"], { cwd: dir });
  gh.addRepo("alice", "notes", { private: opts.private ?? true });
  gh.addRepo("mallory", "secret", { private: true, readers: ["alice"] });
  gh.addContent({
    repo: "alice/notes",
    issues: [
      { number: 1, title: "家計簿が落ちる", body: "起動すると落ちます", user: "bob", labels: ["bug"], comments: [{ user: "alice", body: "見ます" }] },
      { number: 2, title: "閉じたもの", state: "closed" },
      { number: 4, title: "長い", body: "あ".repeat(BODY_LIMIT + 10) },
    ],
    pulls: [{ number: 3, title: "落ちるのを直す", head: "fix-crash", headSha: SHA, user: "alice", comments: [{ user: "bob", body: "ありがとう" }] }],
    runs: [
      { id: 101, name: "CI", status: "completed", conclusion: "failure", headSha: SHA, branch: "fix-crash", jobs: [{ name: "test", status: "completed", conclusion: "failure", steps: [{ name: "npm test", status: "completed", conclusion: "failure" }] }] },
      { id: 100, name: "CI", status: "completed", conclusion: "success", headSha: "b".repeat(40), branch: "main" },
    ],
  });
  gh.addContent({ repo: "mallory/secret", issues: [{ number: 1, title: "見えてはいけない" }] });
  const project: ProjectSummary = { id: "p1", name: "ノート", root: dir, status: "active" };
  const server = createRepositoriesServer({
    dataDir,
    projects: { listProjects: async () => [project], callerProject: async () => project },
    home,
    vault,
    github: httpGithub(gh.endpoints),
    githubEndpoints: gh.endpoints,
    notices: new RecordingNotices(),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  if (opts.account) {
    const place = vault.seed({ implementation: "vault-local", name: "alice-pat", group: "instance", kind: "secret" }, TOKEN);
    gh.users.set(TOKEN, "alice");
    const added = await client.callTool({
      name: "add_github_account_with_pat",
      arguments: { patAlias: place },
      _meta: { [CALLER_META_KEY]: { admin: true }, [CALL_ID_META_KEY]: "admin" },
    });
    assert.ok(!added.isError, JSON.stringify(added));
  }
  await store.update((e) => ({ entries: [...e, { path: dir, github: { owner: "alice", name: "notes" }, ...(opts.account ? { account: "alice" } : {}) }], result: undefined }));
  try {
    await fn({
      gh,
      client,
      vault,
      store,
      dir,
      project,
      async call(name, args = {}, stamp = { project: "p1" }) {
        const r = (await client.callTool({ name, arguments: args, _meta: { [CALLER_META_KEY]: stamp, [CALL_ID_META_KEY]: "turn-1" } })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        const text = r.content[0]!.text;
        return { isError: r.isError === true, text, ...(r.isError ? {} : { json: JSON.parse(text) as Record<string, unknown> }) };
      },
    });
  } finally {
    await client.close();
    await gh.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("6つの tool は AI に見せる読むだけの印を名乗り、引数は決めた欄だけ（ほかの欄は受けない）", async () => {
  await withWorld({ account: true }, async (w) => {
    const { tools } = await w.client.listTools();
    for (const name of TOOLS) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} が無い`);
      const meta = t._meta as Record<string, unknown>;
      assert.equal(meta[VISIBILITY_META_KEY], "agent", name);
      assert.equal(meta[EFFECT_META_KEY], "read", name);
      // 別のサーバの Project の origin を読むため、Project の git の口に届くと名乗る（Backlog #540）
      assert.equal(meta["dev.banto/projectGit"], true, name);
      const schema = t.inputSchema as { properties: Record<string, unknown>; additionalProperties?: unknown };
      assert.equal(schema.additionalProperties, false, name);
      for (const key of Object.keys(schema.properties)) assert.ok(["state", "limit", "number", "status", "runId"].includes(key), `${name} の ${key}`);
    }
    // ほかの tool に読むだけの印は付けない
    for (const t of tools.filter((x) => !TOOLS.includes(x.name))) assert.notEqual((t._meta as Record<string, unknown>)[EFFECT_META_KEY], "read", t.name);
  });
});

test("呼んだ Project のリポジトリの Issue・PR・CI を、台帳のアカウントで読む。トークンは返事に出ない", async () => {
  await withWorld({ account: true }, async (w) => {
    const issues = await w.call("listIssues");
    assert.equal(issues.isError, false, issues.text);
    const list = issues.json!.issues as Array<{ number: number; title: string; labels: string[]; author: string }>;
    // 開いている Issue だけ・PR は除く
    assert.deepEqual(list.map((i) => i.number).sort(), [1, 4]);
    assert.equal(issues.json!.repository, "alice/notes");
    assert.deepEqual(list.find((i) => i.number === 1), { ...list.find((i) => i.number === 1), title: "家計簿が落ちる", labels: ["bug"], author: "bob" });
    const all = await w.call("listIssues", { state: "all", limit: 10 });
    assert.deepEqual((all.json!.issues as Array<{ number: number }>).map((i) => i.number).sort(), [1, 2, 4]);

    const one = await w.call("getIssue", { number: 1 });
    assert.equal((one.json!.issue as { body: string }).body, "起動すると落ちます");
    assert.deepEqual(one.json!.comments, [{ author: "alice", createdAt: "2026-10-20T00:00:00Z", body: "見ます" }]);
    const long = await w.call("getIssue", { number: 4 });
    assert.equal((long.json!.issue as { body: string }).body.length, BODY_LIMIT);
    assert.equal((long.json!.issue as { truncated?: boolean }).truncated, true);
    const isPull = await w.call("getIssue", { number: 3 });
    assert.ok(isPull.isError);
    assert.match(isPull.text, /#3 は PR です/);

    const pulls = await w.call("listPullRequests");
    assert.deepEqual((pulls.json!.pullRequests as Array<{ number: number; head: string }>).map((p) => [p.number, p.head]), [[3, "fix-crash"]]);
    const pull = await w.call("getPullRequest", { number: 3 });
    assert.equal((pull.json!.pullRequest as { headSha: string }).headSha, SHA);
    assert.deepEqual((pull.json!.comments as Array<{ body: string }>).map((c) => c.body), ["ありがとう"]);
    // その head の CI だけ
    assert.deepEqual((pull.json!.ci as Array<{ id: number; conclusion: string }>).map((r) => [r.id, r.conclusion]), [[101, "failure"]]);

    const runs = await w.call("listCiRuns", { limit: 5 });
    assert.deepEqual((runs.json!.runs as Array<{ id: number }>).map((r) => r.id), [101, 100]);
    const failed = await w.call("listCiRuns", { status: "failure" });
    assert.deepEqual((failed.json!.runs as Array<{ id: number }>).map((r) => r.id), [101]);
    const run = await w.call("getCiRun", { runId: 101 });
    assert.deepEqual(run.json!.jobs, [
      { name: "test", status: "completed", conclusion: "failure", startedAt: "2026-10-20T00:00:00Z", completedAt: "2026-10-20T00:00:00Z", steps: [{ name: "npm test", status: "completed", conclusion: "failure" }] },
    ]);
    const missing = await w.call("getCiRun", { runId: 999 });
    assert.ok(missing.isError);
    assert.match(missing.text, /github\.com\/alice\/notes の CI の実行 999 が見つかりません/);

    // 読みに行ったのはこのリポジトリだけ、台帳のアカウントで。トークンは返事に出ない
    assert.ok(w.gh.apiReads.length > 0);
    for (const r of w.gh.apiReads) {
      assert.match(r.path, /^\/repos\/alice\/notes\//);
      assert.equal(r.login, "alice");
    }
    for (const r of [issues, one, pulls, pull, runs, run]) assert.equal(r.text.includes(TOKEN), false);
  });
});

test("決めた欄の外（owner・repo・URL・検索語）・形の違う値は、GitHub にも Vault にも行かずに断る", async () => {
  await withWorld({ account: true }, async (w) => {
    const resolvesBefore = w.vault.calls.filter((c) => c.op === "resolve").length;
    for (const args of [
      { owner: "mallory", repo: "secret" },
      { repository: "mallory/secret" },
      { url: "https://api.github.com/repos/mallory/secret/issues" },
      { q: "password" },
    ]) {
      const r = await w.call("listIssues", args);
      assert.ok(r.isError, JSON.stringify(args));
      assert.match(r.text, /受けるのは state・limit だけです/);
      assert.match(r.text, /リポジトリ・URL・検索語は選べません/);
    }
    for (const [name, args, why] of [
      ["listIssues", { state: "draft" }, /state は open・closed・all のどれかです/],
      ["listIssues", { limit: 500 }, /limit は 50 までです/],
      ["getIssue", { number: "1" }, /number は1以上の整数/],
      ["getIssue", {}, /number は1以上の整数/],
      ["getCiRun", { runId: -1 }, /runId は1以上の整数/],
    ] as const) {
      const r = await w.call(name, args);
      assert.ok(r.isError, `${name} ${JSON.stringify(args)}`);
      assert.match(r.text, why);
    }
    assert.deepEqual(w.gh.apiReads, [], "断ったのに GitHub に行った");
    assert.equal(w.vault.calls.filter((c) => c.op === "resolve").length, resolvesBefore, "断ったのに Vault の値を引いた");
  });
});

test("台帳に無い・origin が台帳と違う・刻印が無い／食い違う・別のサーバの Project は断る", async () => {
  await withWorld({ account: true }, async (w) => {
    // 刻印が無い（Module 間）・食い違う
    const unstamped = (await w.client.callTool({ name: "listIssues", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    assert.ok(unstamped.isError);
    assert.match(unstamped.content[0]!.text, /Project のための呼び出しからだけ/);
    const other = await w.call("listIssues", {}, { project: "p2" });
    assert.ok(other.isError);
    assert.match(other.text, /刻印の Project（p2）と、host の台帳の Project（p1）が違います/);

    // origin を別のリポジトリに書き換えても、台帳の場所と違えば読まない（コンテナの中から origin は書ける）
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/mallory/secret.git"], { cwd: w.dir });
    const moved = await w.call("listIssues");
    assert.ok(moved.isError);
    assert.match(moved.text, /origin（github\.com\/mallory\/secret）が Repositories の一覧の github\.com\/alice\/notes と違うので読みません/);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/alice/notes.git"], { cwd: w.dir });

    // 台帳から外したら読めない
    await w.store.update(() => ({ entries: [], result: undefined }));
    const gone = await w.call("listPullRequests");
    assert.ok(gone.isError);
    assert.match(gone.text, /このリポジトリは Repositories の一覧にありません/);
    assert.deepEqual(w.gh.apiReads, [], "断ったのに GitHub に行った");
  });

  await withWorld({ account: true }, async (w) => {
    w.project.runtime = "remote:other";
    const r = await w.call("listIssues");
    assert.ok(r.isError);
    assert.match(r.text, /別のサーバで動いています/);
  });
});

test("アカウントの無い行は鍵なしで読む——公開なら読め、非公開は次の手を添えて断る", async () => {
  await withWorld({ account: false, private: false }, async (w) => {
    const r = await w.call("listIssues");
    assert.equal(r.isError, false, r.text);
    assert.deepEqual((r.json!.issues as Array<{ number: number }>).map((i) => i.number).sort(), [1, 4]);
    assert.equal(w.gh.apiReads[0]!.login, undefined);
    assert.equal(w.vault.calls.filter((c) => c.op === "resolve").length, 0);
  });
  await withWorld({ account: false, private: true }, async (w) => {
    const r = await w.call("listIssues");
    assert.ok(r.isError);
    assert.match(r.text, /github\.com\/alice\/notes が見つかりません（無いか、非公開です——Repositories でこのリポジトリを扱うアカウントを選ぶと読めます）/);
  });
});
