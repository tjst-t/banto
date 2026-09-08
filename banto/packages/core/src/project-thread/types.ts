// docs/specs/v4-architecture.md §2.2 Project / Thread（Memoryを含む）の型。
// Thread は「Memory ＋ それ以降のメッセージ」——Memoryはこの定義の一部。

export type ProjectId = string;
export type ThreadId = string;

export interface MemoryEntry {
  seq: number;
  text: string;
  /** 無効化イベントのseq。無効化されていなければundefined（物理削除・書き換えは
   *  しない、規則3・item3決定）。**booleanではなくseqを持つ**のは、Threadごとの
   *  確定時点（`memoryBaselineSeq`）から見て「確定した時点で既に無効だったのか、
   *  確定より後に無効になったのか」を区別するため——後者をsystem promptに反映
   *  させると、走行中の枝の先頭が変わってキャッシュが崩れる（§3、決定・2026-09-05）。 */
  invalidatedAtSeq?: number;
  /** どのThreadで決まったか（決定・2026-09-05）。走行中のThreadへ差分を届けるとき、
   *  「別の枝で決まったこと」として読めるようにするための出所。人が設定画面から
   *  直接足したものはundefined。 */
  originThreadId?: ThreadId;
}

/** あるThreadから見た、確定済みMemoryの1件（その確定時点での見え方）。 */
export interface EstablishedMemory {
  seq: number;
  text: string;
  invalidated: boolean;
}

/** 確定より後にProjectで起きたMemoryの変化（決定・2026-09-05）。system promptには
 *  入れず、ターンに添えて届ける（§2.3）。 */
export interface PendingMemoryChange {
  kind: "appended" | "invalidated";
  /** 対象エントリのseq。 */
  seq: number;
  text: string;
  /** どのThreadで決まったか（出所）。 */
  originThreadId?: ThreadId;
  /** この変化が起きたイベントのseq。どこまで届けたかの判定に使う。 */
  changedAtSeq: number;
}

/** Thread再読み込み時の表示復元専用（決定・2026-09-04）。実行再開はresumePointが担う
 *  ——ここはUI表示に足る最小の形（発言者とテキストだけ）に絞る。 */
export interface MessageEntry {
  seq: number;
  role: "user" | "assistant";
  text: string;
  /** そのターンで呼ばれた**画面つきの tool**（決定・2026-09-07、ユーザー報告）。
   *  リロードすると会話は host の記録から組み直されるので、ここに残っていないと
   *  **Module の画面が消える**。画面を出すのに要る分だけを持つ
   *  ——記録の目的は表示の復元であって、実行の再現ではない。 */
  uiToolCalls?: UiToolCallEntry[];
}

/** 画面つき tool の呼び出し1件（表示の復元に要る分だけ）。 */
export interface UiToolCallEntry {
  toolCallId: string;
  /** Runner から見える名前（`mcp__<Module名>__<tool名>`）。 */
  toolName: string;
  /** Module の名前（宣言の name）。 */
  server: string;
  /** 画面の資源（`ui://…`）。 */
  resourceUri: string;
  args?: unknown;
  result?: unknown;
  /**
   * **どの面に出したか**（追加・2026-09-07、ユーザー指摘）。
   *
   * 「どの tool がどの画面をどの引数で呼んだか」だけでは、**リロード後に
   * 出し直せない**——inline は会話の中に埋め、fullscreen は会話の隣に開く、
   * という違いがここに無かった。無いために、復元した画面が毎回自分で
   * 「大きく出して」と言い直し、**リロードのたびに Canvas が勝手に開いていた**。
   *
   * 決めるのは画面側（`ui/request-display-mode`）なので、決まった時点で
   * banto が記録する。記録が無い（古い）ものは inline として扱う。
   */
  displayMode?: "inline" | "fullscreen";
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
  /** そのターンの入出力とキャッシュの内訳（Runnerが返した値をそのまま、決定・2026-09-06）。
   *  **キャッシュが効いているかは、これを見ないと分からない**——文脈サイズ（contextUsage）
   *  は「どれだけ積んだか」であって「いくらで読めたか」ではない。
   *  Phase 1 の完了条件「ツールを足してもキャッシュが落ちない（数値で確認）」の材料であり、
   *  あとから「あのターンはなぜ高かったのか」を追える記録でもある。 */
  apiUsage?: unknown;
}

export interface ProjectState {
  id: ProjectId;
  name: string;
  root: string;
  status: "active" | "closed";
  /** Memoryの持ち主はProject（§1.1・§2.2、決定・2026-09-05）。Threadは写しを
   *  持たず、「どこまでをsystem promptに入れるか」の境界（memoryBaselineSeq）
   *  だけを持つ——導出できる値を保存しない（規則3）。 */
  memory: MemoryEntry[];
  createdAt: string;
}

export type ThreadKind = "base" | "fork";

/** Claude Agent SDKの`permissionMode`（v4-frontend.md §6.4の6値）。 */
export type ThreadPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export interface ThreadState {
  id: ThreadId;
  projectId: ProjectId;
  kind: ThreadKind;
  parentThreadId?: ThreadId;
  /** この Thread が作られたイベントの seq（追加・2026-09-07）。
   *  Fork を**親の会話のどこで分岐したか**の位置として使う——Clear の横線と
   *  同じ仕組みで、その場所に「この Fork を開く」を置ける。
   *  導出値の写しではなく、作成イベント自身の seq をそのまま持つ。 */
  createdSeq: number;
  /** SDKのresume用識別子。新規Threadはundefined。 */
  resumePoint?: string;
  /** この`resumePoint`が**この Thread 自身のセッション**か（決定・2026-09-05）。
   *  Fork Thread は作られた時点では親のresume-pointを借りているだけなので false
   *  ——そのまま resume すると**親と同じセッションを共有し、会話が1本に混ざる**
   *  （実測・2026-09-05）。最初のターンで `forkSession` により枝を分け、
   *  自分のsession idを受け取った時点で true になる。 */
  ownsSession: boolean;
  status: "active" | "closed";
  /** system promptに入れるMemoryの上限seq（決定・2026-09-05）。Thread作成時と
   *  「畳んだ」時点で確定し、走行中は動かない——§3「走行中の枝の先頭は変えない」。
   *  これより後に増えた分は、ターンに添えて届ける（§2.3）。
   *  Fork Threadが分岐時点のMemoryを固定的に持つ（§2.2 item6）のも、この1つの値で表す。 */
  memoryBaselineSeq: number;
  /** 確定後に増えた分を、どこまでターンに添えて届けたか（決定・2026-09-05）。
   *  メッセージ列は追記なので、一度届けば会話に残る——同じ差分を毎ターン
   *  繰り返さないための目印。届けたことは事実であって導出できないので、
   *  イベント（`memory.delivered`）として残しfoldで持つ（規則3）。 */
  memoryDeliveredSeq: number;
  /** 人がこのThreadで明示的に切り替えたpermissionMode（決定・2026-09-06、
   *  ユーザー報告起点）。**切り替えていないThreadは持たない**——Configurationの
   *  カスケード（Project上書き→instance既定）から導出する（規則3）。
   *  hostが持つのは、ターンを実際に走らせるのがhostだから——UI側だけに置くと
   *  リロードで消え、「いまどのモードで会話しているか」を見失う（§6.4の狙いが
   *  崩れる）。 */
  permissionMode?: ThreadPermissionMode;
  /** Clear で切り離したセッション（決定・2026-09-06、見直し起点）。
   *  走行中に Clear すると、そのターンは終了時に**開始時のセッションid**で
   *  resume-point を更新しようとして **Clear を取り消してしまう**——画面には
   *  横線だけ残り、次のターンは畳む前の文脈を引き継ぐ、という気づけない嘘に
   *  なっていた。切り離したものはここに覚えておき、後から同じidが来ても入れない。 */
  abandonedSessions: string[];
  messages: MessageEntry[];
  markers: ThreadMarkerEntry[];
  usage: UsageEntry[];
  createdAt: string;
}

export interface ProjectThreadReadModel {
  projects: Map<ProjectId, ProjectState>;
  threads: Map<ThreadId, ThreadState>;
  /**
   * **画面をどの面に出したかの記録が、会話より先に届く**ことがある
   * （実測・2026-09-07）。画面が「大きく出して」と言うのはターンの**途中**、
   * その tool 呼び出しが会話に書かれるのはターンの**終わり**——先に届いた分は
   * 宛先がまだ無い。ここに預かっておき、会話が書かれた時点で貼る。
   * 追記のみの世界で順番に依存しないための入れ物であって、写しではない（規則3）。
   */
  displayModeByToolCall: Map<string, "inline" | "fullscreen">;
}
