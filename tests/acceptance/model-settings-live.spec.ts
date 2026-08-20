/**
 * **設定したモデルが、走っている会話にも効く**（PO報告 2026-08-20）。
 *
 * PO から3件まとめて上がった:
 *   1. 設定画面で「章の要約」のモデルを変えても、要約は変わらない
 *   2. 会話の途中でモデルを変えても、うまく変わらない（思考レベルが届かない）
 *   3. pi から Claude Code へ替えると、会話の履歴が引き継がれていない
 *
 * どれも「組み立てたときの値を最後まで使う／別のセッションだから空から始まる」という
 * 同じ形の取り違えだった。ここで固定するのは、直した3つの機構:
 *
 * - a1: 章の要約は**畳む直前に**モデルを引き直す（設定の変更が次の1回から効く）
 * - a2: 思考レベルは SDK セッションの**皮**が覚え、畳んで組み直しても消えない
 * - a3: バックエンドを跨ぐときの種は、**会話の記録**から・**いまの章のぶんだけ**作る
 *
 * LLM にも Claude Code にも繋がない。呼ぶ口と中身は偽物に差し替え、筋道だけを見る。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, ChapterOpening, HarnessEvent, ModuleSettingsSpec } from "@banto/core";
import {
  PooledSdkHarness,
  SdkSessionPool,
  SettingsStore,
  createCoreSettingsSections,
  createLlmChapterSummarizer,
  renderBackendHandover,
  type ChapterCompleter,
  type ChapterModelResolution,
  type ChapterSummarizerPlan,
  type TranscriptEntry,
} from "@banto/host";

// ── a1: 章の要約は畳む直前にモデルを引き直す ─────────────────────────────────

/** 形式どおりの資料を返す偽の呼び口。何回呼ばれたかを数える。 */
function completerReturning(body: string): { complete: ChapterCompleter; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    complete: async () => {
      calls++;
      return {
        stopReason: "stop",
        content: [{ type: "text", text: `TOPIC: ${body}\nDECIDED:\n- なし\nNEXT:\n- なし\n---BODY---\n${body}` }],
      };
    },
  };
}

describe("[a1] 章の要約に使うモデルは、畳む直前に引き直す", () => {
  it("設定を変えたら、走っている会話の次の1回から新しいモデルで書かれる", async () => {
    const first = completerReturning("1回目");
    const second = completerReturning("2回目");
    /** 画面の設定にあたるもの。試験の途中で書き換える。 */
    let saved: ChapterSummarizerPlan = {
      modelRef: { backend: "pi", provider: "local", model: "small" },
      complete: first.complete,
    };

    const summarize = createLlmChapterSummarizer({ resolve: () => saved });

    const before = await summarize({ transcript: "PO: こんにちは", chapter: 1 });
    assert.match(
      before.body,
      /要約に使ったモデル: pi\/local\/small/u,
      "1回目は保存されていたモデルで書く"
    );
    assert.equal(first.calls(), 1);

    // ここで PO が設定画面から「章の要約」を変えた（会話はそのまま走っている）
    saved = {
      modelRef: { backend: "claude-agent-sdk", provider: "claude", model: "haiku" },
      complete: second.complete,
    };

    const after = await summarize({ transcript: "PO: つづき", chapter: 2 });
    assert.match(
      after.body,
      /要約に使ったモデル: claude-agent-sdk\/claude\/haiku/u,
      "**器を組み直さずに**新しい指定で書く（以前は会話の生涯そのままだった）"
    );
    assert.equal(second.calls(), 1, "新しい側の呼び口が使われる");
    assert.equal(first.calls(), 1, "古い側はもう呼ばれない");
  });

  it("固定で渡す形も残る（引き直す相手が無い呼び出し側を巻き込まない）", async () => {
    const fixed = completerReturning("固定");
    const summarize = createLlmChapterSummarizer({
      modelRef: { backend: "pi", provider: "local", model: "small" },
      complete: fixed.complete,
    });
    const handoff = await summarize({ transcript: "PO: こんにちは", chapter: 1 });
    assert.match(handoff.body, /要約に使ったモデル: pi\/local\/small/u);
  });
});

describe("[a1] 設定画面は、章の要約に**実際に効いている**モデルを映す", () => {
  const sectionFor = (
    chapterModel: string | undefined,
    resolution: ChapterModelResolution
  ): ModuleSettingsSpec => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-chapter-view-"));
    const store = new SettingsStore(path.join(dir, "settings.json"));
    if (chapterModel !== undefined) store.update("chapterModel", chapterModel);
    const sections = createCoreSettingsSections(store, {
      effectiveChapterModel: () => resolution,
    });
    return sections.find((s) => s.id === "roles")!.spec;
  };

  const chapterRow = async (spec: ModuleSettingsSpec): Promise<Record<string, unknown>> => {
    const values = await spec.read();
    const rows = values["_rolesTable"] as Array<Record<string, unknown>>;
    return rows.find((r) => r["key"] === "chapterModel")!;
  };

  it("環境変数が勝っているときは、保存値ではなく効いている方を出す", async () => {
    const row = await chapterRow(
      sectionFor("pi|local|small", {
        ref: { backend: "claude-agent-sdk", provider: "claude", model: "haiku" },
        source: "env",
      })
    );
    assert.equal(row["value"], "pi|local|small", "選択欄は保存値のまま（何を保存したかは見える）");
    assert.equal(
      row["effective"],
      "claude-agent-sdk › claude › haiku",
      "**割り当てモデルは実際に効いているもの**（以前は保存値を映していた）"
    );
    assert.match(String(row["note"]), /BANTO_CHAPTER_MODEL が優先/u, "なぜそうなのかを言う");
  });

  it("指定が解決できず既定へ落ちたときは、理由まで出す", async () => {
    const row = await chapterRow(
      sectionFor("pi|消えた|モデル", {
        ref: { backend: "claude-agent-sdk", provider: "claude", model: "haiku" },
        source: "default",
        fallback: {
          requested: { backend: "pi", provider: "消えた", model: "モデル" },
          reason: "使えるモデルの一覧にありません",
          from: "settings",
        },
      })
    );
    assert.equal(row["effective"], "claude-agent-sdk › claude › haiku");
    assert.match(String(row["note"]), /解決できないため既定/u);
    assert.match(String(row["note"]), /使えるモデルの一覧にありません/u);
  });
});

// ── a2: 思考レベルは SDK セッションの皮が覚える ──────────────────────────────

/** 中身の代わり。組み立てに渡された値と、後から言われた思考レベルを覚える。 */
class FakeInner implements BantoHarness {
  readonly backendId = "claude-agent-sdk";
  static built: FakeInner[] = [];
  thinkingSetAfterBuild: string | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(readonly params: { resume?: string; model?: string; thinking?: string }) {
    FakeInner.built.push(this);
  }

  get sessionId(): string {
    return "fake";
  }
  get isStreaming(): boolean {
    return false;
  }
  subscribe(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  contextTokens(): number | undefined {
    return 10;
  }
  messageCount(): number {
    return 2;
  }
  transcript(): string {
    return "PO: やあ";
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
  resumeToken(): string | undefined {
    return "token";
  }
  setThinking(thinking: string): void {
    this.thinkingSetAfterBuild = thinking;
  }
  async dispose(): Promise<void> {}
}

describe("[a2] 思考レベルは SDK セッションの皮が持つ", () => {
  let pool: SdkSessionPool;

  beforeEach(() => {
    FakeInner.built = [];
    pool = new SdkSessionPool();
  });

  const makeHarness = (thinking?: string): PooledSdkHarness =>
    new PooledSdkHarness({
      threadId: "thread-1",
      pool,
      ...(thinking !== undefined ? { thinking } : {}),
      create: (params) => new FakeInner(params),
    });

  it("走り出しの指定が中身の組み立てへ渡る", async () => {
    const harness = makeHarness("disabled");
    await harness.prompt("やあ");
    assert.equal(FakeInner.built[0]?.params.thinking, "disabled");
  });

  it("選び直しは生きている中身へその場で届く（畳んで組み直さない）", async () => {
    const harness = makeHarness();
    await harness.prompt("やあ");
    const inner = FakeInner.built[0]!;

    harness.setThinking("adaptive");

    assert.equal(inner.thinkingSetAfterBuild, "adaptive");
    assert.equal(FakeInner.built.length, 1, "思考レベルのために子プロセスを立て直さない");
  });

  it("**畳んで組み直しても指定が消えない**（皮が覚えているから）", async () => {
    const harness = makeHarness();
    await harness.prompt("やあ");
    harness.setThinking("disabled");

    // アイドル・本数の上限で畳まれたのと同じこと
    await harness.release("試験");
    await harness.prompt("つづき");

    assert.equal(FakeInner.built.length, 2, "中身は組み直されている");
    assert.equal(
      FakeInner.built[1]?.params.thinking,
      "disabled",
      "組み直した中身にも思考レベルが渡る（中身だけが覚えていると、ここで消える）"
    );
  });

  it("undefined は「触らない」（空文字はサービス既定へ戻す指定なので通す）", async () => {
    const harness = makeHarness("disabled");
    await harness.prompt("やあ");
    const inner = FakeInner.built[0]!;

    harness.setThinking(undefined);
    assert.equal(inner.thinkingSetAfterBuild, undefined, "指定が無いときは何もしない");

    harness.setThinking("");
    assert.equal(inner.thinkingSetAfterBuild, "", "空文字は既定へ戻す指定として届く");
  });
});

// ── a3: バックエンドを跨ぐときの引き継ぎの種 ─────────────────────────────────

describe("[a3] バックエンドを替えるときは、ここまでの会話を種にする", () => {
  const entries: TranscriptEntry[] = [
    { role: "po", text: "前の章の話" },
    { role: "chapter", chapter: 1, topic: "前の章", at: "2026-08-20T00:00:00Z" },
    { role: "po", text: "task-0042 を進めて" },
    { role: "reasoning", text: "考えていること" },
    { role: "tool", name: "kobo.list", state: "ok" },
    { role: "banto", text: "職人へ委譲しました" },
    { role: "notice", source: "worker", text: "職人が終わりました" },
  ];

  it("いまの章のぶんだけを、会話の記録から書き起こす", () => {
    const seed = renderBackendHandover(entries, { from: "pi", to: "claude-agent-sdk" });

    assert.match(seed, /task-0042 を進めて/u);
    assert.match(seed, /番頭: 職人へ委譲しました/u);
    assert.match(seed, /知らせ（worker）: 職人が終わりました/u);
    assert.doesNotMatch(seed, /前の章の話/u, "畳んだ章は蘇らせない（畳んだ意味が消える）");
    assert.doesNotMatch(seed, /考えていること/u, "思考は載せない");
    assert.doesNotMatch(seed, /kobo\.list/u, "ツールの呼び出しと結果は載せない（決定28 と同じ理由）");
  });

  it("同じ会話の続きだと言い切る（挨拶し直させない）", () => {
    const seed = renderBackendHandover(entries, { from: "pi", to: "claude-agent-sdk" });
    assert.match(seed, /pi から claude-agent-sdk へ引き継ぎ/u);
    assert.match(seed, /同じ会話の続き/u);
    assert.match(seed, /ここから先が続き/u);
  });

  it("話していない会話には種を作らない（空で始め直させない）", () => {
    assert.equal(renderBackendHandover([], { from: "pi", to: "claude-agent-sdk" }), "");
    assert.equal(
      renderBackendHandover(
        [{ role: "chapter", chapter: 1, topic: "畳んだ直後", at: "2026-08-20T00:00:00Z" }],
        { from: "pi", to: "claude-agent-sdk" }
      ),
      "",
      "畳んだ直後（章の後ろに何も無い）も種は無い"
    );
  });

  it("長すぎる書き起こしは新しい側を残して切る（替えた先の出力予算を潰さない）", () => {
    const long: TranscriptEntry[] = [
      { role: "po", text: `古い話 ${"あ".repeat(500)}` },
      { role: "banto", text: "新しい返事" },
    ];
    const seed = renderBackendHandover(long, { from: "pi", to: "claude-agent-sdk", limit: 100 });

    assert.match(seed, /新しい返事/u, "新しい側は残る");
    assert.doesNotMatch(seed, /古い話 あああ/u, "古い側から削る");
    assert.match(seed, /前略/u, "削ったことを黙らない");
  });
});
