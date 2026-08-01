/**
 * task-0039: repo-manager モジュール（ghq / gwq を状態を持たずに提供する）。ADR-0010 決定36。
 *
 * **Kobo も Banto も起こさない**（a6）。外部コマンドの口（CommandRunner）を差し替えて、
 * `ghq` / `gwq` が入っていない機械でも中身を検証できるようにしてある。
 * ワークツリーの作成・削除だけは本物の `git` で確かめる——ここは実際にディレクトリが
 * できたか消えたかが本題で、偽物では何も見たことにならない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createRepoManagerPlaceProvider,
  createRepoManagerTools,
  createWorktree,
  listGhqRepositories,
  listGwqWorktrees,
  removeWorktree,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "@banto/repo-manager";

/** 応答表から答える偽の外部コマンド。キーは `コマンド 引数...`。 */
function fakeRunner(responses: Record<string, string | Error>): CommandRunner {
  return async (command, args): Promise<CommandResult> => {
    const key = [command, ...args].join(" ");
    const value = responses[key];
    if (value === undefined) {
      // 表に無い＝そのコマンドは入っていない、として扱う
      return { ok: false, stdout: "", stderr: "not found", notFound: true };
    }
    if (value instanceof Error) {
      return { ok: false, stdout: "", stderr: value.message, notFound: false };
    }
    return { ok: true, stdout: value, stderr: "", notFound: false };
  };
}

const GHQ_RESPONSES = {
  "ghq root --all": "/home/u/ghq\n",
  "ghq list --full-path": "/home/u/ghq/github.com/tjst-t/banto\n/home/u/ghq/github.com/oicteam/hydra\n",
};

const GWQ_RESPONSES = {
  "gwq config get worktree.basedir": "~/worktrees\n",
  "gwq list -g --json": JSON.stringify([
    { path: `${os.homedir()}/worktrees/github.com/oicteam/hydra/refine-ui`, branch: "refine-ui", is_main: false },
    { path: `${os.homedir()}/worktrees/github.com/tjst-t/banto/survey`, branch: "survey", is_main: false },
  ]),
};

describe("[task-0039/a1] ghq のリポジトリと gwq のワークツリーが場所になる", () => {
  it("リポジトリの id は ghq のルートからの相対パス（他が増えても変わらない）", async () => {
    const places = await listGhqRepositories(fakeRunner(GHQ_RESPONSES));
    assert.deepEqual(
      places.map((p) => p.id),
      ["github.com/tjst-t/banto", "github.com/oicteam/hydra"]
    );
    assert.deepEqual(places.map((p) => p.label), ["tjst-t/banto", "oicteam/hydra"]);
    assert.equal(places[0]!.path, "/home/u/ghq/github.com/tjst-t/banto");
  });

  it("ワークツリーの id は gwq の置き場からの相対パス。ブランチ名が名前に出る", async () => {
    const worktrees = await listGwqWorktrees(fakeRunner(GWQ_RESPONSES));
    assert.deepEqual(
      worktrees.map((w) => w.id),
      ["github.com/oicteam/hydra/refine-ui", "github.com/tjst-t/banto/survey"]
    );
    assert.match(worktrees[0]!.label, /refine-ui/);
    assert.match(worktrees[0]!.label, /ワークツリー/);
  });

  it("提供元は両方をまとめて返す", async () => {
    const provider = createRepoManagerPlaceProvider({
      run: fakeRunner({ ...GHQ_RESPONSES, ...GWQ_RESPONSES }),
    });
    const places = await provider.list();
    assert.equal(places.length, 4);
    // 決定38a: ghq が見つけたものは1つも書けない
    for (const place of places) {
      assert.equal(place.writable, undefined, `${place.id} は読み取り専用であること`);
    }
  });

  it("リポジトリ本体（is_main）はワークツリー側に混ぜない（ghq と二重にならない）", async () => {
    const worktrees = await listGwqWorktrees(
      fakeRunner({
        "gwq config get worktree.basedir": "~/worktrees\n",
        "gwq list -g --json": JSON.stringify([
          { path: "/home/u/ghq/github.com/tjst-t/banto", branch: "main", is_main: true },
          { path: `${os.homedir()}/worktrees/x/y/z/feat`, branch: "feat", is_main: false },
        ]),
      })
    );
    assert.deepEqual(worktrees.map((w) => w.branch), ["feat"]);
  });
});

describe("[task-0039/a2] 独自の台帳を持たない（D3）", () => {
  it("パッケージに設定ファイル・保存先が無い", () => {
    const srcDir = path.join(new URL("../../packages/banto-repo-manager/src", import.meta.url).pathname);
    const sources = fs
      .readdirSync(srcDir, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf-8");
      // 台帳を持つなら必ず書き込みが要る。worktree.ts の mkdir（作業場所の用意）だけが例外
      if (file === "worktree.ts") continue;
      assert.doesNotMatch(
        content,
        /writeFileSync|appendFileSync|createWriteStream/,
        `${file} が状態を書き出している（D3: 導出できる値は保存しない）`
      );
    }
  });

  it("一覧は呼ぶたびに導出される（結果を溜め込まない）", async () => {
    let calls = 0;
    const run: CommandRunner = async (command, args) => {
      calls += 1;
      return fakeRunner({ ...GHQ_RESPONSES, ...GWQ_RESPONSES })(command, args);
    };
    const provider = createRepoManagerPlaceProvider({ run });
    await provider.list();
    const first = calls;
    await provider.list();
    assert.equal(calls, first * 2, "2回目もコマンドを引き直すこと");
  });
});

describe("[task-0039/a3] 未導入でも番頭を止めない（決定36b）", () => {
  it("ghq も gwq も無ければ場所を1つも返さない。例外にしない", async () => {
    const provider = createRepoManagerPlaceProvider({ run: fakeRunner({}) });
    assert.deepEqual(await provider.list(), []);
  });

  it("片方だけ入っていれば、入っている方だけ返す", async () => {
    const provider = createRepoManagerPlaceProvider({ run: fakeRunner(GHQ_RESPONSES) });
    const places = await provider.list();
    assert.deepEqual(places.map((p) => p.id), ["github.com/tjst-t/banto", "github.com/oicteam/hydra"]);
  });

  it("入っているのに失敗したら黙って空を返さない（I2: 壊れたことに気づけなくなる）", async () => {
    const provider = createRepoManagerPlaceProvider({
      run: fakeRunner({
        "ghq root --all": "/home/u/ghq\n",
        "ghq list --full-path": new Error("permission denied"),
      }),
    });
    await assert.rejects(() => provider.list(), /permission denied/);
  });
});

describe("[task-0039/a4] ワークツリーの作成・削除（本物の git で見る）", () => {
  let dir: string;
  let repo: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-mgr-"));
    repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      childProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "init");
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("作って消せる。消したあともう一度消しても落ちない（I3）", async () => {
    const worktree = path.join(dir, "wt", "task-1");

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

  it("repo.worktree.remove は gwq が知らないものを消さない（取り違え防止）", async () => {
    const tools = createRepoManagerTools({ run: fakeRunner(GWQ_RESPONSES) });
    const remove = tools.find((t) => t.name === "repo.worktree.remove")!;
    await assert.rejects(
      () => remove.execute({ worktree: "/etc" }),
      /gwq が知りません/
    );
  });

  it("repo.worktree.add は ghq が知らないリポジトリでは動かない", async () => {
    const tools = createRepoManagerTools({ run: fakeRunner(GHQ_RESPONSES) });
    const add = tools.find((t) => t.name === "repo.worktree.add")!;
    await assert.rejects(
      () => add.execute({ repo: "github.com/someone/unknown", branch: "x" }),
      /ghq が知りません/
    );
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

  it("Git の変更操作は持たない（決定37）", () => {
    for (const tool of createRepoManagerTools()) {
      assert.doesNotMatch(tool.name, /commit|push|branch\.|remote|tag|merge|reset/);
    }
  });
});

describe("[task-0039] 本物の ghq / gwq（入っていなければ飛ばす）", () => {
  it("実物から場所を導出できる", async (t) => {
    const probe = await runCommand("ghq", ["root", "--all"]);
    if (probe.notFound) {
      t.skip("ghq が入っていない環境なのでこの確認は飛ばす（決定36b の通り空で動く）");
      return;
    }
    const places = await createRepoManagerPlaceProvider().list();
    assert.ok(places.length > 0, "1つ以上の場所が見つかること");
    for (const place of places) {
      assert.ok(path.isAbsolute(place.path), `${place.id} の path が絶対パスであること`);
      assert.ok(place.id.length > 0 && place.label.length > 0);
    }
  });
});

describe("[task-0043] repo.list（GUI が引く一覧）", () => {
  it("リポジトリとワークツリーを分けて返し、どのリポジトリのものかも分かる", async () => {
    const worktreePath = `${os.homedir()}/worktrees/github.com/tjst-t/banto/survey`;
    const tools = createRepoManagerTools({
      run: fakeRunner({
        ...GHQ_RESPONSES,
        "gwq config get worktree.basedir": "~/worktrees\n",
        "gwq list -g --json": JSON.stringify([
          { path: worktreePath, branch: "survey", is_main: false },
        ]),
        // 属するリポジトリは git に聞く（gwq の出力には入っていない）
        [`git -C ${worktreePath} worktree list --porcelain`]:
          "worktree /home/u/ghq/github.com/tjst-t/banto\nHEAD abc\n",
      }),
    });
    const list = tools.find((t) => t.name === "repo.list")!;
    const details = (await list.execute({})).details as {
      repositories: Array<{ id: string }>;
      worktrees: Array<{ id: string; branch: string; repo: string | null }>;
    };

    assert.deepEqual(details.repositories.map((r) => r.id), [
      "github.com/tjst-t/banto",
      "github.com/oicteam/hydra",
    ]);
    assert.deepEqual(details.worktrees.map((w) => [w.branch, w.repo]), [
      ["survey", "github.com/tjst-t/banto"],
    ]);
  });

  it("属するリポジトリが分からなくても一覧から落とさない（畳み忘れが見えなくなる）", async () => {
    const orphan = `${os.homedir()}/worktrees/どこか/x`;
    const tools = createRepoManagerTools({
      run: fakeRunner({
        ...GHQ_RESPONSES,
        "gwq config get worktree.basedir": "~/worktrees\n",
        "gwq list -g --json": JSON.stringify([{ path: orphan, branch: "x", is_main: false }]),
        // git に聞けない（表に無い＝コマンドが無い扱い）
      }),
    });
    const details = (await tools.find((t) => t.name === "repo.list")!.execute({})).details as {
      worktrees: Array<{ repo: string | null }>;
    };
    assert.deepEqual(details.worktrees.map((w) => w.repo), [null]);
  });

  it("query で絞れる", async () => {
    const tools = createRepoManagerTools({ run: fakeRunner(GHQ_RESPONSES) });
    const details = (await tools.find((t) => t.name === "repo.list")!.execute({ query: "hydra" }))
      .details as { repositories: Array<{ id: string }> };
    assert.deepEqual(details.repositories.map((r) => r.id), ["github.com/oicteam/hydra"]);
  });
});

describe("[task-0045] リポジトリを増やす（clone / init）", () => {
  it("repo.clone は ghq get を呼び、増えたものを ghq に聞き直して返す", async () => {
    let called: readonly string[] | undefined;
    const after = "/home/u/ghq/github.com/tjst-t/新しいの";
    let cloned = false;
    const run: CommandRunner = async (command, args) => {
      if (command === "ghq" && args[0] === "get") {
        called = args;
        cloned = true;
        return { ok: true, stdout: "", stderr: "", notFound: false };
      }
      if (command === "ghq" && args[0] === "list") {
        return {
          ok: true,
          stdout: GHQ_RESPONSES["ghq list --full-path"] + (cloned ? `${after}\n` : ""),
          stderr: "",
          notFound: false,
        };
      }
      return fakeRunner(GHQ_RESPONSES)(command, args);
    };

    const clone = createRepoManagerTools({ run }).find((t) => t.name === "repo.clone")!;
    const result = await clone.execute({ repository: "tjst-t/新しいの" });
    const details = result.details as { repository: { id: string } | null; alreadyPresent: boolean };

    assert.deepEqual(called, ["get", "tjst-t/新しいの"]);
    assert.equal(details.repository?.id, "github.com/tjst-t/新しいの");
    assert.equal(details.alreadyPresent, false);
  });

  it("既にあるものを取っても「増えました」と言わない", async () => {
    const run: CommandRunner = async (command, args) => {
      if (command === "ghq" && args[0] === "get") {
        return { ok: true, stdout: "", stderr: "", notFound: false };
      }
      return fakeRunner(GHQ_RESPONSES)(command, args);
    };
    const clone = createRepoManagerTools({ run }).find((t) => t.name === "repo.clone")!;
    const details = (await clone.execute({ repository: "tjst-t/banto" })).details as {
      alreadyPresent: boolean;
    };
    assert.equal(details.alreadyPresent, true);
  });

  it("失敗したら理由が返る（黙って成功に見せない）", async () => {
    const run: CommandRunner = async (command, args) => {
      if (command === "ghq" && args[0] === "get") {
        return { ok: false, stdout: "", stderr: "repository not found", notFound: false };
      }
      return fakeRunner(GHQ_RESPONSES)(command, args);
    };
    const clone = createRepoManagerTools({ run }).find((t) => t.name === "repo.clone")!;
    await assert.rejects(() => clone.execute({ repository: "だれか/無い" }), /repository not found/);
  });

  it("repo.init は ghq create を呼ぶ。増えていなければ成功に見せない", async () => {
    const silent: CommandRunner = async (command, args) => {
      if (command === "ghq" && args[0] === "create") {
        return { ok: true, stdout: "", stderr: "", notFound: false };
      }
      return fakeRunner(GHQ_RESPONSES)(command, args);
    };
    const init = createRepoManagerTools({ run: silent }).find((t) => t.name === "repo.init")!;
    // create は成功したのに一覧が増えない＝何かおかしい。黙って通さない
    await assert.rejects(() => init.execute({ name: "tjst-t/増えないの" }), /現れませんでした/);
  });

  it("空の指定は ghq へ渡さない", async () => {
    const tools = createRepoManagerTools({ run: fakeRunner(GHQ_RESPONSES) });
    await assert.rejects(
      () => tools.find((t) => t.name === "repo.clone")!.execute({ repository: "   " }),
      /空です/
    );
    await assert.rejects(
      () => tools.find((t) => t.name === "repo.init")!.execute({ name: "" }),
      /空です/
    );
  });

  it("Git の変更操作は増えていない（決定37）", () => {
    for (const tool of createRepoManagerTools()) {
      assert.doesNotMatch(tool.name, /commit|push|branch\.|remote|tag|merge|reset/);
    }
  });
});
