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

function keeper(
  session: ReturnType<typeof fakeSession>,
  overrides: Record<string, unknown> = {}
): ChapterKeeper {
  return new ChapterKeeper({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽のセッション。
    // 契約のうち章立てが使う部分だけを持つ（テストの意図的な絞り込み）
    session: session as any,
    store,
    threadId: "thread-1",
    summarize: goodSummarizer,
    contextWindow: 1000,
    ...overrides,
  });
}

// ── コンパクションを切る ────────────────────────────────────────────────────

describe("[提案§3.2] 自動コンパクションを切って章立てに置き換える", () => {
  it("start() で pi の自動コンパクションが切れる", () => {
    const session = fakeSession([], SessionManager.inMemory());
    assert.equal(session.autoCompactionEnabled, true, "前提：既定では入っている");

    keeper(session).start();
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
