// このマシンから削除：危ない場所を断る・失われるものを数える（本物の git で）・確かめを飛ばせない・worktree・Project。
// アカウントを後から指定：見えないアカウントは断る・書けないなら言う・読むだけに戻すと自動で付け直さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAccounts } from "./accounts.js";
import { setRepositoryAccount } from "./assign.js";
import { DELETE_HOOKS, deleteRepository, inspectDelete } from "./delete.js";
import { GIT_ENV, GIT_TIMEOUTS, lossCount, readLosses } from "./git.js";
import { httpGithub } from "./github.js";
import { LedgerStore } from "./ledger.js";
import { listRepositories, type ProjectsLookup } from "./repositories.js";
import { MemoryVault, RecordingNotices, startFakeGithub } from "./test-fakes.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const noProjects: ProjectsLookup = { ok: true, projects: [] };

/** 使い捨ての home・置き場（~/banto）・台帳。リポジトリは置き場の下に、origin は手元の bare に置く（ネットワーク無し） */
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-delete-")));
  const repoHome = join(home, "banto");
  mkdirSync(repoHome);
  const store = new LedgerStore(join(home, ".data"));
  const origin = (name: string) => {
    const bare = join(home, "remotes", `${name}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare");
    return bare;
  };
  /** origin に push 済みの、きれいなリポジトリ */
  const clean = (name: string) => {
    const bare = origin(name);
    const dir = join(repoHome, name);
    git(home, "clone", "-q", bare, dir);
    writeFileSync(join(dir, "README.md"), name);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
    git(dir, "push", "-q", "-u", "origin", "main");
    return dir;
  };
  const addToLedger = (path: string) => store.update((e) => ({ entries: [...e, { path }], result: undefined }));
  return { home, repoHome, store, clean, addToLedger, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("失われるものを数える——push していないコミット（upstream の無いブランチも）・どのブランチにも無いコミット・変更・追跡していないもの（ignore は数えない）・stash", async () => {
  const w = world();
  try {
    const dir = w.clean("kakeibo");
    assert.deepEqual((await readLosses(dir)), { unpushed: [], unpushedTotal: 0, detached: 0, localOnlyBranches: [], localOnlyTags: [], changed: 0, untracked: 0, stashes: 0, problems: [] });
    // main に2つ push していない
    for (const n of [1, 2]) {
      writeFileSync(join(dir, `a${n}.txt`), String(n));
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", `local ${n}`);
    }
    // upstream の無いブランチに1つ
    git(dir, "switch", "-q", "-c", "spike");
    writeFileSync(join(dir, "spike.txt"), "s");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "spike");
    git(dir, "switch", "-q", "main");
    // stash を1つ
    writeFileSync(join(dir, "README.md"), "stashed");
    git(dir, "stash", "-q");
    // 変更2つ（作業ツリー・index）、追跡していないもの2つ（ファイル・中身ごとのフォルダ）、ignore 済み1つ
    writeFileSync(join(dir, "README.md"), "changed");
    writeFileSync(join(dir, "a1.txt"), "staged");
    git(dir, "add", "a1.txt");
    writeFileSync(join(dir, "new.txt"), "n");
    mkdirSync(join(dir, "newdir"));
    writeFileSync(join(dir, "newdir", "x"), "x");
    writeFileSync(join(dir, ".git", "info", "exclude"), "ignored.log\n");
    writeFileSync(join(dir, "ignored.log"), "i");
    const l = await readLosses(dir);
    // spike は main の push していない2つから枝分かれ——ブランチごとには重なり、合計は重ねない
    assert.deepEqual(l.unpushed, [{ branch: "main", commits: 2 }, { branch: "spike", commits: 3 }]);
    assert.equal(l.unpushedTotal, 3);
    assert.deepEqual(l.localOnlyBranches, ["spike"]);
    assert.equal(l.changed, 2);
    assert.equal(l.untracked, 2, "ignore 済みを数えた・フォルダの中身を1つずつ数えた");
    assert.equal(l.stashes, 1);
    assert.deepEqual(l.problems, []);
    // 数は重ねない合計で：コミット3・リモートに無いブランチ1・変更2・追跡していないもの2・stash 1
    assert.equal(lossCount(l), 9, "ブランチごとの数を足して、重なるコミットを2回数えた");

    // detached HEAD で作ったコミット
    git(dir, "stash", "-q", "-u");
    git(dir, "checkout", "-q", "--detach");
    writeFileSync(join(dir, "loose.txt"), "l");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "loose");
    assert.equal((await readLosses(dir)).detached, 1);

    // submodule の中は数えない——数えていないと言う（「無い」と言わない）
    writeFileSync(join(dir, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n');
    assert.deepEqual((await readLosses(dir)).problems, ["submodule の中の変更は数えていません"]);
  } finally {
    w.done();
  }
});

test("数えるときも、リポジトリの設定の filter（clean・process）を起こさない——起こす git なら走る（対照）", async () => {
  const w = world();
  try {
    const dir = w.clean("trap");
    const mark = join(w.home, "filter-ran");
    const evil = join(w.home, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch ${mark}\ncat\n`);
    chmodSync(evil, 0o755);
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(dir, "a.txt"), "hi\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "attrs");
    git(dir, "config", "filter.evil.clean", evil);
    git(dir, "config", "filter.evil.process", evil);
    git(dir, "config", "filter.evil.required", "true");
    // 中身は同じで時刻だけ変える——git は中身を比べに行く（ここで clean を起こす）
    const later = new Date(Date.now() + 5000);
    const touch = () => utimesSync(join(dir, "a.txt"), later, later);
    touch();
    await readLosses(dir);
    assert.ok(!existsSync(mark), "数えるときにリポジトリの設定の filter が走った");
    touch();
    try {
      // 罠の process は filter の取り決めを話さないので git は失敗する——走ったかだけを見る
      execFileSync("git", ["status", "--porcelain"], { cwd: dir, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: "ignore" });
    } catch {
      // 失敗はよい
    }
    assert.ok(existsSync(mark), "対照で filter が走らない——罠の作りが違う");
  } finally {
    w.done();
  }
});

test("危ない場所は断る：一覧に無い・シンボリックリンク・途中にリンク・置き場の外・置き場そのもの・ホーム・/・リポジトリでない・見つからない", async () => {
  const w = world();
  try {
    const inside = w.clean("ok");
    const outside = join(w.home, "elsewhere", "repo");
    mkdirSync(outside, { recursive: true });
    git(outside, "init", "-q");
    const link = join(w.repoHome, "link");
    symlinkSync(inside, link);
    const viaLinkParent = join(w.home, "alias-home");
    symlinkSync(w.repoHome, viaLinkParent);
    const plain = join(w.repoHome, "plain");
    mkdirSync(plain);
    for (const p of [outside, link, join(viaLinkParent, "ok"), w.repoHome, w.home, "/", plain, join(w.repoHome, "gone")]) await w.addToLedger(p);
    const refusal = async (p: string) => (await inspectDelete(w.store, p, noProjects, w.home)).refusal ?? "";
    assert.match(await refusal(join(w.repoHome, "not-listed")), /一覧に無いフォルダは消しません/);
    assert.match(await refusal(link), /シンボリックリンクは消しません/);
    assert.match(await refusal(join(viaLinkParent, "ok")), /一覧の場所.*と実際の場所.*が違います/);
    assert.match(await refusal(outside), /置き場（~\/banto）の外のフォルダは、このマシンから削除できません/);
    assert.match(await refusal(w.repoHome), /置き場そのものは消しません/);
    assert.match(await refusal(w.home), /ホームや \/ を消すことはできません/);
    assert.match(await refusal("/"), /ホームや \/ を消すことはできません/);
    assert.match(await refusal(plain), /リポジトリでないフォルダは消しません/);
    assert.match(await refusal(join(w.repoHome, "gone")), /フォルダが見つかりません/);
    // 断ったものは、確かめを付けても消さない
    for (const p of [link, outside, w.repoHome]) {
      await assert.rejects(() => deleteRepository(w.store, { path: p, confirmed: true, typedName: "x" }, noProjects, w.home), /消せません/);
    }
    assert.ok(existsSync(inside) && existsSync(outside) && existsSync(link));
  } finally {
    w.done();
  }
});

test("確かめを飛ばせない——何も無ければ1回、あればリポジトリ名。調べたあとに増えたら、もう一度確かめさせる", async () => {
  const w = world();
  try {
    const neat = w.clean("neat");
    await w.addToLedger(neat);
    const look = await inspectDelete(w.store, neat, noProjects, w.home);
    assert.equal(look.lossCount, 0);
    assert.equal(look.needsTypedName, false);
    await assert.rejects(() => deleteRepository(w.store, { path: neat, confirmed: false }, noProjects, w.home), /消す前に確かめてください/);
    // 調べたあとに、追跡していないファイルができた
    writeFileSync(join(neat, "late.txt"), "l");
    await assert.rejects(() => deleteRepository(w.store, { path: neat, confirmed: true }, noProjects, w.home), /失われるものがあります（調べたあとに増えたかもしれません）/);
    assert.ok(existsSync(neat));
    await assert.rejects(() => deleteRepository(w.store, { path: neat, confirmed: true, typedName: "neatt" }, noProjects, w.home), /リポジトリ名が違います/);
    const done = await deleteRepository(w.store, { path: neat, confirmed: true, typedName: "neat" }, noProjects, w.home);
    assert.equal(done.displayPath, "~/banto/neat");
    assert.ok(!existsSync(neat));
    assert.deepEqual(await w.store.entries(), []);
    // origin（リモート）には触っていない
    assert.ok(existsSync(join(w.home, "remotes", "neat.git", "HEAD")));

    const other = w.clean("other");
    await w.addToLedger(other);
    await deleteRepository(w.store, { path: other, confirmed: true }, noProjects, w.home);
    assert.ok(!existsSync(other), "何も無いのに1回の確かめで消せない");
  } finally {
    w.done();
  }
});

test("数えきれなかったら（時間切れ）「無い」と言わず、リポジトリ名を打たせる", async () => {
  const w = world();
  const saved = { t: GIT_TIMEOUTS.losses, path: GIT_ENV.PATH };
  try {
    const dir = w.clean("slow");
    await w.addToLedger(dir);
    const bin = join(w.home, "bin");
    mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && exec sleep 30; done\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    GIT_ENV.PATH = `${bin}:${saved.path ?? ""}`;
    GIT_TIMEOUTS.losses = 300;
    const look = await inspectDelete(w.store, dir, noProjects, w.home);
    assert.equal(look.lossCount, 0);
    assert.match(look.losses!.problems[0]!, /コミットしていない変更を数えられませんでした/);
    assert.equal(look.needsTypedName, true, "数えきれないのに1回の確かめで消せる");
  } finally {
    GIT_TIMEOUTS.losses = saved.t;
    GIT_ENV.PATH = saved.path;
    w.done();
  }
});

test("worktree は worktree だけを消し、本体の記録を片づける。本体を消すときは worktree と Project を言い、名前を打たせる", async () => {
  const w = world();
  try {
    const main = w.clean("main-repo");
    const wt = join(w.repoHome, "main-repo-fix");
    git(main, "worktree", "add", "-q", "-b", "fix", wt);
    git(wt, "push", "-q", "-u", "origin", "fix");
    await w.addToLedger(main);
    await w.addToLedger(wt);
    const lookup: ProjectsLookup = { ok: true, projects: [{ id: "p1", name: "家計簿", root: wt, status: "active" }] };

    const ofMain = await inspectDelete(w.store, main, lookup, w.home);
    assert.deepEqual(ofMain.worktrees, ["~/banto/main-repo-fix"]);
    assert.deepEqual(ofMain.projects, [{ id: "p1", name: "家計簿", closed: false }], "worktree を根にした Project を言っていない");
    assert.equal(ofMain.needsTypedName, true);

    const ofWt = await inspectDelete(w.store, wt, lookup, w.home);
    assert.equal(ofWt.kind, "worktree");
    assert.equal(ofWt.main, "~/banto/main-repo");
    assert.equal(ofWt.lossCount, 0);
    assert.equal(ofWt.needsTypedName, true, "Project が使っているのに1回の確かめで消せる");
    const res = await deleteRepository(w.store, { path: wt, confirmed: true, typedName: "main-repo-fix" }, lookup, w.home);
    assert.deepEqual(res.projects, [{ id: "p1", name: "家計簿", closed: false }]);
    assert.ok(!existsSync(wt));
    assert.ok(existsSync(join(main, ".git")), "worktree を消して本体まで消した");
    assert.doesNotMatch(git(main, "worktree", "list"), /main-repo-fix/, "本体の側に worktree の記録が残っている");
    assert.deepEqual((await w.store.entries()).map((e) => e.path), [main]);

    // どの Project が使っているかが分からない——名前を打たせる
    const unknown = await inspectDelete(w.store, main, { ok: false, error: "中継が答えません" }, w.home);
    assert.equal(unknown.projectsError, "中継が答えません");
    assert.equal(unknown.needsTypedName, true);
  } finally {
    w.done();
  }
});

test("アカウントを後から指定：見えないアカウントは断る・読めるが書けないなら言って指定する・読むだけに戻すと自動では付け直さない", async () => {
  const w = world();
  const gh = await startFakeGithub();
  try {
    const vault = new MemoryVault();
    const github = httpGithub(gh.endpoints);
    const accounts = new GithubAccounts({ store: w.store, vault, github, notices: new RecordingNotices() });
    const add = async (login: string) => {
      const place = vault.seed({ implementation: "vault-local", name: `${login}-pat`, group: "instance", kind: "secret" }, `ghp_${login}_1`);
      gh.users.set(`ghp_${login}_1`, login);
      await accounts.addWithPat({ patAlias: place }, "c");
    };
    for (const l of ["alice", "bob", "carol"]) await add(l);
    gh.addRepo("alice", "secret", { private: true, readers: ["alice", "carol"] });
    const repo = w.clean("secret");
    git(repo, "remote", "set-url", "origin", "https://github.com/alice/secret.git");
    await w.store.update((e) => ({ entries: [...e, { path: repo, github: { owner: "alice", name: "secret" } }], result: undefined }));
    const deps = { store: w.store, accounts, github };

    await assert.rejects(() => setRepositoryAccount(deps, { path: repo, login: "bob" }, "c"), /@bob からは alice\/secret が見えません/);
    assert.equal((await w.store.entries())[0]!.account, undefined, "見えないアカウントを書いた");
    assert.deepEqual(await setRepositoryAccount(deps, { path: repo, login: "carol" }, "c"), { login: "carol", push: false });
    assert.deepEqual(await setRepositoryAccount(deps, { path: repo, login: "alice" }, "c"), { login: "alice", push: true });
    assert.equal((await w.store.entries())[0]!.account, "alice");

    // 読むだけに戻す——持ち主（alice）と同じ login のアカウントがあっても、一覧で付け直さない
    assert.deepEqual(await setRepositoryAccount(deps, { path: repo, login: null }, "c"), { login: null });
    const rows = (await listRepositories(w.store, noProjects, w.home)).rows;
    assert.equal(rows[0]!.account, undefined, "読むだけに戻したのに、一覧で付け直した");
    assert.equal((await w.store.entries())[0]!.readOnly, true);

    // GitHub に聞いている間に一覧から外された——指定したことにしない（行を作り直さない）
    const vanishing = {
      ...github,
      repoAccess: async (token: string, owner: string, name: string) => {
        const access = await github.repoAccess(token, owner, name);
        await w.store.update((e) => ({ entries: e.filter((x) => x.path !== repo), result: undefined }));
        return access;
      },
    };
    await assert.rejects(() => setRepositoryAccount({ ...deps, github: vanishing }, { path: repo, login: "alice" }, "c"), /一覧から外されたので、指定していません/);
    assert.deepEqual(await w.store.entries(), []);
    await w.store.update((e) => ({ entries: [...e, { path: repo, github: { owner: "alice", name: "secret" } }], result: undefined }));

    // 確かめられない（GitHub が落ちている）——指定しない
    await gh.close();
    await assert.rejects(() => setRepositoryAccount(deps, { path: repo, login: "alice" }, "c"), /確かめられなかったので、指定していません/);
    assert.equal((await w.store.entries())[0]!.account, undefined);
  } finally {
    await gh.close().catch(() => undefined);
    w.done();
    void readdirSync;
  }
});

test("タグだけが指すコミット・リモートに無いタグ・notes 等のほかの ref・index だけの submodule を見落とさない", async () => {
  const w = world();
  try {
    const dir = w.clean("tags");
    git(dir, "tag", "v-pushed");
    // ブランチから外れ、タグだけが指すコミット
    git(dir, "switch", "-q", "-c", "tmp");
    writeFileSync(join(dir, "t.txt"), "t");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "tagged only");
    git(dir, "tag", "-a", "-m", "local", "v-local");
    git(dir, "switch", "-q", "main");
    git(dir, "branch", "-q", "-D", "tmp");
    let l = await readLosses(dir);
    assert.equal(l.unpushedTotal, 1, "タグだけが指すコミットを数えていない");
    assert.deepEqual(l.localOnlyTags, ["v-local"], "リモートにあるコミットを指すタグまで出した・注釈つきタグを見落とした");
    assert.equal(lossCount(l), 2);
    await w.addToLedger(dir);
    assert.equal((await inspectDelete(w.store, dir, noProjects, w.home)).needsTypedName, true, "タグだけのコミットがあるのに1回で消せる");

    // notes——ブランチ・タグの外の ref にだけあるコミット
    git(dir, "tag", "-d", "v-local");
    git(dir, "notes", "add", "-m", "memo", "HEAD");
    l = await readLosses(dir);
    assert.equal(l.unpushedTotal, 0);
    assert.deepEqual(l.problems, ["ブランチ・タグの外の ref（refs/notes/commits）にだけあるコミットが 1 件あります——中身は数えていません"]);
    git(dir, "update-ref", "-d", "refs/notes/commits");

    // .gitmodules が無くても、index に submodule（mode 160000）がある
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},vendored`);
    git(dir, "commit", "-q", "-m", "gitlink");
    git(dir, "push", "-q", "origin", "main");
    assert.deepEqual((await readLosses(dir)).problems, ["submodule の中の変更は数えていません"]);
  } finally {
    w.done();
  }
});

test("リモートに無いブランチ：同じ名前は refs/remotes/<リモート>/<ブランチ> の完全一致で、リモートで消えた上流は無いと見る", async () => {
  const w = world();
  try {
    const dir = w.clean("names");
    // リモートには feature/x がある。手元の x は別物
    git(dir, "push", "-q", "origin", "main:feature/x");
    git(dir, "fetch", "-q", "origin");
    git(dir, "branch", "-q", "x");
    // 上流がリモートで消えた
    git(dir, "push", "-q", "-u", "origin", "main:gone");
    git(dir, "branch", "-q", "--set-upstream-to=origin/gone", "main");
    git(dir, "branch", "-q", "gone");
    git(dir, "branch", "-q", "--set-upstream-to=origin/gone", "gone");
    git(dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    git(dir, "push", "-q", "origin", "--delete", "gone");
    git(dir, "fetch", "-q", "--prune", "origin");
    assert.deepEqual((await readLosses(dir)).localOnlyBranches, ["gone", "x"]);
  } finally {
    w.done();
  }
});

test("下のフォルダを Root にした Project も「使っている」に数える", async () => {
  const w = world();
  try {
    const dir = w.clean("mono");
    mkdirSync(join(dir, "packages", "app"), { recursive: true });
    await w.addToLedger(dir);
    const lookup: ProjectsLookup = {
      ok: true,
      projects: [
        { id: "p1", name: "app", root: join(dir, "packages", "app"), status: "active" },
        { id: "p2", name: "隣", root: `${dir}-other`, status: "active" },
      ],
    };
    const look = await inspectDelete(w.store, dir, lookup, w.home);
    assert.deepEqual(look.projects, [{ id: "p1", name: "app", closed: false }], "下のフォルダの Project を見落とした・名前が似た隣を数えた");
    assert.equal(look.needsTypedName, true);
    const res = await deleteRepository(w.store, { path: dir, confirmed: true, typedName: "mono" }, lookup, w.home);
    assert.deepEqual(res.projects, [{ id: "p1", name: "app", closed: false }], "閉じる対象に入らない");
  } finally {
    w.done();
  }
});

test("本体を先に消した worktree は、数えられないと言って名前を打たせて消せる。worktree を消すとき、ほかの worktree の記録は残す", async () => {
  const w = world();
  try {
    const main = w.clean("body");
    const wt1 = join(w.repoHome, "body-a");
    const wt2 = join(w.repoHome, "body-b");
    git(main, "worktree", "add", "-q", "-b", "a", wt1);
    git(main, "worktree", "add", "-q", "-b", "b", wt2);
    // wt2 はいま見えていない（外付けの場所等）——記録は残すべき
    rmSync(wt2, { recursive: true, force: true });
    await w.addToLedger(wt1);
    await deleteRepository(w.store, { path: wt1, confirmed: true, typedName: "body-a" }, noProjects, w.home);
    const list = git(main, "worktree", "list");
    assert.doesNotMatch(list, /body-a/);
    assert.match(list, /body-b/, "見えていないだけの別の worktree の記録まで消した");

    // 本体を消したあとの worktree
    const wt3 = join(w.repoHome, "body-c");
    git(main, "worktree", "add", "-q", "-b", "c", wt3);
    rmSync(main, { recursive: true, force: true });
    await w.addToLedger(wt3);
    const look = await inspectDelete(w.store, wt3, noProjects, w.home);
    assert.equal(look.refusal, undefined, "本体の無い worktree を消せない");
    assert.equal(look.kind, "orphan-worktree");
    assert.match(look.losses!.problems[0]!, /本体の無い worktree です/);
    assert.equal(look.needsTypedName, true, "数えられないのに1回で消せる");
    await assert.rejects(() => deleteRepository(w.store, { path: wt3, confirmed: true }, noProjects, w.home), /リポジトリ名「body-c」を打って/);
    await deleteRepository(w.store, { path: wt3, confirmed: true, typedName: "body-c" }, noProjects, w.home);
    assert.ok(!existsSync(wt3));
  } finally {
    w.done();
  }
});

test("消すときリンクを辿らない・中のマウントは断る・歩いて別の dev に当たったら止まる", async () => {
  const w = world();
  const saved = { ...DELETE_HOOKS };
  try {
    // 中にホーム（の大事なもの）へのリンク——リンクだけを消し、先は残す
    const precious = join(w.home, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "keep.txt"), "keep");
    const dir = w.clean("links");
    symlinkSync(w.home, join(dir, "to-home"));
    symlinkSync(join(precious, "keep.txt"), join(dir, "to-file"));
    writeFileSync(join(dir, ".git", "info", "exclude"), "to-home\nto-file\n");
    await w.addToLedger(dir);
    await deleteRepository(w.store, { path: dir, confirmed: true }, noProjects, w.home);
    assert.ok(!existsSync(dir));
    assert.ok(existsSync(join(precious, "keep.txt")), "リンクの先を消した");

    // 中にマウント（一覧は差し替え——試験では本物のマウントを作れない。空白は \040）
    const mounted = w.clean("mounted");
    await w.addToLedger(mounted);
    const info = join(w.home, "mountinfo");
    writeFileSync(
      info,
      `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n` +
        `40 22 0:50 / ${mounted.replace(/ /g, "\\040")}/data\\040dir rw - fuse.sshfs host: rw\n` +
        `41 22 0:51 / ${mounted}-sibling rw - tmpfs tmpfs rw\n`,
    );
    DELETE_HOOKS.mountinfo = info;
    const look = await inspectDelete(w.store, mounted, noProjects, w.home);
    assert.match(look.refusal ?? "", /中に別のファイルシステムがマウントされています（~\/banto\/mounted\/data dir）/);
    await assert.rejects(() => deleteRepository(w.store, { path: mounted, confirmed: true }, noProjects, w.home), /消せません/);
    assert.ok(existsSync(join(mounted, "README.md")));
    // フォルダそのものがマウント
    writeFileSync(info, `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 22 0:50 / ${mounted} rw - fuse.sshfs host: rw\n`);
    assert.match((await inspectDelete(w.store, mounted, noProjects, w.home)).refusal ?? "", /マウントされています（~\/banto\/mounted）/);

    // 一覧に出ないマウント（一覧が無い・あとから付いた）——歩いて dev が違えば、その先へ入らない
    writeFileSync(info, "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n");
    mkdirSync(join(mounted, "data"));
    writeFileSync(join(mounted, "data", "remote.txt"), "r");
    const real = saved.lstat;
    DELETE_HOOKS.lstat = (async (p: string) => {
      const st = await real(p);
      return p === join(mounted, "data") ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
    }) as typeof DELETE_HOOKS.lstat;
    writeFileSync(join(mounted, ".git", "info", "exclude"), "data\n");
    await assert.rejects(() => deleteRepository(w.store, { path: mounted, confirmed: true }, noProjects, w.home), /別のファイルシステム（マウント）なので、その先は消していません/);
    assert.ok(existsSync(join(mounted, "data", "remote.txt")), "別の dev の中まで消した");
  } finally {
    Object.assign(DELETE_HOOKS, saved);
    w.done();
  }
});
