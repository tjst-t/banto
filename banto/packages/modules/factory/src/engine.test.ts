// Factory の実行を、本物の git と偽の Subagent・Backlog で端から端まで通す（v4-modules.md §4.5）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory, ReplyBox, type FactoryPorts, type RunRecord, type TaskSnapshot } from "./engine.js";
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
function setup(opts: { holdReplies?: boolean; notifyFails?: boolean; settings?: Partial<FactorySettings>; verdicts?: Array<"pass" | "changes">; implement?: (prompt: string, cwd: string, n: number) => void } = {}) {
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
      procedure: deliverTask,
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
