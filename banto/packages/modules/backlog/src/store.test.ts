// 店——一覧のブランチ。orphan で作る・1件1コミット・compare-and-swap の競合・作業ツリーに触らない・どのブランチを
// checkout していても同じ一覧・送れなくても書き込みは止めない・origin が先なら取り込む・食い違いは書かない・
// 読めない中身は書かない・前からある問題。本物の git で見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogStore } from "./store.js";
import { RelayingRemote } from "./remote.js";
import { createItem, updateItem, moveItem, BACKLOG_FORMAT, type BacklogDocument } from "./model.js";

const NOW = "2026-10-04T00:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** コードのコミットが1つあるリポジトリ。`origin` を渡すと bare のリポジトリを origin にする */
function setup(opts: { origin?: boolean | string; branch?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "backlog-store-"));
  git(root, "init", "-q");
  writeFileSync(join(root, "README.md"), "code\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "code");
  let bare: string | undefined;
  if (opts.origin === true) {
    bare = mkdtempSync(join(tmpdir(), "backlog-origin-"));
    git(bare, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", bare);
  } else if (typeof opts.origin === "string") {
    git(root, "remote", "add", "origin", opts.origin);
  }
  const branch = opts.branch ?? "backlog";
  const store = new BacklogStore({ root, branch: () => branch, remote: new RelayingRemote(root, undefined) });
  /** ブランチの中の一覧（git から直接） */
  const onBranch = (ref = `refs/heads/${branch}`): BacklogDocument => JSON.parse(git(root, "show", `${ref}:tasks.json`)) as BacklogDocument;
  const head = (ref = `refs/heads/${branch}`): string => git(root, "rev-parse", ref);
  return { root, bare, store, onBranch, head, branch };
}

/** 作業ツリーに触らずに、ブランチに中身を直接積む（ほかの書き手・人の git の真似） */
function commitDirect(root: string, ref: string, text: string, parent?: string): string {
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  const commit = git(root, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "by hand");
  git(root, "update-ref", ref, commit);
  return commit;
}

const add = (store: BacklogStore, title: string, extra: Record<string, unknown> = {}) =>
  store.mutate((d) => createItem(d, { kind: "task", title, ...extra }, NOW), (r) => `backlog: createItem ${r.id}`);

test("ブランチが無ければ「無い」と読み、最初の作成で親を持たない（orphan）コミットを作る。中は tasks.json だけ、作者は banto", async () => {
  const { root, store, onBranch, head } = setup();
  assert.equal((await store.read()).state, "missing");
  const { created, branch, commit } = await add(store, "First");
  assert.equal(created, true);
  assert.equal(branch, "backlog");
  assert.equal(commit, head());
  assert.equal(onBranch().format, BACKLOG_FORMAT);
  assert.deepEqual(onBranch().items.map((i) => i.id), ["first"]);
  // 親を持たない・コードの履歴とつながらない
  assert.equal(git(root, "rev-list", "--parents", "-n", "1", "backlog"), commit);
  assert.throws(() => git(root, "merge-base", "main", "backlog"), "main とつながっている");
  assert.equal(git(root, "ls-tree", "--name-only", "backlog"), "tasks.json");
  assert.equal(git(root, "log", "-1", "--format=%an <%ae>|%cn|%s", "backlog"), "banto <banto@localhost>|banto|backlog: createItem first");
});

test("1件の変更ごとに1コミット。同時に来た書き込みは列で1件ずつ——どれも失われない", async () => {
  const { root, store, onBranch } = setup();
  await Promise.all(Array.from({ length: 12 }, (_, n) => add(store, `Task ${n}`)));
  assert.equal(onBranch().items.length, 12);
  assert.equal(new Set(onBranch().items.map((i) => i.id)).size, 12);
  assert.equal(git(root, "rev-list", "--count", "backlog"), "12");
  // 親子が一直線（どのコミットも親は1つ以下）
  for (const line of git(root, "rev-list", "--parents", "backlog").split("\n")) assert.ok(line.split(" ").length <= 2, line);
});

test("compare-and-swap：読んだあとに別の書き手が先にブランチを進めたら、読み直してやり直す——両方入る", async () => {
  const { root, store, onBranch, head } = setup();
  await add(store, "Base");
  let calls = 0;
  const written = await store.mutate(
    (d) => {
      calls += 1;
      if (calls === 1) {
        // 読んだ直後に、別の書き手（別のプロセス・人の git）が1件足して先に進める
        const other = createItem(d, { kind: "bug", title: "Other writer" }, NOW).doc;
        commitDirect(root, "refs/heads/backlog", `${JSON.stringify(other)}\n`, head());
      }
      return createItem(d, { kind: "task", title: "Mine" }, NOW);
    },
    () => "backlog: createItem mine",
  );
  assert.equal(calls, 2, "やり直していない");
  assert.deepEqual(onBranch().items.map((i) => i.id), ["base", "other-writer", "mine"]);
  // 番号はやり直しの中で振り直す——1回目に振った #2 は先を越した項目のもの
  assert.deepEqual(onBranch().items.map((i) => i.number), [1, 2, 3]);
  assert.equal(written.commit, head());
  assert.equal(git(root, "rev-list", "--count", "backlog"), "3");

  // 2つの店（列を共有しない——別のプロセスの真似）が同時に書いても、どれも失われない
  const second = new BacklogStore({ root, branch: () => "backlog" });
  await Promise.all(Array.from({ length: 8 }, (_, n) => add(n % 2 === 0 ? store : second, `Race ${n}`)));
  assert.equal(onBranch().items.length, 11);
  assert.deepEqual(onBranch().items.map((i) => i.number).sort((x, y) => x! - y!), Array.from({ length: 11 }, (_, n) => n + 1), "番号が重なった");
});

test("作業ツリーにも index にも触らない——未コミットの変更・HEAD・index はそのまま", async () => {
  const { root, store } = setup();
  writeFileSync(join(root, "README.md"), "edited but not committed\n");
  writeFileSync(join(root, "untracked.txt"), "x\n");
  git(root, "add", "untracked.txt");
  const before = { status: git(root, "status", "--porcelain=v1"), head: git(root, "rev-parse", "HEAD"), index: readFileSync(join(root, ".git/index")), branch: git(root, "symbolic-ref", "HEAD") };
  await add(store, "One");
  await store.mutate((d) => updateItem(d, "one", { status: "done" }, NOW), () => "backlog: updateItem one（status → done）");
  await store.read();
  assert.equal(git(root, "status", "--porcelain=v1"), before.status);
  assert.equal(git(root, "rev-parse", "HEAD"), before.head);
  assert.equal(git(root, "symbolic-ref", "HEAD"), before.branch);
  assert.deepEqual(readFileSync(join(root, ".git/index")), before.index);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "edited but not committed\n");
});

test("どのブランチを checkout していても・worktree からでも、同じ一覧を読み書きする", async () => {
  const { root, store, onBranch } = setup();
  await add(store, "From main");
  git(root, "checkout", "-q", "-b", "feature");
  const fromFeature = await store.read();
  assert.ok(fromFeature.state === "ok");
  assert.deepEqual(fromFeature.doc.items.map((i) => i.id), ["from-main"]);
  await add(store, "From feature");
  const wt = join(mkdtempSync(join(tmpdir(), "backlog-wt-")), "wt");
  git(root, "worktree", "add", "-q", "-b", "other", wt);
  const inWorktree = new BacklogStore({ root: wt, branch: () => "backlog" });
  const snap = await inWorktree.read();
  assert.ok(snap.state === "ok");
  assert.deepEqual(snap.doc.items.map((i) => i.id), ["from-main", "from-feature"]);
  await add(inWorktree, "From worktree");
  assert.deepEqual(onBranch().items.map((i) => i.id), ["from-main", "from-feature", "from-worktree"]);
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "feature");
});

test("書いたら origin へ送る。送れなくても書き込みは止めず、まだ送っていない件数と理由を読むたびに言う", async () => {
  const { root, bare, store, head } = setup({ origin: true });
  const first = await add(store, "Pushed");
  assert.deepEqual(first.push, { ok: true, via: "git" });
  assert.equal(git(bare!, "rev-parse", "refs/heads/backlog"), head());
  let snap = await store.read();
  assert.deepEqual(snap.sync, { origin: true, ahead: 0, behind: 0, diverged: false });

  // 送れない（origin が無くなった）——書き込みは済み、まだ送っていないと言う
  git(root, "remote", "set-url", "origin", join(tmpdir(), "backlog-no-such-origin-" + Date.now()));
  const second = await add(store, "Not pushed");
  assert.equal(second.push?.ok, false);
  assert.equal(git(root, "show", "backlog:tasks.json").includes("not-pushed"), true);
  snap = await store.read();
  assert.equal(snap.sync.ahead, 1);
  assert.match(snap.sync.pushError ?? "", /does not appear to be a git repository|not found|No such/i);
  assert.match(snap.sync.fetchError ?? "", /.+/, "書く前に取ってこれなかったことも覚える");

  // 戻ったら、次の書き込みで2件まとめて送られ、知らせは消える
  git(root, "remote", "set-url", "origin", bare!);
  await add(store, "Third");
  snap = await store.read();
  assert.deepEqual(snap.sync, { origin: true, ahead: 0, behind: 0, diverged: false });
  assert.equal(git(bare!, "rev-parse", "refs/heads/backlog"), head());

  // origin が無いリポジトリでは送らない——「まだ送っていない」とも言わない
  const local = setup();
  const r = await add(local.store, "Local");
  assert.equal(r.push, undefined);
  assert.deepEqual((await local.store.read()).sync, { origin: false, ahead: 0, behind: 0, diverged: false });
});

test("origin が手元より先なら取り込む（取ってくるのは書く前と refresh だけ）。両方に新しいコミットがあれば書かずに理由を言う", async () => {
  const { root, bare, store, head, onBranch } = setup({ origin: true });
  await add(store, "Shared");
  // 別の手元が origin に1件足した
  const other = mkdtempSync(join(tmpdir(), "backlog-other-"));
  git(other, "clone", "-q", bare!, "c");
  const otherRoot = join(other, "c");
  const otherStore = new BacklogStore({ root: otherRoot, branch: () => "backlog", remote: new RelayingRemote(otherRoot, undefined) });
  const otherSnap = await otherStore.read();
  assert.ok(otherSnap.state === "ok", "clone した手元が origin/backlog を使い始めていない");
  await add(otherStore, "From elsewhere");

  // 読み直すだけでは取ってこない
  let snap = await store.read();
  assert.ok(snap.state === "ok" && snap.doc.items.length === 1);
  await store.refresh();
  snap = await store.read();
  assert.ok(snap.state === "ok");
  assert.deepEqual(snap.doc.items.map((i) => i.id), ["shared", "from-elsewhere"]);
  assert.equal(head(), head("refs/remotes/origin/backlog"), "fast-forward で手元を進めていない");

  // 食い違い：手元で1件（送れない）・origin でも1件
  git(root, "remote", "set-url", "origin", join(tmpdir(), "backlog-gone-" + Date.now()));
  await add(store, "Local only");
  git(root, "remote", "set-url", "origin", bare!);
  await add(otherStore, "Remote only");
  const before = head();
  await assert.rejects(add(store, "Blocked"), /手元と origin の backlog が分かれています（手元だけに 1 件・origin だけに 1 件のコミット）。書き込みません/);
  assert.equal(head(), before, "食い違ったまま書いた");
  snap = await store.read();
  assert.deepEqual({ ahead: snap.sync.ahead, behind: snap.sync.behind, diverged: snap.sync.diverged }, { ahead: 1, behind: 1, diverged: true });
  assert.deepEqual(onBranch().items.map((i) => i.id), ["shared", "from-elsewhere", "local-only"]);
});

test("ブランチの中身が古い形・壊れた JSON・tasks.json が無いなら、読まず・書かない（ref を動かさない）", async () => {
  const { root, store, head } = setup();
  commitDirect(root, "refs/heads/backlog", JSON.stringify({ tasks: [{ id: "a", title: "A", status: "pending" }] }));
  let snap = await store.read();
  assert.ok(snap.state === "refused" && snap.legacy);
  const before = head();
  await assert.rejects(add(store, "X"), /書き込みません.*git show backlog:tasks\.json > old-tasks\.json && node \S+convert-tasks-json\.mjs/);
  assert.equal(head(), before);

  commitDirect(root, "refs/heads/backlog", "{ not json", head());
  snap = await store.read();
  assert.ok(snap.state === "refused" && /JSON として読めません/.test(snap.reason));
  await assert.rejects(add(store, "X"), /書き込みません/);

  const emptyTree = git(root, "mktree");
  git(root, "update-ref", "refs/heads/backlog", git(root, "commit-tree", emptyTree, "-p", head(), "-m", "empty"));
  snap = await store.read();
  assert.ok(snap.state === "refused" && snap.reason === "ブランチ backlog に tasks.json がありません");
});

test("違反する変更は理由つきで断り、ブランチを進めない（輪・やめる理由なし）。前からある問題は関係のない変更を止めない", async () => {
  const { root, store, head } = setup();
  await add(store, "A", { id: "a" });
  await add(store, "B", { id: "b", dependsOn: ["a"] });
  const before = head();
  await assert.rejects(store.mutate((d) => updateItem(d, "a", { dependsOn: ["b"] }, NOW), () => "x"), /輪になっています：a → b → a/);
  await assert.rejects(store.mutate((d) => updateItem(d, "a", { status: "dropped" }, NOW), () => "x"), /理由/);
  assert.equal(head(), before);

  commitDirect(
    root,
    "refs/heads/backlog",
    JSON.stringify({
      format: BACKLOG_FORMAT,
      items: [
        { id: "a", kind: "task", title: "A", status: "ready", dependsOn: ["gone"] },
        { id: "b", kind: "task", title: "B", status: "ready" },
      ],
    }),
    head(),
  );
  const snap = await store.read();
  assert.ok(snap.state === "ok" && snap.problems.length === 1);
  await store.mutate((d) => updateItem(d, "b", { title: "B2" }, NOW), () => "backlog: updateItem b（title）");
  await assert.rejects(store.mutate((d) => updateItem(d, "b", { dependsOn: ["gone2"] }, NOW), () => "x"), /「gone2」がありません/);
  // 並べ替えも同じ列
  await Promise.all([
    store.mutate((d) => moveItem(d, "b", "a", "before"), () => "m"),
    add(store, "c"),
  ]);
  assert.deepEqual((await store.read() as { doc: BacklogDocument }).doc.items.map((i) => i.id), ["b", "a", "c"]);
});

test("Project の根が git でなければ書かない。ブランチが無く作業ツリーに一覧が残っていれば、移すコマンドを案内する（自動では移さない）", async () => {
  const plain = mkdtempSync(join(tmpdir(), "backlog-plain-"));
  const store = new BacklogStore({ root: plain, branch: () => "backlog" });
  const snap = await store.read();
  assert.ok(snap.state === "missing" && /git のリポジトリではありません/.test(snap.notRepository ?? ""));
  await assert.rejects(add(store, "X"), /git のリポジトリではありません（一覧はリポジトリのブランチに置きます）。書き込みません/);

  const { root, store: s2 } = setup();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/tasks.json"), JSON.stringify({ format: BACKLOG_FORMAT, items: [] }));
  const before = statSync(join(root, "docs/tasks.json")).mtimeMs;
  const missing = await s2.read();
  assert.ok(missing.state === "missing" && missing.leftover);
  assert.equal(missing.leftover.path, "docs/tasks.json");
  assert.match(missing.leftover.command, /^node \S+\/move-to-branch\.mjs --repo \S+ --file docs\/tasks\.json --branch backlog --push$/);
  assert.equal(statSync(join(root, "docs/tasks.json")).mtimeMs, before);
  assert.throws(() => git(root, "rev-parse", "--verify", "-q", "refs/heads/backlog"));
});
