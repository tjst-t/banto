// GitHub に公開（段階5）。**本物の git で、偽の GitHub（作る API と、本物の `git http-backend` が受ける push）へ**。
// 見るのは：公開できるか（断る理由と次の手）・持ち主の候補と作れそうか・名前のぶつかり・作る→origin→push→台帳・
// コミットが無いとき・push の失敗で作ったものを消さず push だけやり直せる・やめる・トークンが返り値・台帳・
// `.git/config`・ログに出ない・push の送り先を変える設定があれば push しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts } from "./accounts.js";
import { CLONE_TIMEOUTS, GIT_ENV } from "./git.js";
import { httpGithub, type GithubEndpoints } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { PUBLISH_HOOKS, Publisher, type PublishJobView } from "./publish.js";
import { registerGithubHost } from "./remote.js";
import { listRepositories } from "./repositories.js";
import { FAKE_CLIENT_ID, MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

/**
 * 偽の GitHub に話しかける git は**非同期で**（偽物は同じプロセスで動くので、execFileSync で待つと答えられずに止まる）。
 * 止まったら 20 秒で切って理由を言う
 */
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
  account(login: string, token: string, opts?: { ssh?: boolean }): Promise<void>;
  /** ブラウザでログイン（GitHub App のデバイスフロー）でアカウントを登録する——資格情報の種類が app になる */
  appAccount(login: string): Promise<void>;
  endpoints: GithubEndpoints;
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-publish-")));
  const gh = await startFakeGithub();
  registerGithubHost(new URL(gh.endpoints.web).host);
  const vault = new MemoryVault();
  const store = new LedgerStore(join(home, ".data"));
  const github = httpGithub(gh.endpoints);
  const accounts = new GithubAccounts({ store, vault, github, notices: new RecordingNotices(), sleep: async () => undefined });
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
      async account(login, token, opts) {
        const place = vault.seed({ implementation: "vault-local", name: `${login}-pat`, group: "instance", kind: "secret" }, token);
        const ssh = opts?.ssh ? vault.seed({ implementation: "vault-local", name: `${login}-ssh`, group: "instance", kind: "ssh-identity" }, "k") : undefined;
        gh.users.set(token, login);
        await accounts.addWithPat({ patAlias: place, ...(ssh ? { ssh } : {}) }, "c");
      },
      async appAccount(login) {
        await accounts.setAppClientId(FAKE_CLIENT_ID);
        gh.loginForDevice = login;
        gh.script = ["authorized"];
        const flow = await accounts.startLogin({}, "c");
        const r = await accounts.pollLogin(flow.flowId, "c");
        assert.equal(r.state, "done", JSON.stringify(r));
      },
    });
  } finally {
    delete PUBLISH_HOOKS.beforePush;
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
    assert.deepEqual(job.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "ledger:done", "push:done"]);
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
    await w.appAccount("alice");
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
    assert.deepEqual(job.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "ledger:done", "push:failed"]);
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
    assert.deepEqual(done.steps.map((s) => `${s.key}:${s.state}`), ["create:done", "origin:done", "ledger:done", "push:skipped"]);
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

test("fine-grained PAT は、インストールが読めても App の見方で断らない——資格情報の種類で見分ける", async () => {
  await withWorld(async (w) => {
    // 偽物は ghu_ で始まるトークンにインストールを返す。PAT として登録したもの（種類 pat）はそれで判断しない
    await w.account("carol", "ghu_looks_like_app_but_pat");
    w.gh.installations.set("carol", []);
    w.gh.orgs.set("open", { login: "open", members: new Map([["carol", "member"]]), membersCanCreate: true });
    const owners = (await w.publisher.targets(undefined, "c")).accounts[0]!.owners;
    assert.deepEqual(owners.map((o) => `${o.login}:${o.create}`), ["carol:unknown", "open:unknown"]);
  });
});

test("push の直前に読み直す：押したあとに送り先を変えられたら・push 先が作った URL でなければ push しない。origin 中にやめたら push しない", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    const pushes = () => w.gh.gitRequests.filter((r) => r.path.endsWith("git-receive-pack") || r.path.includes("service=git-receive-pack")).length;
    const cases: Array<[string, (dir: string) => void, RegExp]> = [
      ["pushInsteadOf", (dir) => git(dir, "config", `url.${w.endpoints.web}/mallory/.pushInsteadOf`, `${w.endpoints.web}/alice/`), /push の送り先や TLS を変える設定がありました（url\./],
      // pushurl は「送り先を変える設定」として先に断られる（どちらでも push しない）
      ["pushurl", (dir) => git(dir, "remote", "set-url", "--push", "origin", `${w.endpoints.web}/mallory/x.git`), /remote\.origin\.pushurl/],
      ["url を替える", (dir) => git(dir, "remote", "set-url", "origin", `${w.endpoints.web}/mallory/y.git`), /1つではありませんでした/],
    ];
    for (const [label, tamper, why] of cases) {
      const name = `t-${cases.findIndex((c) => c[0] === label)}`;
      const dir = await w.repo(name);
      PUBLISH_HOOKS.beforePush = async (path) => tamper(path);
      const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "alice", name, private: true }, "c"));
      assert.equal(job.state, "failed", label);
      assert.equal(job.error!.step, "push", label);
      assert.match(job.error!.message, why, label);
      assert.match(job.error!.message, /push していません。GitHub にはできています/, label);
    }
    assert.equal(pushes(), 0, "読み直して断ったのに push した");
    assert.ok(!w.gh.repos.has("mallory/x") && !w.gh.repos.has("mallory/y"));

    // origin を足している間に「やめる」——push しない
    const dir = await w.repo("stop");
    PUBLISH_HOOKS.beforePush = async (_path, id) => void w.publisher.cancel(id);
    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "stop", private: true }, "c"));
    assert.equal(job.state, "cancelled");
    assert.match(job.error!.message, /push をやめました。GitHub にはできています/);
    assert.equal(pushes(), 0, "やめたのに push した");
  });
});

test("submodule へは辿らない：push.recurseSubmodules=on-demand でも submodule の remote には何も届かない。remote.origin.mirror は push しない側に倒れる", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    w.gh.addRepo("alice", "sub");
    const before = remoteHead(w.gh, "alice", "sub", "main");
    const dir = await w.repo("parent");
    await gitAsync(dir, "-c", "protocol.allow=always", "submodule", "add", "-q", `${w.endpoints.web}/alice/sub.git`, "sub");
    writeFileSync(join(dir, "sub", "new.txt"), "unpushed in submodule");
    git(join(dir, "sub"), "add", ".");
    git(join(dir, "sub"), "commit", "-q", "-m", "sub change");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "bump sub");
    git(dir, "config", "push.recurseSubmodules", "on-demand");
    git(dir, "config", "submodule.recurse", "true");
    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "alice", name: "parent", private: true }, "c"));
    assert.equal(job.state, "done", JSON.stringify(job.error));
    assert.equal(remoteHead(w.gh, "alice", "sub", "main"), before, "submodule の remote に push した");
    assert.ok(!w.gh.gitRequests.some((r) => r.path.startsWith("/alice/sub.git/git-receive-pack")), "submodule の remote に push しに行った");

    // mirror：送るのは決めた1本だけ——mirror の設定があっても、ほかのブランチ・タグは届かない
    // origin を足したあと（押したあと）に mirror を置かれた
    const mir = await w.repo("mirror");
    git(mir, "branch", "-q", "spike");
    git(mir, "tag", "v1");
    PUBLISH_HOOKS.beforePush = async (path) => void git(path, "config", "remote.origin.mirror", "true");
    const m = await finish(w.publisher, await w.publisher.start({ path: mir, login: "alice", owner: "alice", name: "mirror", private: true }, "c"));
    assert.equal(remoteHead(w.gh, "alice", "mirror", "spike"), undefined, "mirror の設定でほかのブランチまで送った");
    assert.notEqual(m.state, "running");
  });
});

test("方式の食い違い（origin が ssh なのに SSH 鍵の無いアカウント等）は push せず理由を言う。頼んだ公開範囲で作られなければ origin も push もしない。作れたか分からなければ名前の話にしない", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    await w.account("sshy", "ghp_sshy_token", { ssh: true });
    const sshHost = w.endpoints.ssh ?? new URL(w.endpoints.web).hostname;
    registerGithubHost(sshHost);
    const a = await w.repo("via-ssh");
    git(a, "remote", "add", "origin", `git@${sshHost}:alice/via-ssh.git`);
    await w.store.update((e) => ({ entries: e.map((x) => (x.path === a ? { ...x, account: "alice" } : x)), result: undefined }));
    assert.equal((await w.publisher.inspect(a)).state, "needs-push");
    await assert.rejects(() => w.publisher.retryPush({ path: a }, "c"), /origin は ssh の URL（git@.*）ですが、@alice は SSH 鍵を登録していません/);
    const b = await w.repo("via-https");
    git(b, "remote", "add", "origin", `${w.endpoints.web}/sshy/via-https.git`);
    await w.store.update((e) => ({ entries: e.map((x) => (x.path === b ? { ...x, account: "sshy" } : x)), result: undefined }));
    await assert.rejects(() => w.publisher.retryPush({ path: b }, "c"), /origin は https の URL（.*）ですが、@sshy は SSH 鍵で push するアカウントです/);

    // 非公開を頼んだのに公開で作られた——origin も push もしない
    w.gh.forcePublic = true;
    const c = await w.repo("leaky");
    const job = await finish(w.publisher, await w.publisher.start({ path: c, login: "alice", owner: "alice", name: "leaky", private: true }, "c"));
    assert.equal(job.state, "failed");
    assert.equal(job.error!.step, "create");
    assert.match(job.error!.message, /公開で作りました（頼んだのは非公開）。origin も push もしていません/);
    assert.throws(() => git(c, "remote", "get-url", "origin"), "食い違ったのに origin を足した");
    assert.equal(remoteHead(w.gh, "alice", "leaky", "main"), undefined, "食い違ったのに push した");
    w.gh.forcePublic = false;

    // 作ってから接続が切れた——作られているかもしれない。名前がぶつかった話にしない
    w.gh.dropAfterCreate = true;
    const d = await w.repo("lost");
    await assert.rejects(
      () => w.publisher.start({ path: d, login: "alice", owner: "alice", name: "lost", private: true }, "c"),
      (err: Error) => /GitHub に作れたかどうか分かりません.*GitHub で alice\/lost を確かめてください——あれば git remote add origin .*\/alice\/lost\.git/s.test(err.message) && !/もう lost があります/.test(err.message),
    );
    assert.ok(w.gh.repos.has("alice/lost"), "偽物の側で作られていない（試験の作りが違う）");
  });
});

test("Project の入口：Root のリポジトリの一番上で台帳の行を引く——台帳にある外側のリポジトリを、中の別のリポジトリの Project に使わない", async () => {
  await withWorld(async (w) => {
    const outer = await w.repo("outer");
    const inner = join(outer, "vendor", "inner");
    mkdirSync(inner, { recursive: true });
    git(inner, "init", "-q");
    mkdirSync(join(outer, "packages", "app"), { recursive: true });
    const lookup = {
      ok: true as const,
      projects: [
        { id: "inner", name: "inner", root: inner, status: "active" as const },
        { id: "app", name: "app", root: `${join(outer, "packages", "app")}/`, status: "active" as const },
      ],
    };
    await assert.rejects(() => w.publisher.resolveFolder({ forProject: "inner" }, lookup), /リポジトリの一覧にありません/);
    assert.equal(await w.publisher.resolveFolder({ forProject: "app" }, lookup), outer);
  });
});

test("持ち主の名前を確かめ、origin の URL は GitHub の返事（作られた持ち主・名前）から組む。一覧に書けなければ push の失敗と混ぜずに言う", async () => {
  await withWorld(async (w) => {
    await w.account("alice", TOKEN);
    const dir = await w.repo("named");
    await assert.rejects(() => w.publisher.start({ path: dir, login: "alice", owner: "../evil", name: "named", private: true }, "c"), /持ち主の名前として読めません/);
    // 大文字で頼んでも、GitHub が返した持ち主（alice）の URL にする
    const job = await finish(w.publisher, await w.publisher.start({ path: dir, login: "alice", owner: "ALICE", name: "named", private: true }, "c"));
    assert.equal(job.state, "done", JSON.stringify(job.error));
    assert.equal(git(dir, "remote", "get-url", "origin").trim(), `${w.endpoints.web}/alice/named.git`);

    // 台帳に書けない
    const other = await w.repo("noledger");
    const started = await w.publisher.start({ path: other, login: "alice", owner: "alice", name: "noledger", private: true }, "c");
    const update = w.store.update.bind(w.store);
    w.store.update = async () => {
      throw new Error("ディスクがいっぱいです");
    };
    const failed = await finish(w.publisher, started);
    w.store.update = update;
    assert.equal(failed.state, "failed");
    assert.equal(failed.error!.step, "ledger");
    assert.match(failed.error!.message, /origin も足しました（github\.com\/alice\/noledger）が、一覧に書けませんでした：ディスクがいっぱいです——push はしていません/);
    assert.deepEqual(failed.steps.map((x) => `${x.key}:${x.state}`), ["create:done", "origin:done", "ledger:failed", "push:waiting"]);
  });
});
