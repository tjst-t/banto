// Factory の実行を、本物の git と偽の Subagent・Backlog で端から端まで通す（v4-modules.md §4.5）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory, ReplyBox, type FactoryPorts, type Procedure, type RunRecord, type TaskSnapshot } from "./engine.js";
import { deliverTask } from "./procedure.js";
import { execCommand } from "./server.js";
import { DEFAULT_SETTINGS, type FactorySettings } from "./settings.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

interface Fake {
  /** 実装役が頼まれた回数 */
  implements: number;
  reviews: number;
  backlog: Array<{ id: string; status: string }>;
  stopped: string[];
  finished: RunRecord[];
}

/**
 * 偽の Subagent：実装役は頼みの中の `<commit 名前>` のファイルをその worktree に書いてコミットする（続きの頼みでは
 * `fix` の名前で）。レビュー役は `verdicts` を順に返す
 */
function setup(opts: { holdReplies?: boolean; notifyFails?: boolean; procedure?: Procedure; settings?: Partial<FactorySettings>; verdicts?: Array<"pass" | "changes">; implement?: (prompt: string, cwd: string, n: number) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-"));
  const project = join(root, "project");
  const data = join(root, "data");
  execFileSync("mkdir", ["-p", project]);
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "README"), "x\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "init");
  const fake: Fake = { implements: 0, reviews: 0, backlog: [], stopped: [], finished: [] };
  const verdicts = [...(opts.verdicts ?? [])];
  let seq = 0;
  let factory!: Factory;
  void 0;
  const held: Array<() => void> = [];
  const deliverLater = (replyId: string, body: unknown) => {
    const go = () => factory.receiveReply({ replyId, from: "subagent", title: "終わりました", text: JSON.stringify(body), final: true, lost: false });
    if (opts.holdReplies) held.push(go);
    else setTimeout(go, 5);
  };
  const ports: FactoryPorts = {
    call: async (role, tool, args) => {
      if (role === "backlog") {
        fake.backlog.push({ id: String(args.id), status: String(args.status) });
        return { text: "ok", isError: false };
      }
      if (tool === "cancelSubagent") return { text: "止めました", isError: false };
      const replyId = `rid_${++seq}`;
      const cwd = join(project, String(args.cwd));
      const prompt = String(args.prompt);
      if (args.schema) {
        fake.reviews++;
        const v = verdicts.shift() ?? "pass";
        deliverLater(replyId, { text: "", sessionId: "rev", structured: { verdict: v, items: v === "pass" ? [] : [{ what: "直す", why: "試験" }] } });
      } else {
        fake.implements++;
        (opts.implement ?? defaultImplement)(prompt, cwd, fake.implements);
        deliverLater(replyId, { text: "やりました", sessionId: args.sessionId ?? `s${seq}` });
      }
      return { text: JSON.stringify({ runId: `run${seq}` }), isError: false, meta: { "dev.banto/replyId": replyId } };
    },
    exec: execCommand,
  };
  const make = () =>
    new Factory({
      dataDir: data,
      projectRoot: project,
      ports,
      procedure: (ctx) => (opts.procedure ?? deliverTask)(ctx),
      replies: new ReplyBox(join(data, "replies")),
      events: {
        itemStopped: async (_run, item) => {
          fake.stopped.push(item.stopped!.reason);
          return !opts.notifyFails;
        },
        runFinished: async (run) => void fake.finished.push(run),
      },
    });
  factory = make();
  const settings: FactorySettings = { ...DEFAULT_SETTINGS, testCommand: "test -f README", ...opts.settings };
  return {
    project,
    fake,
    opts,
    get factory() {
      return factory;
    },
    restart() {
      factory = make();
      return factory.resumeAll();
    },
    settings,
    held,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function defaultImplement(prompt: string, cwd: string, n: number) {
  const m = /<commit ([\w.-]+)>/.exec(prompt);
  const name = m ? m[1]! : `fix-${n}.txt`;
  writeFileSync(join(cwd, name), `${n}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", `add ${name}`);
}

const task = (id: string, body = ""): TaskSnapshot => ({ id, number: null, kind: "task", title: `題 ${id}`, body, doneWhen: "" });

async function until(cond: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`待っても ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("1件：実装→テスト→レビュー→main に入り、Backlog が in-progress→done、worktree とブランチが片づく", async () => {
  const s = setup();
  try {
    const run = s.factory.start({ tasks: [task("a", "<commit a.txt>")], settings: s.settings });
    await until(() => s.fake.finished.length === 1, "終わらない");
    assert.equal(run.items[0]!.status, "done");
    assert.ok(existsSync(join(s.project, "a.txt")), "main（作業ツリー）に入っていない");
    assert.deepEqual(s.fake.backlog.map((b) => b.status), ["in-progress", "done"]);
    assert.equal(existsSync(join(s.project, ".worktrees", "factory-a")), false, "worktree が残っている");
    assert.equal(git(s.project, "branch", "--list", "factory/a"), "");
  } finally {
    s.cleanup();
  }
});

test("テストが上限を越えて落ちたら止まって知らせ、「続ける」の指示で直して入る", async () => {
  const s = setup({
    settings: { testCommand: "test -f ok.txt", limits: { ...DEFAULT_SETTINGS.limits, testRetries: 1 } },
    implement: (prompt, cwd, n) => defaultImplement(prompt.includes("人からの指示：ok") ? "<commit ok.txt>" : prompt, cwd, n),
  });
  try {
    const run = s.factory.start({ tasks: [task("b")], settings: s.settings });
    await until(() => s.fake.stopped.length === 1, "止まらない");
    assert.match(s.fake.stopped[0]!, /テストが 2 回続けて落ちました/);
    assert.equal(run.items[0]!.status, "stopped");
    s.factory.answer(run.id, "b", { action: "continue", instruction: "ok" });
    await until(() => s.fake.finished.length === 1, "答えたのに終わらない");
    assert.equal(run.items[0]!.status, "done");
    assert.ok(existsSync(join(s.project, "ok.txt")));
  } finally {
    s.cleanup();
  }
});

test("Factory を起こし直すと、記録から流し直して続ける——終わった段（サブエージェント）を繰り返さない", async () => {
  const s = setup({ settings: { testCommand: "test -f never.txt", limits: { ...DEFAULT_SETTINGS.limits, testRetries: 0 } } });
  try {
    const run = s.factory.start({ tasks: [task("c")], settings: s.settings });
    await until(() => s.factory.get(run.id)!.items[0]!.stopped?.notified === true, "止まったことを知らせない");
    const before = s.fake.implements;
    // 起こし直す（前の Factory は捨てる——走っていた待ちは消える）
    const resumed = s.restart();
    assert.equal(resumed.length, 1);
    await until(() => answerWhenAsked(s.factory, run.id, "c", { action: "drop", reason: "試験" }), "起こし直したあと、また問いまで来ない");
    assert.equal(s.fake.implements, before, "起こし直しで実装役にもう一度頼んだ");
    assert.equal(s.fake.stopped.length, 1, "届いた「止まりました」を流し直しで届け直した");
    await until(() => s.fake.finished.length === 1, "やめたのに終わらない");
    assert.equal(s.factory.get(run.id)!.items[0]!.status, "dropped");
    assert.equal(s.fake.backlog.at(-1)?.status, "ready");
  } finally {
    s.cleanup();
  }
});

/** 止まって問いを待っていれば答える（流し直しが問いまで来たか）。まだなら false */
function answerWhenAsked(factory: Factory, runId: string, taskId: string, answer: Parameters<Factory["answer"]>[2]): boolean {
  try {
    factory.answer(runId, taskId, answer);
    return true;
  } catch {
    return false;
  }
}

test("止まった知らせが届かないまま Factory が起き直したら、流し直して問いに戻ったとき届け直す", async () => {
  const s = setup({ notifyFails: true, settings: { testCommand: "test -f never.txt", limits: { ...DEFAULT_SETTINGS.limits, testRetries: 0 } } });
  try {
    const run = s.factory.start({ tasks: [task("c2")], settings: s.settings });
    await until(() => s.fake.stopped.length === 1, "止まらない");
    assert.equal(s.factory.get(run.id)!.items[0]!.stopped?.notified, undefined);
    s.opts.notifyFails = false;
    s.restart();
    await until(() => s.fake.stopped.length === 2, "届かなかった「止まりました」を届け直さない");
    await until(() => s.factory.get(run.id)!.items[0]!.stopped?.notified === true, "届いたことが記録に残らない");
    assert.ok(answerWhenAsked(s.factory, run.id, "c2", { action: "drop", reason: "試験" }));
    await until(() => s.fake.finished.length === 1, "やめたのに終わらない");
  } finally {
    s.cleanup();
  }
});

test("記録と手順が食い違って止まった1件は、起き直して同じ食い違いで止まっても「止まりました」を届け直さない", async () => {
  const s = setup({ settings: { testCommand: "test -f never.txt", limits: { ...DEFAULT_SETTINGS.limits, testRetries: 0 } } });
  try {
    const run = s.factory.start({ tasks: [task("g")], settings: s.settings });
    await until(() => s.factory.get(run.id)!.items[0]!.stopped?.notified === true, "止まらない");
    // 手順が変わった（4 番目の段が違う）——流し直すと記録と食い違う
    s.opts.procedure = async (ctx) => {
      await ctx.stage("違う段");
    };
    s.restart();
    await until(() => s.fake.stopped.length === 2, "食い違いで止まらない");
    assert.match(s.fake.stopped[1]!, /記録と手順が食い違いました/);
    await until(() => s.factory.get(run.id)!.items[0]!.stopped?.notified === true, "届いたことが記録に残らない");
    s.restart();
    await until(() => answerWhenAsked(s.factory, run.id, "g", { action: "drop", reason: "試験" }), "起こし直したあと、また問いまで来ない");
    assert.equal(s.fake.stopped.length, 2, "同じ食い違いの「止まりました」を届け直した");
    await until(() => s.fake.finished.length === 1, "やめたのに終わらない");
  } finally {
    s.cleanup();
  }
});

test("2件を同時に流すと、マージの列で1件ずつ入る（後の1件は rebase してテストしてから）", async () => {
  const s = setup();
  try {
    s.factory.start({ tasks: [task("d", "<commit d.txt>"), task("e", "<commit e.txt>")], settings: s.settings });
    await until(() => s.fake.finished.length === 1, "終わらない");
    assert.ok(existsSync(join(s.project, "d.txt")) && existsSync(join(s.project, "e.txt")));
    assert.equal(Number(git(s.project, "rev-list", "--count", "main")), 3);
  } finally {
    s.cleanup();
  }
});

test("レビューで直すことがあれば実装役へ戻し、上限を越えたら止まる。「このまま取り込む」で入る", async () => {
  const s = setup({ verdicts: ["changes", "changes"], settings: { limits: { ...DEFAULT_SETTINGS.limits, reviewRounds: 1 } } });
  try {
    const run = s.factory.start({ tasks: [task("f", "<commit f.txt>")], settings: s.settings });
    await until(() => s.fake.stopped.length === 1, "止まらない");
    assert.match(s.fake.stopped[0]!, /レビューで 2 回/);
    assert.equal(s.fake.implements, 2, "1回目の指摘で実装役へ戻していない");
    s.factory.answer(run.id, "f", { action: "accept" });
    await until(() => s.fake.finished.length === 1, "取り込まない");
    assert.equal(run.items[0]!.status, "done");
  } finally {
    s.cleanup();
  }
});

test("止める：走っている件はやめて Backlog を ready に戻し、worktree は残す", async () => {
  const s = setup({ settings: { testCommand: "sleep 30" } });
  try {
    const run = s.factory.start({ tasks: [task("g", "<commit g.txt>")], settings: s.settings });
    await until(() => run.items[0]!.stage === "テスト", "テストに来ない");
    await s.factory.cancel(run.id, undefined, "試験で止めた");
    await until(() => s.fake.finished.length === 1, "止めたのに終わらない");
    assert.equal(run.items[0]!.status, "dropped");
    assert.equal(s.fake.backlog.at(-1)?.status, "ready");
    assert.ok(existsSync(join(s.project, ".worktrees", "factory-g")));
  } finally {
    s.cleanup();
  }
});

test("サブエージェントの返事を待っているうちに Factory が起き直しても、頼み直さずに同じ返事を待って続ける", async () => {
  const s = setup({ holdReplies: true });
  try {
    const run = s.factory.start({ tasks: [task("h", "<commit h.txt>")], settings: s.settings });
    await until(() => s.held.length === 1, "実装役に頼まない");
    s.restart();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.fake.implements, 1, "起き直したあと実装役に頼み直した");
    // 返事は起き直したあとに届く（host が残してから渡す）
    s.held.shift()!();
    await until(() => s.held.length === 1, "レビューに進まない");
    s.held.shift()!();
    await until(() => s.fake.finished.length === 1, "終わらない");
    assert.equal(s.factory.get(run.id)!.items[0]!.status, "done");
  } finally {
    s.cleanup();
  }
});

// ---- マージの列（Backlog の factory-merge-queue） ---------------------------------------------------------

/** README の n 行目（1 から）を書き換えてコミットする実装役。頼みの中の `<line N 文>` で決まる */
function editLine(prompt: string, cwd: string, n: number) {
  const m = /<line (\d+) ([^>]+)>/.exec(prompt);
  if (!m) return defaultImplement(prompt, cwd, n);
  const lines = readFileSync(join(cwd, "README"), "utf8").split("\n");
  lines[Number(m[1]) - 1] = m[2]!;
  writeFileSync(join(cwd, "README"), lines.join("\n"));
  git(cwd, "commit", "-q", "-am", `README ${m[1]} 行目を ${m[2]}`);
}

/** main の README を5行にしておく（worktree は流し始めたときの main から作られる） */
function fiveLines(project: string) {
  writeFileSync(join(project, "README"), "1\n2\n3\n4\n5\n");
  git(project, "commit", "-q", "-am", "5行にする");
}

test("同じファイルの別の場所を触る2件は、両方とも順に main に入る——後の1件は rebase してテストし直してから", async () => {
  const s = setup({ implement: editLine });
  try {
    fiveLines(s.project);
    const run = s.factory.start({ tasks: [task("top", "<line 1 上>"), task("bottom", "<line 5 下>")], settings: s.settings });
    await until(() => s.fake.finished.length === 1, "終わらない");
    assert.deepEqual(run.items.map((i) => i.status), ["done", "done"]);
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), "上\n2\n3\n4\n下\n", "両方の変更が main（作業ツリー）に揃っていない");
    // 履歴は一直線（マージコミットを作らない）。後に入った1件は先の1件の上に積み直されている
    const subjects = git(s.project, "log", "--format=%s", "main").split("\n");
    assert.equal(subjects.length, 4);
    assert.ok(subjects.slice(0, 2).every((x) => x.startsWith("README")), subjects.join(" / "));
    assert.equal(git(s.project, "rev-list", "--merges", "--count", "main"), "0");
    for (const item of run.items) {
      const steps = s.factory.journalOf(run.id, item.task.id).map((x) => x.key);
      assert.ok(steps.includes("rebase") && steps.filter((k) => k === "test").length >= 2, `${item.task.id} が取り込む直前にテストしていない：${steps.join(",")}`);
    }
  } finally {
    s.cleanup();
  }
});

test("本当に競合する2件では、後の1件が rebase で止まって知らせる。worktree で直して「続ける」と入る", async () => {
  const s = setup({ implement: editLine });
  try {
    fiveLines(s.project);
    const run = s.factory.start({ tasks: [task("a", "<line 3 甲>"), task("b", "<line 3 乙>")], settings: s.settings });
    await until(() => s.fake.stopped.length === 1, "競合で止まらない");
    assert.match(s.fake.stopped[0]!, /main に rebase できませんでした（競合）/);
    const done = run.items.find((i) => i.status === "done")!;
    const stopped = run.items.find((i) => i.status === "stopped")!;
    assert.ok(done && stopped, `片方が入り片方が止まっていない：${run.items.map((i) => i.status).join(",")}`);
    assert.equal(stopped.stage, "マージ");
    // 先の1件は入っている。止まった1件の worktree は rebase を畳んだきれいな状態で残っている
    const mine = done.task.id === "a" ? "甲" : "乙";
    const theirs = mine === "甲" ? "乙" : "甲";
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), `1\n2\n${mine}\n4\n5\n`);
    const wt = join(s.project, stopped.worktree);
    assert.equal(git(wt, "status", "--porcelain"), "", "止まった worktree が rebase の途中のまま");
    // 人（か AI）が worktree で直す：main に積み直して、両方を残す形で解く
    try {
      git(wt, "rebase", "main");
    } catch {
      // 競合する——解いて続ける
    }
    writeFileSync(join(wt, "README"), `1\n2\n${mine}${theirs}\n4\n5\n`);
    git(wt, "add", "README");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", "rebase", "--continue"], { cwd: wt });
    s.factory.answer(run.id, stopped.task.id, { action: "continue" });
    await until(() => s.fake.finished.length === 1, "直して答えたのに終わらない");
    assert.equal(stopped.status, "done");
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), `1\n2\n${mine}${theirs}\n4\n5\n`);
  } finally {
    s.cleanup();
  }
});

test("root の作業ツリーに未コミットの変更があって取り込めないときは止まって知らせ、片づけて「続ける」と入る——変更は消さない", async () => {
  const s = setup({ implement: editLine });
  try {
    fiveLines(s.project);
    // 人が root で同じファイルを書きかけている（コミットしていない）
    writeFileSync(join(s.project, "README"), "1\n2\n3\n4\n5\n書きかけ\n");
    const run = s.factory.start({ tasks: [task("c", "<line 2 二>")], settings: s.settings });
    await until(() => s.fake.stopped.length === 1, "止まらない");
    assert.match(s.fake.stopped[0]!, /main に fast-forward できませんでした/);
    assert.equal(run.items[0]!.stage, "マージ");
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), "1\n2\n3\n4\n5\n書きかけ\n", "人の書きかけを消した");
    assert.equal(git(s.project, "log", "-1", "--format=%s", "main"), "5行にする", "取り込めないはずが main が動いた");
    // 人が書きかけを退ける
    git(s.project, "stash", "-q");
    s.factory.answer(run.id, "c", { action: "continue" });
    await until(() => s.fake.finished.length === 1, "片づけて答えたのに終わらない");
    assert.equal(run.items[0]!.status, "done");
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), "1\n二\n3\n4\n5\n");
    assert.equal(git(s.project, "stash", "list").split("\n").length, 1, "退けた書きかけが残っていない");
  } finally {
    s.cleanup();
  }
});

test("root の作業ツリーの変更が取り込む変更と関係なければ、そのまま取り込み、人の変更も残す", async () => {
  const s = setup({ implement: editLine });
  try {
    fiveLines(s.project);
    writeFileSync(join(s.project, "notes.txt"), "人のメモ\n");
    const run = s.factory.start({ tasks: [task("d", "<line 4 四>")], settings: s.settings });
    await until(() => s.fake.finished.length === 1, "終わらない");
    assert.equal(run.items[0]!.status, "done");
    assert.equal(readFileSync(join(s.project, "README"), "utf8"), "1\n2\n3\n四\n5\n");
    assert.equal(readFileSync(join(s.project, "notes.txt"), "utf8"), "人のメモ\n");
  } finally {
    s.cleanup();
  }
});
