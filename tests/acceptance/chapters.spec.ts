/**
 * 提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.2 の受け入れ検証。
 *
 * 確かめるのは、コンパクションと章立ての**違い**そのもの:
 *
 * - 自動コンパクションが切れていること（切れていないと、畳む前に要約で潰される）
 * - 畳むのは**ターン境界**で、閾値に達したときだけ
 * - 畳んでも**トランスクリプトは残る**（D3。要約と違って情報を失わない）
 * - 次の章に載るのは**見出しと参照だけ**（段階的開示）
 * - 資料が書けなければ**畳まない**（引き継ぎ無しで文脈だけ消さない・I2）
 *
 * LLM には繋がない。要約器は差し替え可能な引数なので、偽物を渡して機構だけを検証する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  ArtifactStore,
  ChapterKeeper,
  HandoffStore,
  createBantoHostSession,
  createHandoffTools,
  createLlmChapterSummarizer,
  DEFAULT_CHAPTER_MAX_TOKENS,
  PiHarness,
  parseHandoff,
  renderChapterOpening,
  renderTranscript,
  type ChapterHandoff,
} from "@banto/host";

let dir: string;
let store: HandoffStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-chapters-"));
  store = new HandoffStore(path.join(dir, "handoffs"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 偽のメッセージ（pi の AgentMessage の、ここで要る部分だけ）。 */
function userMsg(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantMsg(text: string, tokens?: number): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provider: "test",
    model: "test",
    stopReason: "stop",
    ...(tokens !== undefined ? { usage: { input: tokens, output: 0, totalTokens: tokens } } : {}),
  };
}

/**
 * pi のセッションを偽装する。**`sessionManager` は本物**——章の境界は pi の
 * コンパクションエントリとして書くので、そこが本物でないと検証にならない。
 */
function fakeSession(messages: unknown[], sessionManager: SessionManager) {
  let autoCompaction = true;
  const listeners: Array<(e: unknown) => void> = [];
  return {
    agent: { state: { messages } },
    sessionManager,
    setAutoCompactionEnabled(enabled: boolean) {
      autoCompaction = enabled;
    },
    get autoCompactionEnabled() {
      return autoCompaction;
    },
    subscribe(listener: (e: unknown) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    emit(event: unknown) {
      for (const l of [...listeners]) l(event);
    },
  };
}

const goodSummarizer = async (): Promise<ChapterHandoff> => ({
  summary: {
    topic: "記憶システムの改善",
    decided: ["退避を先に入れる", "コンパクションは切る"],
    next: ["章立てを実装する"],
    open: ["閾値をいくつにするか"],
  },
  body: "詳細な経緯。ADR-0003 の二層が未実装であること、FTS5 の前提が崩れていることを確認した。",
});

/**
 * ADR-0020 決定89: 章立ては `BantoHarness` の語彙で動く。
 *
 * **偽セッションを本物の `PiHarness` で包む**——こうすると、章の検証が seam を
 * 通ったまま残り、pi 固有の手順（`appendCompaction` ＋ `buildSessionContext`）も
 * 一緒に検証される。
 */
function harnessOf(session: ReturnType<typeof fakeSession>): PiHarness {
  return new PiHarness({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽のセッション。
    // 契約のうち章立てが使う部分だけを持つ（テストの意図的な絞り込み）
    session: session as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    agentSession: session as any,
    toLogicalName: (n) => n,
    renderTranscript,
  });
}

function keeper(
  session: ReturnType<typeof fakeSession>,
  overrides: Record<string, unknown> = {}
): ChapterKeeper {
  return new ChapterKeeper({
    harness: harnessOf(session),
    store,
    threadId: "thread-1",
    summarize: goodSummarizer,
    contextWindow: 1000,
    ...overrides,
  });
}

// ── コンパクションを切る ────────────────────────────────────────────────────

describe("[提案§3.2] 自動コンパクションを切って章立てに置き換える", () => {
  it("ハーネスを組んだ時点で pi の自動コンパクションが切れる（ADR-0020 決定89）", () => {
    const session = fakeSession([], SessionManager.inMemory());
    assert.equal(session.autoCompactionEnabled, true, "前提：既定では入っている");
    // 章の境界を番頭が持つのは**契約の前提**なので、見張りを始めたかとは別に効く

    keeper(session);
    assert.equal(session.autoCompactionEnabled, false, "切れていないと畳む前に潰される");
  });
});

// ── いつ畳むか ──────────────────────────────────────────────────────────────

describe("[提案§3.2] 畳むのはターン境界で、閾値に達したときだけ", () => {
  it("閾値未満なら畳まない", async () => {
    const messages = [userMsg("こんにちは"), assistantMsg("はい", 100), userMsg("続き"), assistantMsg("はい", 100)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));

    assert.equal(k.shouldClose(), false);
    assert.equal(await k.maybeCloseChapter(), undefined);
    assert.deepEqual(store.list("thread-1"), []);
  });

  it("閾値を超えたら畳む", async () => {
    // contextWindow 1000 × 既定 0.6 = 600
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));

    assert.equal(k.shouldClose(), true);
    const record = await k.maybeCloseChapter();
    assert.ok(record, "章が閉じられていない");
    assert.equal(record.chapter, 1);
  });

  it("短い会話は畳まない（始まったばかりの会話に引き継ぐものは無い）", () => {
    const messages = [userMsg("A"), assistantMsg("B", 900)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));
    assert.equal(k.shouldClose(), false, "2件では畳まない（既定の下限は4件）");
  });

  it("文脈長が分からなければ畳まない（閾値を判定できない）", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 9999)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), { contextWindow: undefined });
    assert.equal(k.shouldClose(), false);
  });

  /**
   * 割合だけで測ると、窓の広いモデルへ差し替えたとき畳む位置がそのまま伸びる。
   * `opus[1m]` で窓が 1,000,000 になり、0.6 は **60万トークン**を意味していた——
   * 実測ログに `tokens=478818 window=1000000 threshold=0.6 willClose=false` が並び、
   * 畳まれない文脈が毎ターン丸ごと読み直されていた（cache read が費用の 62%）。
   */
  it("窓が広いモデルでも、畳む位置は絶対値で決まる（上限を掛ける）", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 130_000)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), {
      contextWindow: 1_000_000,
    });

    // 上限が無ければ 1,000,000 × 0.6 = 600,000 なので 13万では畳まれない
    assert.equal(k.shouldClose(), true, "20万 × 0.6 = 12万 を超えたら畳むはず");
    assert.equal(k.evaluation()?.window, 200_000, "判定に使った窓は上限側であるべき");
  });

  it("上限より狭い窓は、そのまま割合で測る（上限は狭い側を広げない）", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), { contextWindow: 1000 });

    assert.equal(k.shouldClose(), true, "1000 × 0.6 = 600 を超えている");
    assert.equal(k.evaluation()?.window, 1000, "狭い窓はそのまま使うべき");
  });

  it("上限は差し替えられる（BANTO_CHAPTER_WINDOW_CAP 相当）", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 130_000)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), {
      contextWindow: 1_000_000,
      windowCap: 500_000,
    });

    assert.equal(k.shouldClose(), false, "500,000 × 0.6 = 300,000 には届かない");
    assert.equal(k.evaluation()?.window, 500_000, "渡した上限が使われるべき");
  });

  it("ターンの途中では畳まない——agent_end だけを見る", async () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const session = fakeSession(messages, SessionManager.inMemory());
    keeper(session).start();

    session.emit({ type: "turn_end" });
    session.emit({ type: "tool_execution_end" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(store.list("thread-1"), [], "ターンの途中で畳んではいけない");

    session.emit({ type: "agent_end" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.list("thread-1").length, 1, "ターンの終わりでは畳む");
  });
});

// ── 判定は畳まなかったときも外から読める（inc-0075） ────────────────────────

describe("[a1/a3] shouldClose の判定は、畳まなかったときも外から読める（inc-0075）", () => {
  it("まだ一度も判定していなければ undefined（「判定したか」自体が読める）", () => {
    const messages = [userMsg("A"), assistantMsg("B", 100)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));
    assert.equal(k.evaluation(), undefined, "shouldClose を呼ぶ前は判定していないはず");
  });

  it("畳まなかったときも、いまの文脈長・窓・閾値・結果が読める", () => {
    // contextWindow 1000 × 既定 0.6 = 600。100 は届かないので畳まない
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 100)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));

    assert.equal(k.shouldClose(), false);
    const ev = k.evaluation();
    assert.ok(ev, "判定したことが読めない");
    assert.equal(ev.tokens, 100, "いまの文脈長が読めない");
    assert.equal(ev.window, 1000, "窓が読めない");
    assert.equal(ev.thresholdRatio, 0.6, "閾値が読めない");
    assert.equal(ev.willClose, false, "畳むと判断したかが読めない");
  });

  it("畳んだときも同じ形で読める", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()));

    assert.equal(k.shouldClose(), true);
    const ev = k.evaluation();
    assert.ok(ev, "判定したことが読めない");
    assert.equal(ev.tokens, 700, "いまの文脈長が読めない");
    assert.equal(ev.window, 1000, "窓が読めない");
    assert.equal(ev.thresholdRatio, 0.6, "閾値が読めない");
    assert.equal(ev.willClose, true, "畳むと判断したかが読めない");
  });

  it("文脈長が測れないときも、判定したこと自体は読める", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 9999)];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), { contextWindow: undefined });

    assert.equal(k.shouldClose(), false);
    const ev = k.evaluation();
    assert.ok(ev, "窓が無いだけで、判定自体はしているはず");
    assert.equal(ev.window, undefined);
    assert.equal(ev.willClose, false);
  });
});

// ── 長く畳めていないことに気づける（inc-0075） ──────────────────────────────

describe("[a2] 長く章が畳めていないことに気づける（inc-0075）", () => {
  it("最後に閉じてからのしきい値を過ぎたら知らせる", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 100)];
    const calls: Array<{ threadId: string; sinceMs: number }> = [];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), {
      staleAfterMs: 0,
      onLongWithoutClose: (info: { threadId: string; sinceMs: number }) => calls.push(info),
    });

    k.shouldClose();
    assert.equal(calls.length, 1, "長く畳めていないことが知らされない");
    assert.equal(calls[0].threadId, "thread-1");
    assert.ok(calls[0].sinceMs >= 0, "経過時間が読めない");
  });

  it("しきい値の内側では知らせない（畳まないこと自体は異常ではない・過検知しない）", () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 100)];
    const calls: unknown[] = [];
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), {
      staleAfterMs: 60 * 60 * 1000,
      onLongWithoutClose: (info: unknown) => calls.push(info),
    });

    k.shouldClose();
    assert.equal(calls.length, 0, "しきい値に達していないのに知らせている（過検知）");
  });

  it("章を閉じると、知らせの起点がリセットされる", async () => {
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const calls: unknown[] = [];
    const staleAfterMs = 50;
    const k = keeper(fakeSession(messages, SessionManager.inMemory()), {
      staleAfterMs,
      onLongWithoutClose: (info: unknown) => calls.push(info),
    });

    await new Promise((r) => setTimeout(r, staleAfterMs + 50));
    k.shouldClose();
    assert.equal(calls.length, 1, "しきい値を過ぎたのに知らせない");

    await k.closeChapter();
    calls.length = 0;

    k.shouldClose();
    assert.equal(
      calls.length,
      0,
      "畳んだ直後なのに知らせている（「長く畳めていない」の起点がリセットされていない）",
    );
  });
});

// ── 畳んだあと ──────────────────────────────────────────────────────────────

describe("[提案§3.2] 畳んだあとの文脈", () => {
  it("次の章に載るのは見出しと参照だけ（前のやり取りは載らない）", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("秘密の合言葉はカワセミ") as never);
    sm.appendMessage(assistantMsg("承知しました", 700) as never);
    sm.appendMessage(userMsg("続けて") as never);
    sm.appendMessage(assistantMsg("はい", 700) as never);
    const session = fakeSession(sm.buildSessionContext().messages, sm);

    await keeper(session).closeChapter();

    const text = JSON.stringify(session.agent.state.messages);
    assert.doesNotMatch(text, /カワセミ/, "前のやり取りが文脈に残ってはいけない");
    assert.match(text, /記憶システムの改善/, "見出しは載る");
    assert.match(text, /handoff\.read/, "詳細を引く手立てが載る");
  });

  it("畳んでもトランスクリプトは残る（D3。要約と違って情報を失わない）", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("秘密の合言葉はカワセミ") as never);
    sm.appendMessage(assistantMsg("承知", 700) as never);
    sm.appendMessage(userMsg("続けて") as never);
    sm.appendMessage(assistantMsg("はい", 700) as never);
    const session = fakeSession(sm.buildSessionContext().messages, sm);

    await keeper(session).closeChapter();

    const entries = JSON.stringify(sm.getEntries());
    assert.match(entries, /カワセミ/, "セッションの記録からは消えてはいけない");
  });

  it("境界は pi のコンパクションエントリとして書かれる（fromHook つき）", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("A") as never);
    sm.appendMessage(assistantMsg("B", 700) as never);
    const session = fakeSession(sm.buildSessionContext().messages, sm);

    await keeper(session).closeChapter();

    const compaction = sm.getEntries().find((e) => e.type === "compaction");
    assert.ok(compaction, "境界がセッションに書かれていない");
    assert.equal((compaction as { fromHook?: boolean }).fromHook, true, "pi の要約と区別が付かない");
  });

  it("引き継ぎ資料には詳細が書かれる（文脈には載らない側）", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const record = await keeper(session).closeChapter();

    const body = store.read(record!.id);
    assert.match(body, /ADR-0003 の二層が未実装/, "詳細が資料に残っていない");
    assert.match(body, /第1章の引き継ぎ/);
    assert.match(body, /決まったこと/);
  });

  it("章は続けて閉じられ、番号が増える", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const k = keeper(session);

    assert.equal((await k.closeChapter())!.chapter, 1);
    assert.equal((await k.closeChapter())!.chapter, 2);
    assert.deepEqual(store.list("thread-1"), ["thread-1/ch-0001", "thread-1/ch-0002"]);
  });

  /**
   * [PO報告 2026-08-14・事実確定] 畳んだ直後、pi版ハーネスの `contextTokens()` は
   * 前章の実測（700）を引きずらない。
   *
   * `startChapter`（＝`closeChapter` の中の `buildSessionContext` 再構築）は境界より
   * 前を1件も残さないので、`contextTokens()` が後ろから走査しても前章の assistant
   * メッセージの usage には当たらない——新しい章の（種だけの）小さな見積りに落ちる。
   * 「畳む判断が前章の値でされる」という疑いは、pi版については再現しなかった。
   */
  it("[事実確定] 畳んだ直後の contextTokens() は前章の実測を引きずらない（pi版）", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("秘密の合言葉はカワセミ") as never);
    sm.appendMessage(assistantMsg("承知しました", 700) as never);
    sm.appendMessage(userMsg("続けて") as never);
    sm.appendMessage(assistantMsg("はい", 700) as never);
    const session = fakeSession(sm.buildSessionContext().messages, sm);
    const harness = harnessOf(session);

    assert.equal(harness.contextTokens(), 700, "前提：畳む前は前章の実測が出る");

    await new ChapterKeeper({
      harness,
      store,
      threadId: "thread-1",
      summarize: goodSummarizer,
      contextWindow: 1000,
    }).closeChapter();

    const after = harness.contextTokens();
    assert.notEqual(after, 700, "前章の実測（700）を引きずっていない");
    assert.ok(after !== undefined && after < 700, "新しい章の種だけの小さな見積りに落ちる");
  });
});

// ── 失敗したとき ────────────────────────────────────────────────────────────

describe("[提案§3.2] 資料が書けなければ畳まない（I2）", () => {
  it("要約器が失敗したら例外になり、文脈は畳まれない", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage(userMsg("秘密の合言葉はカワセミ") as never);
    sm.appendMessage(assistantMsg("承知", 700) as never);
    const session = fakeSession(sm.buildSessionContext().messages, sm);

    const k = keeper(session, {
      summarize: async () => {
        throw new Error("LLM が落ちた");
      },
    });

    await assert.rejects(() => k.closeChapter(), /LLM が落ちた/);
    assert.match(JSON.stringify(session.agent.state.messages), /カワセミ/, "文脈が消えてはいけない");
    assert.deepEqual(store.list("thread-1"), [], "半端な資料を残してはいけない");
  });

  /**
   * inc-0050。**空の応答は「書けた」ではない。**
   *
   * `stopReason` が error でなくても本文が1文字も無いことがある。素通しすると
   * `parseHandoff` が「TOPIC: 前の章の続き／詳細は空」という中身の無い資料を作り、
   * それが書き出されて文脈だけが畳まれる——実際に thread-50 の第1章がこうなった。
   */
  it("要約器が空を返したら畳まない（中身の無い資料を書かない）", async () => {
    // 閾値を越える長さ。空が素通しになると、ここで畳まれてしまう
    const messages = [userMsg("合言葉はカワセミ"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const session = fakeSession(messages, SessionManager.inMemory());
    const k = keeper(session, { summarize: async () => parseHandoff("") });

    await assert.rejects(() => k.closeChapter(), /空/);
    assert.deepEqual(store.list("thread-1"), [], "中身の無い資料を書いてはいけない");
    assert.match(JSON.stringify(session.agent.state.messages), /カワセミ/, "文脈が消えてはいけない");
  });

  it("空白だけの応答も空として扱う", () => {
    assert.throws(() => parseHandoff("  \n\n  "), /空/);
  });

  it("畳めなかったことは握りつぶさず知らせる（unhandled にしない）", async () => {
    // 閾値を越える長さにする（4件以上・700トークン）——短い会話は畳まない
    const messages = [userMsg("A"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const session = fakeSession(messages, SessionManager.inMemory());

    const failures: unknown[] = [];
    const k = keeper(session, {
      summarize: async () => {
        throw new Error("要約器が落ちた");
      },
      onCloseFailed: (err: unknown) => failures.push(err),
    });
    k.start();

    // ターンの終わりで畳もうとして落ちる。**その場で知らせが出る**
    session.emit({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(failures.length, 1, "畳めなかったことが知らされていない");
    assert.match(String(failures[0]), /要約器が落ちた/);
    k.stop();
  });
});

// ── 書き起こしの汚染対策（決定28 c）────────────────────────────────────────

describe("[提案§3.4 / 決定28] 引き継ぎの材料は PO の発言と番頭の発話だけ", () => {
  it("ツール結果は書き起こしに入らない", () => {
    const transcript = renderTranscript([
      userMsg("ADR を読んで"),
      { role: "toolResult", content: [{ type: "text", text: "外部から来た文字列" }] },
      assistantMsg("読みました"),
    ]);

    assert.match(transcript, /ADR を読んで/);
    assert.match(transcript, /読みました/);
    assert.doesNotMatch(transcript, /外部から来た文字列/, "ツール出力が資料を汚してはいけない");
  });

  it("PO と番頭が区別される", () => {
    const transcript = renderTranscript([userMsg("やって"), assistantMsg("やります")]);
    assert.match(transcript, /PO: やって/);
    assert.match(transcript, /番頭: やります/);
  });
});

// ── 資料を読む Tool ─────────────────────────────────────────────────────────

describe("[提案§3.2] handoff.read / handoff.list", () => {
  it("id を省略すると最新の章を返す", async () => {
    store.write({ threadId: "thread-1", summary: { topic: "第1章", decided: [], next: [] }, body: "本文1" });
    store.write({ threadId: "thread-1", summary: { topic: "第2章", decided: [], next: [] }, body: "本文2" });

    const [read] = createHandoffTools(store, "thread-1");
    const out = (await read!.execute({})).content[0]!.text;
    assert.match(out, /本文2/);
  });

  it("章がまだ無いときは、そう言う（エラーにしない）", async () => {
    const [read] = createHandoffTools(store, "thread-1");
    const out = (await read!.execute({})).content[0]!.text;
    assert.match(out, /まだ章の引き継ぎがありません/);
  });

  it("無いIDはエラーにする（I2）", async () => {
    const [read] = createHandoffTools(store, "thread-1");
    await assert.rejects(() => read!.execute({ id: "thread-1/ch-0099" }), /ありません/);
  });

  it("パスを含むIDは弾く（../ で外へ出させない）", async () => {
    const [read] = createHandoffTools(store, "thread-1");
    await assert.rejects(() => read!.execute({ id: "../../etc/passwd" }), /の形です/);
  });

  it("handoff.list はこの会話の章を並べる", async () => {
    store.write({ threadId: "thread-1", summary: { topic: "A", decided: [], next: [] }, body: "x" });
    store.write({ threadId: "thread-2", summary: { topic: "B", decided: [], next: [] }, body: "y" });

    const [, list] = createHandoffTools(store, "thread-1");
    const out = (await list!.execute({})).content[0]!.text;
    assert.match(out, /thread-1\/ch-0001/);
    assert.doesNotMatch(out, /thread-2/, "別の会話の章を見せてはいけない");
  });
});

// ── 要約器の出力の読み取り ──────────────────────────────────────────────────

describe("[提案§3.2] 引き継ぎの読み取りは、形式が崩れても中身を捨てない", () => {
  it("形式どおりなら見出しと本文に分かれる", () => {
    const parsed = parseHandoff(
      [
        "TOPIC: 記憶の改善",
        "DECIDED:",
        "- 退避を先に入れる",
        "NEXT:",
        "- 章立てを作る",
        "OPEN:",
        "- 閾値",
        "---BODY---",
        "詳細な経緯。",
      ].join("\n")
    );

    assert.equal(parsed.summary.topic, "記憶の改善");
    assert.deepEqual(parsed.summary.decided, ["退避を先に入れる"]);
    assert.deepEqual(parsed.summary.next, ["章立てを作る"]);
    assert.deepEqual(parsed.summary.open, ["閾値"]);
    assert.equal(parsed.body, "詳細な経緯。");
  });

  it("「なし」は項目として数えない", () => {
    const parsed = parseHandoff("TOPIC: X\nDECIDED:\n- なし\nNEXT:\n- なし\n---BODY---\n本文");
    assert.deepEqual(parsed.summary.decided, []);
    assert.deepEqual(parsed.summary.next, []);
  });

  it("形式が崩れていても全文を本文として残す（中身を落とさない）", () => {
    const parsed = parseHandoff("うっかり普通の文章で書いてしまった要約です。");
    assert.match(parsed.body, /うっかり普通の文章/);
    assert.match(parsed.summary.topic, /うっかり普通の文章/);
  });
});

// ── 実際に番頭へ渡る道具箱に入っているか（inc-0050）────────────────────────

/**
 * **書けても読めなければ意味が無い。**
 *
 * `handoff.read` は実装も登録もされていたのに、実際にモデルへ渡る道具の一覧に
 * 入っていなかった（`bin.ts` の「逆引き用の写し」にしか足されていなかった）。
 * 文脈には見出しだけが載るのに詳細を引く手段が無く、段階的開示の後半が欠けていた。
 *
 * だから登録の有無ではなく、**セッションが持っている道具**を見る。
 */
describe("[提案§3.2 / inc-0050] 引き継ぎを読む口が、番頭の道具箱に入っている", () => {
  it("handoffs を渡すと handoff.read / handoff.list がセッションに載る", async () => {
    const model = getModel("anthropic", "claude-opus-4-5");
    assert.ok(model);
    const { session } = await createBantoHostSession({
      systemPrompt: "あなたは番頭です。",
      tools: [],
      handoffs: { store, threadId: "thread-1" },
      cwd: process.cwd(),
      model,
      modelRuntime: await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
      }),
      sessionManager: SessionManager.inMemory(),
    });

    // 決定22: プロバイダへはドットを潰した wire 名で渡る
    const names = session.agent.state.tools.map((t) => t.name);
    assert.ok(names.includes("handoff__read"), `handoff.read が道具箱に無い: ${names.join(", ")}`);
    assert.ok(names.includes("handoff__list"), `handoff.list が道具箱に無い: ${names.join(", ")}`);
  });

  it("handoffs を渡さなければ載らない（要らない構成で増やさない）", async () => {
    const model = getModel("anthropic", "claude-opus-4-5");
    assert.ok(model);
    const { session } = await createBantoHostSession({
      systemPrompt: "あなたは番頭です。",
      tools: [],
      cwd: process.cwd(),
      model,
      modelRuntime: await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
      }),
      sessionManager: SessionManager.inMemory(),
    });
    assert.ok(!session.agent.state.tools.some((t) => t.name.startsWith("handoff__")));
  });
});

// ── 章の頭に置く文言 ────────────────────────────────────────────────────────

describe("[提案§3.2] 章の頭に置く文言", () => {
  it("見出しと参照を載せ、「失われていない」と明示する", () => {
    const record = store.write({
      threadId: "thread-1",
      summary: { topic: "記憶の改善", decided: ["退避が先"], next: ["章立て"] },
      body: "詳細",
    });
    const opening = renderChapterOpening(record);

    assert.match(opening, /記憶の改善/);
    assert.match(opening, /退避が先/);
    assert.match(opening, /handoff\.read/);
    assert.match(opening, /失われてはいない/);
    assert.doesNotMatch(opening, /^詳細$/mu, "詳細は載せない（段階的開示）");
  });
});

// ── 栞の引き継ぎ（PO指摘 2026-08-05）────────────────────────────────────────

describe("[提案§3.1+§3.2] 章を畳んでも、退避した観測の在り処を見失わない", () => {
  it("引き継ぎ資料に artifact の索引が書かれる", async () => {
    const artifacts = new ArtifactStore(path.join(dir, "artifacts", "thread-1"));
    artifacts.write("# ADR-0010\n決定47 の本文");
    artifacts.write("# 職人の報告\n調査結果");

    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const record = await keeper(session, { artifacts }).closeChapter();

    const body = store.read(record!.id);
    assert.match(body, /## この章で退避した観測/);
    assert.match(body, /`a-0001`/);
    assert.match(body, /ADR-0010/);
    assert.match(body, /`a-0002`/);
    assert.match(body, /artifact\.read/);
  });

  it("**要約器が書かなくても載る**（モデル任せにしない）", async () => {
    const artifacts = new ArtifactStore(path.join(dir, "artifacts", "thread-1"));
    artifacts.write("# 退避した中身");

    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    // 要約器は artifact に一言も触れない
    const record = await keeper(session, {
      artifacts,
      summarize: async (): Promise<ChapterHandoff> => ({
        summary: { topic: "章", decided: [], next: [] },
        body: "artifact のことは何も書かない要約",
      }),
    }).closeChapter();

    assert.match(store.read(record!.id), /`a-0001`/, "機構として索引が付くこと");
  });

  it("次の章の頭に、退避が何件あるかと引き方が載る", async () => {
    const artifacts = new ArtifactStore(path.join(dir, "artifacts", "thread-1"));
    artifacts.write("# 1件目");
    artifacts.write("# 2件目");

    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    await keeper(session, { artifacts }).closeChapter();

    const context = JSON.stringify(session.agent.state.messages);
    assert.match(context, /2 件の観測を退避してある/);
    assert.match(context, /artifact\.list/);
  });

  it("章の頭に一覧そのものは載せない（増えても頭が膨らまない）", async () => {
    const artifacts = new ArtifactStore(path.join(dir, "artifacts", "thread-1"));
    for (let i = 0; i < 20; i++) artifacts.write(`# 見出し${i}\n本文`);

    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    await keeper(session, { artifacts }).closeChapter();

    const context = JSON.stringify(session.agent.state.messages);
    assert.match(context, /20 件の観測を退避してある/);
    assert.doesNotMatch(context, /a-0007/, "IDの一覧は資料側（handoff.read / artifact.list）にある");
  });

  it("退避が無ければ、章の頭にも資料にも余計な節を足さない", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const record = await keeper(session).closeChapter();

    assert.doesNotMatch(JSON.stringify(session.agent.state.messages), /観測を退避してある/);
    assert.doesNotMatch(store.read(record!.id), /この章で退避した観測/);
  });
});

// ── 上限に当たったときのやり直し（inc-0068）────────────────────────────────

/**
 * inc-0068。**要約器が上限に当たって空を返しても、そのまま諦めない。**
 *
 * 実機（thread-59）で起きた形はこう:
 *
 * - `BANTO_CHAPTER_MODEL` は未設定。会話のモデル（`claude/opus`・Agent SDK）は
 *   pi の台帳で解決できないので、要約器は**番頭の標準**（ローカルの
 *   `huihui/deepseek-v4-flash-abliterated`）へ黙って落ちていた
 * - そのモデルは思考（`reasoning_content`）を既定で出し、思考と本文は同じ
 *   `max_tokens` を分け合う。資料本文は実測 5,800字前後＝3,000〜4,800トークンで、
 *   当時の予算 4000 では思考ゼロでも天井——`stopReason: length` で返る
 * - 本文が1文字も出ないまま上限に当たると、機構は（正しく）畳まない。しかし
 *   **やり直しが無かった**ので、章を畳む道が塞がったまま文脈だけが伸びた
 *
 * ここで押さえるのは「もう一度やる」ことと「断るときに何が使われていたかを言う」こと。
 * 本物のモデルは叩かない——LLM を呼ぶ口（`complete`）を差し替えて筋書きで確かめる。
 */
describe("[inc-0068] 出力上限に当たって空で返ったら、一度はやり直す", () => {
  /** 要約器が見る座標だけ。 */
  const fakeModelRef = { backend: "pi", provider: "huihui", model: "deepseek-v4-flash" };
  const fakeModelMaxTokens = 16384;

  /** 出力上限に当たって本文ゼロで返る応答。 */
  const emptyOnLength = { stopReason: "length", content: [{ type: "thinking", thinking: "…" }] };
  const goodBody = [
    "TOPIC: 章立ての不具合",
    "DECIDED:",
    "- やり直しを入れる",
    "NEXT:",
    "- 受け入れ試験",
    "---BODY---",
    "詳細な引き継ぎ。inc-0068 の経緯。",
  ].join("\n");

  function summarizer(
    responses: unknown[],
    seen: Array<{ prompt: string; maxTokens: number }>,
    overrides: Record<string, unknown> = {}
  ) {
    return createLlmChapterSummarizer({
      modelRef: fakeModelRef,
      modelMaxTokens: fakeModelMaxTokens,
      complete: async (request) => {
        seen.push({ prompt: request.prompt, maxTokens: request.maxTokens });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
        return responses[seen.length - 1] as any;
      },
      ...overrides,
    });
  }

  it("1回目が空（stopReason: length）なら、やり直して資料を書く", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, { stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    const handoff = await summarize({ transcript: "PO: やあ\n\n番頭: どうも", chapter: 3 });

    assert.equal(seen.length, 2, "やり直しが走っていない");
    assert.equal(handoff.summary.topic, "章立ての不具合");
    assert.match(handoff.body, /inc-0068 の経緯/);
    assert.match(handoff.body, /2回目の試み/, "やり直しで書いたことを資料に残す");
  });

  it("やり直しでは出力予算を上げ、より短い形式で頼む", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, { stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    await summarize({ transcript: "PO: やあ\n\n番頭: どうも", chapter: 1 });

    assert.equal(seen[0]!.maxTokens, DEFAULT_CHAPTER_MAX_TOKENS, "1回目は既定の予算");
    assert.ok(seen[1]!.maxTokens > seen[0]!.maxTokens, "やり直しで予算が上がっていない");
    assert.ok(
      seen[1]!.maxTokens <= fakeModelMaxTokens,
      "モデル自身の上限を超えて頼んではいけない"
    );
    assert.match(seen[1]!.prompt, /2000字以内/, "より短い形式で頼んでいない");
    assert.doesNotMatch(seen[0]!.prompt, /2000字以内/, "1回目は密度を落とさない");
  });

  it("やり直しでは書き起こしを削る（新しい側を残す）", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, { stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    // 60,000字の上限を超える長さ。頭に古い印・末尾に新しい印を置く
    const transcript = `PO: 古い話カワセミ\n${"あ".repeat(70_000)}\n番頭: 新しい話ヤマセミ`;
    await summarize({ transcript, chapter: 9 });

    assert.ok(seen[1]!.prompt.length < seen[0]!.prompt.length, "書き起こしが削られていない");
    assert.match(seen[1]!.prompt, /ヤマセミ/, "新しい側が残っていない");
    assert.doesNotMatch(seen[1]!.prompt, /カワセミ/, "古い側から削る");
    assert.match(seen[1]!.prompt, /前略/, "削ったことを本人に伝えていない");
  });

  it("やり直しても空なら畳まず、断りに使ったモデル・入力の大きさ・出力上限を載せる", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, emptyOnLength], seen);

    await assert.rejects(
      () => summarize({ transcript: "PO: やあ\n\n番頭: どうも", chapter: 4 }),
      (err: Error) => {
        assert.equal(seen.length, 2, "やり直しは1回だけ");
        assert.match(err.message, /畳みません/);
        assert.match(err.message, /huihui\/deepseek-v4-flash/, "使ったモデルが分からない");
        assert.match(err.message, /16384/, "モデルの出力上限が分からない");
        assert.match(err.message, /1回目/, "1回目の記録が無い");
        assert.match(err.message, /2回目/, "やり直したことが分からない");
        assert.match(err.message, /字/, "入力の大きさが分からない");
        assert.match(err.message, /length/, "止まった理由が分からない");
        return true;
      }
    );
  });

  it("LLM 自体が落ちたときは、やり直さずそのまま止まる（I2）", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer(
      [{ stopReason: "error", errorMessage: "429 Too Many Requests", content: [] }],
      seen
    );

    await assert.rejects(
      () => summarize({ transcript: "PO: やあ", chapter: 1 }),
      /429 Too Many Requests/
    );
    assert.equal(seen.length, 1, "エラーは要約器のやり直しで直る類ではない");
  });

  it("1回で書けたなら、やり直さない（余計に呼ばない）", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([{ stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    const handoff = await summarize({ transcript: "PO: やあ", chapter: 1 });

    assert.equal(seen.length, 1);
    assert.doesNotMatch(handoff.body, /2回目の試み/);
  });

  it("やり直しで書けたなら、章はちゃんと畳まれる", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, { stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    const messages = [userMsg("合言葉はカワセミ"), assistantMsg("B"), userMsg("C"), assistantMsg("D", 700)];
    const session = fakeSession(messages, SessionManager.inMemory());
    const record = await keeper(session, { summarize }).closeChapter();

    assert.ok(record, "畳めていない");
    assert.deepEqual(store.list("thread-1"), ["thread-1/ch-0001"]);
    assert.doesNotMatch(
      JSON.stringify(session.agent.state.messages),
      /カワセミ/,
      "資料が書けたのだから文脈は畳まれる"
    );
  });

  // ── task-0151 a6: 書き上がった資料に、実際に使ったモデルが残る ────────────────

  it("[task-0151 a6] 1回で書けた資料に、使ったモデルが残る", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([{ stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    const handoff = await summarize({ transcript: "PO: やあ", chapter: 1 });

    assert.match(handoff.body, /要約に使ったモデル/);
    assert.match(handoff.body, /pi\/huihui\/deepseek-v4-flash/, "座標（backend/provider/model）が残っていない");
  });

  it("[task-0151 a6] やり直しで書けた資料にも、使ったモデルが残る", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, { stopReason: "stop", content: [{ type: "text", text: goodBody }] }], seen);

    const handoff = await summarize({ transcript: "PO: やあ\n\n番頭: どうも", chapter: 1 });

    assert.match(handoff.body, /2回目の試み/, "やり直したことは既存どおり残る");
    assert.match(handoff.body, /要約に使ったモデル/);
    assert.match(handoff.body, /pi\/huihui\/deepseek-v4-flash/);
  });

  // ── task-0151 a4: 断りに「指定された名前・解決の結果・実際に使ったもの」が載る ──

  it("[task-0151 a4] 既定へ落ちていたときは、断りに指定・理由・実際に使ったものが載る", async () => {
    const seen: Array<{ prompt: string; maxTokens: number }> = [];
    const summarize = summarizer([emptyOnLength, emptyOnLength], seen, {
      fallback: {
        requested: { backend: "claude-agent-sdk", provider: "claude", model: "opus" },
        reason: "Claude Code は claude 以外のプロバイダを回せません",
      },
    });

    await assert.rejects(
      () => summarize({ transcript: "PO: やあ", chapter: 1 }),
      (err: Error) => {
        assert.match(err.message, /claude-agent-sdk\/claude\/opus/, "指定された名前が載っていない");
        assert.match(
          err.message,
          /Claude Code は claude 以外のプロバイダを回せません/,
          "解決できなかった理由が載っていない"
        );
        assert.match(err.message, /pi\/huihui\/deepseek-v4-flash/, "実際に使ったものが載っていない");
        return true;
      }
    );
  });
});

/**
 * imp-0052「畳んでいる最中の発話が止まらない」の掛け金。
 *
 * `ChapterKeeper` 側の受け持ちは**掛け金の開け閉てだけ**——待たせるのはサーバ
 * （`chapter-close-holds-speech.spec.ts`）。ここで見るのは、掛け金が
 *   - 畳んでいる間だけ掛かること
 *   - 解けるのが `startChapter` の**後**（新しい章のセッションが立ってから）であること
 *   - 畳めなかったときも**必ず解ける**こと（I2：待たせたまま消さない）
 * の3つ。
 */
describe("[imp-0052] 畳んでいる間だけ掛け金が掛かる", () => {
  it("畳んでいない間は掛かっておらず、待っても素通りする", async () => {
    const k = keeper(fakeSession([], SessionManager.inMemory()));
    assert.equal(k.isClosing(), false);
    // 解決しなければここで時間切れになる（node:test の既定）
    await k.whenSettled();
  });

  it("要約している間は掛かっていて、済むと解ける", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    let releaseSummarizer: () => void = () => {};
    const slow = new Promise<void>((r) => (releaseSummarizer = r));
    const k = keeper(session, {
      summarize: async () => {
        await slow;
        return { summary: { topic: "話題", decisions: [], next: [] }, body: "本文" };
      },
    });

    const closing = k.closeChapter();
    await new Promise((r) => setImmediate(r));
    assert.equal(k.isClosing(), true, "要約の最中は畳んでいると名乗る");

    let settled = false;
    void k.whenSettled().then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "要約が済むまでは解けない（ここで解くと古い方へ流れる）");

    releaseSummarizer();
    await closing;
    await k.whenSettled();
    assert.equal(k.isClosing(), false);
  });

  it("解けるのは startChapter の後——新しい章のセッションが立ってから", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const order: string[] = [];
    let releaseSummarizer: () => void = () => {};
    const slow = new Promise<void>((r) => (releaseSummarizer = r));
    // `onChapterClosed` は `startChapter` の直後に呼ばれる＝新しい章が立った印
    const k = keeper(session, {
      onChapterClosed: () => order.push("章が立った"),
      summarize: async () => {
        await slow;
        return { summary: { topic: "話題", decisions: [], next: [] }, body: "本文" };
      },
    });

    // **畳んでいる最中に**待ち始める（畳む前に訊けば素通りするのが正しい）
    const closing = k.closeChapter();
    await new Promise((r) => setImmediate(r));
    void k.whenSettled().then(() => order.push("解けた"));

    releaseSummarizer();
    await closing;
    await new Promise((r) => setImmediate(r));

    // 「解けた」が先に並ぶことは無い——先に解けると、待っていた発話が
    // まだ立っていないセッションへ入る（＝直す前と同じ壊れ方に戻る）
    assert.deepEqual(order, ["章が立った", "解けた"]);
  });

  it("[I2] 畳めなかったときも掛け金は解ける（待たせたまま消さない）", async () => {
    const session = fakeSession([userMsg("A"), assistantMsg("B", 700)], SessionManager.inMemory());
    const k = keeper(session, {
      summarize: async () => {
        throw new Error("要約器が落ちた");
      },
    });

    await assert.rejects(() => k.closeChapter(), /要約器が落ちた/);
    assert.equal(k.isClosing(), false, "掛かったままだと以後の発話が全部止まる");
    await k.whenSettled();
  });
});
