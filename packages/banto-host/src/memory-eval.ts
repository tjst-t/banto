/**
 * 記憶の評価セット（提案§3.6）。
 *
 * ## なぜ要るか
 *
 * `spec-improvement-loop` §1 が「層A資産は壊れると静かに劣化する」と書いている、
 * その当の対象が記憶である。**測らなければ静かに腐る**——注入の予算を変えた、抽出を
 * 足した、二層に分けた、そのどれも「壊れていない」ことを誰も確かめないまま積み上がる。
 *
 * ## 何を測るか
 *
 * LongMemEval の6分類に倣う。ただし測るのは**記憶システムが正しいものを差し出せるか**
 * であって、モデルの賢さではない。番頭が答えを間違えるのはモデルの問題だが、
 * **正しい記憶がそもそも届いていない**のは、ここが直すべき問題である。
 *
 * 1. 単一セッション想起 — 覚えたことが次のセッションで注入されるか
 * 2. 選好想起 — 好みが注入されるか
 * 3. 知識更新 — 訂正したとき、古いほうが消えて新しいほうが出るか
 * 4. 時間推論 — `validFrom` が読める形で出るか
 * 5. 複数セッション想起 — 章をまたいでも引けるか
 * 6. 予算超過 — 注入から溢れたとき、検索で引けるか（黙って消えていないか）
 *
 * D5: 判断は無い。「届いているか」の判定だけ。
 * D6: 依存は banto-core の記憶と、同じパッケージの注入器のみ。**LLM を呼ばない**——
 *     評価が鍵とネットワークを要求すると、誰も回さなくなる。
 */

import type { MemoryStore, ScopedMemory } from "@banto/core";
import { renderMemoryForPrompt, type RenderMemoryOptions } from "./memory-tools.js";

/** 評価の分類（LongMemEval に倣う）。 */
export type MemoryEvalCategory =
  | "single-session-recall"
  | "preference-recall"
  | "knowledge-update"
  | "temporal-reasoning"
  | "multi-session-recall"
  | "budget-overflow";

/** 1問。 */
export interface MemoryEvalCase {
  id: string;
  category: MemoryEvalCategory;
  /** 何を確かめる問いか（人が読むため）。 */
  question: string;
  /** 記憶を仕込む。 */
  arrange: (memory: ScopedMemory) => void;
  /** 注入されたプロンプトに現れるべき語。 */
  expectInPrompt?: string[];
  /** 注入されたプロンプトに現れてはいけない語（訂正済み・忘れた記憶など）。 */
  expectNotInPrompt?: string[];
  /**
   * 注入からは溢れてよいが、この語で検索して引けるべき。
   * 「予算で落ちた記憶が、黙って消えていない」ことの検証。
   */
  expectFindable?: string[];
  /** 注入の指定（予算を絞る問いで使う）。 */
  render?: RenderMemoryOptions;
}

/** 1問の結果。 */
export interface MemoryEvalResult {
  id: string;
  category: MemoryEvalCategory;
  passed: boolean;
  /** 落ちた理由。**通ったときも空にしない**（何を見たかが残る）。 */
  notes: string[];
}

/** 評価をまとめて回した結果。 */
export interface MemoryEvalReport {
  results: MemoryEvalResult[];
  passed: number;
  failed: number;
  /** 分類ごとの通過数／件数。どの軸が弱いかが分かる。 */
  byCategory: Record<string, { passed: number; total: number }>;
}

/**
 * 評価を回す。
 *
 * @param makeMemory 問いごとに**空の記憶**を作る。問い同士が混ざると評価にならない
 */
export function runMemoryEval(
  makeMemory: () => ScopedMemory,
  cases: readonly MemoryEvalCase[]
): MemoryEvalReport {
  const results: MemoryEvalResult[] = [];

  for (const testCase of cases) {
    const memory = makeMemory();
    testCase.arrange(memory);
    const prompt = renderMemoryForPrompt(memory, testCase.render ?? {});
    const notes: string[] = [];

    for (const needle of testCase.expectInPrompt ?? []) {
      if (!prompt.includes(needle)) notes.push(`注入されていない: ${needle}`);
    }
    for (const needle of testCase.expectNotInPrompt ?? []) {
      if (prompt.includes(needle)) notes.push(`注入されてはいけないものが出た: ${needle}`);
    }
    for (const needle of testCase.expectFindable ?? []) {
      if (!findable(memory.forPerson(), needle)) notes.push(`検索でも引けない: ${needle}`);
    }

    results.push({
      id: testCase.id,
      category: testCase.category,
      passed: notes.length === 0,
      notes: notes.length === 0 ? ["ok"] : notes,
    });
  }

  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    byCategory,
  };
}

function findable(store: MemoryStore, needle: string): boolean {
  return store.search({ text: needle }).some((r) => r.text.includes(needle));
}

/**
 * 既定の評価セット。
 *
 * **増やしてよい。** ここが薄いほど、記憶の劣化に気づくのが遅れる。
 * 実際に「番頭が前提を忘れていた」ことがあったら、その状況を1問として足すこと。
 */
export const DEFAULT_MEMORY_EVAL: readonly MemoryEvalCase[] = [
  // 1. 単一セッション想起
  {
    id: "recall-fact",
    category: "single-session-recall",
    question: "前のセッションで覚えた事実が、次のセッションのプロンプトに出るか",
    arrange: (m) => {
      m.forPerson().save({ kind: "fact", text: "POの名前は「たくみ」である" });
    },
    expectInPrompt: ["POの名前は「たくみ」である"],
  },
  {
    id: "recall-habit",
    category: "single-session-recall",
    question: "習慣が注入されるか",
    arrange: (m) => {
      m.forPerson().save({ kind: "habit", text: "テスト結果は直接実行して確かめる" });
    },
    expectInPrompt: ["テスト結果は直接実行して確かめる"],
  },
  // 2. 選好想起
  {
    id: "preference-style",
    category: "preference-recall",
    question: "文体の好みが注入されるか",
    arrange: (m) => {
      m.forPerson().save({ kind: "preference", text: "結論から話す" });
    },
    expectInPrompt: ["結論から話す"],
  },
  {
    id: "preference-not-as-fact",
    category: "preference-recall",
    question: "事実と好みが別の節に分かれているか（決定31a）",
    arrange: (m) => {
      m.forPerson().save({ kind: "fact", text: "POの役割はプロダクトオーナー" });
      m.forPerson().save({ kind: "preference", text: "図より文章を好む" });
    },
    expectInPrompt: ["### 事実", "### 好み"],
  },
  // 3. 知識更新
  {
    id: "update-supersede",
    category: "knowledge-update",
    question: "訂正したとき、古い記憶が消えて新しい記憶が出るか",
    arrange: (m) => {
      const store = m.forPerson();
      const old = store.save({ kind: "preference", text: "モックは統合UIで見たい" });
      store.supersede(old.id, { kind: "preference", text: "モックは画面ごとに見たい" });
    },
    expectInPrompt: ["モックは画面ごとに見たい"],
    expectNotInPrompt: ["モックは統合UIで見たい"],
  },
  {
    id: "update-forget",
    category: "knowledge-update",
    question: "忘れた記憶が注入から外れるか",
    arrange: (m) => {
      const store = m.forPerson();
      const gone = store.save({ kind: "habit", text: "毎朝デイリーを書く" });
      store.forget(gone.id, "やめた");
    },
    expectNotInPrompt: ["毎朝デイリーを書く"],
  },
  {
    id: "update-chained",
    category: "knowledge-update",
    question: "訂正の訂正でも、最後のものだけが残るか",
    arrange: (m) => {
      const store = m.forPerson();
      const a = store.save({ kind: "fact", text: "連絡は Slack" });
      const b = store.supersede(a.id, { kind: "fact", text: "連絡は メール" });
      store.supersede(b.id, { kind: "fact", text: "連絡は チャット" });
    },
    expectInPrompt: ["連絡は チャット"],
    expectNotInPrompt: ["連絡は Slack", "連絡は メール"],
  },
  // 4. 時間推論
  {
    id: "temporal-validfrom",
    category: "temporal-reasoning",
    question: "いつから真かが、記録した時刻と区別できる形で出るか",
    arrange: (m) => {
      m.forPerson().save({
        kind: "fact",
        text: "番頭ホストは Node 22 前提",
        validFrom: "2026-08-01",
      });
    },
    expectInPrompt: ["番頭ホストは Node 22 前提（2026-08-01 から）"],
  },
  {
    id: "temporal-no-validfrom",
    category: "temporal-reasoning",
    question: "validFrom が無い記憶に、勝手な日付が付かないか",
    arrange: (m) => {
      m.forPerson().save({ kind: "fact", text: "POは日本語で話す" });
    },
    expectInPrompt: ["POは日本語で話す"],
    expectNotInPrompt: ["POは日本語で話す（"],
  },
  // 5. 複数セッション想起（＝二層と横断の検証）
  {
    id: "multi-project-isolated",
    category: "multi-session-recall",
    question: "別のプロジェクトの記憶が混ざらないか（ADR-0003）",
    arrange: (m) => {
      m.forProject("proj-a").save({ kind: "fact", text: "A のデプロイは staging 経由" });
      m.forProject("proj-b").save({ kind: "fact", text: "B のデプロイは直接" });
    },
    render: { places: [{ id: "proj-a", label: "A" }] },
    expectInPrompt: ["A のデプロイは staging 経由"],
    expectNotInPrompt: ["B のデプロイは直接"],
  },
  {
    id: "multi-person-crosses",
    category: "multi-session-recall",
    question: "人の記憶はプロジェクトを問わず出るか",
    arrange: (m) => {
      m.forPerson().save({ kind: "preference", text: "日本語で返答する" });
      m.forProject("proj-a").save({ kind: "fact", text: "A の決定" });
    },
    render: { places: [{ id: "proj-a" }] },
    expectInPrompt: ["日本語で返答する", "A の決定"],
  },
  // 6. 予算超過
  {
    id: "budget-notices-overflow",
    category: "budget-overflow",
    question: "予算から溢れたとき、溢れたことがプロンプトに書かれるか（黙って落とさない）",
    arrange: (m) => {
      for (let i = 0; i < 6; i++) {
        m.forPerson().save({ kind: "preference", text: `好み${i}` + "あ".repeat(199) });
      }
    },
    render: { tokenBudget: 250 },
    expectInPrompt: ["他に", "memory.search"],
  },
  {
    id: "budget-overflow-findable",
    category: "budget-overflow",
    question: "予算から溢れた記憶が、検索では引けるか",
    arrange: (m) => {
      m.forPerson().save({ kind: "habit", text: "溢れる習慣" + "あ".repeat(2000) });
      m.forPerson().save({ kind: "fact", text: "残る事実" });
    },
    render: { tokenBudget: 60 },
    expectInPrompt: ["残る事実"],
    expectNotInPrompt: ["溢れる習慣"],
    expectFindable: ["溢れる習慣"],
  },
  {
    id: "budget-keeps-facts-first",
    category: "budget-overflow",
    question: "予算が足りないとき、最後まで残るのは事実か（決定31d）",
    arrange: (m) => {
      m.forPerson().save({ kind: "habit", text: "落ちる習慣" + "あ".repeat(199) });
      m.forPerson().save({ kind: "fact", text: "残る事実" + "あ".repeat(199) });
    },
    render: { tokenBudget: 120 },
    expectInPrompt: ["残る事実"],
    expectNotInPrompt: ["落ちる習慣"],
  },
];
