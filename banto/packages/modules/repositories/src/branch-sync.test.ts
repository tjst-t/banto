// ブランチを送る・取ってくる口（Backlog が中継で呼ぶ）。**本物の git で、偽の GitHub（本物の `git http-backend`）へ**。
// 見るのは：台帳のアカウントで送れて取ってこれる・トークンが `.git/config` と返事に残らない・引き受けない場合（台帳に
// 無い・アカウントが無い・GitHub の外）は理由だけ・送り先を変える設定があれば送らない・ブランチ名は1つの ref だけ・
// 口は中継からだけで、呼び出し元の Project は host の台帳と刻印の両方で決まる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUDIT_ARGS_META_KEY, CALLER_META_KEY, CALL_ID_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { GithubAccounts } from "./accounts.js";
import { BranchSync } from "./branch-sync.js";
import { GIT_ENV, isSafeBranchName } from "./git.js";
import { httpGithub } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { registerGithubHost } from "./remote.js";
import type { ProjectSummary } from "./repositories.js";
import { createRepositoriesServer } from "./server.js";
import { MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

const TOKEN = "ghp_branch_sync_secret_Zq9";

/** 偽の GitHub に話しかける git は非同期で（偽物は同じプロセスで動く） */
function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args.join(" ")}：${stderr || err.message}`)) : resolve(stdout)),
    ),
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** 作業ツリーに触らずに、そのブランチに1コミット積む（Backlog と同じ低レベルのコマンド） */
function commitOnBranch(repo: string, branch: string, text: string, gitDir?: string): string {
  const base = gitDir ? ["--git-dir", gitDir] : ["-C", repo];
  const g = (...a: string[]) => execFileSync("git", [...base, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const blob = execFileSync("git", [...base, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", [...base, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  let parent: string | undefined;
  try {
    parent = g("rev-parse", "--verify", "-q", `refs/heads/${branch}`);
  } catch {
    parent = undefined;
  }
  const commit = execFileSync(
    "git",
    [...base, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "backlog: test"],
    { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "banto", GIT_AUTHOR_EMAIL: "banto@localhost", GIT_COMMITTER_NAME: "banto", GIT_COMMITTER_EMAIL: "banto@localhost" } },
  ).trim();
  g("update-ref", `refs/heads/${branch}`, commit);
  return commit;
}

interface World {
  gh: FakeGithub;
  store: LedgerStore;
  accounts: GithubAccounts;
  sync: BranchSync;
  home: string;
  vault: MemoryVault;
  /** 偽の GitHub に alice/notes を作り、手元に clone して台帳に足す（アカウントは渡したもの） */
  cloned(opts?: { account?: string }): Promise<{ dir: string; project: ProjectSummary }>;
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-branch-")));
  const gh = await startFakeGithub();
  registerGithubHost(new URL(gh.endpoints.web).host);
  const vault = new MemoryVault();
  const store = new LedgerStore(join(home, ".data"));
  const github = httpGithub(gh.endpoints);
  const accounts = new GithubAccounts({ store, vault, github, notices: new RecordingNotices(), sleep: async () => undefined });
  const sync = new BranchSync({ store, accounts, vault, dataDir: join(home, ".data"), endpoints: gh.endpoints });
  const saved = { HOME: GIT_ENV.HOME, XDG: GIT_ENV.XDG_CONFIG_HOME };
  GIT_ENV.HOME = join(home, "user");
  GIT_ENV.XDG_CONFIG_HOME = join(home, "user", ".config");
  mkdirSync(GIT_ENV.HOME, { recursive: true });
  try {
    await fn({
      gh,
      store,
      accounts,
      sync,
      home,
      vault,
      async cloned(opts) {
        gh.addRepo("alice", "notes", { writers: ["alice"] });
        const dir = join(home, "notes");
        await gitAsync(home, "clone", "-q", `${gh.endpoints.web}/alice/notes.git`, dir);
        await store.update((e) => ({ entries: [...e, { path: dir, ...(opts?.account ? { account: opts.account } : {}) }], result: undefined }));
        return { dir, project: { id: "p1", name: "ノート", root: dir, status: "active" } };
      },
    });
  } finally {
    GIT_ENV.HOME = saved.HOME;
    GIT_ENV.XDG_CONFIG_HOME = saved.XDG;
    await gh.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function addAccount(w: World, login: string, token: string): Promise<void> {
  const place = w.vault.seed({ implementation: "vault-local", name: `${login}-pat`, group: "instance", kind: "secret" }, token);
  w.gh.users.set(token, login);
  await w.accounts.addWithPat({ patAlias: place }, "c");
}

function bareHead(gh: FakeGithub, branch: string): string | undefined {
  try {
    return execFileSync("git", ["--git-dir", join(gh.gitRoot, "alice", "notes.git"), "rev-parse", "--verify", "-q", `refs/heads/${branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

test("台帳のアカウントで、そのブランチだけを送り、取ってくる。トークンは .git/config にも返事にも残らない", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { dir, project } = await w.cloned({ account: "alice" });
    const mainBefore = bareHead(w.gh, "main");
    const local = commitOnBranch(dir, "backlog", '{"format":"banto-backlog/1","items":[]}\n');

    const pushed = await w.sync.sync("push", "backlog", project, "c");
    assert.deepEqual(pushed, { handled: true, ok: true, message: "backlog を github.com/alice/notes に送りました（@alice）" });
    assert.equal(bareHead(w.gh, "backlog"), local);
    assert.equal(bareHead(w.gh, "main"), mainBefore, "ほかのブランチが動いた");
    // 追跡の ref も進む（Backlog はこれで「まだ送っていない」を数える）
    assert.equal(git(dir, "rev-parse", "refs/remotes/origin/backlog").trim(), local);
    assert.ok(!readFileSync(join(dir, ".git", "config"), "utf8").includes(TOKEN));
    assert.ok(w.gh.gitRequests.some((r) => r.authorization !== undefined), "資格情報を渡していない");

    // origin 側で進んだもの（別の手元から送られた）を取ってくる——手元のブランチには触らない
    const remote = commitOnBranch("", "backlog", '{"format":"banto-backlog/1","items":[],"x":1}\n', join(w.gh.gitRoot, "alice", "notes.git"));
    const fetched = await w.sync.sync("fetch", "backlog", project, "c");
    assert.deepEqual(fetched, { handled: true, ok: true, message: "github.com/alice/notes の backlog を取ってきました（@alice）" });
    assert.equal(git(dir, "rev-parse", "refs/remotes/origin/backlog").trim(), remote);
    assert.equal(git(dir, "rev-parse", "refs/heads/backlog").trim(), local);

    // 先を越されたまま送る——force しないので断られ、理由を言う
    commitOnBranch(dir, "backlog", '{"format":"banto-backlog/1","items":[],"y":1}\n');
    const rejected = await w.sync.sync("push", "backlog", project, "c");
    assert.equal(rejected.handled && rejected.ok, false);
    assert.match((rejected as { message: string }).message, /origin のブランチが先に進んでいます/);
    assert.equal(bareHead(w.gh, "backlog"), remote, "force で上書きした");

    // origin にまだ無いブランチを取ってくる——失敗ではなく「まだ無い」
    assert.deepEqual(await w.sync.sync("fetch", "nothing-here", project, "c"), {
      handled: true,
      ok: true,
      absent: true,
      message: "github.com/alice/notes にはまだ nothing-here がありません",
    });
    // Project の根がリポジトリの下のフォルダでも、同じリポジトリ
    mkdirSync(join(dir, "docs"));
    const inner = await w.sync.sync("fetch", "backlog", { ...project, root: join(dir, "docs") }, "c");
    assert.equal(inner.handled && inner.ok, true);
  });
});

test("引き受けないものは理由だけ返す（台帳に無い・アカウントが決まっていない・登録が外れた・GitHub の外・origin が無い）", async () => {
  await withWorld(async (w) => {
    const { dir, project } = await w.cloned();
    commitOnBranch(dir, "backlog", "{}\n");
    assert.deepEqual(await w.sync.sync("push", "backlog", project, "c"), {
      handled: false,
      reason: "このリポジトリを扱うアカウントが決まっていません（読むだけ）",
    });
    await w.store.update((e) => ({ entries: e.map((x) => ({ ...x, account: "bob" })), result: undefined }));
    assert.deepEqual(await w.sync.sync("push", "backlog", project, "c"), { handled: false, reason: "@bob は登録が外れています" });

    const other = join(w.home, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    assert.deepEqual(await w.sync.sync("push", "backlog", { ...project, root: other }, "c"), {
      handled: false,
      reason: "このリポジトリは Repositories の一覧にありません",
    });
    await w.store.update((e) => ({ entries: [...e, { path: other }], result: undefined }));
    assert.deepEqual(await w.sync.sync("push", "backlog", { ...project, root: other }, "c"), { handled: false, reason: "origin がありません" });
    git(other, "remote", "add", "origin", "https://gitlab.example.com/a/b.git");
    assert.deepEqual(await w.sync.sync("push", "backlog", { ...project, root: other }, "c"), {
      handled: false,
      reason: "origin が GitHub の外です（https://gitlab.example.com/a/b.git）",
    });
    const plain = join(w.home, "plain");
    mkdirSync(plain);
    assert.deepEqual(await w.sync.sync("push", "backlog", { ...project, root: plain }, "c"), {
      handled: false,
      reason: "この Project の根は git のリポジトリではありません",
    });
    assert.equal(bareHead(w.gh, "backlog"), undefined);
  });
});

test("送り先・取ってくる先を変える設定があれば、どちらもしない。origin が台帳の場所でなければ送らない", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { dir, project } = await w.cloned({ account: "alice" });
    commitOnBranch(dir, "backlog", "{}\n");
    const requests = () => w.gh.gitRequests.length;
    let before = requests();
    git(dir, "config", "url.https://evil.example.com/.insteadOf", w.gh.endpoints.web + "/");
    for (const d of ["push", "fetch"] as const) {
      const r = await w.sync.sync(d, "backlog", project, "c");
      assert.equal(r.handled && !r.ok, true);
      assert.match((r as { message: string }).message, /送り先や TLS を変える設定があります（url\.https:\/\/evil\.example\.com\/\.insteadof）/);
    }
    git(dir, "config", "--unset", `url.https://evil.example.com/.insteadOf`);
    git(dir, "config", "remote.origin.uploadpack", "/tmp/x");
    assert.match((await w.sync.sync("fetch", "backlog", project, "c") as { message: string }).message, /remote\.origin\.uploadpack/);
    git(dir, "config", "--unset", "remote.origin.uploadpack");
    assert.equal(requests(), before, "断ったのに GitHub に話しかけた");

    // push 先を足す設定（pushurl）も、送り先を変える設定として断る
    git(dir, "remote", "set-url", "--push", "origin", `${w.gh.endpoints.web}/alice/other.git`);
    before = requests();
    assert.match((await w.sync.sync("push", "backlog", project, "c") as { message: string }).message, /remote\.origin\.pushurl/);
    git(dir, "config", "--unset", "remote.origin.pushurl");
    // origin の URL が2つ——1つに決められないので送らない
    git(dir, "remote", "set-url", "--add", "origin", `${w.gh.endpoints.web}/alice/other.git`);
    const r = await w.sync.sync("fetch", "backlog", project, "c");
    assert.match((r as { message: string }).message, /取ってくる先（.*alice\/notes\.git・.*alice\/other\.git）が github\.com\/alice\/notes の1つではない/);
    assert.equal(requests(), before);
  });
});

test("ブランチ名は1つの ref だけ——refspec・option・範囲に読める字は受けない", async () => {
  for (const ok of ["backlog", "team/backlog", "backlog-2026.10", "a_b"]) assert.equal(isSafeBranchName(ok), true, ok);
  for (const bad of ["", "-f", "+main", "main:main", "a..b", "a b", "refs/*", "x.lock", "x/", "x/.y", "a@{1}", "/x", ".x", "a~1", "a^"]) {
    assert.equal(isSafeBranchName(bad), false, bad);
  }
  await withWorld(async (w) => {
    const { project } = await w.cloned();
    await assert.rejects(() => w.sync.sync("push", "+main:main", project, "c"), /ブランチ名として受け付けられない/);
  });
});

test("口は中継からだけ（可視性 module・ブランチ名を識別子として名乗る）。Project は刻印と host の台帳の両方で決まる", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-branch-server-")));
  const asked: Array<string | undefined> = [];
  let answer: ProjectSummary | Error = { id: "p1", name: "ノート", root: home, status: "active" };
  const server = createRepositoriesServer({
    dataDir: join(home, ".data"),
    projects: {
      listProjects: async () => [],
      callerProject: async (callId) => {
        asked.push(callId);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    home,
    vault: new MemoryVault(),
    github: httpGithub({ web: "http://127.0.0.1:9", api: "http://127.0.0.1:9" }),
    notices: new RecordingNotices(),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, meta: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { branch: "backlog" }, _meta: meta })) as { content: { text: string }[]; isError?: boolean };
  try {
    const { tools } = await client.listTools();
    for (const n of ["push_branch", "fetch_branch"]) {
      const t = tools.find((x) => x.name === n)!;
      assert.equal((t._meta as Record<string, unknown>)[VISIBILITY_META_KEY], "module", n);
      assert.deepEqual((t._meta as Record<string, unknown>)[AUDIT_ARGS_META_KEY], ["branch"], n);
    }
    // 刻印が無い・banto 全体のため——断る（host に聞きにも行かない）
    for (const meta of [{}, { [CALLER_META_KEY]: { instance: true } }, { [CALLER_META_KEY]: { admin: true } }]) {
      const r = await call("push_branch", meta);
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /Project のための呼び出しからだけ/);
    }
    assert.deepEqual(asked, []);
    // 刻印と host の台帳が違う——断る
    const mismatch = await call("push_branch", { [CALLER_META_KEY]: { project: "p2" }, [CALL_ID_META_KEY]: "call-9" });
    assert.match(mismatch.content[0]!.text, /刻印の Project（p2）と、host の台帳の Project（p1）が違います/);
    assert.deepEqual(asked, ["call-9"], "呼び出しの印を host に渡していない");
    // 一致——Project の根（ここは git でない）で決まり、理由だけ返る
    const r = await call("fetch_branch", { [CALLER_META_KEY]: { project: "p1" }, [CALL_ID_META_KEY]: "call-10" });
    assert.equal(r.isError, undefined, r.content[0]!.text);
    assert.deepEqual(JSON.parse(r.content[0]!.text), { handled: false, reason: "この Project の根は git のリポジトリではありません" });
    // 人が Project の画面から押した（admin + forProject）も Project のための呼び出し
    const human = await call("fetch_branch", { [CALLER_META_KEY]: { admin: true, forProject: "p1" }, [CALL_ID_META_KEY]: "call-11" });
    assert.equal(human.isError, undefined);
    // host が決められない——理由をそのまま返す
    answer = new Error("どの Project のための呼び出しか決められません");
    const unknown = await call("push_branch", { [CALLER_META_KEY]: { project: "p1" } });
    assert.match(unknown.content[0]!.text, /決められません/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
