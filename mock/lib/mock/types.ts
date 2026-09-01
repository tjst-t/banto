// 全ダミーデータの型の出どころ（規則3：真実は一箇所）。
// Step 2 時点では会話ビューに要る最小限だけ。受信箱・Module・Skill 等の型は
// 次段（Step 3 以降）で ProjectId 以下に足していく。
import type { ReadonlyJSONObject } from "assistant-stream/utils";

export type ProjectId = string;
export type ThreadId = string;

export type ThreadKind = "base" | "fork";

export interface MockProject {
  id: ProjectId;
  name: string;
  /** rail に出す1文字（prototype の .pj、頭文字アバター） */
  initial: string;
  baseThreadId: ThreadId;
}

export interface MockThread {
  id: ThreadId;
  projectId: ProjectId;
  kind: ThreadKind;
  title: string;
  /** Fork Thread の場合、分岐元 */
  parentThreadId: ThreadId | null;
  script: MockScript;
}

/** 会話の台本。ChatModelAdapter がこれを再生してダミー応答を作る。 */
export type MockStep =
  | { t: "delay"; ms: number }
  | { t: "text"; text: string; charMs?: number }
  | {
      t: "tool";
      name: string;
      args: ReadonlyJSONObject;
      result: unknown;
      runMs?: number;
      /**
       * MCP Apps の display mode（§6.2）の "inline"——tool 呼び出しの結果を
       * 会話のカードの中に埋め込んで見せる。Canvas（"fullscreen"）とは
       * 独立した、別の描画先というだけ——同じ Module の Canvas コンテンツを
       * 小さく再利用する（"昇格"の仕組みは無い、2026-09-01の議論）。
       */
      inlineView?: { moduleId: string; viewId: string };
      /**
       * MCP Apps の display mode（§6.2）の "fullscreen"——AI の tool 呼び出し
       * 自身が fullscreen を要求したケース（§6.2 軸2「AI の tool 呼び出し」
       * 行：既定は inline、fullscreen を要求されたら Canvas）。inlineView とは
       * 排他——tool 呼び出しの結果が揃ったら、banto が自動で Canvas を開く。
       * 人が launcher やヘッダのボタンから開く場合とは起点が違う。
       */
      fullscreenView?: { moduleId: string; viewId: string };
    }
  // tool 呼び出しの中から人に聞く（Elicitation、§2.4）。toolName は
  // useLocalRuntime の unstable_humanToolNames と合わせる——ランタイムがこの
  // tool 呼び出しを requires-action のまま止め、addResult で続きを渡せる状態にする。
  // 60秒以内に答えないとタイムアウトし、記録だけが受信箱に残る（item13の決定）
  | { t: "human"; serverName: string; message: string; elicitation: MockElicitationForm | MockElicitationUrl }
  // 呼ぶ前に人に見せて拒否できる承認ゲート（§6.0・§6.4）。Elicitation とは別の
  // 機構——tool はまだ呼ばれておらず、承認されて初めて実行される（今回は result
  // をその場で確定させる形で模す）。banto は Agent SDK の canUseTool /
  // permissionMode に委ねる方針（2026-08-31、§6.4）だが、UI 側の見た目は
  // ここで先に固める
  | { t: "approval"; name: string; args: ReadonlyJSONObject; result: unknown };

export interface MockScript {
  /** Thread を開いたときに最初から表示されている、既存のやり取り */
  seed: readonly MockStep[];
  /** ユーザーの発言にマッチしたら再生する応答 */
  replies: readonly { match: RegExp | "*"; steps: readonly MockStep[] }[];
}

// 受信箱（§2.4）。判断待ちとレビュー待ちは性質が違うので型を分ける
// ——判断待ちは AI が止まっていて答えを求める、レビュー待ちはもう終わっている確認待ち。

/** Elicitation の mode:"form"（フラットな primitive のみ。enum＋自由記述で表す） */
export interface MockElicitationForm {
  mode: "form";
  enumOptions: readonly string[];
  allowFreeText: boolean;
}

/** Elicitation の mode:"url"（鍵・トークン等の機微情報はこちら。フォームで聞かない） */
export interface MockElicitationUrl {
  mode: "url";
  url: string;
  /** 遷移前に見せるドメイン（要件：ドメインを見せて同意を取る） */
  domain: string;
}

/**
 * 判断待ちの2つの発生源（§2.4「判定の軸を一般化した」、2026-08-31）。
 * どちらも「AIが止まっていて、人の入力がないと先に進まない」という同じ状態——
 * 発生源が Module（Elicitation）か、AI自身の発話（Base/Fork Thread自身）かが違うだけ。
 */
export interface MockInboxJudgmentElicitation {
  kind: "judgment";
  source: "elicitation";
  id: string;
  projectId: ProjectId;
  /** どの MCP サーバ（Module）が聞いているか。要件：明示する */
  serverName: string;
  message: string;
  age: string;
  elicitation: MockElicitationForm | MockElicitationUrl;
  /**
   * "live"：Module 側のタイムアウトをまだ迎えていない。ここで答えると元の
   * tool 呼び出しを直接解決できる。"timedOut"：期限切れ。答えても次のターンへの
   * 新規入力として渡るだけ（§2.4.1、2026-08-31改訂）。解決済み（answered）は
   * 状態として保持せず、その場で一覧から取り除く（Event Store の射影）。
   */
  status: "live" | "timedOut";
}

/**
 * AI が Base/Fork Thread 自身の会話の中で、判断を求めて止まったもの（選択肢の
 * 提示を含む）。Elicitation のような専用プロトコルは無い——行き先はそのThreadを
 * 開いて普通に返信するだけ。
 */
export interface MockInboxJudgmentThread {
  kind: "judgment";
  source: "thread";
  id: string;
  projectId: ProjectId;
  threadId: ThreadId;
  threadKind: ThreadKind;
  threadTitle: string;
  message: string;
  age: string;
}

export type MockInboxJudgment = MockInboxJudgmentElicitation | MockInboxJudgmentThread;

/** Module（Factory/Subagent）が完了を転記したもの。中身は Module の Canvas で見る */
export interface MockInboxReviewModule {
  kind: "review";
  source: "module";
  id: string;
  projectId: ProjectId;
  serverName: string;
  message: string;
  age: string;
  /** 開くと Module の Canvas が出る。core は一覧だけ持つ（§2.4） */
  moduleId: string;
  viewId: string;
}

/** Base/Fork Thread 自身が、判断を求めず純粋にタスクを完了させただけのもの */
export interface MockInboxReviewThread {
  kind: "review";
  source: "thread";
  id: string;
  projectId: ProjectId;
  threadId: ThreadId;
  threadKind: ThreadKind;
  threadTitle: string;
  message: string;
  age: string;
}

export type MockInboxReview = MockInboxReviewModule | MockInboxReviewThread;

export type MockInboxItem = MockInboxJudgment | MockInboxReview;
