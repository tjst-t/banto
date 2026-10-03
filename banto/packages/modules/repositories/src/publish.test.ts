// GitHub に公開（段階5）。**本物の git で、偽の GitHub（作る API と、本物の `git http-backend` が受ける push）へ**。
// 見るのは：公開できるか（断る理由と次の手）・持ち主の候補と作れそうか・名前のぶつかり・作る→origin→push→台帳・
// コミットが無いとき・push の失敗で作ったものを消さず push だけやり直せる・やめる・トークンが返り値・台帳・
// `.git/config`・ログに出ない・push の送り先を変える設定があれば push しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts } from "./accounts.js";
import { CLONE_TIMEOUTS, GIT_ENV } from "./git.js";
import { httpGithub, type GithubEndpoints } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { Publisher, type PublishJobView } from "./publish.js";
import { registerGithubHost } from "./remote.js";
import { listRepositories } from "./repositories.js";
import { MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface World {
  gh: FakeGithub;
  vault: MemoryVault;
  store: LedgerStore;
  accounts: GithubAccounts;
  publisher: Publisher;
  home: string;
  repoHome: string;
  logs: string[];
  /** 置き場の下に、コミットの入ったリポジトリを作って台帳に足す */
  repo(name: string, opts?: { commits?: number }): Promise<string>;
  /** PAT（か GitHub App のトークン——`ghu_` で始めると偽物は App のものと読む）でアカウントを登録する */
  account(login: string, token: string): Promise<void>;
  endpoints: GithubEndpoints;
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-publish-")));
  const gh = await startFakeGithub();
  registerGithubHost(new URL(gh.endpoints.web).host);
  const vault = new MemoryVault();
  const store = new LedgerStore(join(home, ".data"));
  const github = httpGithub(gh.endpoints);
  const accounts = new GithubAccounts({ store, vault, github, notices: new RecordingNotices() });
  const publisher = new Publisher({ store, accounts, vault, github, endpoints: gh.endpoints, home, dataDir: join(home, ".data") });
  const saved = { HOME: GIT_ENV.HOME, XDG: GIT_ENV.XDG_CONFIG_HOME, idle: CLONE_TIMEOUTS.idle };
  GIT_ENV.HOME = join(home, "user");
  GIT_ENV.XDG_CONFIG_HOME = join(home, "user", ".config");
  mkdirSync(GIT_ENV.HOME, { recursive: true });
  const logs: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const repoHome = join(home, "banto");
  try {
    await fn({
      gh,
      vault,
      store,
      accounts,
      publisher,
      home,
      repoHome,
      logs,
      endpoints: gh.endpoints,
      async repo(name, opts) {
        const dir = join(repoHome, name);
        mkdirSync(dir, { recursive: true });
        git(dir, "init", "-q");
        for (let i = 0; i < (opts?.commits ?? 2); i += 1) {
          writeFileSync(join(dir, `f${i}.txt`), String(i));
          git(dir, "add", ".");
          git(dir, "commit", "-q", "-m", `c${i}`);
        }
        await store.update((e) => ({ entries: [...e, { path: dir }], result: undefined }));
        return dir;
      },
      async account(login, token) {
        const place = vault.seed({ implementation: "vault-local", name: `${login}-pat`, group: "instance", kind: "secret" }, token);
        gh.users.set(token, login);
        await accounts.addWithPat({ patAlias: place }, "c");
      },
    });
  } finally {
    for (const k of ["log", "error", "warn"] as const) console[k] = original[k];
    GIT_ENV.HOME = saved.HOME;
    GIT_ENV.XDG_CONFIG_HOME = saved.XDG;
    CLONE_TIMEOUTS.idle = saved.idle;
    await gh.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function finish(p: Publisher, job: PublishJobView): Promise<PublishJobView> {
  let v = job;
  for (let i = 0; i < 400 && v.state === "running"; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
    v = p.status(job.id);
  }
  return v;
}

/** 偽の GitHub の bare リポジトリの、そのブランチの先頭（無ければ undefined） */
function remoteHead(gh: FakeGithub, owner: string, name: string, branch: string): string | undefined {
  try {
    return execFileSync("git", ["--git-dir", join(gh.gitRoot, owner, `${name}.git`), "rev-parse", `refs/heads/${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const TOKEN = "ghp_publish_secret_7Hq";

test("公開：空のリポジトリを作り、origin を足し、いまのブランチを upstream つきで push し、台帳に場所とアカウントを書く。トークンはどこにも残らない", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    const dir = await w.repo("hermes", { commits: 3 });
    git(dir, "branch", "-q", "spike");

    const ins = await w.publisher.inspect(dir);
    assert.equal(ins.refusal, undefined);
    assert.equal(ins.state, "local");
    assert.equal(ins.name, "hermes");
    assert.deepEqual({ branch: ins.branch!.branch, commits: ins.branch!.commits, other: ins.branch!.otherBranches, unborn: ins.branch!.unborn }, { branch: "main", commits: 3, other: ["spike"], unborn: false });
    assert.equal(ins.branch!.lastCommit!.subject, "c2");

    // fine-grained PAT（scope の見出しが無く、インストールも読めない）——作れるかは分からないと言う
    const targets = await w.publisher.targets(dir, "c");
    assert.deepEqual(targets.accounts.map((a) => ({ login: a.login, owners: a.owners.map((o) => `${o.login}:${o.kind}:${o.create}`) })), [{ login: "alice", owners: ["alice:user:unknown"] }]);
    assert.equal(targets.preselected, "alice");
    assert.deepEqual(await w.publisher.checkName({ login: "alice", owner: "alice", name: "hermes" }, "c"), {});

    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "hermes", private: true, description: "記憶の検証" }, "c"));
    assert.equal(job.state, "done", JSON.stringify(job.error));
    assert.deepEqual(job.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "push:done"]);
    assert.deepEqual(w.gh.created, [{ owner: "alice", name: "hermes", private: true, description: "記憶の検証", by: "alice" }]);
    // 送ったのは main だけ（spike は送らない）
    assert.equal(remoteHead(w.gh, "alice", "hermes", "main"), git(dir, "rev-parse", "HEAD").trim());
    assert.equal(remoteHead(w.gh, "alice", "hermes", "spike"), undefined, "ほかのブランチまで送った");
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main");
    assert.equal(git(dir, "remote", "get-url", "origin").trim(), `${w.endpoints.web}/alice/hermes.git`);
    // 台帳：場所とアカウント
    const entry = (await w.store.entries()).find((e) => e.path === dir)!;
    assert.deepEqual({ github: entry.github, account: entry.account }, { github: { owner: "alice", name: "hermes" }, account: "alice" });
    assert.equal((await w.publisher.inspect(dir)).state, "published");
    // トークンは渡った（push の要求に Basic で）が、残っていない
    assert.ok(w.gh.gitRequests.some((r) => r.authorization?.startsWith("Basic ")), "push に資格情報が渡っていない");
    const leaks = [
      ["返り値", JSON.stringify(job) + JSON.stringify(ins) + JSON.stringify(targets)],
      [".git/config", readFileSync(join(dir, ".git", "config"), "utf8")],
      ["台帳", readdirSync(join(w.home, ".data")).map((f) => (f.endsWith(".json") ? readFileSync(join(w.home, ".data", f), "utf8") : "")).join("")],
      ["ログ", w.logs.join("\n")],
    ];
    for (const [where, text] of leaks) assert.ok(!text!.includes(TOKEN), `${where} にトークンが出た`);
  });
});

test("名前のぶつかり：GitHub に同じ名前があれば断り、空いている名前を出す。押しても作らず origin も足さない", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    w.gh.addRepo("alice", "dup");
    w.gh.addRepo("alice", "dup-2");
    const dir = await w.repo("dup");
    assert.deepEqual(await w.publisher.checkName({ login: "alice", owner: "alice", name: "dup" }, "c"), { taken: true, suggestion: "dup-3" });
    assert.deepEqual(await w.publisher.checkName({ login: "alice", owner: "alice", name: "a b" }, "c"), { invalid: "使えるのは英数字と - _ . だけです（100字まで）" });
    await assert.rejects(() => w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "dup", private: false }, "c"), /あなたのアカウントには、もう dup があります/);
    assert.throws(() => git(dir, "remote", "get-url", "origin"), "作れなかったのに origin を足した");
    assert.equal((await w.publisher.inspect(dir)).state, "local");
  });
});

test("持ち主の候補：Organization（owner なら作れる・メンバーは Org の設定次第）・GitHub App は入っている先と Administration・classic PAT は scope", async () => {
  await withWorld(async (w) => {
    await w.account("alice", "ghu_alice_app_token");
    w.gh.orgs.set("acme", { login: "acme", members: new Map([["alice", "member"]]), membersCanCreate: false });
    w.gh.orgs.set("lab", { login: "lab", members: new Map([["alice", "admin"]]), membersCanCreate: false });
    w.gh.orgs.set("open", { login: "open", members: new Map([["alice", "member"]]), membersCanCreate: true });
    // App は alice（Administration あり）と lab（読むだけ）、open（あり）に入っている。acme には入っていない
    w.gh.installations.set("alice", [
      { account: "alice", administration: "write" },
      { account: "lab", administration: "read" },
      { account: "open", administration: "write" },
    ]);
    const dir = await w.repo("tool");
    const owners = (await w.publisher.targets(dir, "c")).accounts[0]!.owners;
    assert.deepEqual(owners.map((o) => `${o.login}:${o.create}`), ["alice:yes", "acme:no", "lab:no", "open:yes"]);
    assert.match(owners[1]!.note!, /GitHub App が acme に入っていません/);
    assert.match(owners[2]!.note!, /Administration（Read and write）の権限がありません.*Permissions & events/);

    // Organization に作る
    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "open", name: "tool", private: false }, "c"));
    assert.equal(job.state, "done", JSON.stringify(job.error));
    assert.deepEqual(job.target, { owner: "open", name: "tool", private: false, htmlUrl: "https://github.com/open/tool" });
    assert.equal(git(dir, "remote", "get-url", "origin").trim(), `${w.endpoints.web}/open/tool.git`);

    // 作れない先に押した——GitHub の断りを、何をどこで足すかつきで返す
    const other = await w.repo("other");
    await assert.rejects(() => w.publisher.start({ path: other, login: "alice", owner: "lab", name: "other", private: true }, "c"), /GitHub App にリポジトリを作る権限がありません——GitHub App の設定/);
    w.gh.installations.set("alice", [{ account: "alice", administration: "write" }, { account: "acme", administration: "write" }]);
    await assert.rejects(() => w.publisher.start({ path: other, login: "alice", owner: "acme", name: "other", private: true }, "c"), /GitHub が acmeに作るのを断りました（HTTP 403：You need admin access/);
    // メンバーが作れない Org（App は入っている）——作れないと先に言う
    const acme = (await w.publisher.targets(other, "c")).accounts[0]!.owners.find((o) => o.login === "acme")!;
    assert.equal(acme.create, "no");
    assert.match(acme.note!, /メンバーがリポジトリを作れない設定です/);

    // classic PAT：repo なら作れる、public_repo だけなら公開のものだけ、無ければ作れない
    await w.account("bob", "ghp_bob_classic");
    for (const [scopes, expect] of [["repo, read:org", "yes"], ["public_repo", "yes:public"], ["read:user", "no"]] as const) {
      w.gh.tokenScopes.set("ghp_bob_classic", scopes);
      const bob = (await w.publisher.targets(undefined, "c")).accounts.find((a) => a.login === "bob")!.owners[0]!;
      assert.equal(`${bob.create}${bob.publicOnly ? ":public" : ""}`, expect, scopes);
    }
  });
});

test("push に失敗しても、作ったリポジトリは消さず「GitHub にはできています」と言い、push だけやり直せる", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    const dir = await w.repo("flaky");
    w.gh.rejectPush.add("alice/flaky");
    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "flaky", private: true }, "c"));
    assert.equal(job.state, "failed");
    assert.deepEqual(job.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "push:failed"]);
    assert.equal(job.error!.step, "push");
    assert.match(job.error!.message, /push する権限がありません.*GitHub にはできています（github\.com\/alice\/flaky）。push だけやり直せます/s);
    assert.ok(w.gh.repos.has("alice/flaky"), "作ったリポジトリを消した");
    // フォルダから「push だけやり直す」状態が導ける（印は持たない）
    const ins = await w.publisher.inspect(dir);
    assert.deepEqual({ state: ins.state, github: ins.github, account: ins.account }, { state: "needs-push", github: { owner: "alice", name: "flaky" }, account: "alice" });
    await assert.rejects(() => w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "flaky-2", private: true }, "c"), /もう GitHub にあります/);

    w.gh.rejectPush.delete("alice/flaky");
    const retry = await finish(w.publisher, await w.publisher.retryPush({ path: dir }, "c"));
    assert.equal(retry.state, "done", JSON.stringify(retry.error));
    assert.equal(remoteHead(w.gh, "alice", "flaky", "main"), git(dir, "rev-parse", "HEAD").trim());
    assert.equal((await w.publisher.inspect(dir)).state, "published");
    await assert.rejects(() => w.publisher.retryPush({ path: dir }, "c"), /もう GitHub にあります/);
  });
});

test("push をやめても作ったリポジトリは残り、やり直せる。コミットが無ければ origin を足すところまで", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    const dir = await w.repo("slow");
    w.gh.gitDelayMs = 2000;
    const started = await w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "slow", private: false }, "c");
    for (let i = 0; i < 200 && w.publisher.status(started.id).steps.find((s) => s.key === "push")!.state !== "running"; i += 1) await new Promise((r) => setTimeout(r, 10));
    w.publisher.cancel(started.id);
    const job = await finish(w.publisher, started);
    assert.equal(job.state, "cancelled");
    assert.match(job.error!.message, /push をやめました。GitHub にはできています（github\.com\/alice\/slow）/);
    w.gh.gitDelayMs = 0;
    assert.equal((await w.publisher.inspect(dir)).state, "needs-push");

    // まだコミットが無い——作って origin を足すところまで（push しない）
    const empty = join(w.repoHome, "fresh");
    mkdirSync(empty, { recursive: true });
    git(empty, "init", "-q");
    await w.store.update((e) => ({ entries: [...e, { path: empty }], result: undefined }));
    const before = w.gh.gitRequests.length;
    const done = await finish(w.publisher, await w.publisher.start({ path: empty, login: "alice", owner: "alice", name: "fresh", private: true }, "c"));
    assert.equal(done.state, "done");
    assert.equal(done.noCommits, true);
    assert.deepEqual(done.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "push:skipped"]);
    assert.equal(w.gh.gitRequests.length, before, "コミットが無いのに push した");
    assert.equal(git(empty, "remote", "get-url", "origin").trim(), `${w.endpoints.web}/alice/fresh.git`);
  });
});

test("断る：一覧に無い・origin が GitHub の外・worktree・detached・push の送り先や TLS を変える設定。Project の画面からは刻印の Project の Root を含む行", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    assert.match((await w.publisher.inspect(join(w.repoHome, "nope"))).refusal!, /一覧に無いフォルダは公開しません/);
    const elsewhere = await w.repo("lab");
    git(elsewhere, "remote", "add", "origin", "https://gitlab.com/me/lab.git");
    assert.match((await w.publisher.inspect(elsewhere)).refusal!, /origin が GitHub の外（https:\/\/gitlab\.com\/me\/lab\.git）を指しています/);

    const main = await w.repo("body");
    const wt = join(w.repoHome, "body-wt");
    git(main, "worktree", "add", "-q", "-b", "x", wt);
    await w.store.update((e) => ({ entries: [...e, { path: wt }], result: undefined }));
    assert.match((await w.publisher.inspect(wt)).refusal!, /worktree からは公開しません——本体（~\/banto\/body）の行から/);

    const det = await w.repo("det");
    git(det, "checkout", "-q", "--detach");
    assert.match((await w.publisher.inspect(det)).refusal!, /detached HEAD/);
    // 一覧でも detached HEAD のリポジトリを「読めません」にしない（段階1からの不具合を段階5で直した）
    const detRow = (await listRepositories(w.store, { ok: true, projects: [] }, w.home)).rows.find((r) => r.path === det)!;
    assert.equal(detRow.state, "ok", JSON.stringify(detRow));

    for (const [key, value] of [["url.https://github.com/mallory/.insteadOf", "https://github.com/alice/"], ["http.sslVerify", "false"], ["http.proxy", "http://127.0.0.1:9"]]) {
      const trap = await w.repo(`trap-${w.gh.created.length}-${key.length}`);
      git(trap, "config", key!, value!);
      const ins = await w.publisher.inspect(trap);
      assert.match(ins.refusal ?? "", /push の送り先や TLS を変える設定があります/, key);
      await assert.rejects(() => w.publisher.start({ path: trap, login: "alice", owner: "alice", name: "trap", private: true }, "c"), /push の送り先や TLS を変える設定/);
    }
    assert.deepEqual(w.gh.created, [], "断ったのに GitHub に作った");
    // push だけやり直す場面（GitHub の origin がある）で pushurl が別の場所を指す——やり直さない
    const half = await w.repo("half");
    git(half, "remote", "add", "origin", `${w.endpoints.web}/alice/half.git`);
    git(half, "config", "remote.origin.pushurl", `${w.endpoints.web}/mallory/half.git`);
    await w.store.update((e) => ({ entries: e.map((x) => (x.path === half ? { ...x, account: "alice" } : x)), result: undefined }));
    assert.match((await w.publisher.inspect(half)).refusal ?? "", /push の送り先や TLS を変える設定があります（remote\.origin\.pushurl）/);
    await assert.rejects(() => w.publisher.retryPush({ path: half }, "c"), /push の送り先や TLS を変える設定/);
    assert.equal(w.gh.gitRequests.length, 0, "断ったのに push した");

    // Project の画面から：刻印の Project の Root（リポジトリの下のフォルダでも）を含む台帳の行
    mkdirSync(join(main, "packages", "app"), { recursive: true });
    const lookup = { ok: true as const, projects: [{ id: "p1", name: "app", root: join(main, "packages", "app"), status: "active" as const }, { id: "p2", name: "外", root: join(w.home, "elsewhere"), status: "active" as const }] };
    assert.equal(await w.publisher.resolveFolder({ forProject: "p1" }, lookup), main);
    await assert.rejects(() => w.publisher.resolveFolder({ forProject: "p2" }, lookup), /リポジトリの一覧にありません——一覧の「フォルダを Import」で足してから/);
    await assert.rejects(() => w.publisher.resolveFolder({}, lookup), /Project の画面の中で開くか、リポジトリの一覧から開いてください/);
  });
});
