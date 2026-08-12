/**
 * task-0039: repo-manager モジュール（リポジトリとワークツリーを、状態を持たずに提供する）。
 * ADR-0010 決定36。**PO裁定 2026-08-11 で `ghq` / `gwq` 依存を外した。**
 *
 * ## なぜ外したか
 *
 * `gwq` はワークツリーの置き場を `git remote get-url origin` から組み立てる。つまり
 * **まだ push していないリポジトリではワークツリーを作れない**——実際にひらがなの
 * task-0001 / task-0002 がここで止まり、Kobo は1本も回せなかった：
 *
 * ```
 * worktree creation failed: gwq add -b task/task-0001 が失敗しました:
 *   failed to generate worktree path: failed to get repository URL: git remote get-url origin
 * ```
 *
 * いまは「リポジトリが根のどこに在るか」から導くので、リモートの有無に依らない。
 * **並びは今までと同じ**（`<根>/<host>/<owner>/<repo>` と `<置き場>/<同じ id>/<ブランチ>`）
 * なので、`ghq`/`gwq` で作った手元の資産はそのまま読める。
 *
 * **本物の git とファイルシステムで確かめる**（偽物の外部コマンドで確かめていた頃より強い）
 * ——ここは実際にディレクトリができたか・見つかるかが本題だから。
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  addTaskWorktree,
  branchDirName,
  createRepoManagerPlaceProvider,
  createRepoManagerTools,
  createWorktree,
  listGitWorktrees,
  listLocalRepositories,
  parseWorktreePorcelain,
  removeWorktree,
  repositoryId,
  repositoryPathFor,
  repoRoots,
  resetRepoDiscovery,
  runCommand,
  worktreeBase,
  worktreePathFor,
  type CommandResult,
  type CommandRunner,
} from "@banto/repo-manager";

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

/** 根の下に、リモートを持たないリポジトリを1つ作る。 */
function makeRepo(root: string, slug: string): string {
  const repo = path.join(root, ...slug.split("/"));
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

// ── 手元の並び（root / worktree base）を一時ディレクトリに閉じ込める ───────────
//
// 環境変数で切り替わるので、試験のあいだだけ差し替える。**本物の ~/ghq は触らない**。

let tmp: string;
let root: string;
let base: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-mgr-"));
  root = path.join(tmp, "roots");
  base = path.join(tmp, "worktrees");
  fs.mkdirSync(root, { recursive: true });
  savedEnv["BANTO_REPO_ROOTS"] = process.env["BANTO_REPO_ROOTS"];
  savedEnv["BANTO_WORKTREE_BASE"] = process.env["BANTO_WORKTREE_BASE"];
  process.env["BANTO_REPO_ROOTS"] = root;
  process.env["BANTO_WORKTREE_BASE"] = base;
  // 並びが変わったので、共有の写しは捨てる（前の試験の一時ディレクトリを指したままになる）
  resetRepoDiscovery();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetRepoDiscovery();
});

describe("[task-0039/a1] 手元のリポジトリとワークツリーが場所になる", () => {
  it("リポジトリの id は根からの相対パス（他が増えても変わらない）", () => {
    makeRepo(root, "github.com/tjst-t/banto");
    makeRepo(root, "github.com/oicteam/hydra");

    const places = listLocalRepositories();
    assert.deepEqual(
      places.map((p) => p.id).sort(),
      ["github.com/oicteam/hydra", "github.com/tjst-t/banto"]
    );
    assert.deepEqual(places.map((p) => p.label).sort(), ["oicteam/hydra", "tjst-t/banto"]);
    for (const place of places) assert.ok(path.isAbsolute(place.path));
  });

  it("ワークツリーの id は置き場からの相対パス。ブランチ名が名前に出る", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    await addTaskWorktree({ repoPath: repo, branch: "survey" });

    const worktrees = await listGitWorktrees(runCommand, listLocalRepositories(), base);
    assert.deepEqual(worktrees.map((w) => w.id), ["github.com/tjst-t/banto/survey"]);
    assert.deepEqual(worktrees.map((w) => w.branch), ["survey"]);
    assert.match(worktrees[0]!.label, /survey/u);
    assert.match(worktrees[0]!.label, /ワークツリー/u);
  });

  it("リポジトリ本体はワークツリー側に混ぜない（二重に出さない）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    await addTaskWorktree({ repoPath: repo, branch: "feat" });

    const worktrees = await listGitWorktrees(runCommand, listLocalRepositories(), base);
    assert.deepEqual(worktrees.map((w) => w.branch), ["feat"], "本体（main）が混じっている");
  });

  it("提供元は両方をまとめて返し、どれも読み取り専用（決定38a）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    makeRepo(root, "github.com/oicteam/hydra");
    await addTaskWorktree({ repoPath: repo, branch: "survey" });

    const places = await createRepoManagerPlaceProvider().list();
    assert.equal(places.length, 3, "リポジトリ2つ＋ワークツリー1つ");
    for (const place of places) {
      assert.equal(place.writable, undefined, `${place.id} は読み取り専用であること`);
    }
    // ワークツリーは親のリポジトリを指す（PO裁定 2026-08-05：記憶の単位は親と同じ）
    const worktree = places.find((p) => p.id.endsWith("/survey"))!;
    assert.equal(worktree.parent, "github.com/tjst-t/banto");
  });

  it("ワークツリーが1つも無くても例外にしない（0件は正常）", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    assert.deepEqual(await listGitWorktrees(runCommand, listLocalRepositories(), base), []);
  });

  it("--porcelain の読みで、本体は先頭・detached も落とさない", () => {
    const parsed = parseWorktreePorcelain(
      [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /wt/a",
        "HEAD def",
        "branch refs/heads/task/task-0001",
        "",
        "worktree /wt/b",
        "HEAD 999",
        "detached",
      ].join("\n")
    );
    assert.deepEqual(
      parsed.map((w) => [w.branch, w.main]),
      [
        ["main", true],
        ["task/task-0001", false],
        ["(detached)", false],
      ]
    );
  });
});

describe("[task-0039/a2] 独自の台帳を持たない（D3）", () => {
  it("パッケージに設定ファイル・保存先が無い", () => {
    const srcDir = new URL("../../packages/banto-repo-manager/src", import.meta.url).pathname;
    const sources = fs
      .readdirSync(srcDir, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      // 台帳を持つなら必ず書き込みが要る。作業場所の用意（mkdir）だけが例外
      if (file === "worktree.ts" || file === "tools.ts") continue;
      const content = fs.readFileSync(path.join(srcDir, file), "utf-8");
      assert.doesNotMatch(
        content,
        /writeFileSync|appendFileSync|createWriteStream/,
        `${file} が状態を書き出している（D3: 導出できる値は保存しない）`
      );
    }
  });

  /**
   * 台帳（保存される状態）と、手元の写し（いつでも捨てられるもの）は別物。
   *
   * 一覧は 400ms 以上かかり、場所の解決は Tool 呼び出しのたびに起きるので、毎回引くと
   * GUI が目に見えて遅くなる（PO報告 2026-08-04：ファイルの中身が出るまで1.4秒）。
   * **待たせないために写しを返し、取り直せることで正しさを保つ。**
   */
  it("同じ一覧を続けて聞かれても導出は1回（待たせない）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    await addTaskWorktree({ repoPath: repo, branch: "survey" });
    let calls = 0;
    const run: CommandRunner = async (command, args, options) => {
      calls += 1;
      return runCommand(command, args, options);
    };
    const provider = createRepoManagerPlaceProvider({ run });
    const first = await provider.list();
    const derived = calls;
    assert.ok(derived > 0, "1回目は導出すること");

    const second = await provider.list();
    assert.equal(calls, derived, "2回目は引き直さないこと（写しを返す）");
    assert.deepEqual(second, first, "写しでも中身は同じこと");
  });

  it("取り直させれば導出し直す（外で作られたワークツリーにも追いつける）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    const provider = createRepoManagerPlaceProvider();
    assert.equal((await provider.list()).length, 1);

    // repo-manager を通さずに作る（人が手で作ったのと同じ）
    git(repo, "worktree", "add", "-b", "outside", path.join(base, "outside"));
    await provider.refresh?.();
    assert.equal((await provider.list()).length, 2, "refresh のあとは引き直すこと");
  });

  it("写しは共有しない：偽の実行口を渡したら、その場限りの導出になる", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    const broken: CommandRunner = async (): Promise<CommandResult> => ({
      ok: false,
      stdout: "",
      stderr: "not found",
      notFound: true,
    });
    const one = createRepoManagerPlaceProvider();
    const other = createRepoManagerPlaceProvider({ run: broken });
    assert.equal((await one.list()).length, 1);
    // git が無い扱いでもリポジトリは並びから見つかる（ワークツリーだけが空）
    assert.equal((await other.list()).length, 1);
  });
});

describe("[task-0039/a3] 何も無くても番頭を止めない（決定36b）", () => {
  it("リポジトリが1つも無ければ空を返す。例外にしない", async () => {
    assert.deepEqual(await createRepoManagerPlaceProvider().list(), []);
  });

  it("根そのものが無くても空を返す（まだ何も clone していない）", () => {
    process.env["BANTO_REPO_ROOTS"] = path.join(tmp, "まだ無い");
    assert.deepEqual(listLocalRepositories(), []);
  });

  it("リポジトリの中の node_modules は別のリポジトリとして数えない", () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    const nested = path.join(repo, "node_modules", "dep");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
    assert.deepEqual(listLocalRepositories().map((r) => r.id), ["github.com/tjst-t/banto"]);
  });
});

describe("[PO裁定 2026-08-11] 置き場は並びから決まる（リモートを見ない）", () => {
  it("リモートが無いリポジトリでもワークツリーの置き場が決まる", () => {
    const repo = makeRepo(root, "github.com/ubuntu/hiragana-app");
    assert.deepEqual(git(repo, "remote").trim(), "", "この検体はリモートを持たない");

    const where = worktreePathFor({ repoPath: repo, branch: "task/task-0001" });
    assert.equal(where, path.join(base, "github.com/ubuntu/hiragana-app", "task-task-0001"));
  });

  it("並びは今までと同じ（`/` は `-` に畳む）", () => {
    assert.equal(branchDirName("task/task-0090"), "task-task-0090");
    assert.equal(branchDirName("feat/kobo/uses-modules"), "feat-kobo-uses-modules");
    assert.equal(branchDirName("survey"), "survey");
  });

  it("置き場の外へ出るブランチ名は通さない（I2）", () => {
    assert.equal(branchDirName("../../etc/passwd"), "etc-passwd");
    assert.throws(() => branchDirName("../.."), /置き場を決められません/u);
    assert.throws(() => branchDirName("   "), /置き場を決められません/u);
  });

  it("根の外にあるリポジトリはディレクトリ名を id にする（絶対パスを生やさない）", () => {
    const outside = path.join(tmp, "手で置いたもの");
    fs.mkdirSync(outside, { recursive: true });
    assert.equal(repositoryId(outside), "手で置いたもの");
    assert.equal(
      worktreePathFor({ repoPath: outside, branch: "x" }),
      path.join(base, "手で置いたもの", "x")
    );
  });

  it("clone / init の置き場を URL からも <owner>/<repo> からも決められる", () => {
    const roots = repoRoots();
    assert.equal(roots[0], root);
    assert.equal(
      repositoryPathFor("https://github.com/tjst-t/hiragana-app.git").id,
      "github.com/tjst-t/hiragana-app"
    );
    assert.equal(
      repositoryPathFor("git@github.com:tjst-t/banto.git").id,
      "github.com/tjst-t/banto"
    );
    assert.equal(repositoryPathFor("tjst-t/banto").id, "github.com/tjst-t/banto");
    assert.equal(repositoryPathFor("example.com/a/b").id, "example.com/a/b");
    assert.equal(repositoryPathFor("tjst-t/banto").path, path.join(root, "github.com/tjst-t/banto"));
    // I2: 解釈できないものは黙って適当な場所に置かない
    assert.throws(() => repositoryPathFor("banto"), /解釈できません/u);
    assert.throws(() => repositoryPathFor("  "), /決められません/u);
  });

  it("置き場は設定で移せる", () => {
    process.env["BANTO_WORKTREE_BASE"] = path.join(tmp, "べつの置き場");
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    assert.ok(
      worktreePathFor({ repoPath: repo, branch: "x" }).startsWith(worktreeBase()),
      "設定した置き場の下に決まること"
    );
  });
});

describe("[task-0039/a4] ワークツリーの作成・削除（本物の git で見る）", () => {
  it("作って消せる。消したあともう一度消しても落ちない（I3）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    const worktree = path.join(tmp, "wt", "task-1");

    await createWorktree(repo, worktree);
    assert.ok(fs.existsSync(worktree), "ワークツリーができていること");

    // 同じ場所への2回目は何もしない（Kobo が再実行しても壊れない）
    await createWorktree(repo, worktree);
    assert.ok(fs.existsSync(worktree));

    await removeWorktree(repo, worktree);
    assert.equal(fs.existsSync(worktree), false);

    // 既に消えているものへの削除は best-effort で例外にしない
    await removeWorktree(repo, worktree);
  });

  it("repo.worktree.remove は手元に無いものを消さない（取り違え防止）", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    const remove = createRepoManagerTools().find((t) => t.name === "repo.worktree.remove")!;
    await assert.rejects(() => remove.execute({ worktree: "/etc" }), /手元にありません/u);
  });

  it("repo.worktree.add は手元に無いリポジトリでは動かない", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    const add = createRepoManagerTools().find((t) => t.name === "repo.worktree.add")!;
    await assert.rejects(
      () => add.execute({ repo: "github.com/someone/unknown", branch: "x" }),
      /手元にありません/u
    );
  });

  it("repo.worktree.add は作り、もう一度押しても作り直さない", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    const tools = createRepoManagerTools();
    const add = tools.find((t) => t.name === "repo.worktree.add")!;

    const first = (await add.execute({ repo: "github.com/tjst-t/banto", branch: "feat/x" }))
      .details as { worktree: { path: string; created: boolean } };
    assert.equal(first.worktree.created, true);
    assert.ok(fs.existsSync(first.worktree.path));
    assert.equal(first.worktree.path, path.join(base, "github.com/tjst-t/banto", "feat-x"));

    const again = (await add.execute({ repo: "github.com/tjst-t/banto", branch: "feat/x" }))
      .details as { worktree: { path: string; created: boolean } };
    assert.equal(again.worktree.created, false, "作り直すと、そこで進んでいた作業が消える");
    assert.equal(again.worktree.path, first.worktree.path);

    // 作った直後に場所として引ける（写しを捨てているか）
    const places = await createRepoManagerPlaceProvider().list();
    assert.ok(places.some((p) => p.path === first.worktree.path), "作った直後に場所として引けない");
    await removeWorktree(repo, first.worktree.path);
  });

  it("Tool は任意のパスを受け取らない（砦が要らない形になっている）", () => {
    for (const tool of createRepoManagerTools()) {
      const properties = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      );
      for (const name of properties) {
        assert.doesNotMatch(
          name,
          /path|dir|cwd/i,
          `${tool.name} の引数 "${name}" がパスを受けている。場所の id だけを受けること`
        );
      }
    }
  });

  /**
   * task-0060 a6（ADR-0013 決定60）: Kobo のワークツリーを**場所として見える所**に作る。
   *
   * 以前は Kobo が `<dataDir>/worktrees/` に自分で作っていたため、実装中の中身を番頭も
   * PO も読めなかった。**そのあと gwq に作らせたが、今度はリモートの無いリポジトリで
   * 作れなくなった**（PO報告 2026-08-11）——いまは並びから決めるので、どちらも起きない。
   */
  it("[task-0060/a6] リモートが無くてもタスクのワークツリーが作れる（冪等）", async () => {
    const repo = makeRepo(root, "github.com/ubuntu/hiragana-app");

    const first = await addTaskWorktree({ repoPath: repo, branch: "task/task-0001" });
    assert.ok(first.created, "1回目は作る");
    assert.equal(
      first.path,
      path.join(base, "github.com/ubuntu/hiragana-app", "task-task-0001"),
      "並びの通りの場所にできること"
    );
    assert.ok(fs.existsSync(first.path), "実際にディレクトリができていること");

    // 冪等：監査と rework は実装者と同じワークツリーを見る必要がある
    const again = await addTaskWorktree({ repoPath: repo, branch: "task/task-0001" });
    assert.equal(again.created, false, "2回目は作らない");
    assert.equal(again.path, first.path, "同じ場所を返す（作り直すと直す対象が消える）");

    await removeWorktree(repo, first.path);
  });

  it("[task-0060/a6] ブランチが既にあれば、それを指すワークツリーを作る（rework）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    // 前回の作業でブランチだけ残っている状態
    git(repo, "branch", "task/task-0002");

    const created = await addTaskWorktree({ repoPath: repo, branch: "task/task-0002" });
    assert.ok(created.created);
    assert.equal(
      git(created.path, "rev-parse", "--abbrev-ref", "HEAD").trim(),
      "task/task-0002",
      "既存のブランチを指すこと（-b を付けると落ちる）"
    );
    await removeWorktree(repo, created.path);
  });

  it("[task-0060/a6] 作れなかったら黙って別の場所に作らない（I2）", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    await assert.rejects(
      () => addTaskWorktree({ repoPath: repo, branch: "無い/../.." }),
      /置き場を決められません/u,
      "置き場を決められないなら理由を添えて止まる"
    );
    // git が無い環境でも、黙って成功にしない
    const noGit: CommandRunner = async (): Promise<CommandResult> => ({
      ok: false,
      stdout: "",
      stderr: "not found",
      notFound: true,
    });
    await assert.rejects(
      () => addTaskWorktree({ repoPath: repo, branch: "task/task-9999", run: noGit }),
      /git が導入されていない/u
    );
  });

  it("Git の変更操作は持たない（決定37）", () => {
    for (const tool of createRepoManagerTools()) {
      assert.doesNotMatch(tool.name, /commit|push|branch\.|remote|tag|merge|reset/);
    }
  });
});

describe("[task-0043] repo.list（GUI が引く一覧）", () => {
  it("リポジトリとワークツリーを分けて返し、どのリポジトリのものかも分かる", async () => {
    const repo = makeRepo(root, "github.com/tjst-t/banto");
    makeRepo(root, "github.com/oicteam/hydra");
    await addTaskWorktree({ repoPath: repo, branch: "survey" });

    const list = createRepoManagerTools().find((t) => t.name === "repo.list")!;
    const details = (await list.execute({})).details as {
      repositories: Array<{ id: string }>;
      worktrees: Array<{ id: string; branch: string; repo: string | null }>;
    };

    assert.deepEqual(details.repositories.map((r) => r.id).sort(), [
      "github.com/oicteam/hydra",
      "github.com/tjst-t/banto",
    ]);
    assert.deepEqual(details.worktrees.map((w) => [w.branch, w.repo]), [
      ["survey", "github.com/tjst-t/banto"],
    ]);
  });

  it("query で絞れる", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    makeRepo(root, "github.com/oicteam/hydra");
    const list = createRepoManagerTools().find((t) => t.name === "repo.list")!;
    const details = (await list.execute({ query: "hydra" })).details as {
      repositories: Array<{ id: string }>;
    };
    assert.deepEqual(details.repositories.map((r) => r.id), ["github.com/oicteam/hydra"]);
  });
});

describe("[task-0045] リポジトリを増やす（clone / init）", () => {
  it("repo.clone は git clone を呼び、並びの通りの場所に置く", async () => {
    // 「リモート」は手元の別のリポジトリで代用する（ネットワークへ出ない）
    const origin = makeRepo(path.join(tmp, "remote"), "origin.git");
    let called: readonly string[] | undefined;
    const run: CommandRunner = async (command, args, options) => {
      if (command === "git" && args[0] === "clone") called = args;
      return runCommand(command, args, options);
    };

    const clone = createRepoManagerTools({ run }).find((t) => t.name === "repo.clone")!;
    const details = (await clone.execute({ repository: `file://${origin}` })).details as {
      repository: { id: string; path: string };
      alreadyPresent: boolean;
    };

    assert.equal(details.alreadyPresent, false);
    assert.ok(fs.existsSync(path.join(details.repository.path, ".git")), "実体があること");
    assert.ok(called?.includes(details.repository.path), "決めた場所へ clone していること");
    // 置いた場所がそのまま一覧に出る（見込みのパスを返していない・D3）
    assert.ok(
      listLocalRepositories().some((r) => r.path === details.repository.path),
      "取り込んだものが場所として引けない"
    );
  });

  it("既にあるものを取りに行かない（外へ出る操作は必要なときだけ）", async () => {
    makeRepo(root, "github.com/tjst-t/banto");
    let cloned = false;
    const run: CommandRunner = async (command, args, options) => {
      if (command === "git" && args[0] === "clone") cloned = true;
      return runCommand(command, args, options);
    };
    const clone = createRepoManagerTools({ run }).find((t) => t.name === "repo.clone")!;
    const details = (await clone.execute({ repository: "tjst-t/banto" })).details as {
      alreadyPresent: boolean;
    };
    assert.equal(details.alreadyPresent, true);
    assert.equal(cloned, false, "既にあるのにネットワークへ出ている");
  });

  it("失敗したら理由が返る（黙って成功に見せない）", async () => {
    const clone = createRepoManagerTools().find((t) => t.name === "repo.clone")!;
    await assert.rejects(
      () => clone.execute({ repository: `file://${path.join(tmp, "無いリポジトリ")}` }),
      /取ってこられませんでした/u
    );
  });

  it("repo.init は空のリポジトリを作る。同じ名前を2度作らない", async () => {
    const init = createRepoManagerTools().find((t) => t.name === "repo.init")!;
    const details = (await init.execute({ name: "tjst-t/新しいの" })).details as {
      repository: { id: string; path: string };
    };
    assert.equal(details.repository.id, "github.com/tjst-t/新しいの");
    assert.ok(fs.existsSync(path.join(details.repository.path, ".git")));

    await assert.rejects(() => init.execute({ name: "tjst-t/新しいの" }), /既にあります/u);
  });

  it("空の指定は通さない", async () => {
    const tools = createRepoManagerTools();
    await assert.rejects(
      () => tools.find((t) => t.name === "repo.clone")!.execute({ repository: "   " }),
      /空です/u
    );
    await assert.rejects(
      () => tools.find((t) => t.name === "repo.init")!.execute({ name: "" }),
      /空です/u
    );
  });
});

describe("[task-0039] 本物の手元（何も無ければ飛ばす）", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env["BANTO_REPO_ROOTS"];
    delete process.env["BANTO_REPO_ROOTS"];
  });
  after(() => {
    if (saved !== undefined) process.env["BANTO_REPO_ROOTS"] = saved;
  });

  it("実物から場所を導出できる", async (t) => {
    delete process.env["BANTO_REPO_ROOTS"];
    delete process.env["BANTO_WORKTREE_BASE"];
    const places = listLocalRepositories();
    if (places.length === 0) {
      t.skip("手元にリポジトリが無い環境なのでこの確認は飛ばす（決定36b の通り空で動く）");
      return;
    }
    for (const place of places) {
      assert.ok(path.isAbsolute(place.path), `${place.id} の path が絶対パスであること`);
      assert.ok(place.id.length > 0 && place.label.length > 0);
      assert.ok(fs.existsSync(path.join(place.path, ".git")), `${place.id} が実在すること`);
    }
  });
});
