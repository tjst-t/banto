/**
 * T4: **幹で手を動かしたら枝へ促す**（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * ## 何を守る試験か
 *
 * PO の恒久方針は「幹は常に PO の入力を受けられる待ち状態でいてほしい」。だが機構には
 * それを促す仕掛けが1つも無く、幹か枝かは**システムプロンプトの文言を変えるだけ**に
 * 使われていた。心がけに頼ったものは守られない——ここで機構にする。
 *
 * **断らない**。促すだけ（第一便）。一発で終わる小さな確認まで枝に追い出すと往復が
 * 増えるので、まず警告から入って様子を見る。だから試験は「促しが**付く**」と同じ重さで
 * 「**処理は止まらない**」「**枝では何も変わらない**」「**既存のターン予算は1ミリも
 * 変わらない**」を見る。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createTrunkWorkNudge,
  nudgeTrunkWork,
  browseNudgeLimitFromEnv,
  createTurnBudget,
  guardTurn,
  withTurnBudgetReset,
  DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT,
  TRUNK_BROWSE_NUDGE_LIMIT_ENV,
  DEFAULT_CALL_WARN_LIMIT,
  DEFAULT_CALL_WARN_AGAIN_LIMIT,
  DEFAULT_CALL_LIMIT,
} from "@banto/host";
import type { NamespacedToolDefinition, TrunkWorkNudge, TurnBudget } from "@banto/host";
import { TurnLog, type TurnLogEntry } from "../../packages/banto-host/src/turn-log.js";
import { renderTurnReport, summarize } from "../../packages/banto-host/src/turn-report.js";
// 番頭の道具箱の組み立て（本番と同じ経路で掛かっているかを見るため、ここだけ直に引く）
import { assembleStewardContext } from "../../packages/banto-host/src/host-session.js";
import type {
  BantoHarness,
  ChapterOpening,
  HarnessEvent,
  HarnessPromptOptions,
} from "@banto/core";

/** 何を呼んだかを記録して、本文をそのまま返す道具。 */
function echoTool(name: string, calls: string[]): NamespacedToolDefinition {
  return {
    name,
    label: name,
    description: "",
    parameters: { type: "object", properties: {} },
    async execute() {
      calls.push(name);
      return { content: [{ type: "text" as const, text: `${name} の結果` }] };
    },
  } as unknown as NamespacedToolDefinition;
}

/** 促し文（あれば）を取り出す。道具の本文は必ず先頭に残っている。 */
async function run(
  tool: NamespacedToolDefinition,
  args: Record<string, unknown> = {}
): Promise<{ body: string; nudge: string | undefined }> {
  const result = await tool.execute(args, {} as never);
  const texts = result.content.map((c) => (c as { text: string }).text);
  return { body: texts[0] ?? "", nudge: texts[1] };
}

/** 幹／枝の器を1つ作る。閾値は明示（既定値が動いても試験の意図は動かない）。 */
function nudgeFor(kind: "trunk" | "branch" | undefined, browseLimit = 4): TrunkWorkNudge {
  return createTrunkWorkNudge({ kind, browseLimit });
}

describe("[T4] 幹で委譲したら枝へ促す", () => {
  it("**幹で `worker.delegate` を呼ぶと促しが付く**（直し方まで書いてある）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk");
    const tool = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);

    const { body, nudge: message } = await run(tool);

    assert.equal(body, "worker.delegate の結果", "道具の結果が壊れている");
    assert.ok(message, "幹で委譲したのに促しが付いていない");
    // D8: 止めるだけでは別の道具で同じことを始める。**次の一手**が書いてあること
    assert.match(message, /thread\.open/u, "枝の開き方が書かれていない");
    assert.match(message, /returnCondition/u, "還す条件の書き方が書かれていない");
  });

  it("**`kobo.enqueue` も同じ**（幹から仕事を出す口は2つとも）", async () => {
    const calls: string[] = [];
    const tool = nudgeTrunkWork(echoTool("kobo.enqueue", calls), nudgeFor("trunk"));
    const { nudge } = await run(tool);
    assert.ok(nudge, "幹で工場へ積んだのに促しが付いていない");
  });

  it("**枝で呼んでも付かない**（枝は何も変わらない）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("branch");
    const delegate = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);
    const enqueue = nudgeTrunkWork(echoTool("kobo.enqueue", calls), nudge);

    assert.equal((await run(delegate)).nudge, undefined, "枝で促している");
    assert.equal((await run(enqueue)).nudge, undefined, "枝で促している");
  });

  it("**幹か枝か分からないときは促さない**（推測で口を出さない）", async () => {
    const calls: string[] = [];
    const tool = nudgeTrunkWork(echoTool("worker.delegate", calls), nudgeFor(undefined));
    assert.equal((await run(tool)).nudge, undefined);
  });

  it("**同じターンで2度は促さない**（雑音にすると読まれなくなる）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk");
    const delegate = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);
    const enqueue = nudgeTrunkWork(echoTool("kobo.enqueue", calls), nudge);

    assert.ok((await run(delegate)).nudge, "1回目で促していない");
    assert.equal((await run(delegate)).nudge, undefined, "同じターンで2度促している");
    assert.equal((await run(enqueue)).nudge, undefined, "同じターンで2度促している");
  });

  it("**次のターンではまた促す**（数え直しはターンの切れ目で起きる）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk");
    const tool = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);

    assert.ok((await run(tool)).nudge);
    assert.equal((await run(tool)).nudge, undefined);
    nudge.reset();
    assert.ok((await run(tool)).nudge, "次のターンで促していない");
  });
});

describe("[T4] 幹で調べ物が続いたら枝へ促す", () => {
  it("**閾値ちょうどで促す／閾値未満では促さない**", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);

    assert.equal((await run(read)).nudge, undefined, "1回目で促している（小さな確認まで追い出さない）");
    assert.equal((await run(read)).nudge, undefined, "2回目で促している");
    assert.equal((await run(read)).nudge, undefined, "3回目で促している");
    const fourth = await run(read);
    assert.ok(fourth.nudge, "閾値に届いても促していない");
    assert.match(fourth.nudge, /thread\.open/u, "枝の開き方が書かれていない");
    assert.match(fourth.nudge, /returnCondition/u, "還す条件の書き方が書かれていない");
    assert.equal(fourth.body, "file.read の結果", "道具の結果が壊れている");
  });

  it("**`file.*` と `git.*` は混ぜて数える**（道具を替えれば逃げられる、では意味がない）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const tools = ["file.read", "git.status", "file.grep", "git.log"].map((n) =>
      nudgeTrunkWork(echoTool(n, calls), nudge)
    );

    assert.equal((await run(tools[0]!)).nudge, undefined);
    assert.equal((await run(tools[1]!)).nudge, undefined);
    assert.equal((await run(tools[2]!)).nudge, undefined);
    assert.ok((await run(tools[3]!)).nudge, "道具を替えると数えが外れている");
  });

  it("**閲覧以外は数えに入らない**（枝を開く・記憶を引くのは幹の仕事）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const other = nudgeTrunkWork(echoTool("thread.open", calls), nudge);
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await run(other)).nudge, undefined, "幹の仕事まで促している");
    }
  });

  it("**同じターンで2度は促さない**（越えた最初の1回だけ）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);

    let nudged = 0;
    for (let i = 0; i < 12; i += 1) {
      if ((await run(read)).nudge !== undefined) nudged += 1;
    }
    assert.equal(nudged, 1, "同じターンで何度も促している");
  });

  it("**枝では何回でも促さない**（調べ物は枝でやるもの）", async () => {
    const calls: string[] = [];
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudgeFor("branch", 4));
    for (let i = 0; i < 12; i += 1) {
      assert.equal((await run(read)).nudge, undefined, "枝で促している");
    }
  });

  it("**促しは処理を止めない**（道具は実行され、結果はそのまま返る）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 2);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    const delegate = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);

    for (let i = 0; i < 5; i += 1) {
      const { body } = await run(read);
      assert.equal(body, "file.read の結果");
    }
    assert.equal((await run(delegate)).body, "worker.delegate の結果");
    assert.equal(calls.length, 6, "促しのせいで道具が実行されていない");
  });
});

describe("[T4] 閾値は環境変数で動かせる（既定は暫定・計測が出たら PO が決める）", () => {
  it("**既定は 4**（幹の1ターンで閲覧が4回続いたら、それは調査である）", () => {
    assert.equal(DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT, 4);
    assert.equal(browseNudgeLimitFromEnv({}), 4);
  });

  it("**環境変数で上書きできる**", () => {
    assert.equal(browseNudgeLimitFromEnv({ [TRUNK_BROWSE_NUDGE_LIMIT_ENV]: "9" }), 9);
  });

  it("**0 で閲覧の促しを止められる**（off スイッチ）", async () => {
    assert.equal(browseNudgeLimitFromEnv({ [TRUNK_BROWSE_NUDGE_LIMIT_ENV]: "0" }), 0);
    const calls: string[] = [];
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudgeFor("trunk", 0));
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await run(read)).nudge, undefined, "止めたはずの促しが出ている");
    }
  });

  it("**書き間違いは既定に戻す**（I2: 黙って安全装置を消さない）", () => {
    assert.equal(browseNudgeLimitFromEnv({ [TRUNK_BROWSE_NUDGE_LIMIT_ENV]: "たくさん" }), 4);
    assert.equal(browseNudgeLimitFromEnv({ [TRUNK_BROWSE_NUDGE_LIMIT_ENV]: "-1" }), 4);
    assert.equal(browseNudgeLimitFromEnv({ [TRUNK_BROWSE_NUDGE_LIMIT_ENV]: "" }), 4);
  });
});

describe("[T4] 台帳にそのターンの道具呼び出し回数が残る", () => {
  it("**全体の回数と閲覧系の回数を分けて数える**", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    const open = nudgeTrunkWork(echoTool("thread.open", calls), nudge);

    await run(read);
    await run(read);
    await run(open);
    assert.deepEqual(nudge.counts(), { total: 3, browse: 2 });
    nudge.reset();
    assert.deepEqual(nudge.counts(), { total: 0, browse: 0 }, "ターンを跨いで積み上がっている");
  });

  it("**台帳の1行に `toolCalls` / `browseCalls` が出る**（閾値を決める材料）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-t4-ledger-"));
    const file = path.join(dir, "turns.jsonl");
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 4);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    await run(read);
    await run(read);

    const ledger = new TurnLog(file, (threadId) =>
      threadId === "thread-1" ? nudge.counts() : undefined
    );
    ledger.append({
      at: new Date().toISOString(),
      threadId: "thread-1",
      threadKind: "trunk",
      source: "po",
      durationMs: 12,
      ok: true,
    });
    ledger.append({
      at: new Date().toISOString(),
      threadId: "thread-2",
      threadKind: "branch",
      source: "worker",
      durationMs: 3,
      ok: true,
    });

    const rows = ledger.readAll();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.toolCalls, 2, "そのターンの道具回数が残っていない");
    assert.equal(rows[0]?.browseCalls, 2, "閲覧系の回数が残っていない");
    // 数えを引けない会話では**項目が出ないだけ**。台帳は今までどおり書ける
    assert.equal(rows[1]?.toolCalls, undefined);
    assert.equal(rows[1]?.ok, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("[T4] 促しが効いたかを台帳から数えられる", () => {
  it("**促しの種類と、出た時点の回数が残る**（委譲と閲覧は別に数えられる）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 3);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    const delegate = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);

    await run(read);
    await run(read);
    assert.equal(nudge.counts().nudges, undefined, "促していないのに印が付いている");
    assert.equal(nudge.counts().browseNudgeAt, undefined, "出ていない促しの時点が入っている");

    await run(read); // 3回目＝閾値
    await run(read); // 促されたあとも触った1回
    await run(delegate);

    const counts = nudge.counts();
    assert.deepEqual([...(counts.nudges ?? [])], ["delegate", "browse"]);
    assert.equal(counts.browseNudgeAt, 3, "促しが出た時点の回数が違う");
    assert.equal(counts.browse, 4);
    // 「促されたあとも触り続けた回数」は browse - browseNudgeAt で引ける
    assert.equal(counts.browse - counts.browseNudgeAt!, 1);
  });

  it("**枝には促しの印が付かない**（促しが出ないのだから当然）", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("branch", 2);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    const delegate = nudgeTrunkWork(echoTool("worker.delegate", calls), nudge);
    await run(read);
    await run(read);
    await run(delegate);
    assert.equal(nudge.counts().nudges, undefined);
    assert.equal(nudge.counts().browseNudgeAt, undefined);
    assert.equal(nudge.counts().browse, 2, "枝でも数えはする（幹と比べるため）");
  });

  it("**ターンを跨いで持ち越さない**", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 1);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudge);
    await run(read);
    assert.deepEqual([...(nudge.counts().nudges ?? [])], ["browse"]);
    nudge.reset();
    assert.equal(nudge.counts().nudges, undefined, "前のターンの促しが残っている");
    assert.equal(nudge.counts().browseNudgeAt, undefined);
  });

  it("**台帳の1行に `nudges` / `browseNudgeAt` が出る**（出ていないターンには出さない）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-t4-nudge-ledger-"));
    const file = path.join(dir, "turns.jsonl");
    const calls: string[] = [];
    const nudged = nudgeFor("trunk", 2);
    const quiet = nudgeFor("trunk", 2);
    const read = nudgeTrunkWork(echoTool("file.read", calls), nudged);
    const quietRead = nudgeTrunkWork(echoTool("file.read", calls), quiet);
    await run(read);
    await run(read);
    await run(read);
    await run(quietRead);

    const ledger = new TurnLog(file, (threadId) =>
      threadId === "thread-1" ? nudged.counts() : quiet.counts()
    );
    for (const threadId of ["thread-1", "thread-2"]) {
      ledger.append({
        at: "2026-08-15T10:00:00.000Z",
        threadId,
        threadKind: "trunk",
        source: "po",
        durationMs: 100,
        ok: true,
      });
    }

    const [loud, silent] = ledger.readAll();
    assert.deepEqual(loud?.nudges, ["browse"]);
    assert.equal(loud?.browseNudgeAt, 2);
    assert.equal(loud?.browseCalls, 3, "促しの後の1回が数えられていない");
    assert.equal(silent?.nudges, undefined, "促していないターンに項目が出ている");
    assert.equal(silent?.browseNudgeAt, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("[T4] レポート（turn-report）に促しの回数が出る", () => {
  /** 台帳の1行を組み立てる小道具。 */
  function entry(over: Partial<TurnLogEntry> & { threadId: string }): TurnLogEntry {
    return {
      at: "2026-08-15T10:00:00.000Z",
      threadKind: "trunk",
      source: "po",
      durationMs: 100,
      ok: true,
      ...over,
    };
  }

  it("**幹の促しが種類別に数えられる／促し後も続けたぶんが引ける**", () => {
    const summary = summarize([
      // 閲覧の促しが出て、そのあとも2回触った
      entry({ threadId: "thread-1", toolCalls: 9, browseCalls: 6, nudges: ["browse"], browseNudgeAt: 4 }),
      // 委譲の促しだけ。閲覧は促していない
      entry({ threadId: "thread-1", toolCalls: 3, browseCalls: 0, nudges: ["delegate"] }),
      // 促しが出て、そこで止まった（＝促しが効いた）
      entry({ threadId: "thread-1", toolCalls: 5, browseCalls: 4, nudges: ["browse"], browseNudgeAt: 4 }),
      // 促されていないターン
      entry({ threadId: "thread-1", toolCalls: 2, browseCalls: 1 }),
      // 枝は促されない
      entry({ threadId: "thread-2", threadKind: "branch", parentId: "thread-1", toolCalls: 30, browseCalls: 28 }),
    ]);

    const trunk = summary.days[0]!.threads.find((t) => t.threadId === "thread-1")!;
    assert.deepEqual(trunk.nudgedTurns, { delegate: 1, browse: 2 });
    // 促し後も続けたのは1ターン・2回だけ（止まったターンは数えない）
    assert.deepEqual(trunk.afterBrowseNudge, { turns: 1, calls: 2 });

    const branch = summary.days[0]!.threads.find((t) => t.threadId === "thread-2")!;
    assert.deepEqual(branch.nudgedTurns, { delegate: 0, browse: 0 });
    assert.deepEqual(branch.afterBrowseNudge, { turns: 0, calls: 0 });
  });

  it("**T4 以前の行は 0 として数える**（項目が無いものを「促した」に化けさせない・I1）", () => {
    const summary = summarize([
      entry({ threadId: "thread-1" }),
      entry({ threadId: "thread-1", toolCalls: 12, browseCalls: 12 }),
    ]);
    const trunk = summary.days[0]!.threads[0]!;
    assert.deepEqual(trunk.nudgedTurns, { delegate: 0, browse: 0 });
    assert.deepEqual(trunk.afterBrowseNudge, { turns: 0, calls: 0 });
  });

  it("**`--json` にも入る**（機械で読む側が同じ数字を引ける）", () => {
    const summary = summarize([
      entry({ threadId: "thread-1", toolCalls: 9, browseCalls: 6, nudges: ["browse", "delegate"], browseNudgeAt: 4 }),
    ]);
    const round = JSON.parse(JSON.stringify(summary)) as typeof summary;
    const trunk = round.days[0]!.threads[0]!;
    assert.deepEqual(trunk.nudgedTurns, { delegate: 1, browse: 1 });
    assert.deepEqual(trunk.afterBrowseNudge, { turns: 1, calls: 2 });
  });

  it("**画面（--json でない側）の幹の行に出る**——促されていない幹も「なし」と読める", () => {
    const printed = renderTurnReport(
      summarize([
        entry({ threadId: "thread-1", toolCalls: 9, browseCalls: 6, nudges: ["browse"], browseNudgeAt: 4 }),
        entry({ threadId: "thread-2", toolCalls: 2, browseCalls: 0 }),
      ])
    );
    assert.match(printed, /thread-1.*促し 委譲:0 閲覧:1\(促し後も 2回\/1ターン\)/u);
    assert.match(printed, /thread-2.*促し なし/u, "促されていない幹が読めない");
  });

  it("**既存の集計（本数・busy・source 別）は変わらない**", () => {
    const summary = summarize([
      entry({ threadId: "thread-1", source: "worker", durationMs: 300 }),
      entry({ threadId: "thread-1", source: "po", durationMs: 200, nudges: ["browse"], browseNudgeAt: 4, browseCalls: 9 }),
    ]);
    const trunk = summary.days[0]!.threads[0]!;
    assert.equal(trunk.turns, 2);
    assert.equal(trunk.busyMs, 500);
    assert.deepEqual(trunk.bySource, { worker: 1, po: 1 });
    // 合計の形は変えない（読む側が壊れる）
    assert.deepEqual(summary.total, { turns: 2, busyMs: 500 });
  });
});

describe("[T4] 既存のターン予算（60/100/120）は1ミリも変わらない", () => {
  /** 予算と促しの両方を掛けた道具箱（本番と同じ組み立て）。 */
  function assembled(
    kind: "trunk" | "branch",
    budget: TurnBudget
  ): { tool: NamespacedToolDefinition; calls: string[] } {
    const calls: string[] = [];
    const { tools } = assembleStewardContext({
      systemPrompt: "",
      tools: [echoTool("worker.attach", calls)],
      loadBantoSkills: false,
      turnBudget: budget,
      trunkNudge: nudgeFor(kind, 4),
    });
    const tool = tools.find((t) => t.name === "worker.attach");
    assert.ok(tool, "道具箱に道具が入っていない");
    return { tool, calls };
  }

  it("**60 で第一警告・100 で第二警告・120 で断る**（幹で促しを掛けても同じ）", async () => {
    const budget = createTurnBudget();
    const { tool } = assembled("trunk", budget);
    const warned: number[] = [];
    let refusedAt = 0;

    for (let i = 1; i <= DEFAULT_CALL_LIMIT + 1; i += 1) {
      try {
        // 同じ問いの上限（3回）に当たらないよう、毎回違う引数で呼ぶ
        const result = await tool.execute({ i }, {} as never);
        const texts = result.content.map((c) => (c as { text: string }).text);
        if (texts.some((t) => t.includes("ターン予算"))) warned.push(i);
      } catch {
        refusedAt = i;
        break;
      }
    }

    assert.deepEqual(
      warned,
      [DEFAULT_CALL_WARN_LIMIT, DEFAULT_CALL_WARN_AGAIN_LIMIT],
      "警告の出る回数が動いている"
    );
    assert.equal(refusedAt, DEFAULT_CALL_LIMIT + 1, "断る回数が動いている");
  });

  it("**同じ問いの繰り返しは今までどおり4回目で断る**", async () => {
    const budget = createTurnBudget();
    const { tool } = assembled("trunk", budget);
    for (let i = 0; i < 3; i += 1) await tool.execute({ same: true }, {} as never);
    await assert.rejects(() => tool.execute({ same: true }, {} as never));
  });

  it("**促しは予算の内側**（断られた呼び出しは促しの数えにも入らない）", async () => {
    const budget = createTurnBudget({ callLimit: 2 });
    const nudge = nudgeFor("trunk", 4);
    const calls: string[] = [];
    const tool = guardTurn(nudgeTrunkWork(echoTool("file.read", calls), nudge), budget);

    await tool.execute({ i: 1 }, {} as never);
    await tool.execute({ i: 2 }, {} as never);
    await assert.rejects(() => tool.execute({ i: 3 }, {} as never));
    assert.deepEqual(nudge.counts(), { total: 2, browse: 2 }, "断られた呼び出しまで数えている");
  });

  it("**ターンの切れ目は1つ**——`reset()` で予算と促しが一緒に数え直される", async () => {
    const calls: string[] = [];
    const nudge = nudgeFor("trunk", 2);
    const budget = createTurnBudget({ onReset: () => nudge.reset() });
    const tool = guardTurn(nudgeTrunkWork(echoTool("file.read", calls), nudge), budget);

    await tool.execute({ i: 1 }, {} as never);
    await tool.execute({ i: 2 }, {} as never);
    assert.deepEqual(nudge.counts(), {
      total: 2,
      browse: 2,
      nudges: ["browse"],
      browseNudgeAt: 2,
    });

    // ハーネスの継ぎ目（新しい入力）で数え直る。促しも同じ切れ目に乗っている
    const harness = withTurnBudgetReset(new FakeHarness(), budget);
    await harness.prompt("次の用件");
    assert.deepEqual(nudge.counts(), { total: 0, browse: 0 }, "促しの数えが数え直されていない");
  });
});

describe("[T4] 組み立てで掛け忘れていない（配線の検査）", () => {
  const source = (file: string): string =>
    fs.readFileSync(new URL(`../../packages/banto-host/src/${file}`, import.meta.url).pathname, "utf-8");

  it("**促しは道具箱の全部に掛かる**（呼び出し側で選ばない＝抜け道を作らない）", async () => {
    const calls: string[] = [];
    const { tools } = assembleStewardContext({
      systemPrompt: "",
      tools: [echoTool("file.read", calls), echoTool("git.log", calls)],
      loadBantoSkills: false,
      trunkNudge: nudgeFor("trunk", 2),
    });
    const read = tools.find((t) => t.name === "file.read");
    const log = tools.find((t) => t.name === "git.log");
    assert.ok(read && log);
    assert.equal((await run(read)).nudge, undefined);
    assert.ok((await run(log)).nudge, "道具箱を通ると促しが掛かっていない");
  });

  it("**幹か枝かは会話の素性から渡っている**（bin.ts の配線）", () => {
    const bin = source("bin.ts");
    assert.match(
      bin,
      /createTrunkWorkNudge\(\{ kind: identity\?\.kind \}\)/u,
      "会話の素性（幹／枝）が促しへ渡っていない"
    );
    assert.match(bin, /\n\s*trunkNudge,/u, "促しが番頭の道具箱の組み立てへ渡っていない");
    assert.match(
      bin,
      /new TurnLog\(defaultTurnLogPath\(\), \(threadId\) => turnCounts\.get\(threadId\)\?\.counts\(\)\)/u,
      "台帳へ道具呼び出し回数が渡っていない"
    );
  });
});

/** `withTurnBudgetReset` の継ぎ目を通すためだけの偽ハーネス。 */
class FakeHarness implements BantoHarness {
  readonly backendId = "pi";
  readonly sessionId = "s-1";
  readonly isStreaming = false;
  private prompts: string[] = [];
  async prompt(text: string, _options?: HarnessPromptOptions): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  subscribe(_handler: (event: HarnessEvent) => void): () => void {
    return () => {};
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return this.prompts.length;
  }
  transcript(): string {
    return this.prompts.join("\n");
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
}
