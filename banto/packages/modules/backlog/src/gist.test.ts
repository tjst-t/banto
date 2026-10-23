// Gist の店——Gist の git（ここでは手元の bare のリポジトリで真似る）へ、読んだ版を親にして force せずに送る。
// 空の Gist に tasks.json を作る・ほかのファイルを残す・別の手元と同時に書いても失われない（送るのが compare-and-swap）・
// 書く前に取ってくる・取ってこれなければ書かない・資格情報の渡し方・Gist の id の読み方・Gist を作る（REST）。本物の git で見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GistStore, checkGistId, createGist, credentialArgs } from "./gist.js";
import { createItem, updateItem, BACKLOG_FORMAT, type BacklogDocument } from "./model.js";

const NOW = "2026-10-23T00:00:00.000Z";
const ID = "0123456789abcdef0123456789abcdef";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Gist の真似——bare のリポジトリに、README.md だけのコミットを1つ（Gist は空では作れない） */
function fakeGist(): string {
  const bare = mkdtempSync(join(tmpdir(), "backlog-gist-remote-"));
  git(bare, "init", "-q", "--bare");
  const blob = execFileSync("git", ["-C", bare, "hash-object", "-w", "--stdin"], { input: "# notes\n", encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", bare, "mktree"], { input: `100644 blob ${blob}\tREADME.md\n`, encoding: "utf8" }).trim();
  const commit = git(bare, "commit-tree", tree, "-m", "gist");
  git(bare, "update-ref", "refs/heads/main", commit);
  return bare;
}

function storeOf(remote: string, token: (callId?: string) => Promise<string> = async () => "t") {
  return new GistStore({ dataDir: mkdtempSync(join(tmpdir(), "backlog-gist-data-")), gistId: ID, token, remoteUrl: remote });
}

const onGist = (bare: string): BacklogDocument => JSON.parse(git(bare, "show", "main:tasks.json")) as BacklogDocument;
const add = (store: GistStore, title: string) => store.mutate((d) => createItem(d, { kind: "task", title }, NOW), (r) => `backlog: createItem ${r.id}`);

test("空の Gist：一覧は空（使えないとは言わない）で、最初の書き込みで tasks.json を作る。ほかのファイルは残し、作者は banto", async () => {
  const bare = fakeGist();
  const store = storeOf(bare);
  const empty = await store.read();
  assert.equal(empty.state, "missing");
  assert.equal(empty.unavailable, undefined);
  assert.deepEqual(empty.gist, { id: ID, url: `https://gist.github.com/${ID}` });
  const written = await add(store, "First");
  assert.equal(written.created, true);
  assert.equal(written.branch, "main");
  assert.equal(written.commit, git(bare, "rev-parse", "main"));
  assert.equal(written.push, undefined);
  assert.equal(onGist(bare).format, BACKLOG_FORMAT);
  assert.deepEqual(onGist(bare).items.map((i) => i.id), ["first"]);
  assert.deepEqual(git(bare, "ls-tree", "--name-only", "main").split("\n"), ["README.md", "tasks.json"]);
  assert.equal(git(bare, "log", "-1", "--format=%an <%ae>|%s", "main"), "banto <banto@localhost>|backlog: createItem first");
  // 前の Gist のコミットの上に積む（履歴を消さない）
  assert.equal(git(bare, "rev-list", "--count", "main"), "2");
  const read = await store.read();
  assert.equal(read.state, "ok");
  assert.equal((await add(store, "Second")).created, false);
});

test("別の手元（別のプロセス）と同時に書いても、どれも失われない——先を越されたら取ってきて読み直し、やり直す", async () => {
  const bare = fakeGist();
  const a = storeOf(bare);
  const b = storeOf(bare);
  await Promise.all([add(a, "A1"), add(b, "B1"), add(a, "A2"), add(b, "B2"), add(a, "A3"), add(b, "B3")]);
  const ids = onGist(bare).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["a1", "a2", "a3", "b1", "b2", "b3"]);
  // 番号も重ならない（振るのは compare-and-swap の中）
  assert.equal(new Set(onGist(bare).items.map((i) => i.number)).size, 6);
  assert.equal(git(bare, "rev-list", "--count", "main"), "7");
});

test("別の手元が書いたものは、取ってくるまで写しのまま。書く前には必ず取ってきて、その上に書く", async () => {
  const bare = fakeGist();
  const a = storeOf(bare);
  const b = storeOf(bare);
  await add(a, "From A");
  assert.equal((await b.read()).state, "ok");
  await add(a, "Again A");
  // b は起きて最初の読みでだけ取ってくる——3秒ごとの読み直しで GitHub を叩かない
  const stale = await b.read();
  assert.equal(stale.state === "ok" && stale.doc.items.length, 1);
  await b.refresh();
  const fresh = await b.read();
  assert.equal(fresh.state === "ok" && fresh.doc.items.length, 2);
  await a.mutate((d) => updateItem(d, "from-a", { status: "ready" }, NOW), () => "backlog: updateItem from-a");
  await b.mutate((d) => updateItem(d, "again-a", { status: "done" }, NOW), () => "backlog: updateItem again-a");
  const doc = onGist(bare);
  assert.deepEqual(doc.items.map((i) => [i.id, i.status]), [["from-a", "ready"], ["again-a", "done"]]);
});

test("取ってこれない Gist：読むと「使えない」と理由を言い、書かない。資格情報を引けなければ、その理由を言う", async () => {
  const gone = join(tmpdir(), `backlog-gist-none-${process.pid}`);
  const store = storeOf(gone);
  const read = await store.read();
  assert.equal(read.state, "missing");
  assert.match(read.unavailable ?? "", new RegExp(`Gist ${ID} を読めません`));
  await assert.rejects(add(store, "X"), /取ってこれないので、書き込みません/);

  const bare = fakeGist();
  const noToken = storeOf(bare, async () => {
    throw new Error("承認されませんでした");
  });
  await assert.rejects(add(noToken, "X"), /トークンを引けません（承認されませんでした）/);
  assert.equal(git(bare, "rev-list", "--count", "main"), "1");
});

test("取ってこれなくなっても、写しがあれば写しを出し、取ってこれなかったことを添える", async () => {
  const bare = fakeGist();
  let fail = false;
  const store = storeOf(bare, async () => {
    if (fail) throw new Error("Vault が止まっています");
    return "t";
  });
  await add(store, "Kept");
  fail = true;
  await store.refresh();
  const read = await store.read();
  assert.equal(read.state, "ok");
  assert.match(read.sync.fetchError ?? "", /Vault が止まっています/);
  assert.equal(read.sync.origin, false);
});

test("読めない形の tasks.json は読まず・書かない", async () => {
  const bare = fakeGist();
  const blob = execFileSync("git", ["-C", bare, "hash-object", "-w", "--stdin"], { input: "{ broken", encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", bare, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  git(bare, "update-ref", "refs/heads/main", git(bare, "commit-tree", tree, "-p", "main", "-m", "by hand"));
  const store = storeOf(bare);
  const read = await store.read();
  assert.equal(read.state, "refused");
  await assert.rejects(add(store, "X"), /読めない形なので、書き込みません/);
});

test("資格情報は credential helper で環境変数から渡す（コマンドの引数・URL に入れない）", () => {
  const out = execFileSync("git", [...credentialArgs(), "credential", "fill"], {
    input: "protocol=https\nhost=gist.github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, BANTO_GIST_TOKEN: "ghp_secret", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.match(out, /^username=x-access-token$/m);
  assert.match(out, /^password=ghp_secret$/m);
  assert.ok(!credentialArgs().join(" ").includes("ghp_secret"));
});

test("Gist の id：id そのもの・gist.github.com の URL（.git つきも）を受け、ほかは断る", () => {
  assert.equal(checkGistId(ID), ID);
  assert.equal(checkGistId(`https://gist.github.com/someone/${ID.toUpperCase()}`), ID);
  assert.equal(checkGistId(`https://gist.github.com/${ID}.git`), ID);
  assert.throws(() => checkGistId(""), /空/);
  assert.throws(() => checkGistId("--upload-pack=x"), /16進数/);
  assert.throws(() => checkGistId(`https://example.com/${ID}`), /gist.github.com/);
});

test("Gist を作る：非公開で、中は空の一覧。公開で作られたら使わない。断られたら権限の案内を添える", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const api = (status: number, body: unknown) => ({
    base: "https://api.example",
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
  const place = await createGist("ghp_x", "banto Backlog", api(201, { id: ID, public: false }));
  assert.deepEqual(place, { id: ID, url: `https://gist.github.com/${ID}` });
  assert.equal(sent[0]!.url, "https://api.example/gists");
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, "Bearer ghp_x");
  const body = JSON.parse(String(sent[0]!.init.body)) as { public: boolean; files: Record<string, { content: string }> };
  assert.equal(body.public, false);
  assert.deepEqual(JSON.parse(body.files["tasks.json"]!.content).items, []);
  await assert.rejects(createGist("t", "d", api(201, { id: ID, public: true })), /公開で作られました/);
  await assert.rejects(createGist("t", "d", api(403, { message: "Resource not accessible" })), /Resource not accessible（トークンに Gist を作る権限/);
});
