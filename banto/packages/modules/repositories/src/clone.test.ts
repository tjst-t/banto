// URL から clone・新しいリポジトリ。**本物の git で、偽の GitHub（git の smart HTTP を本物の `git http-backend` で
// 答える）から clone する**。見るのは：元の読み方・もう手元にある／clone し直す・置く場所・アカウントと資格情報の
// 渡し方（トークンが ps・環境・ログ・台帳・返り値に出ない）・clone の間も設定の罠が走らない・進み具合・時間切れ・
// やめる・失敗の理由と次の手・新しいリポジトリ（ブランチ名・ぶつかり・GitHub に同じ名前）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts } from "./accounts.js";
import { Cloner, parseCloneSource, remoteKey, type CloneJobView } from "./clone.js";
import { CLONE_TIMEOUTS, GIT_ENV, readFolder } from "./git.js";
import { httpGithub, type GithubEndpoints } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { registerGithubHost } from "./remote.js";
import { credentialParent } from "./credential-server.js";
import { makeTlsCert, MemoryVault, RecordingNotices, startFakeGithub, type FakeGithub } from "./test-fakes.js";

const GH: GithubEndpoints = { web: "https://github.com", api: "https://api.github.com", ssh: "github.com" };

test("clone の元を読む——GitHub は owner/name に、外は URL のまま。手元・file・git・ext・資格情報入りの URL は断る", () => {
  const gh = (owner: string, name: string) => ({ kind: "github", owner, name });
  for (const text of ["tjst-t/banto", "github.com/tjst-t/banto", "https://github.com/tjst-t/banto.git", "https://github.com/tjst-t/banto/", "git@github.com:tjst-t/banto.git", "ssh://git@github.com/tjst-t/banto.git"]) {
    assert.deepEqual(parseCloneSource(text, GH), gh("tjst-t", "banto"), text);
  }
  // 行き先を替えた GitHub（偽物）も GitHub と読む
  assert.deepEqual(parseCloneSource("http://127.0.0.1:4555/a/b.git", { web: "http://127.0.0.1:4555", api: "x" }), gh("a", "b"));
  assert.deepEqual(parseCloneSource("https://gitlab.com/tjst-t/notes.git", GH), { kind: "elsewhere", url: "https://gitlab.com/tjst-t/notes.git", host: "gitlab.com", name: "notes" });
  assert.deepEqual(parseCloneSource("git@gitlab.com:group/sub/zine.git", GH), { kind: "elsewhere", url: "git@gitlab.com:group/sub/zine.git", host: "gitlab.com", name: "zine" });
  const reason = (text: string) => {
    const r = parseCloneSource(text, GH);
    assert.equal(r.kind, "invalid", text);
    return (r as { reason: string }).reason;
  };
  assert.match(reason("/srv/git/x.git"), /手元のフォルダは clone しません/);
  assert.match(reason("~/code/x"), /手元のフォルダ/);
  assert.match(reason("file:///srv/x.git"), /file:\/\/ の URL は受けません/);
  assert.match(reason("git://github.com/a/b"), /暗号化されない/);
  // http は行き先を替えた GitHub（試験の偽物）だけ
  assert.match(reason("http://gitlab.example.com/a/b.git"), /http:\/\/ は暗号化されないので受けません/);
  assert.match(reason("ext::sh -c touch% /tmp/pwned"), /URL として読めません/);
  assert.match(reason("-uhttps://evil/x"), /URL として読めません/);
  assert.match(reason("https://user:ghp_secret@github.com/a/b"), /資格情報を書かないで/);
  assert.match(reason("https://github.com/only-owner"), /owner\/repo の形/);
  assert.match(reason(""), /URL を入れてください/);
  assert.equal(remoteKey("git@gitlab.com:a/b.git"), remoteKey("https://gitlab.com/a/b"));
  assert.equal(remoteKey("ssh://git@gitlab.com/a/b.git"), remoteKey("https://GitLab.com/a/b/"));
});

interface World {
  gh: FakeGithub;
  vault: MemoryVault;
  store: LedgerStore;
  accounts: GithubAccounts;
  cloner: Cloner;
  home: string;
  repoHome: string;
  logs: string[];
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-clone-")));
  const gh = await startFakeGithub();
  registerGithubHost(new URL(gh.endpoints.web).host);
  const vault = new MemoryVault();
  const store = new LedgerStore(join(home, ".data"));
  const github = httpGithub(gh.endpoints);
  const accounts = new GithubAccounts({ store, vault, github, notices: new RecordingNotices() });
  const cloner = new Cloner({ store, accounts, vault, github, endpoints: gh.endpoints, home, dataDir: join(home, ".data") });
  // git が読む人の設定は使い捨ての home に（この機械の ~/.gitconfig を試験に混ぜない）
  const saved = { HOME: GIT_ENV.HOME, XDG: GIT_ENV.XDG_CONFIG_HOME, PATH: GIT_ENV.PATH, idle: CLONE_TIMEOUTS.idle };
  GIT_ENV.HOME = join(home, "user");
  GIT_ENV.XDG_CONFIG_HOME = join(home, "user", ".config");
  mkdirSync(GIT_ENV.HOME, { recursive: true });
  const logs: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    await fn({ gh, vault, store, accounts, cloner, home, repoHome: join(home, "banto"), logs });
  } finally {
    Object.assign(console, original);
    GIT_ENV.HOME = saved.HOME;
    GIT_ENV.XDG_CONFIG_HOME = saved.XDG;
    GIT_ENV.PATH = saved.PATH;
    CLONE_TIMEOUTS.idle = saved.idle;
    await gh.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(gh.gitRoot, { recursive: true, force: true });
  }
}

async function finished(w: World, job: CloneJobView): Promise<CloneJobView> {
  for (;;) {
    const s = w.cloner.status(job.id);
    if (s.state !== "running") return s;
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** PAT のアカウントを登録する（値は偽の Vault に、持ち主は偽の GitHub に） */
async function addPatAccount(w: World, login: string, token: string): Promise<void> {
  const place = w.vault.seed({ implementation: "vault-local", name: `${login}-pat`, group: "instance", kind: "secret" }, token);
  w.gh.users.set(token, login);
  await w.accounts.addWithPat({ patAlias: place }, "c");
}

/** いま動いている自分のプロセスの引数と環境（読めるものだけ） */
function processTexts(): string {
  const out: string[] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    for (const f of ["cmdline", "environ"]) {
      try {
        out.push(readFileSync(`/proc/${pid}/${f}`, "latin1"));
      } catch {
        // 消えた・読めない——人のものは見ない
      }
    }
  }
  return out.join("\n");
}

test("公開のリポジトリをアカウント無しで clone し、台帳に足す。もう手元にあるものは clone しない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "hello");
    const look = await w.cloner.inspect({ source: "octo/hello" });
    assert.deepEqual(look.accounts, { logins: [] });
    assert.equal(look.target?.displayPath, "~/banto/hello");
    assert.deepEqual(look.target?.state, { kind: "free" });
    const job = await w.cloner.start({ source: "octo/hello" }, "c");
    assert.equal(job.state, "running");
    const done = await finished(w, job);
    assert.equal(done.state, "done", JSON.stringify(done.error));
    const facts = await readFolder(join(w.repoHome, "hello"));
    assert.equal(facts.kind, "repo");
    assert.deepEqual(await w.store.entries(), [{ path: join(w.repoHome, "hello"), github: { owner: "octo", name: "hello" } }]);
    // 資格情報は使っていない
    assert.ok(w.gh.gitRequests.every((r) => !r.authorization));

    const again = await w.cloner.inspect({ source: "https://github.com/octo/hello" });
    assert.equal(again.have?.displayPath, "~/banto/hello", "もう手元にあるのに clone しようとした");
    await assert.rejects(() => w.cloner.start({ source: "octo/hello" }, "c"), /もう手元にあります（~\/banto\/hello）/);
    assert.deepEqual(w.logs, []);
  });
});

test("非公開は選んだアカウントのトークンで clone する——トークンは ps・環境・ログ・台帳・返り値に出ない", async () => {
  await withWorld(async (w) => {
    const token = "ghp_clone_token_value_7Kq";
    await addPatAccount(w, "alice", token);
    w.gh.addRepo("alice", "secret", { private: true });
    const inspected = await w.cloner.inspect({ source: "alice/secret" });
    assert.deepEqual(inspected.accounts, { logins: ["alice"], preselected: "alice" }, "持ち主と同じ login を先に選んでいない");

    w.gh.gitDelayMs = 400;
    // 前からある窓口（ほかの試験・動いている banto の clone）は数えない——この clone の分だけを見る
    const windowsBefore = new Set(readdirSync(credentialParent()).filter((d) => d.startsWith("banto-git-cred-")));
    const job = await w.cloner.start({ source: "alice/secret" }, "call-9");
    // clone の最中に、どのプロセスの引数にも環境にもトークンが無い
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!processTexts().includes(token), "clone の最中にトークンがプロセスの引数か環境に出ている");
    const done = await finished(w, job);
    w.gh.gitDelayMs = 0;
    assert.equal(done.state, "done", JSON.stringify(done.error));
    assert.equal(done.account, "alice");
    // GitHub には Basic でトークンが届いた（helper が渡した）
    const sent = w.gh.gitRequests.filter((r) => r.authorization).map((r) => Buffer.from(r.authorization!.slice(6), "base64").toString());
    assert.ok(sent.length > 0 && sent.every((s) => s === `alice:${token}`), JSON.stringify(sent));
    // 台帳・返り値・clone 先の設定・ログに無い
    const entries = await w.store.entries();
    assert.deepEqual(entries, [{ path: join(w.repoHome, "secret"), github: { owner: "alice", name: "secret" }, account: "alice" }]);
    for (const [where, text] of [
      ["返り値", JSON.stringify([job, done])],
      ["台帳", readdirSync(join(w.home, ".data")).map((f) => readFileSync(join(w.home, ".data", f), "utf8")).join()],
      ["clone 先の .git/config", readFileSync(join(w.repoHome, "secret", ".git", "config"), "utf8")],
      ["ログ", w.logs.join()],
    ]) {
      assert.ok(!text!.includes(token), `${where} にトークンが出ている`);
    }
    // 資格情報の窓口は片づいた
    assert.deepEqual(
      readdirSync(credentialParent()).filter((d) => d.startsWith("banto-git-cred-") && !windowsBefore.has(d)),
      [],
      "資格情報の窓口が残っている",
    );
    // Vault には押した呼び出しの印で行った
    assert.ok(w.vault.calls.filter((c) => c.op === "resolve").every((c) => c.callId === "call-9" || c.callId === "c"));
  });
});

test("読めないときは理由と次の手の手がかり——アカウント無しは「資格情報」、見えないアカウントは「見つからない」。途中のフォルダは残さない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("alice", "secret", { private: true });
    const anon = await finished(w, await w.cloner.start({ source: "alice/secret" }, "c"));
    assert.equal(anon.state, "failed");
    assert.equal(anon.error?.hint, "auth");
    assert.match(anon.error!.message, /資格情報が通りませんでした/);
    assert.ok(!existsSync(join(w.repoHome, "secret")), "失敗した clone のフォルダが残った");
    assert.deepEqual(await w.store.entries(), []);

    await addPatAccount(w, "bob", "ghp_bob_token_1");
    const bob = await finished(w, await w.cloner.start({ source: "alice/secret", account: "bob" }, "c"));
    assert.equal(bob.error?.hint, "not-found");
    assert.match(bob.error!.message, /見つかりません（非公開なら、このアカウントからは読めません）/);
    assert.ok(!bob.error!.message.includes("ghp_bob_token_1"));
    await assert.rejects(() => w.cloner.start({ source: "alice/secret", account: "carol" }, "c"), /@carol は登録されていません/);
  });
});

test("置く場所がぶつかれば <名前>-2 を先に入れ、人が変えた名前は確かめる。台帳にあるのに見つからない行には clone し直す", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "tool");
    mkdirSync(join(w.repoHome, "tool"), { recursive: true });
    writeFileSync(join(w.repoHome, "tool", "x"), "");
    const look = await w.cloner.inspect({ source: "octo/tool" });
    assert.equal(look.target?.folder, "tool-2");
    assert.equal(look.target?.renamedFrom, "tool");
    const chosen = await w.cloner.inspect({ source: "octo/tool", folder: "tool" });
    assert.deepEqual(chosen.target?.state, { kind: "taken-folder", entries: 1, suggestion: "tool-2" });
    assert.equal((await w.cloner.inspect({ source: "octo/tool", folder: "../x" })).target?.folderInvalid, true);
    await assert.rejects(() => w.cloner.start({ source: "octo/tool", folder: "tool" }, "c"), /もう何かがあります（上書きしません）/);
    assert.equal((await finished(w, await w.cloner.start({ source: "octo/tool" }, "c"))).state, "done");
    assert.ok(existsSync(join(w.repoHome, "tool-2", ".git")));

    // フォルダが消えた——元の場所に clone し直す（台帳の行は1つのまま）
    rmSync(join(w.repoHome, "tool-2"), { recursive: true });
    const again = await w.cloner.inspect({ source: "https://github.com/octo/tool.git" });
    assert.equal(again.reclone?.displayPath, "~/banto/tool-2");
    const re = await finished(w, await w.cloner.start({ source: "octo/tool" }, "c"));
    assert.equal(re.recloned, true);
    assert.equal(re.state, "done");
    assert.equal((await w.store.entries()).length, 1);
    assert.equal((await readFolder(join(w.repoHome, "tool-2"))).kind, "repo");
  });
});

test("GitHub の外はこのマシンの git の設定で clone する——人の CA・credential helper が実際に使われる（GitHub のアカウントは使わない）", async () => {
  await withWorld(async (w) => {
    const tls = makeTlsCert(w.home);
    const other = await startFakeGithub({ tls });
    try {
      other.addRepo("team", "notes");
      other.users.set("tok-team", "teammate");
      other.addRepo("team", "private-notes", { private: true, readers: ["teammate"] });
      // この機械の git の設定：自己署名の CA を信じ、この相手の資格情報を返す helper（使われたら印を残す）
      const mark = join(w.home, "machine-helper-used");
      const helper = join(w.home, "machine-helper.sh");
      writeFileSync(helper, `#!/bin/sh\n[ "$1" = get ] || exit 0\ntouch ${mark}\necho username=teammate\necho password=tok-team\n`);
      chmodSync(helper, 0o755);
      writeFileSync(join(GIT_ENV.HOME!, ".gitconfig"), `[http]\n\tsslCAInfo = ${tls.certPath}\n[credential]\n\thelper = ${helper}\n`);

      const url = `${other.endpoints.web}/team/notes.git`;
      const look = await w.cloner.inspect({ source: url });
      assert.equal(look.source?.kind, "elsewhere");
      assert.equal(look.accounts, undefined);
      const done = await finished(w, await w.cloner.start({ source: url }, "c"));
      assert.equal(done.state, "done", JSON.stringify(done.error));
      assert.deepEqual(await w.store.entries(), [{ path: join(w.repoHome, "notes"), elsewhere: url }]);
      assert.equal((await w.cloner.inspect({ source: url.replace(/\.git$/, "") })).have?.name, "notes");

      const priv = await finished(w, await w.cloner.start({ source: `${other.endpoints.web}/team/private-notes.git` }, "c"));
      assert.equal(priv.state, "done", JSON.stringify(priv.error));
      assert.ok(existsSync(mark), "この機械の credential helper が使われていない");
    } finally {
      await other.close();
    }
  });
});

test("GitHub へは人の git の設定を読まない——相手の .gitattributes が人の filter（git-lfs 等）を起こさず、人の insteadOf で書き換わらない", async () => {
  await withWorld(async (w) => {
    const mark = join(w.home, "smudge-ran");
    const smudge = join(w.home, "smudge.sh");
    writeFileSync(smudge, `#!/bin/sh\ntouch ${mark}\ncat\n`);
    chmodSync(smudge, 0o755);
    w.gh.addRepo("octo", "lfs", { files: { ".gitattributes": "README.md filter=lfs\n" } });
    writeFileSync(
      join(GIT_ENV.HOME!, ".gitconfig"),
      `[filter "lfs"]\n\tsmudge = ${smudge}\n\trequired = true\n[url "ssh://nowhere.invalid/"]\n\tinsteadOf = ${w.gh.endpoints.web}/\n`,
    );
    const done = await finished(w, await w.cloner.start({ source: "octo/lfs" }, "c"));
    assert.equal(done.state, "done", `人の insteadOf で書き換わった？ ${JSON.stringify(done.error)}`);
    assert.ok(!existsSync(mark), "相手の .gitattributes から人の filter が走った");
    // 対照：人の設定を読む git なら、どちらも効く（書き換わって失敗する）
    const plain = await new Promise<string>((resolve) =>
      execFile(
        "git",
        ["clone", "-q", `${w.gh.endpoints.web}/octo/lfs.git`, join(w.home, "plain-lfs")],
        { env: { ...process.env, HOME: GIT_ENV.HOME, XDG_CONFIG_HOME: GIT_ENV.XDG_CONFIG_HOME, GIT_TERMINAL_PROMPT: "0" } },
        (err, _o, se) => resolve(err ? String(se) : "ok"),
      ),
    );
    assert.match(plain, /nowhere\.invalid/, `対照で insteadOf が効かない——罠の作りが違う：${plain}`);
  });
});

test("同じ場所への同時の clone は2本目を断る——1本目のフォルダを消さない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "twin");
    w.gh.gitDelayMs = 300;
    const results = await Promise.allSettled([w.cloner.start({ source: "octo/twin" }, "c"), w.cloner.start({ source: "octo/twin" }, "c")]);
    w.gh.gitDelayMs = 0;
    const ok = results.filter((r): r is PromiseFulfilledResult<CloneJobView> => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(ok.length, 1, "同じ場所に2本の clone を始めた");
    assert.match(String(refused[0]!.reason), /いま別の clone が置こうとしています/);
    assert.equal((await finished(w, ok[0]!.value)).state, "done");
    assert.ok(existsSync(join(w.repoHome, "twin", ".git")), "1本目のフォルダが消えた");
  });
});

test("判断のあと・clone の直前に誰かがその場所にフォルダを作ったら、何も消さずに断る（自分が作ったフォルダだけを消す）", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "raced");
    const job = await w.cloner.start({ source: "octo/raced" }, "c");
    // 仕事はまだ置き場のフォルダを作っていない（ファイルの操作の返事を待っている）——その間に人が作った
    mkdirSync(join(w.repoHome, "raced"), { recursive: true });
    writeFileSync(join(w.repoHome, "raced", "mine.txt"), "人のファイル");
    const done = await finished(w, job);
    assert.equal(done.state, "failed");
    assert.match(done.error!.message, /もう何かがあります（上書きしません）/);
    assert.equal(readFileSync(join(w.repoHome, "raced", "mine.txt"), "utf8"), "人のファイル", "人が作ったフォルダを消した");
  });
});

test("台帳の場所に違うもの（リポジトリでない・読めない）があれば、clone し直さず・もう手元にあるとも言わない。その場所には触らない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "gone");
    w.gh.addRepo("octo", "locked");
    const plain = join(w.home, "elsewhere", "gone");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "keep.txt"), "人のファイル");
    const locked = join(w.home, "elsewhere", "locked");
    mkdirSync(join(locked, ".git"), { recursive: true });
    await w.store.update((e) => ({
      entries: [...e, { path: plain, github: { owner: "octo", name: "gone" } }, { path: locked, github: { owner: "octo", name: "locked" } }],
      result: undefined,
    }));
    const notRepo = await w.cloner.inspect({ source: "octo/gone" });
    assert.equal(notRepo.have, undefined, "リポジトリでないのに「もう手元にあります」");
    assert.equal(notRepo.reclone, undefined, "違うものがある場所に clone し直そうとした");
    assert.match(notRepo.misplaced!.problem, /git のリポジトリでないフォルダがあります/);
    assert.equal(notRepo.target?.displayPath, "~/banto/gone");

    chmodSync(locked, 0o000);
    try {
      const unreadable = await w.cloner.inspect({ source: "octo/locked" });
      assert.equal(unreadable.reclone, undefined, "読めない場所を「無い」と見て clone し直そうとした");
      assert.match(unreadable.misplaced!.problem, /読めません/);
      // 別の名前（置き場の下）に clone する——台帳の場所には触らない
      const done = await finished(w, await w.cloner.start({ source: "octo/locked" }, "c"));
      assert.equal(done.state, "done", JSON.stringify(done.error));
      assert.equal(done.displayPath, "~/banto/locked");
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.ok(existsSync(join(locked, ".git")));
    assert.equal(readFileSync(join(plain, "keep.txt"), "utf8"), "人のファイル");
  });
});

test("リダイレクトの先の別の相手にはトークンを渡さない。失敗・時間切れでも資格情報の窓口は閉じる", async () => {
  await withWorld(async (w) => {
    const token = "ghp_redirect_token_1";
    await addPatAccount(w, "alice", token);
    const other = await startFakeGithub();
    try {
      other.users.set(token, "alice");
      other.addRepo("alice", "moved", { private: true });
      w.gh.addRepo("alice", "moved", { private: true, redirectTo: other.endpoints.web });
      const before = new Set(readdirSync(credentialParent()));
      const redirected = await finished(w, await w.cloner.start({ source: "alice/moved" }, "c"));
      assert.equal(redirected.state, "failed");
      assert.ok(other.gitRequests.length > 0, "リダイレクトが起きていない——試験の作りが違う");
      assert.ok(other.gitRequests.every((r) => !r.authorization), "リダイレクトの先の相手に資格情報を渡した");

      w.gh.addRepo("alice", "slow", { private: true });
      w.gh.gitDelayMs = 3000;
      CLONE_TIMEOUTS.idle = 300;
      const timedOut = await finished(w, await w.cloner.start({ source: "alice/slow" }, "c"));
      assert.equal(timedOut.error?.hint, "timeout");
      assert.deepEqual(readdirSync(credentialParent()).filter((d) => d.startsWith("banto-git-cred-") && !before.has(d)), [], "失敗・時間切れのあとに窓口が残っている");
    } finally {
      w.gh.gitDelayMs = 0;
      await other.close();
    }
  });
});

test("失敗の分類は git 自身の行だけで決める（相手の remote: の文言で偽れない）。改行の来ない出力でも限りなく伸びない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "fake");
    const bin = join(w.home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho "remote: Repository not found." >&2\nhead -c 200000 /dev/zero | tr '\\\\0' x >&2\necho >&2\necho "fatal: unable to access 'x': Could not resolve host: x" >&2\nexit 128\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    GIT_ENV.PATH = `${bin}:${GIT_ENV.PATH ?? ""}`;
    const failed = await finished(w, await w.cloner.start({ source: "octo/fake" }, "c"));
    assert.equal(failed.error?.hint, "network", "相手の「Repository not found」で分類が変わった");
    assert.ok(failed.error!.message.length < 50_000, `失敗の文言が伸びすぎている（${failed.error!.message.length} 字）`);
  });
});

test("clone の間も、この機械の git の設定（テンプレートの hooks・fsmonitor）から何も走らない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "trap");
    const marks = join(w.home, "marks");
    mkdirSync(marks);
    const template = join(w.home, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    for (const h of ["post-checkout", "reference-transaction"]) {
      writeFileSync(join(template, "hooks", h), `#!/bin/sh\ntouch ${join(marks, h)}\n`);
      chmodSync(join(template, "hooks", h), 0o755);
    }
    const fsmonitor = join(w.home, "fsmonitor.sh");
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${join(marks, "fsmonitor")}\nexit 1\n`);
    chmodSync(fsmonitor, 0o755);
    writeFileSync(join(GIT_ENV.HOME!, ".gitconfig"), `[init]\n\ttemplateDir = ${template}\n[core]\n\tfsmonitor = ${fsmonitor}\n`);

    const done = await finished(w, await w.cloner.start({ source: "octo/trap" }, "c"));
    assert.equal(done.state, "done", JSON.stringify(done.error));
    assert.deepEqual(readdirSync(marks), [], "clone でこの機械の設定のコマンドが走った");
    // 対照：潰さない git なら、この罠は走る（偽の GitHub は同じプロセスなので、待たずに走らせる execFile で）
    await new Promise<void>((resolve, reject) =>
      execFile(
        "git",
        ["clone", "-q", `${w.gh.endpoints.web}/octo/trap.git`, join(w.home, "plain-clone")],
        { env: { ...process.env, HOME: GIT_ENV.HOME, XDG_CONFIG_HOME: GIT_ENV.XDG_CONFIG_HOME } },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    assert.ok(readdirSync(marks).includes("post-checkout"), `対照で罠が走らない——罠の作りが違う（${readdirSync(marks).join(",")}）`);
  });
});

test("何も言ってこない clone は時間で切り、やめたら止める——どちらも途中のフォルダを残さない", async () => {
  await withWorld(async (w) => {
    w.gh.addRepo("octo", "slow");
    w.gh.gitDelayMs = 3000;
    CLONE_TIMEOUTS.idle = 300;
    const timedOut = await finished(w, await w.cloner.start({ source: "octo/slow" }, "c"));
    assert.equal(timedOut.state, "failed");
    assert.equal(timedOut.error?.hint, "timeout");
    assert.match(timedOut.error!.message, /300 msのあいだ git が何も言ってこなかったので、やめました/);
    assert.ok(!existsSync(join(w.repoHome, "slow")));

    CLONE_TIMEOUTS.idle = 60_000;
    const job = await w.cloner.start({ source: "octo/slow" }, "c");
    await new Promise((r) => setTimeout(r, 200));
    w.cloner.cancel(job.id);
    const cancelled = await finished(w, job);
    assert.equal(cancelled.state, "cancelled");
    assert.ok(!existsSync(join(w.repoHome, "slow")));
    // 終わったので、同じ場所にまた置ける
    w.gh.gitDelayMs = 0;
    assert.deepEqual((await w.cloner.inspect({ source: "octo/slow" })).target?.state, { kind: "free" });
  });
});

test("SSH 鍵を選んだアカウントは、Vault の ssh-agent の窓口だけを使う ssh で clone する", async () => {
  await withWorld(async (w) => {
    const key = w.vault.seed({ implementation: "vault-local", name: "alice-ssh", group: "instance", kind: "ssh-identity" }, "-----BEGIN");
    const pat = w.vault.seed({ implementation: "vault-local", name: "alice-pat", group: "instance", kind: "secret" }, "ghp_alice_ssh_1");
    w.gh.users.set("ghp_alice_ssh_1", "alice");
    await w.accounts.addWithPat({ patAlias: pat, ssh: key }, "c");
    // ssh の代わり：渡された引数を書き残して断る
    const bin = join(w.home, "bin");
    mkdirSync(bin);
    const record = join(w.home, "ssh-args");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$@" > ${record}\nexit 255\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    GIT_ENV.PATH = `${bin}:${GIT_ENV.PATH ?? ""}`;
    const failed = await finished(w, await w.cloner.start({ source: "alice/secret" }, "c"));
    assert.deepEqual(w.vault.agents, [key], "Vault に ssh-agent を頼んでいない");
    const args = readFileSync(record, "utf8");
    assert.match(args, new RegExp(`IdentityAgent=${w.vault.agentSocket.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    assert.match(args, /BatchMode=yes/);
    assert.match(args, /-F \/dev\/null/, "人の ~/.ssh/config を読んでいる");
    assert.match(args, /StrictHostKeyChecking=yes/, "初めての相手を覚える（accept-new）のまま");
    assert.match(args, /GlobalKnownHostsFile=\/dev\/null/);
    const knownHosts = args.match(/UserKnownHostsFile=(\S+)/)![1]!;
    assert.match(readFileSync(knownHosts, "utf8"), /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl/);
    assert.match(args, /git@127\.0\.0\.1|git@/);
    // Vault の実装が返す窓口の場所をそのままシェルに埋めない——形の違うものは断る（仕事を始めない）
    w.vault.agentSocket = '/tmp/a"; touch /tmp/banto-pwned; "';
    await assert.rejects(() => w.cloner.start({ source: "alice/secret" }, "c"), /ssh-agent の窓口の場所が受け付けられない形です/);
    assert.ok(!existsSync("/tmp/banto-pwned"));
    assert.deepEqual((await w.cloner.inspect({ source: "alice/secret" })).target?.state, { kind: "free" }, "断ったのに場所を取ったまま");
    assert.equal(failed.state, "failed");
  });
});

test("新しいリポジトリ：git の設定のブランチ名か main で作り、ぶつかれば断って -2 を出す。GitHub に同じ名前があれば言う", async () => {
  await withWorld(async (w) => {
    await addPatAccount(w, "alice", "ghp_alice_new_1");
    w.gh.addRepo("alice", "taken");
    const reposAsked = () => w.gh.requests.filter((r) => r.path.startsWith("/repos/")).length;
    const free = await w.cloner.inspectNew({ name: "fresh" }, "c");
    assert.equal(reposAsked(), 0, "名前を確定する前に GitHub に聞いた");
    assert.equal((await w.cloner.inspectNew({ name: "taken" }, "c")).takenOnGithub, undefined);
    assert.deepEqual(free.state, { kind: "free" });
    assert.equal(free.displayPath, "~/banto/fresh");
    assert.equal(free.takenOnGithub, undefined);
    assert.equal((await w.cloner.inspectNew({ name: "taken", checkGithub: true }, "c")).takenOnGithub, "alice");
    assert.equal((await w.cloner.inspectNew({ name: "a/b" }, "c")).folderInvalid, true);

    const made = await w.cloner.create({ name: "fresh" });
    assert.equal(made.branch, "main");
    const facts = await readFolder(join(w.repoHome, "fresh"));
    assert.deepEqual(facts.kind === "repo" && [facts.branch, facts.commits, facts.remote.kind], ["main", 0, "none"]);
    assert.deepEqual(await w.store.entries(), [{ path: join(w.repoHome, "fresh") }]);
    assert.deepEqual((await w.cloner.inspectNew({ name: "fresh" }, "c")).state, { kind: "taken-repo", name: "fresh", suggestion: "fresh-2" });
    await assert.rejects(() => w.cloner.create({ name: "fresh" }), /上書きしません）。fresh-2 ならあいています/);

    // 人がこの機械で決めたブランチ名には従う
    writeFileSync(join(GIT_ENV.HOME!, ".gitconfig"), "[init]\n\tdefaultBranch = trunk\n");
    assert.equal((await w.cloner.create({ name: "other" })).branch, "trunk");
  });
});
