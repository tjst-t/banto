// ブランチを送る・取ってくる口（Backlog が中継で呼ぶ）。**本物の git で、偽の GitHub（本物の `git http-backend`）へ**。
// 見るのは：台帳のアカウントで送れて取ってこれる・トークンが `.git/config` と返事に残らない・引き受けない場合（台帳に
// 無い・アカウントが無い・GitHub の外）は理由だけ・送り先を変える設定があれば送らない・ブランチ名は1つの ref だけ・
// 口は中継からだけで、呼び出し元の Project は host の台帳と刻印の両方で決まる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUDIT_ARGS_META_KEY, CALLER_META_KEY, CALL_ID_META_KEY, VALUE_FREE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { GithubAccounts } from "./accounts.js";
import { BranchSync, accountForRemote, repositoryLabel, watchDirSize, type ProjectGitAccess } from "./branch-sync.js";
import { PROJECT_GIT_BUNDLE_MAX_BYTES, isSafeBranchName, type ProjectGitOrigin } from "@banto/module-contract";
import { GIT_ENV } from "./git.js";
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
    // 別のサーバの Project：根が同じ文字列でも、この機械のフォルダとは別物（v4-security.md §1）。core の口が無ければ引き受けない
    assert.deepEqual(await w.sync.sync("push", "backlog", { ...project, runtime: "remote:lab" }, "c"), {
      handled: false,
      reason: "この Repositories は別のサーバの Project の git に届く口を持っていません",
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
      // repository・account は別のサーバの Project のときだけ載る（載れば承認のカードと鍵に入る）
      assert.deepEqual((t._meta as Record<string, unknown>)[AUDIT_ARGS_META_KEY], ["branch", "repository", "account"], n);
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
    // 送り先を引く口：値を返さない（場所と login だけ）。この機械の Project は {remote: false}、別のサーバは決まり方を返す
    const bt = tools.find((x) => x.name === "branch_target")!;
    assert.equal((bt._meta as Record<string, unknown>)[VISIBILITY_META_KEY], "module");
    assert.equal((bt._meta as Record<string, unknown>)[VALUE_FREE_META_KEY], true);
    const hostTarget = await call("branch_target", { [CALLER_META_KEY]: { project: "p1" }, [CALL_ID_META_KEY]: "call-12" });
    assert.deepEqual(JSON.parse(hostTarget.content[0]!.text), { remote: false });
    answer = { id: "p1", name: "ノート", root: "/home/dev/x", status: "active", runtime: "remote:lab" };
    const farTarget = await call("branch_target", { [CALLER_META_KEY]: { project: "p1" }, [CALL_ID_META_KEY]: "call-13" });
    assert.deepEqual(JSON.parse(farTarget.content[0]!.text), {
      remote: true,
      handled: false,
      reason: "この Repositories は別のサーバの Project の git に届く口を持っていません",
    });
    assert.match((await call("branch_target", {})).content[0]!.text, /Project のための呼び出しからだけ/);
    // host が決められない——理由をそのまま返す
    answer = new Error("どの Project のための呼び出しか決められません");
    const unknown = await call("push_branch", { [CALLER_META_KEY]: { project: "p1" } });
    assert.match(unknown.content[0]!.text, /決められません/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 別のサーバの Project（Backlog #466、v4-modules.md §2.4「別のサーバの Project」） ─────────────────────────────

/**
 * core の口（`relayProjectGit*`）の代わり：「向こう」のリポジトリ（この機械のフォルダで真似る）で、core の台本と同じことを
 * 本物の git でする。呼ばれた口を覚える
 */
class FarRepo implements ProjectGitAccess {
  readonly calls: string[] = [];
  /** 次の bundle をこれに差し替える（大きすぎるものを返す向こう） */
  forgedBundle?: Buffer;
  /** その口で core が断ったのと同じ形で投げる（向こうに繋がらない・core の上限で止まった） */
  failWith?: { op: "origin" | "bundle" | "unbundle"; message: string };
  constructor(readonly dir: string) {}

  private g(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  async origin(): Promise<ProjectGitOrigin> {
    this.calls.push("origin");
    if (this.failWith?.op === "origin") throw new Error(this.failWith.message);
    try {
      this.g("rev-parse", "--git-dir");
    } catch {
      return { kind: "not-repo" };
    }
    let out = "";
    try {
      out = this.g("config", "--local", "--null", "--get-regexp", "^remote\\.origin\\.(url|pushurl)$|^url\\..*\\.(insteadof|pushinsteadof)$");
    } catch {
      out = "";
    }
    const urls: string[] = [];
    const redirects: string[] = [];
    for (const e of out.split("\0").filter(Boolean)) {
      const [key, value] = [e.slice(0, e.indexOf("\n")), e.slice(e.indexOf("\n") + 1)];
      if (key === "remote.origin.url") urls.push(value);
      else redirects.push(key);
    }
    return { kind: "repo", urls, redirects };
  }

  async bundle(branch: string): Promise<Buffer | undefined> {
    this.calls.push(`bundle ${branch}`);
    if (this.failWith?.op === "bundle") throw new Error(this.failWith.message);
    if (this.forgedBundle) return this.forgedBundle;
    try {
      this.g("rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`);
    } catch {
      return undefined;
    }
    return execFileSync("git", ["-C", this.dir, "bundle", "create", "-q", "-", `refs/heads/${branch}`], { stdio: ["ignore", "pipe", "pipe"] });
  }

  async unbundle(branch: string, bundle: Buffer): Promise<void> {
    this.calls.push(`unbundle ${branch}`);
    if (this.failWith?.op === "unbundle") throw new Error(this.failWith.message);
    const file = join(this.dir, "..", "in.bundle");
    writeFileSync(file, bundle);
    try {
      this.g("fetch", "-q", "--no-tags", "--no-write-fetch-head", file, `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    } finally {
      rmSync(file, { force: true });
    }
  }

  async track(branch: string, commit: string): Promise<void> {
    this.calls.push(`track ${branch}`);
    this.g("update-ref", `refs/remotes/origin/${branch}`, commit);
  }
}

/** 偽の GitHub の alice/notes を「向こう」に clone する（台帳には載せない） */
async function farClone(w: World): Promise<{ far: FarRepo; sync: BranchSync; project: ProjectSummary }> {
  w.gh.addRepo("alice", "notes", { writers: ["alice"] });
  const dir = join(w.home, "far", "notes");
  mkdirSync(join(w.home, "far"));
  await gitAsync(w.home, "clone", "-q", `${w.gh.endpoints.web}/alice/notes.git`, dir);
  const far = new FarRepo(dir);
  const sync = new BranchSync({ store: w.store, accounts: w.accounts, vault: w.vault, dataDir: join(w.home, ".data"), endpoints: w.gh.endpoints, projectGit: far });
  // 根は向こうのパス——この機械には無い
  return { far, sync, project: { id: "p9", name: "向こうのノート", root: "/home/dev/notes", status: "active", runtime: "remote:lab" } };
}

/**
 * Backlog と同じ頼み方：先に送り先とアカウントを引き（`branch_target`）、引き受けるならそれを名乗って送る・取ってくる
 * （承認のカードに出るのは名乗りのほう）
 */
async function asBacklog(sync: BranchSync, direction: "push" | "fetch", branch: string, project: ProjectSummary, callId = "c") {
  const d = await sync.remoteTarget(project, callId);
  if (d.kind === "not-handled") return { handled: false as const, reason: d.reason };
  if (d.kind === "refused") return { handled: true as const, ok: false as const, message: d.message };
  return sync.sync(direction, branch, project, callId, { repository: repositoryLabel(d.at), account: d.login });
}

test("別のサーバの Project：clone したときのアカウントで、向こうの中身を host から送り、取ってくる。資格情報は向こうへ出ない", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { far, sync, project: base } = await farClone(w);
    const project = { ...base, clonedFrom: { url: `${w.gh.endpoints.web}/alice/notes.git`, account: "alice" } };
    const mainBefore = bareHead(w.gh, "main");
    const local = commitOnBranch(far.dir, "backlog", '{"format":"banto-backlog/1","items":[]}\n');

    const pushed = await asBacklog(sync, "push", "backlog", project, "c");
    // 最初に引き受けたときに、この Project の送り先として覚える
    assert.deepEqual(pushed, {
      handled: true,
      ok: true,
      message: "backlog を github.com/alice/notes に送りました（@alice、clone したときのアカウント。この Project の送り先として覚えました）",
    });
    assert.equal(bareHead(w.gh, "backlog"), local);
    assert.equal(bareHead(w.gh, "main"), mainBefore, "ほかのブランチが動いた");
    // 向こうの追跡の ref も進む（Backlog はこれで「まだ送っていない」を数える）
    assert.equal(git(far.dir, "rev-parse", "refs/remotes/origin/backlog").trim(), local);
    // origin は2回読む（送り先を引くときと、送る直前に確かめるとき）
    assert.deepEqual(far.calls, ["origin", "origin", "bundle backlog", "track backlog"]);
    assert.ok(w.gh.gitRequests.some((r) => r.authorization !== undefined), "資格情報を渡していない");
    // トークンは向こうのどこにも書かれない。使い捨ての置き場は残らない
    assert.ok(!readFileSync(join(far.dir, ".git", "config"), "utf8").includes(TOKEN));
    assert.deepEqual(readdirSync(join(w.home, ".data", "branch-sync")), []);

    // origin 側で進んだもの（別の手元から送られた）を取ってくる——向こうの追跡の ref だけ。手元のブランチには触らない
    const remote = commitOnBranch("", "backlog", '{"format":"banto-backlog/1","items":[],"x":1}\n', join(w.gh.gitRoot, "alice", "notes.git"));
    far.calls.length = 0;
    const fetched = await asBacklog(sync, "fetch", "backlog", project, "c");
    assert.deepEqual(fetched, { handled: true, ok: true, message: "github.com/alice/notes の backlog を取ってきました（@alice、clone したときのアカウント）" });
    assert.deepEqual(far.calls, ["origin", "origin", "unbundle backlog"]);
    assert.equal(git(far.dir, "rev-parse", "refs/remotes/origin/backlog").trim(), remote);
    assert.equal(git(far.dir, "rev-parse", "refs/heads/backlog").trim(), local);

    // 先を越されたまま送る——force しないので断られ、理由を言う。向こうの追跡の ref は動かさない
    commitOnBranch(far.dir, "backlog", '{"format":"banto-backlog/1","items":[],"y":1}\n');
    const rejected = await asBacklog(sync, "push", "backlog", project, "c");
    assert.equal(rejected.handled && rejected.ok, false);
    assert.match((rejected as { message: string }).message, /origin のブランチが先に進んでいます/);
    assert.equal(bareHead(w.gh, "backlog"), remote, "force で上書きした");
    assert.equal(git(far.dir, "rev-parse", "refs/remotes/origin/backlog").trim(), remote);

    // origin にまだ無いブランチを取ってくる——失敗ではなく「まだ無い」。向こうに無いブランチは送れない
    assert.deepEqual(await asBacklog(sync, "fetch", "nothing-here", project, "c"), {
      handled: true,
      ok: true,
      absent: true,
      message: "github.com/alice/notes にはまだ nothing-here がありません",
    });
    assert.deepEqual(await asBacklog(sync, "push", "nothing-here", project, "c"), {
      handled: true,
      ok: false,
      message: "この Project のリポジトリに nothing-here がありません",
    });
    assert.deepEqual(readdirSync(join(w.home, ".data", "branch-sync")), []);
  });
});

test("別のサーバの Project：送り先は向こうの origin の GitHub の場所を host で組む。送り先を変える設定・GitHub の外・git でないもの", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { far, sync, project } = await farClone(w);
    commitOnBranch(far.dir, "backlog", "{}\n");
    const before = w.gh.gitRequests.length;
    // 送り先を変える設定（向こうの git が送る先と、ここが送る先が食い違う）——どちらもしない
    for (const [key, value] of [
      ["remote.origin.pushurl", `${w.gh.endpoints.web}/alice/other.git`],
      ["url.https://evil.example.com/.insteadOf", `${w.gh.endpoints.web}/`],
      ["url.https://evil.example.com/.pushInsteadOf", `${w.gh.endpoints.web}/`],
    ] as const) {
      git(far.dir, "config", key, value);
      for (const d of ["push", "fetch"] as const) {
        const r = await asBacklog(sync, d, "backlog", project, "c");
        assert.equal(r.handled && !r.ok, true, `${key} ${d}`);
        assert.match((r as { message: string }).message, new RegExp(`送り先を変える設定があります（${key.toLowerCase().replace(/[.]/g, "\\.")}）`), key);
      }
      git(far.dir, "config", "--unset", key);
    }
    // origin が2つ
    git(far.dir, "remote", "set-url", "--add", "origin", `${w.gh.endpoints.web}/alice/other.git`);
    assert.match((await asBacklog(sync, "push", "backlog", project, "c") as { message: string }).message, /origin の URL が1つではない/);
    assert.equal(w.gh.gitRequests.length, before, "断ったのに GitHub に話しかけた");
    // GitHub の外——引き受けない（頼んだ側が自分の git で試す）
    git(far.dir, "remote", "set-url", "--delete", "origin", "other");
    git(far.dir, "remote", "set-url", "origin", "https://gitlab.example.com/a/b.git");
    assert.deepEqual(await asBacklog(sync, "push", "backlog", project, "c"), { handled: false, reason: "origin が GitHub の外です（https://gitlab.example.com/a/b.git）" });
    git(far.dir, "remote", "remove", "origin");
    assert.deepEqual(await asBacklog(sync, "push", "backlog", project, "c"), { handled: false, reason: "origin がありません" });
    const plain = new FarRepo(join(w.home, "far"));
    const plainSync = new BranchSync({ store: w.store, accounts: w.accounts, vault: w.vault, dataDir: join(w.home, ".data"), endpoints: w.gh.endpoints, projectGit: plain });
    assert.deepEqual(await asBacklog(plainSync, "fetch", "backlog", project, "c"), { handled: false, reason: "この Project の根は git のリポジトリではありません" });
    // 方式は向こうの URL ではなくアカウントで決める（ssh の URL でも、トークンのアカウントなら https で送る）
    git(far.dir, "remote", "add", "origin", `ssh://git@${new URL(w.gh.endpoints.web).host}/alice/notes.git`);
    const r = await asBacklog(sync, "push", "backlog", project, "c");
    assert.deepEqual(r, {
      handled: true,
      ok: true,
      message: "backlog を github.com/alice/notes に送りました（@alice、持ち主と同じアカウント。この Project の送り先として覚えました）",
    });
  });
});

test("別のサーバの Project：アカウントが決まらない・登録が外れた・大きすぎる bundle", async () => {
  await withWorld(async (w) => {
    const { far, sync, project } = await farClone(w);
    commitOnBranch(far.dir, "backlog", "{}\n");
    assert.deepEqual(await asBacklog(sync, "push", "backlog", project, "c"), {
      handled: false,
      reason: "github.com/alice/notes を扱うアカウントが決まっていません（clone したときの記録・リポジトリの一覧・持ち主と同じ login のどれも無い）",
    });
    const cloned = { ...project, clonedFrom: { url: `${w.gh.endpoints.web}/alice/notes.git`, account: "bob" } };
    assert.deepEqual(await asBacklog(sync, "push", "backlog", cloned, "c"), { handled: false, reason: "@bob（clone したときのアカウント）は登録が外れています" });
    await addAccount(w, "alice", TOKEN);
    // 向こうが上限を越える bundle を返した——送らない
    far.forgedBundle = Buffer.alloc(PROJECT_GIT_BUNDLE_MAX_BYTES + 1);
    const big = await asBacklog(sync, "push", "backlog", project, "c");
    assert.equal(big.handled && !big.ok, true);
    assert.match((big as { message: string }).message, /backlog が大きすぎて、別のサーバとの間で運べません/);
    // 壊れた bundle——取り込めずに、引き受けて断る（投げると Backlog が自分の git で送り直そうとする。レビュー M2）
    far.forgedBundle = Buffer.from("# v2 git bundle\n0000000000000000000000000000000000000000 refs/heads/backlog\n\nPACKgarbage");
    const broken = await asBacklog(sync, "push", "backlog", project);
    assert.equal(broken.handled && !broken.ok, true, JSON.stringify(broken));
    assert.match((broken as { message: string }).message, /push できませんでした：向こうから来た backlog を取り込めませんでした/);
    delete far.forgedBundle;
    // core の上限で止まった（向こうの bundle を読むのをやめた）——同じく引き受けて断る
    far.failWith = { op: "bundle", message: "backlog が大きすぎて、別のサーバとの間で運べません（上限は 6MB）" };
    const capped = await asBacklog(sync, "push", "backlog", project);
    assert.deepEqual(capped, { handled: true, ok: false, message: "push できませんでした：backlog が大きすぎて、別のサーバとの間で運べません（上限は 6MB）" });
    // 取り込む途中で切れた（GitHub にある main を取ってきて、向こうへ運ぶところ）
    far.failWith = { op: "unbundle", message: "SSH の接続がありません" };
    assert.deepEqual(await asBacklog(sync, "fetch", "main", project), { handled: true, ok: false, message: "fetch できませんでした：SSH の接続がありません" });
    // origin を読めない（向こうに繋がらない）——引き受けて断る（自前の道も同じ接続の上なので落とさない）
    far.failWith = { op: "origin", message: "別のサーバ「lab」で git を流せません——SSH の接続がありません" };
    assert.deepEqual(await asBacklog(sync, "push", "backlog", project), {
      handled: true,
      ok: false,
      message: "この Project のリポジトリの origin を読めませんでした（別のサーバ「lab」で git を流せません——SSH の接続がありません）——Repositories は送りも取ってきもしません",
    });
    assert.equal(bareHead(w.gh, "backlog"), undefined);
    assert.ok(!existsSync(join(w.home, ".data", "branch-sync")) || readdirSync(join(w.home, ".data", "branch-sync")).length === 0);
  });
});

test("別のサーバの Project のアカウント：clone の記録 → 台帳の同じ場所 → 持ち主と同じ login", () => {
  const at = { owner: "Org", name: "app" };
  const base: ProjectSummary = { id: "p", name: "n", root: "/r", status: "active", runtime: "remote:lab" };
  const cloned = { ...base, clonedFrom: { url: "https://github.com/org/app.git", account: "carol" } };
  const ledger = [{ path: "/a", github: { owner: "org", name: "App" }, account: "dave" }];
  assert.deepEqual(accountForRemote(cloned, at, ledger, ["org"]), { login: "carol", via: "clone したときのアカウント" });
  // clone した場所と origin が違えば断る——次の段（台帳・持ち主と同じ login）へは進まない（origin の書き換えでアカウントを選ばせない）
  const elsewhere = { ...base, clonedFrom: { url: "https://github.com/org/other.git", account: "carol" } };
  assert.match((accountForRemote(elsewhere, at, ledger, ["org"]) as { refused: string }).refused, /github\.com\/org\/other から clone しましたが、origin が github\.com\/Org\/app/);
  // アカウントを選ばずに clone した（公開のもの）——場所が同じなら次の段へ
  assert.deepEqual(accountForRemote({ ...base, clonedFrom: { url: "https://github.com/org/app.git" } }, at, ledger, ["org"]), { login: "dave", via: "リポジトリの一覧のアカウント" });
  // 台帳の行どうしで違えば決めない
  const torn = [...ledger, { path: "/b", github: { owner: "org", name: "app" }, account: "erin" }];
  assert.match((accountForRemote(base, at, torn, []) as { reason: string }).reason, /1つに決まりません（@dave・@erin）/);
  // 同じアカウントの行が2つなら決まる
  assert.deepEqual(accountForRemote(base, at, [...ledger, { path: "/c", github: at, account: "Dave" }], []), { login: "dave", via: "リポジトリの一覧のアカウント" });
  // 台帳に無ければ、持ち主と同じ login
  assert.deepEqual(accountForRemote(base, at, [{ path: "/x", github: at }], ["ORG"]), { login: "ORG", via: "持ち主と同じアカウント" });
  assert.ok("reason" in accountForRemote(base, at, [], ["someone"]));
});

test("別のサーバの Project：最初に引き受けた送り先とアカウントを覚え、origin を書き換えても選び替えない。名乗りが違えば断る", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    await addAccount(w, "bob", "ghp_bob_secret_token_44");
    w.gh.addRepo("bob", "secrets", { private: true, readers: ["bob"], writers: ["bob"] });
    const { far, sync, project } = await farClone(w);
    commitOnBranch(far.dir, "backlog", "{}\n");
    const toBob = () => w.gh.gitRequests.filter((r) => r.path.includes("/bob/secrets")).length;

    // 名乗らない・違う名乗りは断る（覚えない）——中の AI が送る口を直に呼んでも、カードに出ていない場所へは送らない
    assert.match((await sync.sync("push", "backlog", project, "c") as { message: string }).message, /送り先とアカウントを名乗っていない呼び出しです（github\.com\/alice\/notes・@alice）/);
    const wrong = await sync.sync("push", "backlog", project, "c", { repository: "github.com/bob/secrets", account: "bob" });
    assert.match((wrong as { message: string }).message, /名乗った送り先（github\.com\/bob\/secrets・@bob）が、いま決まる送り先（github\.com\/alice\/notes・@alice）と違う/);
    assert.deepEqual([...(await w.store.remoteTargets()).keys()], []);

    // 引き受けたら覚える
    const first = await asBacklog(sync, "push", "backlog", project);
    assert.equal(first.handled && first.ok, true, JSON.stringify(first));
    const pinned = (await w.store.remoteTargets()).get("p9");
    assert.deepEqual({ ...pinned, at: undefined }, { github: { owner: "alice", name: "notes" }, account: "alice", via: "持ち主と同じアカウント", at: undefined });

    // origin を bob/secrets に書き換える——持ち主と同じ login の bob は選ばれず、送りも取ってきもしない
    git(far.dir, "remote", "set-url", "origin", `${w.gh.endpoints.web}/bob/secrets.git`);
    for (const d of ["push", "fetch"] as const) {
      const r = await asBacklog(sync, d, "backlog", project);
      assert.equal(r.handled && !r.ok, true, d);
      assert.match((r as { message: string }).message, /送り先は github\.com\/alice\/notes（@alice）に決めてあります.*origin が github\.com\/bob\/secrets になっている/);
      // 名乗りを bob/secrets にしても同じ
      const named = await sync.sync(d, "backlog", project, "c", { repository: "github.com/bob/secrets", account: "bob" });
      assert.match((named as { message: string }).message, /決めてあります/);
    }
    // GitHub の外に書き換えても、引き受けないで自分の git に任せる（＝別の道で送らせる）のではなく断る
    git(far.dir, "remote", "set-url", "origin", "https://gitlab.example.com/a/b.git");
    assert.match((await asBacklog(sync, "push", "backlog", project) as { message: string }).message, /決めてあります/);
    assert.equal(toBob(), 0, "書き換えた先に話しかけた");
    // 戻せばまた送れる（覚えたアカウントで）
    git(far.dir, "remote", "set-url", "origin", `${w.gh.endpoints.web}/alice/notes.git`);
    commitOnBranch(far.dir, "backlog", '{"a":1}\n');
    assert.deepEqual(await asBacklog(sync, "push", "backlog", project), { handled: true, ok: true, message: "backlog を github.com/alice/notes に送りました（@alice、持ち主と同じアカウント）" });

    // clone の記録があるのに origin が別の場所——最初から断る（覚えていない別の Project）
    const other = { ...project, id: "p10", clonedFrom: { url: `${w.gh.endpoints.web}/alice/notes.git`, account: "alice" } };
    git(far.dir, "remote", "set-url", "origin", `${w.gh.endpoints.web}/bob/secrets.git`);
    const refused = await asBacklog(sync, "fetch", "backlog", other);
    assert.match((refused as { message: string }).message, /github\.com\/alice\/notes から clone しましたが、origin が github\.com\/bob\/secrets/);
    assert.equal((await w.store.remoteTargets()).has("p10"), false);
    assert.equal(toBob(), 0);
  });
});

/** git の形として正しくないコミット（author にメールが無い）1つだけの bundle（`hash-object --literally` で作る） */
function malformedBundle(dir: string): Buffer {
  const repo = join(dir, "malformed");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", repo]);
  const tree = execFileSync("git", ["--git-dir", repo, "mktree"], { input: "", encoding: "utf8" }).trim();
  const body = `tree ${tree}\nauthor nobody 1700000000 +0000\ncommitter nobody 1700000000 +0000\n\nbad\n`;
  const commit = execFileSync("git", ["--git-dir", repo, "hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: body, encoding: "utf8" }).trim();
  execFileSync("git", ["--git-dir", repo, "update-ref", "refs/heads/backlog", commit]);
  return execFileSync("git", ["--git-dir", repo, "bundle", "create", "-q", "-", "refs/heads/backlog"]);
}

test("別のサーバの Project：向こうから来た bundle の中身を fsck で確かめ、git の形として正しくなければ送らない", async () => {
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { far, sync, project } = await farClone(w);
    far.forgedBundle = malformedBundle(w.home);
    const r = await asBacklog(sync, "push", "backlog", project);
    assert.equal(r.handled && !r.ok, true, JSON.stringify(r));
    assert.match((r as { message: string }).message, /git の形として正しくないので送りません：error in commit [0-9a-f]+: missingEmail/);
    assert.equal(bareHead(w.gh, "backlog"), undefined, "正しくない中身を GitHub に送った");
    assert.equal(w.gh.gitRequests.filter((r) => r.path.includes("receive-pack")).length, 0);
  });
});

test("遅い線：ブランチを送る口を処理している間は進み具合を送る——頼んだ側の待ちが数え直され、途中で切れない（レビュー M3）", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-branch-slow-")));
  const slow: ProjectGitAccess = {
    // 向こうへの線が遅い（頼んだ側の待ちの上限より長くかかる）
    origin: () => new Promise((resolve) => setTimeout(() => resolve({ kind: "not-repo" }), 600)),
    bundle: async () => undefined,
    unbundle: async () => undefined,
    track: async () => undefined,
  };
  const server = createRepositoriesServer({
    dataDir: join(home, ".data"),
    projects: {
      listProjects: async () => [],
      callerProject: async () => ({ id: "p1", name: "向こう", root: "/home/dev/x", status: "active", runtime: "remote:lab" }),
    },
    home,
    vault: new MemoryVault(),
    github: httpGithub({ web: "http://127.0.0.1:9", api: "http://127.0.0.1:9" }),
    notices: new RecordingNotices(),
    projectGit: slow,
    progressIntervalMs: 50,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const meta = { [CALLER_META_KEY]: { project: "p1" }, [CALL_ID_META_KEY]: "call-1" };
  try {
    for (const name of ["branch_target", "push_branch", "fetch_branch"]) {
      let beats = 0;
      const r = (await client.callTool({ name, arguments: { branch: "backlog" }, _meta: meta }, undefined, {
        timeout: 200,
        resetTimeoutOnProgress: true,
        onprogress: () => (beats += 1),
      })) as { content: { text: string }[]; isError?: boolean };
      assert.equal(r.isError, undefined, `${name}：${r.content[0]!.text}`);
      assert.ok(beats >= 3, `${name} の進み具合が ${beats} 回`);
    }
    // 進み具合が無ければ切れる（対照）——上の通りは進み具合のおかげ
    await assert.rejects(() => client.callTool({ name: "push_branch", arguments: { branch: "backlog" }, _meta: meta }, undefined, { timeout: 200 }), /timed out/i);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("取ってくる向きは大きさを見張る：置き場が上限を越えたらその場でやめる。大きすぎるブランチは向こうへ運ばない（レビュー L1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-repositories-watch-"));
  try {
    const w = watchDirSize(dir, 1000, 5);
    mkdirSync(join(dir, "objects"));
    writeFileSync(join(dir, "objects", "a"), Buffer.alloc(600));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.signal.aborted, false, "上限の手前で止めた");
    writeFileSync(join(dir, "objects", "b"), Buffer.alloc(600));
    const started = Date.now();
    while (!w.signal.aborted && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 5));
    w.stop();
    assert.equal(w.signal.aborted, true, "上限を越えても止めない");
    assert.equal(w.seen(), 1200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await withWorld(async (w) => {
    await addAccount(w, "alice", TOKEN);
    const { far, sync, project } = await farClone(w);
    // GitHub の側に、上限（6MB）を越えるブランチ（縮まない中身）
    const big = join(w.home, "big");
    execFileSync("git", ["init", "-q", big]);
    writeFileSync(join(big, "blob.bin"), randomBytes(PROJECT_GIT_BUNDLE_MAX_BYTES + 1024 * 1024));
    git(big, "add", "blob.bin");
    git(big, "commit", "-q", "-m", "big");
    git(big, "push", "-q", join(w.gh.gitRoot, "alice", "notes.git"), "HEAD:refs/heads/big");
    far.calls.length = 0;
    const r = await asBacklog(sync, "fetch", "big", project);
    assert.equal(r.handled && !r.ok, true, JSON.stringify(r));
    assert.match((r as { message: string }).message, /big が大きすぎて、別のサーバとの間で運べません/);
    assert.deepEqual(far.calls, ["origin", "origin"], "大きすぎるものを向こうへ運んだ");
    assert.deepEqual(readdirSync(join(w.home, ".data", "branch-sync")), []);
  });
});
