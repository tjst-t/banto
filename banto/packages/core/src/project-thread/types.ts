// docs/specs/v4-architecture.md §2.2 Project / Thread（Memoryを含む）の型。
// Thread は「Memory ＋ それ以降のメッセージ」——Memoryはこの定義の一部。

import type { BackgroundWork } from "../delivery/reply-handles.js";
import type { SessionSkillSet } from "../skills/types.js";

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
  /** 最初の `message.appended` の seq */
  seq: number;
  role: "user" | "assistant";
  /**
   * **AI の発言は、1ターンぶんが1件**（改訂・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに記録する」）。記録には
   * 書き終えた発言ごとに1件ずつ足すが、fold が同じターンの分を1件にまとめる（段落を分けてつなぐ）——画面の吹き出しも
   * ターンごとに1つ
   */
  text: string;
  /** そのターンで呼ばれた**画面つきの tool**（決定・2026-09-07、ユーザー報告）。
   *  リロードすると会話は host の記録から組み直されるので、ここに残っていないと
   *  **Module の画面が消える**。画面を出すのに要る分だけを持つ
   *  ——記録の目的は表示の復元であって、実行の再現ではない。 */
  uiToolCalls?: UiToolCallEntry[];
  /**
   * **そのターンで出た中継の承認のカード**（追加・2026-10-05、アーキ仕様 §2.5・`docs/notes/2026-10-05-relay-card-stop-keep.md`）。
   * 判断待ちの id だけを持つ——中身（宛名・答え）の真実は受信箱（Event Store）で、Thread を返すときに引いて添える（規則3）。
   * 無いと、会話を記録から組み直したとき（止めた・開き直した）にカードが消え、止めたことを忘れる
   */
  judgmentIds?: string[];
  /**
   * **ターンの終わりのまとめ**（追加・2026-10-06、アーキ仕様 §2.2「ターンの終わりのまとめ」）。AI が `report_turn` で渡した
   * もの。1ターンに何度呼ばれても最後の1つだけ持つ（画面もそれを出す）。中身の形は `http/turn-summary.ts` が決める
   */
  turnSummary?: TurnSummaryRecord;
  /** **機械から届いたもの**の印（追加・2026-09-25）。**無ければ人の発言** */
  origin?: MessageOrigin;
  /** 人が添えた画像（決定・2026-09-26）。中身は画像の置き場にあり、ここは名前だけ（`images/store.ts`） */
  images?: MessageImage[];
}

/** 記録に残すまとめ。中身（summary）の形は `http/turn-summary.ts` の `TurnSummary` */
export interface TurnSummaryRecord {
  summary: Record<string, unknown>;
  /** 受け付けた時刻（ISO） */
  at: string;
}

/** 発言に添えた画像1枚。**形式は持たない**——中身から決まる（規則3） */
export interface MessageImage {
  /** 中身の SHA-256（画像の置き場での名前） */
  id: string;
  /** 人が付けていた名前（ファイルから添えたとき）。貼り付けでは無いこともある */
  name?: string;
}

/**
 * **機械から届いたメッセージの印**（決定・2026-09-25、アーキ仕様 §4.2「Thread に届ける」）。
 * RFC 3834 の `Auto-Submitted` に当たる——画面はこれで人の吹き出しと分けて出し、ループ防止はホップ数を見る。
 */
export interface MessageOrigin {
  /** 送り手（Module の宣言上の名前） */
  from: string;
  /** 画面に出す1行 */
  title: string;
  /** 人が送ったターンから何回中継されたか（人が送ったターン＝0 から出た札で届いたもの＝1） */
  hop: number;
  deliveryId: string;
  /**
   * **別の Thread の AI が送ったもの**なら、その送り元（追加・2026-10-01、アーキ仕様 §4.2「Thread 間・Project 間の
   * 送り方」）。受け取った AI はここへ送り返す——返事は送り元の Thread に戻る。Module が届けたものには無い
   */
  sender?: MessageSender;
}

/** メッセージの送り元（Project と Thread。名前は送った時点のもの） */
export interface MessageSender {
  projectId: ProjectId;
  projectName: string;
  threadId: ThreadId;
  threadLabel: string;
}

/** 届いて、まだ会話に積んでいないもの——次のターンの頭に積む（起こさなかったものは、人が次に送ったターンに） */
export interface PendingDelivery extends MessageOrigin {
  text: string;
  receivedAt: string;
  /** 起こし直しで切れたターンの続き（`TurnContinuation`）。このときは待ち行列の先頭に並ぶ */
  continues?: TurnContinuation;
}

/**
 * **起こし直しで切れたターンの続き**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。host が
 * 起き直したとき、切れたターンを「届いたもの」（送り手 `banto`）で起こし直す——その届いたものに付ける。これを積んだ
 * ターンが続きのターンになる（`turn-runner.ts`）。記録に残るので、続きを起こす前に host がまた落ちても失われない
 */
export interface TurnContinuation {
  /** 続ける（切れた）ターン */
  turnId: string;
  /** 続きのターンの `attempt`（切れたターンの `attempt` ＋1）。続けて切れた回数の上限に使う */
  attempt: number;
  /**
   * 切れたターンの会話が記録のどこから始まったか（切れたターンの始まりの seq。続きの続きなら最初に切れたターンの
   * もの）。続きのターンが書く resume-point の履歴をここに置く——切れた吹き出しから Fork を分けても会話が見つかる
   */
  fromSeq: number;
  /**
   * **続ける会話**。無ければ Thread の resume-point（と巻き戻しの位置）のまま——続いている会話・会話を書く前に切れた
   * Fork の最初のターン（親から新しい id で分け直す）。`resume`：切れたターンが自分の会話を書いていた（新しい会話・
   * Fork の最初のターン）のでそれを続ける。`fresh`：新しい会話の最初のターンが会話を書く前に切れたので、同じ id で
   * 最初から（実測 M2）。その会話を Clear で捨てていたら使わない
   */
  session?: { resume: string } | { fresh: string };
}

/**
 * **返事待ちの札**（決定・2026-09-25、アーキ仕様 §4.2「返事待ちの札は失くさない」）。Module が「あとで届ける」と
 * 言ったもの。Module が止まった・host を起動し直したときに残っていれば、host が「途中で終わりました」を届ける
 */
export interface AwaitingReply {
  replyTo: string;
  /** 札を渡した Module の接続名（Project ごとの Module は `<名前>-<projectId>`） */
  connName: string;
  moduleName: string;
  /** 届いたときのホップ（札を出したターンのホップ＋1） */
  hop: number;
  since: string;
  /** 人に見せる手がかり（追加・2026-10-03）。前からある記録には無い */
  work?: BackgroundWork;
  /**
   * **起こし直しのあと Module が続けると答えた時刻**（追加・2026-10-05、アーキ仕様 §2.5「2.」・レビュー 2-3）。札を覚え直した
   * （`reply.kept`）。画面のバックグラウンドの印に「起こし直しのあと続けています」と出す——長く届かなければ人が気づける
   */
  keptAt?: string;
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
  /**
   * **会話にはカードだけを置く**（`dev.banto/card`、決定・2026-10-01）。題と説明の文（`{引数名}` は画面が
   * 引数で置き換える）。無ければ今までどおり会話の中に画面を埋める
   */
  card?: { title?: string; description?: string };
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
  /**
   * **承認なしでメッセージを受け取ってよい Project**（決定・2026-10-01、アーキ仕様 §4.2）。Project をまたぐ送信の
   * 承認画面で「以後聞かない」を押すと足される。人が Project の設定で外せる。無ければ空
   */
  acceptMessagesFrom?: ProjectId[];
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

/**
 * reasoning effort（Claude Agent SDK の `effort`、決定・2026-09-23、ユーザー）。
 * どの段が使えるかはモデルごとに違う——SDK の `supportedModels()` が言う（`runner/models.ts`）。
 */
export type ThreadEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const THREAD_EFFORTS: readonly ThreadEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ThreadState {
  id: ThreadId;
  projectId: ProjectId;
  kind: ThreadKind;
  parentThreadId?: ThreadId;
  /** 人が付けた名前（決定・2026-09-11、ユーザー要望）。**付けていなければ持たない**
   *  ——既定の呼び名（「Fork 1」）はその Project の中の連番から導出できる（規則3）。 */
  title?: string;
  /**
   * 親の会話の**どのメッセージの時点から**分けたか（追加・2026-09-11、ユーザー要望）。
   * いまの続きから分けたときは持たない（そのときの位置は `createdSeq`）。
   * 「この Fork を開く」を**分けた場所**に置くのに使う。
   */
  forkedFromSeq?: number;
  /**
   * **いつ、どのセッションだったか**（追加・2026-09-11、ユーザー要望）。
   * 過去のメッセージから分けるには、その時点の resume-point が要る
   * ——`resumePoint` は「いま」の1つしか持たないので、履歴をここに残す。
   * **Clear で手放したものも残る**（Clear の前のやり取りから分けられるように）。
   * `seq` はそのセッションの会話が載り始めたところ——ターンの中で書かれたものはターンの始まり（`turn.started`）の
   * seq（改訂・2026-10-05。AI の発言は resume-point より前に記録される）
   */
  resumePoints: { seq: number; sessionId: string }[];
  /** この Thread が作られたイベントの seq（追加・2026-09-07）。
   *  Fork を**親の会話のどこで分岐したか**の位置として使う——Clear の横線と
   *  同じ仕組みで、その場所に「この Fork を開く」を置ける。
   *  導出値の写しではなく、作成イベント自身の seq をそのまま持つ。 */
  createdSeq: number;
  /** SDKのresume用識別子。新規Threadはundefined。 */
  resumePoint?: string;
  /**
   * **`resumePoint` のセッションで、最後まで走ったターンの最後のやり取り**（SDK のメッセージの uuid。
   * 追加・2026-10-01、v4-frontend.md §6.31）。人が止めて発言を取り消したとき、次のターンをここまでで切って
   * resume するのに使う。知らなければ（この仕組みより前の記録・止めたターンのあと）持たない——そのときは
   * 取り消さず、止めるだけにする
   */
  resumeAnchor?: string;
  /**
   * **次のターンはこのやり取りまでで切って resume する**（追加・2026-10-01）。発言を取り消したときに立ち、
   * 次に resume-point が進むと消える
   */
  rewindTo?: string;
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
  /**
   * **人がこの Thread で選んだモデルと reasoning effort**（決定・2026-09-23、ユーザー）。
   * 選んでいなければ無い——SDK（CLI）の既定で走る。**途中で変えてよい**が、変えた次の
   * 1ターンはキャッシュが効かない（アーキ仕様 §3）。変えたことは画面が人に見せてから送る。
   * permissionMode と同じく host が持つ——UI 側だけに置くとリロードで消える。
   */
  model?: string;
  effort?: ThreadEffort;
  /** Clear で切り離したセッション（決定・2026-09-06、見直し起点）。
   *  走行中に Clear すると、そのターンは終了時に**開始時のセッションid**で
   *  resume-point を更新しようとして **Clear を取り消してしまう**——画面には
   *  横線だけ残り、次のターンは畳む前の文脈を引き継ぐ、という気づけない嘘に
   *  なっていた。切り離したものはここに覚えておき、後から同じidが来ても入れない。 */
  abandonedSessions: string[];
  /**
   * **セッションごとに、効かせた Skill の集合**（決定・2026-09-23、§5.7「会話にも刻む」）。
   *
   * `instructions` は `resume` でも Fork でも読み直されない（実測）ので、効かせる
   * 集合は**新しいセッションの最初のターン**で決まり、そのセッションのあいだ
   * 変わらない。**設定は「これから」、これは「あのとき」**——後から設定を
   * 変えても、過去の会話がなぜそう振る舞ったかはこれで説明できる。
   *
   * **最後の1件がいまのセッションのもの。** Fork は分けた時点のものを親から
   * 引き継ぐ（Fork は `resume` を引き継ぐので、前置きも引き継ぐ）。
   * 前からある snapshot には無い——無ければ空として読む。
   */
  skillSets?: Array<{ seq: number; set: SessionSkillSet }>;
  /** 届いて、まだ会話に積んでいないもの（追加・2026-09-25）。前からある snapshot には無い——無ければ空 */
  deliveries?: PendingDelivery[];
  /** 返事待ちの札（追加・2026-09-25）。無ければ空 */
  awaitingReplies?: AwaitingReply[];
  /**
   * **どの Thread から、最後にいつメッセージを受け取ったか**（追加・2026-10-01、アーキ仕様 §4.2）。鍵は送り元の
   * Thread の id、値は届いた時刻。受け取ってから 24 時間以内の送り元への返事は、Project をまたいでも承認なしで届く
   */
  receivedFrom?: Record<ThreadId, string>;
  /**
   * **最後に始めたターンの進み具合**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。host が
   * ターンの途中で止まって起き直したとき、切れたターンがあったかをここで見る（`findInterruptedTurns`）。1度も
   * 走っていない・この仕組みより前のものは持たない
   */
  lastTurn?: TurnRecord;
  messages: MessageEntry[];
  markers: ThreadMarkerEntry[];
  /** 最新の1件だけ（2026-10-04 から。履歴は Event Store の usage.recorded） */
  usage: UsageEntry[];
  createdAt: string;
}

/** ターンを始めたもの：人の発言（届いたものも一緒に積んだときを含む）か、届いたものだけで起こしたか */
export type TurnCause = "human" | "delivery";

/** ターンの終わり方：最後まで行った／人が止めた／失敗した */
export type TurnOutcome = "completed" | "stopped" | "failed";

/**
 * **1ターンの進み具合**（追加・2026-10-05、アーキ仕様 §2.5「1. Thread のターンを続ける」）。`turn.started`・
 * `turn.session_known`・`turn.ended` と、始めたより後に起きた出来事から fold が作る
 */
export interface TurnRecord {
  turnId: string;
  /** `turn.started` の seq。このターンで積んだ発言は、これより後ろの seq を持つ */
  startedSeq: number;
  startedAt: string;
  cause: TurnCause;
  /** 起こし直しで続けたターンなら1以上（何回目の続きか）。ふつうは0 */
  attempt: number;
  /**
   * 始めたときに渡した resume-point と巻き戻しの位置。Thread の今の値の写しではない——終わりの resume-point の
   * 更新・Clear・取り消しで Thread の値は変わるが、続けるときは**始めたときの値**が要る（巻き戻しを保つ、実測 M1）。
   * 新しい会話なら resume-point は無い
   */
  resumePoint?: string;
  rewindTo?: string;
  /** 新しい会話の最初のターン・Fork の最初のターンで、host が先に決めて Runner に渡した session id */
  assignedSessionId?: string;
  /** Runner の `system/init` で分かった session id（`turn.session_known`）。**resume-point は変えない** */
  knownSessionId?: string;
  /** 終わり方（`turn.ended`）。無ければ終わりを書く前に止まった */
  outcome?: TurnOutcome;
  /** 始めたより後に resume-point が書かれた——CLI の側ではターンが最後まで行っている */
  resumePointUpdated?: boolean;
  /** 始めたより後に、人がこの会話を Clear した・Thread を閉じた・Project を閉じた（最初の1つ） */
  abandonedBy?: "cleared" | "thread_closed" | "project_closed";
  /** 起こし直しで切れたターンの続きなら、続けたターン（`TurnContinuation.turnId`） */
  continuesTurnId?: string;
  /**
   * 続きのターンなら、切れたターンの会話が記録のどこから始まったか（`TurnContinuation.fromSeq`）。resume-point の
   * 履歴はここに置く。間に Clear があれば持たない（Clear より前の発言から分けて、Clear のあとの会話にならないように）
   */
  continuesFromSeq?: number;
}

export interface ProjectThreadReadModel {
  projects: Map<ProjectId, ProjectState>;
  threads: Map<ThreadId, ThreadState>;
  /** 人が決めた Project の並び（決定・2026-09-11）。**ここに無いものは、
   *  あるものの後ろに作られた順で並ぶ**——並び替えたことのない Project も
   *  一覧から消えない。順番そのものを1つの値として持つ（規則3——各要素に
   *  番号を振ると、1件動かすたびに全件の書き直しが要る）。 */
  projectOrder: ProjectId[];
  /** Project ごとの Fork の並び。鍵は Project の id。 */
  threadOrder: Map<ProjectId, ThreadId[]>;
  /**
   * **画面をどの面に出したかの記録が、会話より先に届く**ことがある
   * （実測・2026-09-07）。画面が「大きく出して」と言うのはターンの**途中**、
   * その tool 呼び出しが会話に書かれるのはターンの**終わり**——先に届いた分は
   * 宛先がまだ無い。ここに預かっておき、会話が書かれた時点で貼る。
   * 追記のみの世界で順番に依存しないための入れ物であって、写しではない（規則3）。
   */
  displayModeByToolCall: Map<string, "inline" | "fullscreen">;
}
