// docs/specs/v4-architecture.md §2.2 Project / Thread（Memoryを含む）の型。
// Thread は「Memory ＋ それ以降のメッセージ」——Memoryはこの定義の一部。

export type ProjectId = string;
export type ThreadId = string;

export interface MemoryEntry {
  seq: number;
  text: string;
  /** 無効化イベントの追記で立つ。物理削除・書き換えはしない（規則3、item3決定）。 */
  invalidated: boolean;
}

/** Thread再読み込み時の表示復元専用（決定・2026-09-04）。実行再開はresumePointが担う
 *  ——ここはUI表示に足る最小の形（発言者とテキストだけ）に絞る。 */
export interface MessageEntry {
  seq: number;
  role: "user" | "assistant";
  text: string;
}

/** 「Clear」——会話を畳む（v4-architecture.md §2.2「会話を畳む」）。次のRunner呼び出しで
 *  resume-pointを渡さない（新規query()）。表示上は横線マーカーとして残す（決定・2026-09-04）。 */
export interface ThreadMarkerEntry {
  seq: number;
  kind: "clear";
}

/** ターンごとの文脈使用量（F2/F3、決定・2026-09-04）。contextUsageはRunner
 *  （Claude Agent SDK）が返す形をそのまま保存する——中身の構造を中核側で
 *  解釈・加工しない（規則12「そのまま使う」）。F1のしきい値検知が履歴を
 *  要るため、最新値で上書きせず列として持つ。 */
export interface UsageEntry {
  seq: number;
  contextUsage: unknown;
  compactionCount: number;
}

export interface ProjectState {
  id: ProjectId;
  name: string;
  root: string;
  status: "active" | "closed";
  createdAt: string;
}

export type ThreadKind = "base" | "fork";

export interface ThreadState {
  id: ThreadId;
  projectId: ProjectId;
  kind: ThreadKind;
  parentThreadId?: ThreadId;
  /** SDKのresume用識別子。新規Threadはundefined。 */
  resumePoint?: string;
  status: "active" | "closed";
  memory: MemoryEntry[];
  messages: MessageEntry[];
  markers: ThreadMarkerEntry[];
  usage: UsageEntry[];
  createdAt: string;
}

export interface ProjectThreadReadModel {
  projects: Map<ProjectId, ProjectState>;
  threads: Map<ThreadId, ThreadState>;
}
