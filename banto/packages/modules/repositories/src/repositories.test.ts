// 台帳・Import の判断・origin との突き合わせ・外す／戻す。**本物の git で、使い捨ての home の中に作る**
// ——偽の git で試すと、git の失敗の文言（「git でない」と「読めない」の見分け）を確かめたことにならない（規則1）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFolder, type FolderFacts } from "./git.js";
import { LedgerStore, syncWithOrigin } from "./ledger.js";
import {
  dismissCorrection,
  importRepository,
  inspectImport,
  listFolders,
  listRepositories,
  normalizeRepoHome,
  removeRepository,
  repoHomeView,
  restoreRepository,
  setRepoHome,
  type ProjectsLookup,
} from "./repositories.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 使い捨ての home に、リポジトリ・worktree・ただのフォルダを作る */
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-")));
  const dataDir = join(home, ".banto-data");
  const make = (name: string, origin?: string, commit = true) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    if (origin) git(dir, "remote", "add", "origin", origin);
    if (commit) {
      writeFileSync(join(dir, "README.md"), name);
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "first");
    }
    return dir;
  };
  const kakeibo = make("work/kakeibo", "git@github.com:tjst-t/kakeibo.git");
  const sketch = make("work/sketch", undefined, false);
  const notes = make("work/notes", "https://gitlab.com/tjst-t/notes.git");
  mkdirSync(join(kakeibo, "src"));
  git(kakeibo, "worktree", "add", "-q", join(home, "wt/kakeibo-fix"));
  mkdirSync(join(home, "plain/inner"), { recursive: true });
  return {
    home,
    store: new LedgerStore(dataDir),
    dataDir,
    kakeibo,
    sketch,
    notes,
    worktree: join(home, "wt/kakeibo-fix"),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const noProjects: ProjectsLookup = { ok: true, projects: [] };

test("Import の判断：git のリポジトリ・git でない・リポジトリの中・worktree・無いパス・もう一覧にある", async () => {
  const w = world();
  try {
    const ready = await inspectImport(w.store, "~/work/kakeibo", w.home);
    assert.equal(ready.path, w.kakeibo);
    assert.equal(ready.displayPath, "~/work/kakeibo");
    assert.deepEqual(ready.check, {
      kind: "ready",
      remote: { kind: "github", owner: "tjst-t", name: "kakeibo" },
      branch: "main",
      commits: 1,
    });

    // コミットの無いリポジトリも Import できる（このマシンにだけ・コミットなし）
    assert.deepEqual((await inspectImport(w.store, w.sketch, w.home)).check, {
      kind: "ready",
      remote: { kind: "none" },
      branch: "main",
      commits: 0,
    });
    assert.deepEqual((await inspectImport(w.store, "~/work/notes", w.home)).check.kind, "ready");

    assert.deepEqual((await inspectImport(w.store, "~/plain", w.home)).check, { kind: "not-git" });

    const inside = await inspectImport(w.store, "~/work/kakeibo/src", w.home);
    assert.deepEqual(inside.check, { kind: "inside", top: { path: w.kakeibo, displayPath: "~/work/kakeibo", name: "kakeibo" } });
    // git の管理用のフォルダの中も「リポジトリの中」
    assert.equal((await inspectImport(w.store, "~/work/kakeibo/.git", w.home)).check.kind, "inside");

    const wt = await inspectImport(w.store, "~/wt/kakeibo-fix", w.home);
    assert.deepEqual(wt.check, {
      kind: "worktree",
      main: { path: w.kakeibo, displayPath: "~/work/kakeibo", name: "kakeibo" },
      mainKnown: false,
    });

    const missing = await inspectImport(w.store, "~/work/nope/deeper", w.home);
    assert.deepEqual(missing.check, { kind: "missing", nearest: { path: join(w.home, "work"), displayPath: "~/work", name: "work" } });

    await importRepository(w.store, "~/work/kakeibo", w.home);
    assert.deepEqual((await inspectImport(w.store, "~/work/kakeibo", w.home)).check, { kind: "known" });
    assert.equal(((await inspectImport(w.store, "~/wt/kakeibo-fix", w.home)).check as { mainKnown: boolean }).mainKnown, true);
  } finally {
    w.done();
  }
});

test("Import は画面の判断を信じず読み直す——git でない・重複・worktree は足さない", async () => {
  const w = world();
  try {
    await assert.rejects(() => importRepository(w.store, "~/plain", w.home), /git のリポジトリではありません/);
    await assert.rejects(() => importRepository(w.store, "~/wt/kakeibo-fix", w.home), /worktree です/);
    await assert.rejects(() => importRepository(w.store, "~/work/kakeibo/src", w.home), /リポジトリの中のフォルダです/);
    await assert.rejects(() => importRepository(w.store, "~/nope", w.home), /このフォルダはありません/);
    assert.deepEqual(await w.store.entries(), []);

    const added = await importRepository(w.store, "~/work/kakeibo/", w.home);
    assert.deepEqual(added, { path: w.kakeibo, displayPath: "~/work/kakeibo", name: "kakeibo" });
    await importRepository(w.store, w.notes, w.home);
    await assert.rejects(() => importRepository(w.store, w.kakeibo, w.home), /もう一覧にあります/);
    // 台帳が覚えるのは置き場所とリモートの場所だけ（GitHub なら owner/name、外は URL）
    assert.deepEqual(await w.store.entries(), [
      { path: w.kakeibo, github: { owner: "tjst-t", name: "kakeibo" } },
      { path: w.notes, elsewhere: "https://gitlab.com/tjst-t/notes.git" },
    ]);
  } finally {
    w.done();
  }
});

test("一覧：Project で使っているか（根そのもの・worktree）で分け、中は見つからない → このマシンにだけ → 名前順", async () => {
  const w = world();
  try {
    for (const p of [w.kakeibo, w.sketch, w.notes]) await importRepository(w.store, p, w.home);
    // 置き場所を覚えたあとでフォルダが消えた
    const gone = join(w.home, "work/gone");
    mkdirSync(gone, { recursive: true });
    git(gone, "init", "-q");
    git(gone, "remote", "add", "origin", "https://github.com/work-org/gone.git");
    await importRepository(w.store, gone, w.home);
    rmSync(gone, { recursive: true, force: true });

    const lookup: ProjectsLookup = {
      ok: true,
      projects: [
        { id: "p1", name: "家計簿", root: w.kakeibo, status: "active" },
        { id: "p2", name: "家計簿の直し", root: w.worktree, status: "closed" },
        { id: "p3", name: "旧", root: gone, status: "closed" },
      ],
    };
    const { rows, projectsError } = await listRepositories(w.store, lookup, w.home);
    assert.equal(projectsError, undefined);
    assert.deepEqual(
      rows.map((r) => [r.section, r.name, r.state]),
      [
        ["used", "gone", "missing"],
        ["used", "kakeibo", "ok"],
        ["unused", "sketch", "ok"],
        ["unused", "notes", "ok"],
      ],
    );
    const [goneRow, kakeiboRow, sketchRow, notesRow] = rows;
    // 見つからない行の手がかりは台帳の値だけ
    assert.deepEqual(goneRow!.remote, { kind: "github", owner: "work-org", name: "gone" });
    assert.equal(goneRow!.remembered, true);
    assert.deepEqual(goneRow!.projects, [{ id: "p3", name: "旧", closed: true, viaWorktree: false }]);
    assert.deepEqual(kakeiboRow!.projects, [
      { id: "p1", name: "家計簿", closed: false, viaWorktree: false },
      { id: "p2", name: "家計簿の直し", closed: true, viaWorktree: true },
    ]);
    assert.deepEqual(sketchRow!.remote, { kind: "none" });
    assert.equal(sketchRow!.commits, 0);
    assert.deepEqual(notesRow!.remote, { kind: "elsewhere", url: "https://gitlab.com/tjst-t/notes.git", host: "gitlab.com" });
    assert.equal(kakeiboRow!.displayPath, "~/work/kakeibo");
    // フォルダが見つからない間は、台帳を直さない
    assert.deepEqual((await w.store.entries()).find((e) => e.path === gone), { path: gone, github: { owner: "work-org", name: "gone" } });
  } finally {
    w.done();
  }
});

test("どの Project が使っているかを引けなかったら、区切らずに理由を返す（「使っていない」と言わない）", async () => {
  const w = world();
  try {
    await importRepository(w.store, w.kakeibo, w.home);
    const listing = await listRepositories(w.store, { ok: false, error: "中継に届きません" }, w.home);
    assert.equal(listing.projectsError, "中継に届きません");
    assert.equal(listing.rows[0]!.section, "unknown");
    assert.equal(listing.rows[0]!.projects, undefined);
  } finally {
    w.done();
  }
});

test("origin と食い違ったら origin を正として台帳を直し、一度だけ知らせる（見たら消す）", async () => {
  const w = world();
  try {
    await importRepository(w.store, w.kakeibo, w.home);
    await importRepository(w.store, w.notes, w.home);
    // GitHub の上で持ち主が変わった・gitlab の場所が変わった
    git(w.kakeibo, "remote", "set-url", "origin", "https://github.com/work-org/kakeibo.git");
    git(w.notes, "remote", "set-url", "origin", "git@gitlab.com:tjst-t/notes2.git");

    const first = await listRepositories(w.store, noProjects, w.home);
    const k = first.rows.find((r) => r.name === "kakeibo")!;
    assert.deepEqual(k.remote, { kind: "github", owner: "work-org", name: "kakeibo" });
    assert.deepEqual(k.correctedFrom, { owner: "tjst-t", name: "kakeibo" });
    // GitHub の外の URL は覚え直すだけ（お知らせはしない）
    assert.equal(first.rows.find((r) => r.name === "notes")!.correctedFrom, undefined);
    assert.deepEqual(await w.store.entries(), [
      { path: w.kakeibo, github: { owner: "work-org", name: "kakeibo" }, correctedFrom: { owner: "tjst-t", name: "kakeibo" } },
      { path: w.notes, elsewhere: "git@gitlab.com:tjst-t/notes2.git" },
    ]);

    // 見たら消す
    await dismissCorrection(w.store, w.kakeibo);
    const second = await listRepositories(w.store, noProjects, w.home);
    assert.equal(second.rows.find((r) => r.name === "kakeibo")!.correctedFrom, undefined);

    // origin を消した——GitHub の場所も消し、前の場所を知らせる
    git(w.kakeibo, "remote", "remove", "origin");
    const third = await listRepositories(w.store, noProjects, w.home);
    const k3 = third.rows.find((r) => r.name === "kakeibo")!;
    assert.deepEqual(k3.remote, { kind: "none" });
    assert.deepEqual(k3.correctedFrom, { owner: "work-org", name: "kakeibo" });
  } finally {
    w.done();
  }
});

test("syncWithOrigin：覚えていなかった場所を覚えるのは知らせない・大文字小文字だけの違いは知らせずに合わせる", () => {
  const repo = (remote: { kind: "github"; owner: string; name: string } | { kind: "none" }): FolderFacts => ({
    kind: "repo",
    path: "/r",
    remote,
    commits: 1,
    worktrees: [],
  });
  assert.deepEqual(syncWithOrigin({ path: "/r" }, repo({ kind: "github", owner: "a", name: "b" })), {
    entry: { path: "/r", github: { owner: "a", name: "b" } },
    changed: true,
  });
  assert.deepEqual(syncWithOrigin({ path: "/r", github: { owner: "a", name: "b" } }, repo({ kind: "github", owner: "A", name: "B" })), {
    entry: { path: "/r", github: { owner: "A", name: "B" } },
    changed: true,
  });
  const same = { path: "/r", github: { owner: "a", name: "b" } };
  assert.equal(syncWithOrigin(same, repo({ kind: "github", owner: "a", name: "b" })).changed, false);
  // フォルダが読めない間は直さない
  assert.equal(syncWithOrigin(same, { kind: "missing" }).changed, false);
  assert.equal(syncWithOrigin(same, { kind: "not-git" }).changed, false);
});

test("一覧から外す（フォルダは消さない）・元に戻す・二重に戻せない", async () => {
  const w = world();
  try {
    await importRepository(w.store, w.kakeibo, w.home);
    const removed = await removeRepository(w.store, w.kakeibo);
    assert.deepEqual(removed, { path: w.kakeibo, github: { owner: "tjst-t", name: "kakeibo" } });
    assert.deepEqual(await w.store.entries(), []);
    // フォルダはそのまま
    assert.equal(git(w.kakeibo, "rev-parse", "--show-toplevel").trim(), w.kakeibo);
    await assert.rejects(() => removeRepository(w.store, w.kakeibo), /一覧にありません/);

    // 外している間に origin が変わっていても、戻すときに合わせる
    git(w.kakeibo, "remote", "set-url", "origin", "https://github.com/tjst-t/kakeibo-v2.git");
    const restored = await restoreRepository(w.store, removed);
    assert.deepEqual(restored.github, { owner: "tjst-t", name: "kakeibo-v2" });
    await assert.rejects(() => restoreRepository(w.store, removed), /もう一覧にあります/);
    // 形の違うものは戻さない
    await assert.rejects(() => restoreRepository(w.store, { path: "relative/path" }), /絶対パス/);
  } finally {
    w.done();
  }
});

test("一覧の行が読めない・リポジトリでなくなった——隠さずに理由つきで出す", async () => {
  const w = world();
  try {
    await importRepository(w.store, w.sketch, w.home);
    rmSync(join(w.sketch, ".git"), { recursive: true, force: true });
    const { rows } = await listRepositories(w.store, noProjects, w.home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "not-repo");
    assert.match(rows[0]!.problem!, /git のリポジトリではなくなっています/);
  } finally {
    w.done();
  }
});

test("壊れた台帳を空と読まない——読めないと言って止まる", async () => {
  const w = world();
  try {
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(join(w.dataDir, "ledger.json"), "{ broken");
    await assert.rejects(() => listRepositories(w.store, noProjects, w.home), /台帳.*を読めませんでした/);
    writeFileSync(join(w.dataDir, "ledger.json"), JSON.stringify({ version: 1, repositories: [{ path: 3 }] }));
    await assert.rejects(() => w.store.entries(), /1 行目.*置き場所/);
  } finally {
    w.done();
  }
});

test("フォルダをたどる：名前だけ・台帳にあるものに印・.git は出さない・無いパスはそう言う", async () => {
  const w = world();
  try {
    await importRepository(w.store, w.kakeibo, w.home);
    const listing = await listFolders(w.store, "~/work", w.home);
    assert.equal(listing.displayPath, "~/work");
    assert.deepEqual(listing.parent, { path: w.home, displayPath: "~", name: listing.parent!.name });
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.known]),
      [
        ["kakeibo", true],
        ["notes", false],
        ["sketch", false],
      ],
    );
    assert.ok(!(await listFolders(w.store, "~/work/kakeibo", w.home)).entries.some((e) => e.name === ".git"));
    await assert.rejects(() => listFolders(w.store, "~/nope", w.home), /~\/nope というフォルダはありません/);
  } finally {
    w.done();
  }
});

test("既定の置き場：既定は ~/banto・ホームや / は断る・変えて戻す", async () => {
  const w = world();
  try {
    assert.deepEqual(await repoHomeView(w.store, w.home), {
      repoHome: "~/banto",
      isDefault: true,
      defaultRepoHome: "~/banto",
      exists: false,
    });
    for (const bad of ["~", "/", "~/", "", w.home]) {
      assert.throws(() => normalizeRepoHome(bad, w.home), /ホームや \/ をそのまま置き場にはできません/, bad);
    }
    assert.throws(() => normalizeRepoHome("code", w.home), /~\/ か \/ から始まる/);
    // home の下は ~/… で覚える
    assert.equal(normalizeRepoHome(`${w.home}/work/`, w.home), "~/work");

    const changed = await setRepoHome(w.store, "~/work", w.home);
    assert.deepEqual(changed, { repoHome: "~/work", isDefault: false, defaultRepoHome: "~/banto", exists: true });
    assert.deepEqual(await setRepoHome(w.store, null, w.home), (await repoHomeView(w.store, w.home)));
    assert.equal((await repoHomeView(w.store, w.home)).isDefault, true);
  } finally {
    w.done();
  }
});

test("扱うアカウント：origin の持ち主と登録した login が一致すれば台帳に覚え、一致しなければ読むだけ。登録を外しても覚えたまま", async () => {
  const w = world();
  try {
    const other = join(w.home, "work/other");
    mkdirSync(other);
    git(other, "init", "-q");
    git(other, "remote", "add", "origin", "https://github.com/someone-else/other.git");
    const account = (login: string) => ({
      login,
      credential: { kind: "pat" as const, alias: { implementation: "vault-local", name: `github-${login.toLowerCase()}-pat` } },
    });
    // まだ登録が無いうちに Import したもの
    await importRepository(w.store, "~/work/kakeibo", w.home);
    assert.equal((await w.store.entries())[0]!.account, undefined);
    const readOnly = await listRepositories(w.store, noProjects, w.home);
    assert.equal(readOnly.rows[0]!.account, undefined);

    // 大文字小文字違いの login を登録——一覧で突き合わせて覚える
    await w.store.updateAccounts(() => ({ accounts: [account("TJST-T")], result: undefined }));
    const listed = await listRepositories(w.store, noProjects, w.home);
    assert.deepEqual(listed.rows.find((r) => r.path === w.kakeibo)!.account, { login: "TJST-T", registered: true });
    assert.equal((await w.store.entries())[0]!.account, "TJST-T", "台帳に覚えていない");

    // Import の判断にも出し、足すときに覚える。持ち主が違えば覚えない
    assert.equal(((await inspectImport(w.store, "~/work/other", w.home)).check as { account?: string }).account, undefined);
    await importRepository(w.store, "~/work/other", w.home);
    const forked = join(w.home, "work/mine");
    mkdirSync(forked);
    git(forked, "init", "-q");
    git(forked, "remote", "add", "origin", "git@github.com:tjst-t/mine.git");
    assert.equal(((await inspectImport(w.store, "~/work/mine", w.home)).check as { account?: string }).account, "TJST-T");
    await importRepository(w.store, "~/work/mine", w.home);
    const accounts = new Map((await w.store.entries()).map((e) => [e.path, e.account]));
    assert.deepEqual([accounts.get(realpathSync(other)), accounts.get(realpathSync(forked))], [undefined, "TJST-T"]);

    // 登録を外しても台帳は覚えたまま——一覧は「登録されていない」と言う。登録し直せばまた繋がる
    await w.store.updateAccounts(() => ({ accounts: [], result: undefined }));
    const gone = await listRepositories(w.store, noProjects, w.home);
    assert.deepEqual(gone.rows.find((r) => r.path === w.kakeibo)!.account, { login: "TJST-T", registered: false });
    assert.equal(gone.rows.find((r) => r.path === realpathSync(other))!.account, undefined);
    await w.store.updateAccounts(() => ({ accounts: [account("tjst-t")], result: undefined }));
    const back = await listRepositories(w.store, noProjects, w.home);
    assert.deepEqual(back.rows.find((r) => r.path === w.kakeibo)!.account, { login: "tjst-t", registered: true });
  } finally {
    w.done();
  }
});

test("設定は項目ごとに変わる——置き場を変えても client ID は消えない。壊れたアカウントの一覧は空と読まない", async () => {
  const w = world();
  try {
    await w.store.updateSettings({ githubAppClientId: "Iv23liABCDEFGH" });
    await setRepoHome(w.store, "~/code", w.home);
    assert.deepEqual(await w.store.settings(), { repoHome: "~/code", githubAppClientId: "Iv23liABCDEFGH" });
    await setRepoHome(w.store, null, w.home);
    assert.deepEqual(await w.store.settings(), { githubAppClientId: "Iv23liABCDEFGH" });

    writeFileSync(join(w.dataDir, "accounts.json"), JSON.stringify({ accounts: [{ login: "x" }] }));
    await assert.rejects(() => w.store.accounts(), /アカウントの 1 件目：API の資格情報が読めません/);
    await assert.rejects(() => listRepositories(w.store, noProjects, w.home), /API の資格情報が読めません/);
  } finally {
    w.done();
  }
});

test("一覧の git 読みは台帳の書き込みの列の外——読んでいるフォルダが答えなくても、外す・Import は待たされない", async () => {
  const w = world();
  try {
    await importRepository(w.store, "~/work/kakeibo", w.home);
    await importRepository(w.store, "~/work/notes", w.home);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    // 応答しないマウントの代わり：kakeibo を読むのが止まる
    const listing = listRepositories(w.store, noProjects, w.home, async (path) => {
      if (path === w.kakeibo) {
        reading();
        await gate;
      }
      return readFolder(path);
    });
    // 一覧が読み始めてから外す（先に外すと、列の順だけで通ってしまう）
    await started;
    const removed = await Promise.race([
      removeRepository(w.store, w.notes).then(() => "removed"),
      new Promise((r) => setTimeout(() => r("blocked"), 2000)),
    ]);
    assert.equal(removed, "removed", "一覧が git を読んでいる間、台帳の書き込みが止まった");
    release();
    const rows = (await listing).rows;
    // 読んでいる間に外した行は出さない（列の中で今の台帳を見る）
    assert.deepEqual(rows.map((r) => r.path), [w.kakeibo]);
  } finally {
    w.done();
  }
});

test("元に戻すは、画面が持ってきた置き場所の字を信じず realpath に寄せる。bare は理由つきで Import を断る", async () => {
  const w = world();
  try {
    symlinkSync(join(w.home, "work"), join(w.home, "link"));
    const restored = await restoreRepository(w.store, { path: join(w.home, "link", "kakeibo") });
    assert.equal(restored.path, w.kakeibo, "シンボリックリンクの字のまま台帳に書いた");
    assert.deepEqual(restored.github, { owner: "tjst-t", name: "kakeibo" });
    await assert.rejects(() => restoreRepository(w.store, { path: w.kakeibo }), /もう一覧にあります/);

    execFileSync("git", ["init", "-q", "--bare", join(w.home, "srv.git")]);
    assert.deepEqual((await inspectImport(w.store, "~/srv.git", w.home)).check, { kind: "bare" });
    await assert.rejects(() => importRepository(w.store, "~/srv.git", w.home), /作業ツリーの無い（bare）リポジトリです/);
  } finally {
    w.done();
  }
});
