// docs/specs/v4-architecture.md §2.2 Project / Thread（Memoryを含む）の型。
// Thread は「Memory ＋ それ以降のメッセージ」——Memoryはこの定義の一部。

import type { ThreadRestriction } from "@banto/module-contract";
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
  /** 取り消した理由（AI が `revise_memory` で頼み人が許したとき。追加・2026-10-15、§2.2）。人の画面から取り消したものは無い */
  invalidatedReason?: string;
  /** 「改める」で置き換えた先の行の seq（同上） */
  replacedBy?: number;
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
  /**
   * **AI に番号を見せるか**（追加・2026-10-15、§2.2「取り消した行は AI に渡さない」）。Project Memory の行だけ——AI は番号で
   * `revise_memory` に取り消す行を指す。Global Memory はこの道具で変えられないので付けない
   */
  numbered?: boolean;
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
  /**
   * **Module の画面から人が添えたもの**（追加・2026-10-15、v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」）。
   * 人の文（`text`）とは分けて持つ——AI には出所つきの引用として渡す（`http/canvas-quotes.ts`）
   */
  quotes?: MessageQuote[];
}

/** 画面から人が添えた塊1つ。出所の Module と、第三者か（host が宣言から決めた値） */
export interface MessageQuote {
  /** Module の宣言上の名前（見回りの気づきの引用は `banto`） */
  module: string;
  thirdParty: boolean;
  text: string;
  /**
   * **見回り〈名前〉の気づきの引用**（追加・2026-10-20、アーキ仕様 §4.4「気づき（受信箱）」）。受信箱の「やって」「任務にする」で
   * 人の発言に添えたもの。中身は host が受信箱の気づきから組む（外から来た文を読んだ見回りが書いたもの）
   */
  patrol?: string;
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
  /**
   * **自動化の1回分として届けたもの**（追加・2026-10-15、アーキ仕様 §4.3「1回分の結果」）。その回のターンが終わったら、
   * 結末を `automation.fired` に書く
   */
  automation?: { id: string; runId: string };
  /**
   * **任務の予約で起こしたもの**（追加・2026-10-20、アーキ仕様 §4.4「起こし方」）。`wake` は何回目か（1 から）。その回のターンが
   * 終わったら結果を `mission.wake_settled` に書く
   */
  mission?: MissionWakeOrigin;
  /**
   * **番頭が頼んだ決まった手順**（`instruct_thread`、追加・2026-10-21、アーキ仕様 §4.5「番頭の tool」）。どの番頭の、どの回の、どの指示か。
   * `automation` は付けない——付けると、指示した会話の次の決めることが「番頭自身の回が起こした出来事」になって番頭に届かない
   */
  supervisor?: SupervisorOrigin;
  /**
   * **外から来たもの**（追加・2026-10-15、アーキ仕様 §4.3「Webhook」）。自動化の指示の下に添える、Webhook で受けた本文。
   * 指示（人が決めたもの）とは分けて持ち、AI には別の囲みでデータとして渡す——中の指示には従わせない
   */
  external?: ExternalContent[];
}

/** 番頭の指示の印（`MessageOrigin.supervisor`）。`actionId` で番頭の記録（`automation.supervisor_acted` の `instructed`）を引く */
export interface SupervisorOrigin {
  supervisorId: string;
  /** 指示した番頭の回（その回の自動化と回の id） */
  runId: string;
  automationId: string;
  actionId: string;
  /**
   * 番頭が添えた補足（500字まで）。指示の文（host が行いから組む）とは分けて持ち、AI には別の囲み（`<banto-supervisor-note>`）で
   * データとして渡す——中の文が囲みを閉じて指示の側に出られないように
   */
  note?: string;
}

/** 外から来た本文1件（Webhook で受けたもの・Module が知らせた出来事） */
export interface ExternalContent {
  source: "webhook" | "event";
  receivedAt: string;
  /** 本文（出来事なら `text`。省いた・無いなら空） */
  body: string;
  /** 本文を切ったなら、もとのバイト数 */
  truncatedFrom?: number;
  /**
   * **出来事の見出し**（`source: "event"` だけ、追加・2026-10-16、アーキ仕様 §4.3「届け方」）。名前・題・属性は Module の
   * 申告なので、本文と同じく囲みの中に入れる
   */
  event?: { name: string; title: string; eventId: string; occurredAt: string; fields: Record<string, string | number | boolean> };
  /** まとめた1本が大きすぎて本文を省いた（見出しだけ渡した） */
  bodyOmitted?: true;
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
  /**
   * **書き手が分かっていて、中の指示に従ってよいもの**（追加・2026-10-15、アーキ仕様 §4.2「届いたものの包み方」）。
   * `banto`＝host 自身が書いた知らせ、`fork`＝親の Thread の AI が立てた Fork への最初の指示。無ければ AI に渡すとき
   * 外から来たもの（Module の返事・別の Thread からのメッセージ）としてデータ扱いにする
   */
  kind?: DeliveryAuthor;
  /** 起こし直しで切れたターンの続き（`TurnContinuation`）。このときは待ち行列の先頭に並ぶ */
  continues?: TurnContinuation;
}

/**
 * 届いたもののうち、中の指示に従ってよい書き手（`PendingDelivery.kind`）。`automation`＝自動化の指示（人が作った、
 * または人が確かめた——アーキ仕様 §4.3。追加・2026-10-15）。`decision`＝判断役が、元の AI が出した選択肢から選んだ答え
 * （人の答えと同じに従ってよい。ただし後に人の答えがあれば人を優先——§4.3「banto.turn-decisions と判断役」、追加・2026-10-16）。
 * `mission`＝任務の予約どおりに banto が起こした知らせ（目標・枠・前の予約のメモ。§4.4、追加・2026-10-20）。
 * `supervisor`＝番頭が方針の範囲で頼んだ決まった手順（文は host が行いから組む。番頭の `note` は囲んで添える。§4.5、追加・2026-10-21）
 */
export type DeliveryAuthor = "banto" | "fork" | "automation" | "decision" | "mission" | "supervisor";

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
  /**
   * **何の続きか**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 9.）。`rate_limit`＝Claude の使用量の
   * 上限で止まったターンを、リセットのあと続けるもの。無ければ起こし直しで切れたターンの続き。`attempt` はどちらも
   * 「続けて何回目か」だが、数える上限が別（切れた回数は `RESUME_CUT_LIMIT`、上限で続けた回数は `RATE_LIMIT_CONTINUE_LIMIT`）
   */
  reason?: "rate_limit";
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
  /**
   * **banto は動いたまま、Module との接続が切れたあと続けている**（追加・2026-10-17、アーキ仕様 §2.5「2.」の「banto は動いたまま、
   * Module との接続だけが切れたとき」、Backlog #362）。画面は「接続が切れたあと続けています」と出す。無ければ起こし直しのあと
   */
  keptAfter?: "disconnect";
}

/**
 * **届け直せる札**（追加・2026-10-16、アーキ仕様 §2.5「2.」の「別のサーバの Module は繋がるまで待つ」、Backlog #324）。
 * 起こし直しで Module に繋がらないまま打ち切り、「途中で終わりました」を届けた札。あとでその Module が繋がったら、
 * 打ち切った札として問い直し、仕事が終わっていれば結果をこの Thread に届けさせる——**一度だけ**（問い直すときに
 * 返事待ちに戻すので、ここからは消える。`reply.awaiting` の fold）
 */
export interface RedeliverableReply {
  replyTo: string;
  connName: string;
  moduleName: string;
  /** 届いたときのホップ（札を出したターンのホップ＋1） */
  hop: number;
  work?: BackgroundWork;
  /** 打ち切った時刻 */
  lostAt: string;
  /** banto は動いたまま Module との接続が切れて打ち切った（追加・2026-10-17、Backlog #362）。無ければ起こし直しで */
  after?: "disconnect";
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
/**
 * 会話の横線。`clear`＝人が Clear した、`compact`＋`reason: "idle"`＝空いた会話を冷める前に要約した（追加・2026-10-20、
 * アーキ仕様 §3.1「冷める前の要約」）。SDK の自動の要約は印にしない（観測するだけ、§3）
 */
export type ThreadMarkerEntry = { seq: number; kind: "clear" } | { seq: number; kind: "compact"; reason: CompactionReason };

/** 要約の理由（`thread.compacted` の `reason`）。`idle`＝4時間空いた会話を、キャッシュが温かいうちに host が要約した */
export type CompactionReason = "idle";

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
  /** 根。別のサーバの Project なら向こうのパス（作るときに向こうで正規化したもの。この機械には無い） */
  root: string;
  /**
   * **実行場所**（決定・2026-10-08、v4-security.md §1「Project の記録に実行場所を持つ」）。`remote:<名前>` なら登録した
   * 別のサーバ。無ければこの機械のコンテナ（`host-container`）。作るときに決め、変えるのは「別の実行場所へ移す」だけ
   * （v4-security.md §1「Project を別の実行場所へ移す」）
   */
  runtime?: string;
  /**
   * **チャット**（決定・2026-10-21、アーキ仕様 §2.2「チャット——Project を作る前の相談」）。中身は普通の Project で、画面だけ別に
   * 扱う。無ければ普通の Project。作るときに決まる
   */
  kind?: ProjectKind;
  /**
   * **試作を始めた**（チャットだけ。`project.prototyping.started` で立つ、アーキ仕様 §2.2「コンテナは試作を始めたときに作る」）
   */
  prototyping?: true;
  /**
   * **いま別の実行場所へ移している**（追加・2026-10-11、v4-security.md §1「Project を別の実行場所へ移す」）。
   * `project.runtime_move_started` で立ち、`runtime_moved`・`runtime_move_failed` で消える。立っている間はターンを断り、
   * 届いたものは留める
   */
  move?: RuntimeMoveInProgress;
  /**
   * **始め方の仕事**（追加・2026-10-20、v4-frontend.md §6.49）。別のサーバに「clone」「新しいリポジトリ」で作った Project だけが
   * 持つ。`project.start_changed` で丸ごと置き換える（終わっても残す——帯を出すかは `status` で決まる）
   */
  start?: ProjectStart;
  /** **前にいた場所**（移したもの。古い順）。元は消さずに残すので、設定の画面に出して人が消す */
  previousLocations?: ProjectLocation[];
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
  /**
   * **入っているグループ**（決定・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。0 か 1 つ。無ければ
   * 「グループなし」。閉じても覚えていて、開き直したら元のグループに戻る。グループをなくしたら外れる
   */
  groupId?: ProjectGroupId;
  /**
   * **眠っている**（決定・2026-10-16、アーキ仕様 §2.2「スリープ」）。状態（`status`）は `active` のまま——`closed` で断っている
   * 場所（届ける・自動化・メッセージ・移す）を眠っている間も通すため。`project.slept` で立ち、`project.woke`・`project.closed` で消える
   */
  sleep?: ProjectSleepState;
  /**
   * **最近 Claude のアカウントを切り替えたこと**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 6.）。
   * 古い順に直近 `RECENT_ACCOUNT_SWITCHES` 件まで。Project 設定の観測（「最近の切り替え」、v4-frontend.md §6.46）に出す。
   * 履歴の全部は Event Store の `claude_account.switched`
   */
  recentClaudeAccountSwitches?: ClaudeAccountSwitchRecord[];
  createdAt: string;
}

/**
 * **Claude のアカウントを切り替えた1件**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 6.）。
 * `reason.kind`：`threshold`（前のものが閾値を越えた。`window` と `utilization`）・`rejected`（前のものが上限で断った）・
 * `recovered`（前のものがリセットされ並びの前へ戻った）・`order`（並びが変わった）・`unavailable`（前のものが使えなかった）
 */
export interface ClaudeAccountSwitchRecord {
  seq: number;
  at: string;
  from: string;
  to: string;
  reason: ClaudeAccountSwitchReasonRecord;
  /** 並びの全部が閾値を越えていて、一番早くリセットされる `to` で続けた（会話の1行を warn の形にする、v4-frontend.md §6.46） */
  allOver?: true;
}

export interface ClaudeAccountSwitchReasonRecord {
  kind: "threshold" | "rejected" | "recovered" | "order" | "unavailable";
  window?: "5h" | "7d";
  /** 0〜1 */
  utilization?: number;
  resetsAt?: string;
  claim?: string;
}

/** Project の印。いまはチャットだけ（アーキ仕様 §2.2「チャット」） */
export type ProjectKind = "chat";

/** 誰が眠らせたか（人・しばらく開いていないので自動で） */
export type ProjectSleptBy = "human" | "auto";
/** 閉じたのが人でないとき（使っていないチャットを自動で、アーキ仕様 §2.2「チャット」）。人が閉じたら付けない */
export type ProjectClosedBy = "auto";
/** 何で起きたか（開いた・人が送った・届いたもの・自動化の届けもの） */
export type ProjectWokeCause = "opened" | "human" | "delivery" | "automation";
export const PROJECT_WOKE_CAUSES: readonly ProjectWokeCause[] = ["opened", "human", "delivery", "automation"];

export interface ProjectSleepState {
  since: string;
  by: ProjectSleptBy;
}

export type ProjectGroupId = string;

/** グループの色（決めた5つ）。記録には名前で持ち、値は画面の段の色 */
export const PROJECT_GROUP_COLORS = ["blue", "green", "yellow", "orange", "pink"] as const;
export type ProjectGroupColor = (typeof PROJECT_GROUP_COLORS)[number];

/** **Project のグループ**（決定・2026-10-16、アーキ仕様 §2.2）。banto 全体に1つの並び。グループ＝名前＋色 */
export interface ProjectGroupState {
  id: ProjectGroupId;
  name: string;
  color: ProjectGroupColor;
  createdAt: string;
}

/** Project のいる場所：実行場所（`host-container`・`remote:<名前>`）と根（その実行場所の側のパス） */
export interface ProjectLocation {
  runtime: string;
  root: string;
  /** 移した時刻（`previousLocations` だけ） */
  movedAt?: string;
}

/**
 * **移している途中の記録**（`project.runtime_move_started` の中身）。途中で banto が落ちたら、起き直したときにここを見て
 * 移す先の banto が作ったものだけを消す
 */
export interface RuntimeMoveInProgress {
  from: ProjectLocation;
  to: ProjectLocation;
  /** 移す先に banto が作ったもの・退かせたもの（片づけに使う） */
  created: RuntimeMoveCreated;
  startedAt: string;
}

/**
 * **新しい Project の始め方の仕事**（追加・2026-10-20、v4-frontend.md §6.49）。その Project の Shell で `git init`・`git clone` を
 * 流す。1つの Project に同時に1本。`account` は GitHub の login（Vault の `repositories-github-<login>` を Shell に渡す）
 */
export interface ProjectStart {
  kind: "init" | "clone";
  url?: string;
  account?: string;
  startedAt: string;
  /** waking：Shell を起こしている（containers の最初の1回は土台のイメージを作るので数分）／running：git を流している */
  status: "waking" | "running" | "done" | "failed" | "interrupted";
  error?: string;
}

export interface RuntimeMoveCreated {
  /** 根のフォルダを banto が作った（無ければ、もとからあった空のフォルダ——片づけでは中身だけ消す） */
  rootCreated: boolean;
  /** 写す Module の置き場（移す先の側のパス。写す前から有ったものも——中身は banto が写したもの） */
  moduleDirs: string[];
  /** そのうち、写す前から `s` だけがあった置き場（片づけでは `s` を残す） */
  mergedModuleDirs?: string[];
  /** 移す先に残っていて、写す前に退かせた置き場（`from`→`to`。失敗したら戻す） */
  movedAside: Array<{ from: string; to: string }>;
  /**
   * **前に居た場所へ戻す——差分で写す**（追加・2026-10-13、v4-security.md §1「前に居た場所へ戻す」）。根と、もとから有った
   * Module の置き場は rsync で今の場所とそろえる——片づけではそれらに触らない（`moduleDirs` は新しく作った置き場だけ）
   */
  syncedPrevious?: boolean;
}

export type ThreadKind = "base" | "fork";

/** Claude Agent SDKの`permissionMode`（v4-frontend.md §6.4の6値）。 */
/**
 * Thread を閉じたのは AI（`close_fork`）か人（画面）か、自動化が専用の Fork を乗り換えたか（追加・2026-10-15、
 * アーキ仕様 §4.3「乗り換え」）
 */
export type ThreadClosedBy = "ai" | "human" | "automation";

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
  /**
   * **読むだけの回**（追加・2026-10-20、アーキ仕様 §4.4「読むだけの回」）。立てたとき（`thread.created`）に刻み、**外す口は無い**
   * ——外の文を読んだ文脈が、ふつうの会話に戻らない。この会話のターンは、どの起こし方でも読むだけの tool しか使えない。
   * 印の付いた会話から分けた Fork も同じ印を持つ。ふつうの会話は持たない
   */
  restriction?: ThreadRestriction;
  /**
   * **誰が閉じたか・なぜか**（追加・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。閉じている間だけ持つ
   * ——開き直したら外す。これより前に閉じた記録は持たない
   */
  closedBy?: ThreadClosedBy;
  /** AI が閉じたときの理由（`close_fork` の `reason`）・自動化が乗り換えたこと */
  closedReason?: string;
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
  /** 届け直せる札（追加・2026-10-16、Backlog #324）。無ければ空 */
  redeliverableReplies?: RedeliverableReply[];
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
  /**
   * **走っている冷める前の要約**（`turn.started` の cause が `idle-compaction`、追加・2026-10-20、アーキ仕様 §3.1）。終わりが
   * 書かれたら消える。起こし直しのあとに残っていれば、切れた要約——続けずに終わりだけ書く（`IdleCompactions.start`）
   */
  idleCompactionTurn?: { turnId: string; startedSeq: number; startedAt: string };
  messages: MessageEntry[];
  markers: ThreadMarkerEntry[];
  /**
   * **この Thread の要求で Claude のアカウントを切り替えた**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを
   * 複数持つ」の 6.）。会話に薄い1行で出す画面だけの印で、**AI の文脈には入れない**。前からある snapshot には無い——無ければ空
   */
  accountSwitches?: ClaudeAccountSwitchRecord[];
  /** 最新の1件だけ（2026-10-04 から。履歴は Event Store の usage.recorded） */
  usage: UsageEntry[];
  /**
   * **今の任務**（追加・2026-10-20、アーキ仕様 §4.4「任務」）。終わった任務も、次の任務を始めるまで残す（結末を読む）。
   * 1度も始めていなければ無い
   */
  mission?: MissionState;
  createdAt: string;
}

/**
 * **任務の予約で起こした回の印**（発言の `origin.mission`）。`maxWakes`・`note` は会話の薄い1行（「任務で起きました（3/20 回目）
 * ——前の予約：〈note〉」、v4-frontend.md §6.47）に出す分で、起こした時点の値（追加・2026-10-20、Backlog #422。前の記録には無い）
 */
export interface MissionWakeOrigin {
  id: string;
  wake: number;
  maxWakes?: number;
  note?: string;
}

/** 任務の枠（アーキ仕様 §4.4「枠」） */
export interface MissionFrame {
  /** 起きる回数の上限（任務の予約で起こした回だけ数える） */
  maxWakes: number;
  /** 期限（ISO） */
  until: string;
  /** 最短の間隔（分）——前に任務で起こした時刻からの間 */
  minIntervalMinutes: number;
}

/** 待つ出来事（§4.3 段2の名前と条件）。`until` までに来なければ「来ませんでした」で起こす */
export interface MissionEventWait {
  name: string;
  where?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** 出来事の題（名乗りから）。届ける文と画面に出す */
  title?: string;
  until: string;
}

/** 来た出来事（届ける文に外から来たものとして添える） */
export interface MissionReceivedEvent {
  at: string;
  name: string;
  title: string;
  eventId: string;
  occurredAt: string;
  fields: Record<string, string | number | boolean>;
  text?: string;
  truncatedFrom?: number;
}

/**
 * **次の予約**（`schedule_followup`）。1つだけ——新しく予約したら置き換わる。`at` か `event` のどちらか。出来事が来たら
 * banto が `at`（来た時刻か、前に起こした時刻＋最短の間隔の遅いほう）と `received` を付けて置き直す
 */
export interface MissionFollowup {
  note: string;
  setAt: string;
  at?: string;
  event?: MissionEventWait;
  received?: MissionReceivedEvent;
}

/** 起きたきっかけ。`time`＝予約の時刻・`event`＝待っていた出来事・`event-timeout`＝出来事が来ないまま待つ上限・`human`＝人の「今すぐ起こす」 */
export type MissionWakeCause = "time" | "event" | "event-timeout" | "human";

/** 起きた回の結果（ターンが終わってから書く） */
export type MissionWakeResult = "done" | "decisions" | "waiting" | "failed";

export interface MissionWakeRecord {
  wake: number;
  at: string;
  cause: MissionWakeCause;
  /** 時刻を過ぎてから起こした（banto が止まっていた・会話が空いていなかった）なら、予約の時刻 */
  scheduledFor?: string;
  result?: MissionWakeResult;
}

/**
 * 任務の状態。`active` 以外は人に返っている：`done`・`gave-up`＝AI が終えた、`exhausted`＝枠を使い切った（回数・期限）、
 * `stalled`＝予約も終わりも無いままターンが終わった、`stopped`＝人が止めた・会話や Project を閉じた
 */
export type MissionStatus = "active" | "done" | "gave-up" | "exhausted" | "stalled" | "stopped";

export interface MissionState {
  id: string;
  goal: string;
  doneWhen: string;
  frame: MissionFrame;
  startedBy: "ai" | "human";
  startedAt: string;
  status: MissionStatus;
  /** 任務の予約で起こした回数（起こした時点で数える） */
  wakes: number;
  /** 前に任務で起こした時刻（最短の間隔の起点） */
  lastWakeAt?: string;
  followup?: MissionFollowup;
  /** 起きた記録（新しい順、直近 50 件） */
  history: MissionWakeRecord[];
  /** 終わった・止めたときの結果の文（AI の `result`・止めた理由） */
  result?: string;
  finishedAt?: string;
  /** 終わりを書いた出来事の seq（受信箱がどのターンで人に返ったかを見る） */
  finishedSeq?: number;
}

/**
 * ターンを始めたもの：人の発言（届いたものも一緒に積んだときを含む）か、届いたものだけで起こしたか。`idle-compaction` は
 * 空いた会話を host が冷める前に要約したターン（追加・2026-10-20、アーキ仕様 §3.1）——`lastTurn` には入れず
 * `ThreadState.idleCompactionTurn` に畳む（受信箱・上限の待ち・切れたターンの続き・自動化と任務の回を動かさない）
 */
export type TurnCause = "human" | "delivery" | "idle-compaction";

/** ターンの終わり方：最後まで行った／人が止めた／失敗した */
export type TurnOutcome = "completed" | "stopped" | "failed";

/**
 * **終わった理由**（`turn.ended` の `reason`、追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 9.）。
 * `rate_limit`＝Claude の使用量の上限で断られて終わった（Runner の `error: "rate_limit"`）
 */
export type TurnEndReason = "rate_limit";

/** 上限の待ちを消した理由（`turn.continuation_cancelled`）：人が「待つのをやめる」を押した／止めるボタン */
export type ContinuationCancelledBy = "human" | "stopped";

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
  /** 続きのターンなら、何の続きか（`TurnContinuation.reason`）。`rate_limit` は上限で止まったターンの続き */
  continuesReason?: "rate_limit";
  /**
   * **Claude の使用量の上限で終わった**（`turn.ended` の `reason: "rate_limit"`、追加・2026-10-18、v4-security.md §2 の 9.）。
   * `continueAt` はリセットのあと自動で続ける時刻——無ければ待たない（続けて上限に当たった回数が上限に達した・リセットの
   * 時刻が分からない。受信箱で人に聞いている）。待ちが生きているかは `rateLimitWaitOf`
   */
  rateLimit?: { continueAt?: string };
  /** 上限の待ちを消した（`turn.continuation_cancelled`）。消したら自動では続けない */
  continuationCancelled?: ContinuationCancelledBy;
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
  /** Project のグループ（決定・2026-10-16）。Map の順＝作った順（並びに無いものはこの順で後ろに並ぶ） */
  projectGroups: Map<ProjectGroupId, ProjectGroupState>;
  /** 人が決めたグループの並び。`projectOrder` と同じく fail open */
  projectGroupOrder: ProjectGroupId[];
  /**
   * **画面をどの面に出したかの記録が、会話より先に届く**ことがある
   * （実測・2026-09-07）。画面が「大きく出して」と言うのはターンの**途中**、
   * その tool 呼び出しが会話に書かれるのはターンの**終わり**——先に届いた分は
   * 宛先がまだ無い。ここに預かっておき、会話が書かれた時点で貼る。
   * 追記のみの世界で順番に依存しないための入れ物であって、写しではない（規則3）。
   */
  displayModeByToolCall: Map<string, "inline" | "fullscreen">;
}
