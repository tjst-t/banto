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
  | { t: "tool"; name: string; args: ReadonlyJSONObject; result: unknown; runMs?: number };

export interface MockScript {
  /** Thread を開いたときに最初から表示されている、既存のやり取り */
  seed: readonly MockStep[];
  /** ユーザーの発言にマッチしたら再生する応答 */
  replies: readonly { match: RegExp | "*"; steps: readonly MockStep[] }[];
}
