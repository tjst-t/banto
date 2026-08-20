/**
 * 番頭ホストの常駐サーバ（task-0009・task-0035）。
 *
 * **会話スレッドを複数抱え**、その進行を WebSocket で配信する。CLI も WebUI も
 * このサーバの同格クライアントになる（Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * スレッドの帳簿は `ThreadRegistry`（threads.ts）が持ち、ここは配信とプロトコル変換だけ。
 * イベントには常に `threadId` が載るので、1つの接続で複数スレッドを同時に描ける。
 *
 * D5: 判断ロジックを持たない。セッションの組み立ては host-session.ts、記憶・SKILLは
 *     それぞれのモジュールにあり、ここは pub/sub とプロトコル変換だけを行う。
 * D6: ws — Node 20 には WebSocket サーバ実装が無い（banto-daemon と同じ理由で同じ依存）。
 * I2: 不正なメッセージは黙って捨てず、error イベントで返す。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BantoHarness, HarnessEvent, HarnessImage } from "@banto/core";

import type { Inbox, InboxEffect, InboxItem } from "./inbox.js";
import { THEME_URL_BASE, type UserThemes } from "./user-themes.js";
import type { CanvasCatalog } from "./canvas.js";
import { CORE_ORIGIN, type ModuleRegistry } from "./module.js";
import { CORE_TOOL_BASE_URL, createCoreToolHandler, createModuleToolHandler } from "./module-serve.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import { createWebAssetHandler } from "./web-assets.js";
import {
  BANTO_DEFAULT_PORT,
  BANTO_WS_PATH,
  type Attachment,
  type ClientMessage,
  type NoticeSource,
  type ServerEvent,
  type TranscriptAttachment,
  type TranscriptEntry,
  type UtsuwaView,
} from "./protocol.js";
import { openUtsuwa } from "./canvas-utsuwa.js";
import { fromWireToolName } from "@banto/core";
import type {
  NoticeReopenOutcome,
  Thread,
  ThreadRegistry,
  ThreadSpec,
} from "./threads.js";
import { workspaceRoot } from "./workspace.js";
import { TurnLog } from "./turn-log.js";

/**
 * 同じ面への口が既に立っているか（PO報告 2026-08-10）。
 *
 * 行き先（`view`）と引数が同じなら同じ口。**引数まで見る**のは、同じ面でも
 * 別のファイルを開いたなら別の行き先だから。
 */
/**
 * 同じ口が**このターンで**既に立っているか（PO要望 2026-08-11 で範囲を絞った）。
 *
 * もとは会話の最初から探していた。そのため**一度開いた面は、閉じたあと開き直しても
 * 口が立たない**——最初の口は何百行も上にあり、実際には辿り着けない。PO が求めたのは
 * 「閉じた後に押して開き直せる口」なので、**開くたびに、いまの位置に立つ**必要がある。
 *
 * 一方、番頭が1回の用件で `canvas.open` を数回呼ぶと同じ行が並ぶ問題（PO報告 2026-08-10）は
 * 残っている。だから**このターンの中だけ**を見る：直前の入力（POの発言・外からの知らせ）
 * より後ろに同じ口があれば積まない。
 */
function hasSameOpen(
  transcript: readonly TranscriptEntry[],
  utsuwa: Extract<UtsuwaView, { kind: "open" }>
): boolean {
  const args = JSON.stringify(utsuwa.args ?? {});
  // このターンの始まり＝最後の入力。無ければ会話の頭から
  let from = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const role = transcript[i]!.role;
    // 枝からの相談（決定107）もターンの始まり——知らせと同じく、これで番頭が喋り出す
    if (role === "po" || role === "notice" || role === "branch_note") {
      from = i;
      break;
    }
  }
  return transcript.slice(from).some(
    (e) =>
      e.role === "utsuwa" &&
      e.utsuwa.kind === "open" &&
      e.utsuwa.view === utsuwa.view &&
      JSON.stringify(e.utsuwa.args ?? {}) === args
  );
}

/**
 * 添付（テキストファイル）の保存先。ワークスペースのルート配下の `work/attachments/`。
 * BANTO_PLACES で `work/**` が読み書きできる場所として登録されている想定。
 * プロンプト注釈にもそのまま使うので、区切りは常に `/`。
 */
const ATTACHMENT_DIR_REL = "work/attachments";

/** 保存した添付を UI へ配る入口。vite の開発サーバは `/api` をホストへ中継する。 */
const ATTACHMENT_URL_BASE = "/api/attachments/";

/**
 * ツールの引数・結果として履歴に載せる最大の長さ。
 *
 * **丸ごと載せない**——ファイル読込のように結果が数MBになるツールがあり、そのまま積むと
 * 会話履歴（JSONL）が肥大化し、再読み込みのたびに同じ塊が流れる。切ったことは
 * 隠さず、末尾に印を付けて返す（I1）。
 */
const TOOL_PAYLOAD_MAX_CHARS = 4000;

/**
 * 死活確認（ping）の間隔。この2倍まで pong が返らなければ、その接続は畳む。
 *
 * 30秒にしたのは、間に挟まる NAT・Tailscale の DERP 中継が黙って落とす前に
 * 通しておきたいから——多くの実装で無通信の見切りは60秒前後にある。
 */
const WS_HEARTBEAT_MS = 30_000;

/**
 * 閉じるときに待つ上限（imp-0037 原因3）。
 *
 * ws の既定は close フレームの返事を **30秒** 待ち、`httpServer.close()` は中継の
 * upgrade が1本でも残っていれば**返らない**。どちらも「閉じると決めた後」の待ちなので、
 * 短く区切って先へ進む。
 */
const WSS_CLOSE_DEADLINE_MS = 2000;
const HTTP_CLOSE_DEADLINE_MS = 3000;

/**
 * 期限つきで待つ。超えたら**諦めた事実を残して**先へ進む（I2: 握りつぶさない）。
 *
 * 元の promise は捨てない（reject しても unhandled にならないよう受けておく）——
 * 後から返ってきても、こちらは既に次へ進んでいるだけでよい。
 */
function withDeadline(work: Promise<void>, ms: number, what: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[banto-host] ${what} を ${ms}ms で閉じられませんでした。先へ進みます`);
      resolve();
    }, ms);
    timer.unref?.();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.error(`[banto-host] ${what} を閉じるときに転びました: ${String(err)}`);
        resolve();
      }
    );
  });
}

/**
 * ツールの引数・結果を履歴に載せられる大きさへ収める。
 * 長すぎるときは文字列に落として切り詰める（構造を保ったまま部分的に消すと、
 * 何が欠けたのか読み取れなくなる）。
 */
function clampToolPayload(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  // 中身の無いものは「無かった」として扱う。空の `{}` を引数として見せても、
  // 開いた側には何も分からない——行が増えるだけ
  if (typeof value === "string" && value.length === 0) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    // 循環参照など JSON にできないもの。捨てずに姿だけ残す（I2）
    return "(表示できない値)";
  }
  if (serialized.length <= TOOL_PAYLOAD_MAX_CHARS) return value;
  return `${serialized.slice(0, TOOL_PAYLOAD_MAX_CHARS)}…（${serialized.length} 文字のうち先頭のみ）`;
}

/** ハーネスが返した数値をそのまま足せる形に。数でなければ 0（推測しない）。 */
function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 添付ファイル名から Content-Type を当てる。分からないものは汎用で返す。 */
function contentTypeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * サーバが必要とするセッションの最小契約。pi の `AgentSession` はこれを構造的に満たす。
 *
 * 具象型ではなくこの契約に依存することで、(a) ハーネスを差し替えても server は無変更
 * （ADR-0010 決定3）、(b) 実プロバイダを呼ばずに配信経路だけを検証できる、という2つを得る。
 */
export interface HostSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(
    text: string,
    options?: { streamingBehavior?: "steer" | "followUp"; images?: HarnessImage[] }
  ): Promise<void>;
  abort(): Promise<void>;
  /**
   * 走っているセッションのモデルを差し替える（対応するハーネスだけ）。
   *
   * 型を `unknown` にしているのは、モデルの実体がハーネスのものだから——server は
   * 中身を知らないまま、解決した実体を bin.ts から受け取って渡すだけ（ADR-0010 決定3）。
   */
  setModel?(model: unknown): Promise<void>;
}

/** モデル情報。WebUI が画像添付の可否を判定するための最小形。 */
export interface ModelInfo {
  id: string;
  /**
   * **バックエンドが変わったときの新しいハーネス**（PO要望 2026-08-13）。
   *
   * モデルの名前でバックエンドが決まる（職人側の `planModel` と同じ規則）。
   * 返ってきたら会話のハーネスを差し替える——再起動は要らない。
   */
  harness?: BantoHarness;
  /** どのバックエンドで動いているか。画面に出す。 */
  backend?: string;
  /** vision 対応（モデルの input が image を受け付ける）か。 */
  vision: boolean;
  /** 文脈に入る最大トークン数（分かるときだけ）。 */
  contextWindow?: number;
}

/** `notify` の宛先と出所。 */
/**
 * **知らせが指す対象**（T3）。用件ごとの枝を引き当てる鍵。
 *
 * 出所（worker / kobo / env）ごとの常設1本でも、知らせ1件ごとでもない——**用件**が単位。
 * 同じ職人・同じタスク・同じ検証環境の知らせは、同じ枝に集まる。
 */
export interface NoticeSubject {
  /**
   * 鍵。**出所を含めて一意にする**（`worker:sess-3` / `kobo:banto/task-0151` /
   * `env:env-12`）——番号だけだと、別の出所の同じ番号が同じ枝に混ざる。
   */
  key: string;
  /** 画面に出す名前（枝の題と還す条件に使う）。 */
  label: string;
  /**
   * **この鍵の最後の知らせか**（職人が落ちた・タスクがマージされた・環境が畳まれた）。
   * 真のときだけ「畳んでよい」と分かる印を添える。**機構は畳まない**——結論は番頭が書く。
   */
  terminal?: boolean;
}

export interface NotifyOptions {
  /** 宛先のスレッド（決定35a）。省略時は既定スレッド。 */
  threadId?: string;
  /** 誰からの知らせか。省略時は `system`。 */
  source?: NoticeSource;
  /**
   * 知らせが指す対象（T3）。**幹へ配られようとしている知らせだけ**、ここを鍵に
   * 用件の枝へ回す。省略すると「鍵の割り出せない知らせ」＝その1件だけの枝が立つ。
   */
  subject?: NoticeSubject;
  /**
   * **これは会話であって知らせではない**（T3）。真のときは用件の枝へ回さず、
   * `threadId` の指す会話へそのまま配る。
   *
   * 2つある。**PO が取次で答えた一通**——`notify` で入れているが喋っているのは PO 本人
   * で、枝へ移すと自分が押したボタンの続きを別の会話で探すことになる。そして
   * **番頭が自分で叩いた道具の続き**（`system.restart` の「これから再起動します」）
   * ——呼んだ会話へ返るのが筋である（PO裁定 2026-08-15）。他の幹からの言伝
   * （`thread.send`・出所 `thread`）も同じ理由で幹のまま。
   *
   * **宛先を名指ししていないときは効かない。** 「この会話へ」は会話を指していなければ
   * 意味を成さず、既定の幹へ落とせば結局そこのターンを起こす——それは T3 が塞ぎたい
   * ものそのもの。名指しの無い一通は、鍵の無い知らせと同じくその1件の枝で捌く。
   */
  conversation?: boolean;
}

export interface BantoHostServerOptions {
  /**
   * スレッドの帳簿。**既定スレッドを1本開いた状態で渡すこと**——宛先が無いと、
   * `threadId` を省略したメッセージを捌けない。
   */
  threads: ThreadRegistry;
  /**
   * ターンの台帳（T1）。渡すと `turn_start`〜`turn_end` の1ターンを1行で追記する。
   * **観測を足すだけで、ターンの扱いは変えない**。渡さなければ何もしない（no-op）——
   * 既存の試験が素のまま組んでも壊れない。
   */
  turnLog?: TurnLog;
  /** 待ち受けポート。0 を渡すと空きポートが割り当てられる（テスト用）。 */
  port?: number;
  /** GUIカタログ。welcome でクライアントへ渡し、UIがコンポーネントを解決する。 */
  catalog?: CanvasCatalog;
  /**
   * モジュールの帳簿。渡すと welcome のカタログエントリに、各GUIの提供元モジュールと
   * その接続情報が載る（決定25：UIはコンポーネントに直書きせずここから到達先を得る）。
   */
  modules?: ModuleRegistry;
  /**
   * 中核の Tool（`llm.*` 等）。渡すと `/api/core/tools/{名前}` で公開され、
   * 中核由来のキャンバスGUIがここからデータを取れる（ADR-0011 決定42）。
   */
  coreTools?: readonly NamespacedToolDefinition[];
  /**
   * 取次（受け口）。渡すと上段の札と面が動き、番頭は `inbox.*` で積める。
   * 渡さないと画面は取次を出さない（空ではなく、無い）。
   */
  inbox?: Inbox;
  /**
   * 取次の選択肢に付いた処理を実行する口（決定73）。
   *
   * **POが押したことを、その場で効かせるために要る。** 承認のような
   * 「番頭には呼べない口」（決定29e・38c）は、番頭の次のターンに任せられない
   * ——押したのに何も起きず、番頭に頼み直させることになる。
   *
   * 引くのはホストではなくモジュールの帳簿（決定27：Banto をブローカーにしない）。
   * ここは渡された宛先をそのまま呼ぶだけで、何が起きるかは知らない（D5）。
   *
   * @param origin どの札のどの回答で押されたか。`effect.originArg` に載せて渡す（決定113）
   * @returns 実行結果の一行。番頭への知らせに載る
   */
  runInboxEffect?(
    effect: InboxEffect,
    origin: { itemId: string; actionId: string }
  ): Promise<string>;
  /**
   * 持ち込みのテーマ置き場（spec-design §6.4）。渡すと `/api/themes` で台帳を、
   * `/api/themes/<name>.css` で中身を配る。作り直さずにテーマを足せる。
   */
  userThemes?: UserThemes;
  /**
   * 待ち受けるアドレス（既定 `127.0.0.1`）。
   *
   * **Banto は認証を持たない**（決定40）。守るのは前段（Caddy 等）の役目という裁定だが、
   * ホストが全インターフェースで待っていると**前段を素通りして直に叩ける**——認証が
   * 飾りになる。既定を localhost に閉じることで、「前段に置く」が本当に効く形にする。
   *
   * I1: 運用の心がけではなく機構で担保する。広げるには明示的に指定させ、警告を出す。
   */
  host?: string;
  /**
   * ビルド済み WebUI の置き場（task-0048）。渡すと UI も同じポートで配る。
   *
   * 常駐させるときに要る——開発中は vite が出すが、サービスでは開発サーバを動かし
   * 続けたくない。1プロセス・1ポートにすると、前段で守るのもそのポート1つで済む。
   */
  webDir?: string;
  /**
   * 現在のモデル。WebUI が画像添付の可否を判定するために使う（`GET /api/model`）。
   * 未指定（pi の既定解決に任せている）ときは undefined——画像は受け付けない。
   */
  model?: ModelInfo;
  /**
   * 番頭のモデルを切り替える口。**渡されなければ切替はできない**（UIからは選べない）。
   *
   * 解決（プロバイダ／モデル名 → 実体）も、**その会話のセッションへの適用**も、
   * 保存も、ここを渡す側（bin.ts）の責任。server は結果を配るだけ（D5）。
   * I2: 切り替えられないときは throw すること——黙って前のモデルのまま続けない。
   */
  onSelectModel?: (
    thread: Thread,
    provider: string,
    model: string,
    /** **provider の上位の階層**（PO裁定 2026-08-13）。省略なら会話のいまのバックエンド。 */
    backend?: string,
    /** 思考レベル（2026-08-19 提案）。未指定＝サービス既定に従う。 */
    thinking?: string
  ) => Promise<ModelInfo>;
  /** いま使っているモデルのプロバイダ。`model_state` に載せる。 */
  modelProvider?: string;
  /**
   * **PO に場を渡しておく長さ**（ミリ秒・imp-0048）。既定 {@link PO_FLOOR_HOLD_MS}。
   *
   * 中断した直後、PO が話し出すまで知らせの列を待たせる。返さないと知らせが永久に
   * 止まるので必ず期限を切る（試験からは短く差し替える）。
   */
  poFloorHoldMs?: number;
  /**
   * ターンの開始／終了を外部へ知らせる口：watchdog（task-0278）が
   * imp-0059「返らないターンに見張りが無い」を塞ぐために使う。
   *
   * `finally` で `end` を出すので、転んだターンにも必ず `end` が返る（端から見れば
   * 「返っていない・返った」しか無い）。渡さなければ何もしない（既存の試験はそのまま）。
   */
  onTurnChange?: (threadId: string, phase: "start" | "end") => void;
}

/**
 * 中断してから PO が話し出すまで、知らせを待たせる既定の長さ（imp-0048）。
 *
 * **2分**。止めた直後に何を言うか考える時間より長く、席を立ったまま知らせが
 * 止まり続けるには短い。決め打ちの値なので、直すなら計測してから（P6）。
 */
export const PO_FLOOR_HOLD_MS = 120_000;

/**
 * 番頭ホストサーバ。
 *
 * プロトコルは protocol.ts を参照。1プロセス＝1セッションで、接続した全クライアントが
 * 同じセッションのイベントを受け取る（a3：CLIとWebUIが同時に同じ会話を見られる）。
 */
export class BantoHostServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly threads: ThreadRegistry;
  private readonly catalog: CanvasCatalog | undefined;
  private readonly modules: ModuleRegistry | undefined;
  /** 取次。会話に紐づかない唯一の状態（POを待たせているもの）。 */
  private readonly inbox: Inbox | undefined;
  /** 取次の選択肢に付いた処理を実行する口（決定73）。無ければ記録と知らせだけ。 */
  private readonly runInboxEffect: BantoHostServerOptions["runInboxEffect"];
  private readonly clients = new Set<WebSocket>();
  /**
   * 前回の ping に pong を返した接続。死んだ接続を畳むためだけに持つ（→ `heartbeat`）。
   * 接続そのものが鍵なので、close で clients から外れれば一緒に消える WeakSet でよい。
   */
  private readonly alive = new WeakSet<WebSocket>();
  /**
   * モジュールへ渡した upgrade の socket（imp-0037 原因3）。
   *
   * **中身はモジュールのもの、入口を開けたのはこちら。** 渡した時点で http サーバの
   * 管理から外れるので、閉じるときに断てるよう控えを持つ。閉じたら自分で抜ける。
   */
  private readonly relayed = new Set<Duplex>();
  /** 死活確認のタイマー。close で止める。 */
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly unsubscribeThreads: () => void;
  /** 現在のモデル情報。画像添付の可否判定に使う。切替で入れ替わる。 */
  private modelInfo: ModelInfo | undefined;
  /** 現在のモデルのプロバイダ。切替で入れ替わる。 */
  private modelProvider: string | undefined;
  /** PO に場を渡しておく長さ（imp-0048）。 */
  private readonly poFloorHoldMs: number;
  /** ターンの開始／終了を外部へ知らせる口（watchdog・task-0278）。無ければ no-op。 */
  private readonly onTurnChange: (threadId: string, phase: "start" | "end") => void;
  /**
   * 「章を畳んでいます」を出した会話（imp-0052）。**1回の畳みにつき1回**だけ出す
   * ——畳み中に3つ発話が届いても、同じ文が3行並ぶのは知らせではなく雑音になる。
   */
  private readonly chapterHoldNoticed = new Set<string>();
  /** モデルを切り替える口（無ければ切替不可）。 */
  private readonly selectModel: BantoHostServerOptions["onSelectModel"];
  /** 購読を張り終えたスレッド。開くたびに増える。 */
  private readonly attached = new Set<string>();
  /** ターンの台帳（T1）。無ければ観測しない（既存の挙動に触れない）。 */
  private readonly turnLog: TurnLog | undefined;
  /**
   * いま開いている最中の用件の枝（T3）。鍵ごとに1つの約束を持つ。
   *
   * 同じ職人から2通が続けて来ると、どちらも「枝が無い」を見て**2本立てて**しまう
   * ——1通目の約束をここで待たせる。開き終わったら消す（残すと畳んだ枝を掴み続ける）。
   */
  private readonly openingSubjects = new Map<string, Promise<Thread>>();

  /**
   * 番頭の標準モデル（会話がまだ自分のモデルを持たないときに使う）。
   * 起動時に解決されたものをそのまま持つ。
   */
  private hostDefaultModel():
    | { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number }
    | undefined {
    if (!this.modelInfo) return undefined;
    // 実測が届いていればそれが真実（I1）。届くまでは欄ごと落とす——数で埋めない
    const contextWindow = this.hostMeasuredWindow ?? this.modelInfo.contextWindow;
    return {
      provider: this.modelProvider ?? "",
      id: this.modelInfo.id,
      vision: this.modelInfo.vision,
      ...(contextWindow ? { contextWindow } : {}),
    };
  }

  /**
   * その会話が使っているモデル（`model_state` に載せる形）。
   *
   * 会話ごとの指定が無ければ番頭の標準。**実測した文脈長があればそれで上書きする**
   * ——表に書いてある値より、そのハーネスが実際に測った値のほうが正しい。
   */
  private modelOf(
    thread: Thread
  ):
    | { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number }
    | undefined {
    const model = thread.model ?? this.hostDefaultModel();
    if (!model) return undefined;
    const measured = this.measuredWindow.get(thread.id);
    return measured ? { ...model, contextWindow: measured } : model;
  }

  /**
   * `GET /api/model` に出す番頭の標準モデル。
   * ハーネス（`ModelInfo.harness`）は配線であって能力ではないので載せない。
   */
  private hostModelResponse(): { id: string; vision: boolean; contextWindow?: number } | undefined {
    if (!this.modelInfo) return undefined;
    const contextWindow = this.hostMeasuredWindow ?? this.modelInfo.contextWindow;
    return {
      id: this.modelInfo.id,
      vision: this.modelInfo.vision,
      ...(contextWindow ? { contextWindow } : {}),
    };
  }

  /**
   * **ハーネスが文脈長を測れたら、その場で `model_state` を配り直す**（task-0150）。
   *
   * 実測が分かるのは**最初のターンが終わったとき**（Agent SDK の `result`）。
   * `model_state` は接続直後とモデル切替でしか流れていなかったので、ここで配り直さないと
   * 目盛りは「次に画面を開き直すまで」出ない。変わったときだけ配る（同じ値は流さない）。
   */
  private noteContextWindow(thread: Thread): void {
    const measured = thread.harness.contextWindow?.();
    // I1: 測れていないことを 0 や既定値で埋めない。分からないなら黙る
    if (typeof measured !== "number" || measured <= 0) return;
    if (this.measuredWindow.get(thread.id) === measured) return;
    this.measuredWindow.set(thread.id, measured);
    /**
     * 自分のモデルを持たない会話＝番頭の標準で回っている。その実測が標準の実測。
     * 会話が自分で標準と同じモデルを選んでいる場合も同じ（名前が一致すれば同じモデル）。
     */
    const onHostDefault = thread.model === undefined;
    if (onHostDefault || (this.modelInfo && thread.model?.id === this.modelInfo.id)) {
      this.hostMeasuredWindow = measured;
    }
    // 標準が分かったなら、標準で回っている会話は全部変わる（D3: 真実は一箇所）
    const targets = onHostDefault ? this.threads.list().filter((t) => !t.model) : [thread];
    for (const target of targets) {
      const model = this.modelOf(target);
      if (!model) continue;
      this.broadcast({
        type: "model_state",
        threadId: target.id,
        ...(model.backend ? { backend: model.backend } : {}),
        provider: model.provider,
        id: model.id,
        vision: model.vision,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      });
    }
  }
  /** 思考が始まった時刻（スレッド毎）。「X秒間考えました」を測るために持つ。 */
  private readonly thinkingStartedAt = new Map<string, number>();
  /**
   * 直近のターンで運んだトークン数（スレッド毎）。**実行時状態なので保存しない**（D3）
   * ——再起動したら次のターンまで分からない。推定で埋めるより黙るほうがよい（I1）。
   */
  private readonly contextTokens = new Map<string, number>();
  /**
   * **ハーネスが実測した文脈長**（スレッド毎）。目盛りの分母になる。
   *
   * モデルの表（LLM 登録）は当てにできない——`claude-agent-sdk` のモデルはそこに
   * 載らず、`resolveHostDefault()` は pi 側の**代打**へ落ちる。代打の能力値は標準とは
   * 何の関係も無いので `hostModelInfo` が欄ごと落としており、その結果このバックエンドで
   * 動いている間は**構造的に必ず**分母が消えていた（画面から目盛りが丸ごと消える）。
   *
   * 唯一の正しい出どころは `BantoHarness.contextWindow()`——Agent SDK が `result` で
   * 返した実測。ここには**測れた値しか入らない**（pi のハーネスはこの口を持たないので、
   * 代打の値がこの経路に入ることはない）。**実行時状態なので保存しない**（D3）。
   */
  private readonly measuredWindow = new Map<string, number>();
  /**
   * 番頭の標準モデルで回っている会話が実測した文脈長（`GET /api/model` に出す）。
   * 自分のモデルを持たない会話＝標準で回っている会話なので、その実測が標準の実測。
   */
  private hostMeasuredWindow: number | undefined;

  private constructor(options: BantoHostServerOptions, httpServer: http.Server) {
    this.threads = options.threads;
    this.turnLog = options.turnLog;
    this.catalog = options.catalog;
    this.modules = options.modules;
    this.inbox = options.inbox;
    this.runInboxEffect = options.runInboxEffect;
    // 積まれた／答えが出たら全員へ配り直す（D3：真実は Inbox 側の一箇所）
    if (this.inbox) {
      const inbox = this.inbox;
      inbox.onChange(() => this.broadcast({ type: "inbox_state", items: inbox.list() }));
    }
    this.modelInfo = options.model;
    this.modelProvider = options.modelProvider;
    this.poFloorHoldMs = options.poFloorHoldMs ?? PO_FLOOR_HOLD_MS;
    this.onTurnChange = options.onTurnChange ?? (() => {});
    this.selectModel = options.onSelectModel;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({
      noServer: true,
      // 接続時に配る history は全スレッド分で数MBになる（inc: Android/Tailscale から
      // 使えない）。中身は同じ形の JSON の繰り返しなので、deflate が非常によく効く
      // ——実測 9.67MB → 1.43MB（85%減）。
      //
      // **文脈持ち越し（context takeover）は切らない。** 切ると1フレームごとに辞書が
      // 捨てられ、この「同じ形が延々続く」流れでは圧縮率が大きく落ちる。代償は接続ごとの
      // zlib 窓（数百KB）だが、この面に繋ぐのはPOの画面が数枚——常時多接続ではない
      perMessageDeflate: {
        // 小さなフレーム（turn_start 等）は圧縮しても縮まず、往復の CPU だけ増える
        threshold: 1024,
        // level は 6（zlib 既定）。実測 9.67MB に対し level 3 が 1.66MB / 68ms、
        // level 6 が 1.43MB / 132ms、level 9 は 6 と同じ大きさでさらに遅い。
        // 遅い回線ほど 0.23MB の差が効くので、64ms の CPU は払う価値がある
        zlibDeflateOptions: { level: 6 },
        concurrencyLimit: 10,
      },
    });

    this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) =>
      this.handleConnection(ws, req)
    );

    // **死活確認**（inc: Android/Tailscale から使えない）。
    //
    // モバイル回線・Tailscale・NAT の間では、画面消灯やハンドオーバで TCP が
    // **黙って**切れる。FIN が来ないので close が上がらず、番頭側は生きていると思って
    // 配信し続け、画面側は「繋がっているのに何も来ない」まま止まる。
    // ping を投げて pong が返らない接続を畳むと、画面側の onclose が発火して
    // 繋ぎ直しに入れる——切れたことに気づかせるのが目的。
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!this.alive.has(ws)) {
          // 前回の ping に答えていない＝もう居ない。terminate は 'close' を続けて出すので
          // clients からはそちらで外れる
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, WS_HEARTBEAT_MS);
    // 死活確認のためだけにプロセスを起こし続けない（テストが終わらなくなる）
    this.heartbeat.unref?.();
    // upgrade はここで一手に受け、パスで振り分ける（案A：proxy exposer の WS 中継）。
    // ws に server を持たせると /ws 以外の upgrade を全部 400 で蹴るため、noServer にして
    // 自分の面（/ws）とモジュールの面（中継 URL）をここで分ける
    httpServer.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    // スレッドが開くたびに購読を張り、増減を全クライアントへ配る
    for (const thread of this.threads.list()) this.attach(thread);
    this.unsubscribeThreads = this.threads.subscribe((threads) => {
      for (const thread of threads) this.attach(thread);
      this.broadcast({ type: "thread_state", threads: threads.map((t) => t.view()) });
    });
    /**
     * 幹に立つ2つの行（ADR-0017 決定77）を配る。
     *
     * 帳簿は記録を持つが配信は知らない（D5）ので、ここで差し込む——記録して黙ると、
     * 開いている画面には枝の札が出ないまま次の発話が続く。
     */
    this.threads.onTrunkCard = (trunk, branch) =>
      this.broadcast({ type: "branch_card", threadId: trunk.id, branchId: branch.id });
    this.threads.onBranchResult = (trunk, entry) =>
      this.broadcast({ type: "branch_result", threadId: trunk.id, ...entry });
    /**
     * 枝を畳んだことを取次へ知らせる（ADR-0022 決定109）。**求めるのは判断ではない**ので、
     * `notice: true` を付けて判断待ちの数（`inboxPending`）から外す（決定110）。
     * 詳細（調べた・決めた・残った）は幹へ流さないのと同じ理由で本文には出さず、
     * 在ることだけを言う——読むのは押して枝を開いてから。
     */
    this.threads.onBranchMerged = (thread) => {
      if (!this.inbox) return;
      const detailNote = thread.conclusionDetail ? "（詳細は開けば読めます）" : "";
      this.inbox.post({
        source: { id: "banto", label: "番頭" },
        kind: "枝を回収しました",
        notice: true,
        title: `枝「${thread.title}」を幹に回収しました`,
        what: `${thread.conclusion ?? ""}${detailNote}`,
        ask: "確認したら押してください（再開したければ、開いてから話しかけてください）",
        actions: [{ id: "read", label: "読んだ", tone: "plain" }],
        opens: { threadId: thread.id },
      });
    };
    /**
     * 枝から幹への相談・報告（決定107）。**同じ列に並べる**ので、札と結論と同じ扱いで配る
     * ——知らせに混ぜると、幹を読み返したときにどの枝の話か辿れない。
     */
    this.threads.onBranchNote = (trunk, entry) =>
      this.broadcast({
        type: "branch_note",
        threadId: trunk.id,
        branchId: entry.branchId,
        title: entry.title,
        kind: entry.kind,
        text: entry.text,
        at: entry.at,
      });
  }

  /**
   * 1本のスレッドの進行を配信につなぐ。
   *
   * **スレッドごとに購読を張る**のが要点——ここを1本に共有すると、あるスレッドの
   * キャンバス操作が別スレッドの表示として配信される（決定2 が壊れる）。
   */
  private attach(thread: Thread): void {
    if (this.attached.has(thread.id)) return;
    this.attached.add(thread.id);

    // ハーネスの購読は Thread が1箇所で持つ——**差し替えのときに張り直す**ため
    // （`disposers` に混ぜると、ハーネスのぶんだけを外せない）
    thread.listen((event) => this.handleHarnessEvent(thread, event));
    // D3: キャンバスの真実はホスト側。状態が変わるたび全クライアントへ配る
    if (thread.canvas) {
      thread.disposers.push(
        thread.canvas.subscribe((snapshot) =>
          this.broadcast({
            type: "canvas_state",
            threadId: thread.id,
            tabs: snapshot.tabs,
            activeTabId: snapshot.activeTabId,
          })
        )
      );
    }
    thread.disposers.push(() => this.attached.delete(thread.id));
  }

  /**
   * 会話のハーネスを差し替える（`set_model` と同じ継ぎ目）。購読を張り直す。
   *
   * クオータ節約（Claude の枠が尽きかけたら pi へ戻す）のように、モデル選択を経ずに
   * バックエンドを替えたいときに使う。`release` は差し替える側（いまのハーネスが
   * 抱える中身）の後始末。**既に pi のときは何もしない**——無駄に差し替えたり、
   * 慌てて Claude を畳んだりしない。
   */
  swapHarness(threadId: string, next: BantoHarness, release: () => void): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (thread.harness === next) return;
    thread.replaceHarness(next, (event) => this.handleHarnessEvent(thread, event));
    release();
  }

  /** サーバを起動し、待ち受け開始まで待つ。 */
  static async start(options: BantoHostServerOptions): Promise<BantoHostServer> {
    // 組み込みモジュールのデータAPI（決定25：組み込みの提供元は Banto ホスト自身）。
    // UI はここからデータを取る——番頭の Tool 経路は通らない。
    const serveModuleTool = options.modules ? createModuleToolHandler(options.modules) : undefined;
    // 中核のドメイン（`llm.*` 等）も同じ規約で公開する（ADR-0011 決定42）
    const serveCoreTool = options.coreTools ? createCoreToolHandler(options.coreTools) : undefined;
    // ビルド済み資産があれば UI も配る。無ければ何もしない（vite が出す）
    const serveWebAsset = createWebAssetHandler(options.webDir);

    // 現在のモデル情報。WebUI が画像添付の可否を選択時点で判定するために使う。
    // モデル未指定（pi の既定解決に任せている）ときは、対応を名乗れないので
    // 非対応として返す（I1: 知らないことを対応と偽らない）
    //
    // **文脈長だけは立ってから変わる**（task-0150）。ハーネスが最初のターンで測るまで
    // 分からないので、起動時の写しではなく**立ったサーバへ聞きに行く**——写しを返すと
    // 「1往復したのに欄が出ない」が再起動まで続く
    const modelInfo = options.model;
    let live: BantoHostServer | undefined;
    const httpServer = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/health") {
          const body = JSON.stringify({ ok: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        // 持ち込みのテーマ。台帳と CSS を配るだけで、解釈は画面側（D5）
        if (req.method === "GET" && req.url === "/api/themes") {
          const body = JSON.stringify(options.userThemes?.manifest() ?? { families: [] });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && req.url?.startsWith(THEME_URL_BASE)) {
          const name = decodeURIComponent(req.url.slice(THEME_URL_BASE.length).split("?")[0] ?? "");
          const css = options.userThemes?.css(name);
          if (css === undefined) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
          res.end(css);
          return;
        }
        if (req.method === "GET" && req.url === "/api/model") {
          const body = JSON.stringify(
            live?.hostModelResponse() ?? modelInfo ?? { id: "(未設定)", vision: false }
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        // 会話に残っている添付を返す（吹き出しのサムネイル）。
        // **パスはクライアント由来なので信頼しない**——ベース名だけに落として、
        // 保存先の外へ出られないようにする（`..` や絶対パスを弾く）
        if (req.method === "GET" && req.url?.startsWith(ATTACHMENT_URL_BASE)) {
          const requested = decodeURIComponent(req.url.slice(ATTACHMENT_URL_BASE.length).split("?")[0] ?? "");
          const name = path.basename(requested);
          const file = path.join(workspaceRoot(), ATTACHMENT_DIR_REL, name);
          if (name.length === 0 || !fs.existsSync(file)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": contentTypeOf(name) });
          res.end(fs.readFileSync(file));
          return;
        }
        if (serveCoreTool && (await serveCoreTool(req, res))) return;
        if (serveModuleTool && (await serveModuleTool(req, res))) return;
        // 最後に UI。API より後に見るので、/api を資産で覆い隠すことはない
        if (serveWebAsset(req, res)) return;

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      })().catch((err: unknown) => {
        // I2: ハンドラの例外を黙って落とさず 500 で返す
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    const server = new BantoHostServer(options, httpServer);
    // ここから `/api/model` は写しではなく生きたサーバに聞く（実測が入ると変わる）
    live = server;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? BANTO_DEFAULT_PORT, options.host ?? "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  /**
   * **PO の言葉は、番頭が何をしていても届く**（PO報告 2026-08-11）。
   *
   * もとは `isStreaming` を見て、真のときだけ `steer` として積んでいた。ところが
   * `isStreaming` が真なのは**トークンを吐いている間だけ**で、道具を実行している間は
   * 偽になる——番頭が道具を回し続けているとき（＝暴走しているとき）はほぼ常に偽なので、
   * PO の「ちょっとまって」は `Agent is already processing a prompt` で弾かれた。
   * **止めたいときに限って止められない**、いちばん困る形だった（実機・thread-69）。
   *
   * 見るのをやめて**やってみて、駄目なら steer で積み直す**。状態を覗いて分岐するより、
   * 実際の返事で決めるほうが競走に強い（I1：自己申告ではなく結果で判断する）。
   */
  /**
   * **畳んでいる間の発話は、捨てず・答えさせず・待たせる**（imp-0052）。
   *
   * 章の要約には30秒ほどかかる。その最中に届いた発話をそのまま流すと、
   * **これから捨てるセッション**が答え始め、`startChapter` が走った瞬間に途中で切られる
   * ——PO から見ると「返事が出かかって消える」（thread-85 第9章で実際に起きた）。
   *
   * 門番は戻していない（imp-0048）。走行中の入力は今までどおり受ける——待たせるのは
   * **畳んでいる 30 秒だけ**で、待った発話は新しい章のセッションへそのまま流れる。
   *
   * 待っている間を無反応にしない：`announce` が真なら画面に理由を出す（PO の発話用。
   * 知らせの経路では出さない——知らせは番頭あての用件で、待ちは PO に見せる話ではない）。
   */
  private async holdWhileClosingChapter(thread: Thread, announce: boolean): Promise<void> {
    const gate = thread.chapterGate;
    if (!gate?.isClosing()) return;
    if (announce && !this.chapterHoldNoticed.has(thread.id)) {
      // 待たせる理由は**この畳みにつき1回**だけ出す（発話ごとに出すと同じ文が並ぶ）
      this.chapterHoldNoticed.add(thread.id);
      const note =
        "章を畳んでいます（ここまでの会話をまとめ直しています）。" +
        "**いただいた言葉は消えていません**——畳み終わってから、新しい章でお答えします。";
      thread.record({ role: "notice", source: "system", text: note });
      this.broadcast({ type: "notice", threadId: thread.id, source: "system", text: note });
    }
    await gate.whenSettled();
    this.chapterHoldNoticed.delete(thread.id);
  }

  private async promptEvenWhileBusy(
    thread: Thread,
    text: string,
    options: Parameters<HostSession["prompt"]>[1] = {}
  ): Promise<void> {
    try {
      await thread.harness.prompt(text, {
        ...options,
        ...(thread.harness.isStreaming ? { streamingBehavior: "steer" as const } : {}),
      });
    } catch (err) {
      // ターンの最中だと分かったので、積み直す。それ以外の失敗はそのまま上へ
      if (!isBusyError(err)) throw err;
      await thread.harness.prompt(text, { ...options, streamingBehavior: "steer" as const });
    }
  }

  /**
   * 番頭に外から知らせを入れる（決定29）。職人からの報告・質問がここを通る。
   *
   * **宛先はその職人を起こしたスレッド**（決定35a）。`threadId` を省略すると既定スレッド
   * ——スレッドを使っていない起動元との互換。
   *
   * `source` は**誰からの知らせか**。省略すると `system` になる。出所を名乗らないと、
   * 外から入る知らせが全部同じ札で出る（番頭が開いた分身への一言が職人に見えた）。
   *
   * POの発話ではないので `notice` として配り、UIでも見分けられるようにする。
   * 知らせを入れたら番頭のターンを回す——**気づかせるのが目的**なので、
   * ログに積むだけでは足りない。
   *
   * 知らせ同士はスレッドごとに直列化する。同時に3人の職人が報告してきても、
   * そのスレッドのターンは1本ずつ進む。
   *
   * **幹へ配られようとした知らせは、用件の枝へ回る**（T3 → `routeNotice`）。宛先が
   * 既に枝なら何も変わらない。回した知らせで**幹のターンは回らない**——幹はいつでも
   * PO の入力を受けられる待ち状態でいる、というのが T3 の全部である。
   */
  async notify(text: string, options: NotifyOptions = {}): Promise<void> {
    const source = options.source ?? "system";
    // T3: 幹へ配られようとしている知らせだけ、用件の枝へ回す
    const routed = await this.routeNotice(text, options, source);
    return this.deliverToThread(routed.text, routed.threadId, source, (thread) => {
      thread.record({ role: "notice", source, text: routed.text });
      this.broadcast({ type: "notice", threadId: thread.id, source, text: routed.text });
    });
  }

  /**
   * **知らせで幹のターンを起こさない**（T3・PO 方針 2026-08-15）。
   *
   * 対応をやめるのではなく、**対応の場所を幹から枝へ移す**。幹はいつでも PO の入力を
   * 受けられる待ち状態でいてほしい——職人の報告・工房の進捗・環境の知らせで塞がるのは、
   * PO が「私が会話できない」と名指しで挙げた形そのもの。幹へ返るのは、枝を畳むときの
   * 結論1行だけになる。
   *
   * 回すのは**幹へ配られようとしている知らせだけ**。
   *
   * - 宛先が**枝**なら、そのまま配る。枝の中で委譲した職人の報告がその枝へ返るのは、
   *   既に正しい形（`origin=banto:<threadId>`）——ここに用件の枝を挟むと二重になる
   * - **他の幹からの言伝**（`thread.send`・出所 `thread`）は幹のまま。これは会話その
   *   ものであって知らせではない。PO の発話も同じ（そもそもこの経路を通らない）
   * - 宛先が幹で**鍵が割り出せる**なら、その鍵の枝へ。無ければ機構が立てる
   * - 宛先が幹で**鍵が割り出せない**なら、**その1件のための枝**を立てる。続きが来ても
   *   同じ枝へ結びつけようが無い＝1件で終わる用件だから（PO 指示 2026-08-15：
   *   常設の落ち先は作らない。溜め place になり、古い文脈で知らせに対応する形へ戻る）
   *
   * I2: 枝を立てられなかったら知らせを捨てず、元の宛先へ配る。幹が1本回るのは、
   * 知らせが消えるより遥かにましである。
   */
  private async routeNotice(
    text: string,
    options: NotifyOptions,
    source: NoticeSource
  ): Promise<{ text: string; threadId: string | undefined }> {
    const asIs = { text, threadId: options.threadId };
    /**
     * 会話はその会話のまま。PO が取次で答えた一通・番頭が叩いた道具の続き
     * （`conversation`）と、他の幹からの言伝（`thread.send`・出所 `thread`）。
     *
     * `conversation` は**宛先を名指ししているときだけ**効く——名指しの無い一通を
     * 素通しすると既定の幹へ落ち、そこのターンが回る（T3 が塞ぎたいものそのもの）。
     */
    if (options.conversation === true && options.threadId !== undefined) return asIs;
    if (source === "thread") return asIs;
    let target: Thread;
    try {
      target = this.threads.resolve(options.threadId);
    } catch {
      // 宛先が引けないことはここでは決めない。`deliverToThread` が I2 のまま投げる
      return asIs;
    }
    // 枝が宛先なら、既に幹の外。用件の枝を重ねない
    if (target.kind !== "trunk") return asIs;

    try {
      /**
       * **畳んだ幹に枝は生やさない**（T2 との継ぎ目）。開いている枝の親は開いている幹、
       * が決定77 の前提——畳んだ幹にぶら下げると、レールにも幹の面にも出ない枝ができる。
       * 終えた幹を開き直す（印は残る）が、**ターンは回さない**：回るのは枝である。
       */
      this.reopenClosedTarget(target);
      const branch = await this.subjectBranch(target, options.subject, text);
      return { text: appendCloseHint(text, options.subject), threadId: branch.id };
    } catch (err) {
      // I2: 枝を立てられなかったことを黙らせない。知らせ自体は元の宛先へ配る
      console.error(`[banto] 用件の枝を開けませんでした（幹へ配ります）: ${String(err)}`);
      return asIs;
    }
  }

  /**
   * 用件の枝を引き当てる。無ければ立てる（T3）。
   *
   * 鍵があるものは `findBySubject` で引く——**題では引かない**（改名で壊れる）。鍵は
   * 索引に保存され、再起動をまたいで残る。**畳んだ枝も引き当てる**：そこへ配れば
   * T2 が開き直すので、遅れて届いた1通で二重に枝が立たない。
   *
   * 同じ鍵の知らせが同時に2通来ると、どちらも「枝が無い」を見て2本立ててしまう
   * ——開いている最中の約束を鍵で覚えておき、2通目はそれを待つ。
   */
  private async subjectBranch(
    trunk: Thread,
    subject: NoticeSubject | undefined,
    text: string
  ): Promise<Thread> {
    // 鍵が無い＝続きが来ても結びつけようが無い。**その1件だけの枝**を立てて畳んでもらう
    if (!subject) return this.threads.open(oneShotBranchSpec(text), trunk.id);
    const existing = this.threads.findBySubject(trunk.id, subject.key);
    if (existing) return existing;
    const opening = this.openingSubjects.get(`${trunk.id}::${subject.key}`);
    if (opening) return opening;
    const started = this.threads
      .open(subjectBranchSpec(subject), trunk.id)
      .finally(() => this.openingSubjects.delete(`${trunk.id}::${subject.key}`));
    this.openingSubjects.set(`${trunk.id}::${subject.key}`, started);
    return started;
  }

  /**
   * **記録は済んでいる前提で、番頭のターンだけ回す**（決定107）。
   *
   * 枝からの相談は `ThreadRegistry.consult` が既に**札**として幹へ積んでいる。ここで
   * `notify` を使うと同じ一言が知らせとしても積まれ、1つの相談が2行に見える
   * ——記録の形は呼び出し側が決め、ターンを回す仕掛けはここが持つ。
   */
  nudge(threadId: string | undefined, text: string): Promise<void> {
    // 枝からの相談（決定107）。出所は「枝」なので台帳では "nudge" として残す
    return this.deliverToThread(text, threadId, "nudge", () => {});
  }

  /**
   * 知らせをスレッドの列に並べ、番頭のターンを1本回す。
   *
   * **記録の形だけが呼び出しごとに違う**（知らせの行か、枝の札か）ので、そこを渡して
   * もらう。直列化・turn_start/turn_end・失敗の記録はどの経路でも同じでなければ
   * ならない——別々に書くと、片方だけ turn_start を出さない、といった食い違いが出る。
   *
   * `source` は**誰がこのターンを起こしたか**（台帳 T1 の出所）。知らせは `notify` が
   * 持っている（省略時 `system`）。枝からの相談は `nudge` が `"nudge"` を渡す。
   * 渡ってこなかったときは台帳側で `unknown` になる。
   */
  private deliverToThread(
    text: string,
    threadId: string | undefined,
    source: string | undefined,
    record: (thread: Thread) => void
  ): Promise<void> {
    let thread: Thread;
    try {
      thread = this.threads.resolve(threadId);
    } catch (err) {
      // I2: 宛先不明の知らせを黙って捨てない
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    /**
     * **列を rejected のまま残さない**（inc-0069）。
     *
     * ここは `thread.notices` に `.then` を継ぎ足していく列である。1通のどこか——
     * 記録の書き込み、`broadcast` の `ws.send`、`getLastError`——が投げると、この
     * Promise は rejected のまま残り、**以後この会話へ積む知らせは `.then` の本体すら
     * 走らない**。1回の失敗で、その会話の職人の報告が静かに全部消える。だから外側で
     * 受け止め、列は必ず fulfilled で次へ渡す（I2: 消えたことにしない）。
     */
    thread.notices = thread.notices.then(async () => {
      // T1: ターン1本を台帳へ書く口。開始時刻は turn_start の直前で取る
      let turnStartedAt = 0;
      let logged = false;
      const logTurn = (ok: boolean, errorMessage?: string): void => {
        if (logged) return; // 二重に書かない（外側の catch が拾ったとき用）
        logged = true;
        this.recordTurn(thread, source, turnStartedAt, ok, errorMessage);
      };
      try {
        /**
         * **PO が場を取っている間は待つ**（imp-0048）。中断した直後に列の続きが
         * 走り出すと、PO が話そうとした隙がそのまま埋まる——中断の意味が消える。
         *
         * 待つのは**ここ**（記録より前）。記録してから待つと、番頭がまだ読んでいない
         * 知らせが会話に並び、PO の発話の前にあったように見える。
         */
        await thread.poFloor;
        // imp-0052: 知らせも、畳んでいる最中は待つ。これから捨てるセッションへ渡すと
        // 番頭が答えかけたところで切られる（PO の発話と同じ壊れ方）。画面には出さない
        await this.holdWhileClosingChapter(thread, false);
        // T2: 畳んだ宛先へ遅れて届いた知らせは、宛先を開き直してから配る。
        // 開き直したときだけ、機構からの一文が知らせの前に付く（task-0227）
        // ——文面も、畳み直すかどうかの判断も帳簿の側（D5：ここは繋ぐだけ）
        const reopened = this.reopenClosedTarget(thread, { source: source ?? "system", text });
        record(thread);
        // 職人の報告でも番頭は喋り出す。ここを知らせないと画面から中断する手段が消える
        turnStartedAt = Date.now(); // T1: 開始時刻は turn_start の直前（実測の起点）
        this.broadcast({ type: "turn_start", threadId: thread.id });
        // task-0278: watchdog に「この枝のターンが始まった」と知らせる（imp-0059）
        this.onTurnChange(thread.id, "start");
        try {
          await this.promptEvenWhileBusy(
            thread,
            reopened?.context ? `${reopened.context}\n\n${text}` : text
          );
        } catch (err) {
          // I2: 知らせが番頭に届かなかったことを黙らせない
          thread.record({ role: "error", text: String(err) });
          logTurn(false, String(err));
          this.broadcast({ type: "turn_end", threadId: thread.id, errorMessage: String(err) });
          return;
        }
        const lastError = thread.getLastError();
        if (lastError) thread.record({ role: "error", text: lastError });
        logTurn(lastError === undefined, lastError);
        this.broadcast({
          type: "turn_end",
          threadId: thread.id,
          ...(lastError ? { errorMessage: lastError } : {}),
        });
      } catch (err) {
        console.error(`[banto] ${thread.id} への知らせで転びました: ${String(err)}`);
        try {
          thread.record({ role: "error", text: String(err) });
        } catch {
          // 記録すら書けないなら、上のログだけが痕跡になる
        }
        logTurn(false, String(err));
        this.broadcast({ type: "turn_end", threadId: thread.id, errorMessage: String(err) });
      } finally {
        /**
         * **ターンの終わりは、ここしか知らない**（task-0227）。知らせで開き直した枝を
         * 畳み直す合図をここで1回出す——枝が「畳んでください」と自分で言うのを待たない。
         *
         * `finally` に置くのは、転んだターンでも枝を開いたまま残さないため。
         * 判断（畳み直すのか・枝が自分で `merge` したのか）は帳簿の側にある。
         */
        // task-0278: watchdog にターンの終わりを知らせる。転んだターンも必ず
        // ここに辿り着く（end なしで止まったままにしない・imp-0059）。
        this.onTurnChange(thread.id, "end");
        this.closeAfterNoticeTurn(thread);
      }
    });
    return thread.notices;
  }

  /**
   * 畳んだ宛先へ知らせが届いたら、**その宛先を開き直してから配る**（T2）。
   *
   * `resolve` は畳んだスレッドも返す（決定35b・threads.ts）。**そこは変えない**
   * ——知らせを届けるための意図的な設計である。変えるのは配り方のほう：畳んだまま
   * ターンを回すと、**レールのどこにも出ていない会話が独りでに喋る**。番頭は畳んだ
   * つもりの枝で作業を続け、PO はそれを見る手立てがない。
   *
   * 手は3つしかない。捨てる（I2 に反する）、親の幹へ回す（幹を待ち状態に保つという
   * 狙いに真っ向から反する）、**宛先自身を開き直す**。3つ目を採る——決定68 が本来
   * 意図していた形でもある（kobo-notice.ts の「起こし直して届ける」コメント）。
   *
   * 開き直したことは会話の1行と `thread.list`（開いている側に出る）に残る。
   * **既に開いていれば何もしない**ので、同じ枝への2件目以降で印が積み上がらない。
   *
   * **開いたままにはしない**（task-0227）。開き直した枝は、そのターンが終わったら
   * `closeAfterNoticeTurn` が畳み直す——枝は自分が開き直されたことを知らないので、
   * 「捌いたら `thread.merge` で還してください」と書いても誰も還さなかった。
   * 判断と文面は `ThreadRegistry.reopenForNotice` / `closeAfterNotice` の側にある（D5）。
   *
   * **畳んだ幹も同じ扱いにする。** 幹は「終えたプロジェクト」なので躊躇はあるが、
   * 幹には還す親が無く、ほかへ逃がせば必ず**別の幹（帳場）のターンが回る**
   * ——それは今回塞ぎたいものそのものである。だから宛先本人を開き直し、
   * **印の文言だけ分けて**「終えた幹が動き出した」と読めるようにする。畳み直すのは
   * `thread.close_trunk` で、いつでもできる。
   */
  private reopenClosedTarget(
    thread: Thread,
    notice?: { source: string; text: string }
  ): NoticeReopenOutcome | undefined {
    const reopened = this.threads.reopenForNotice(thread.id, notice);
    if (!reopened) return undefined;
    this.broadcast({ type: "notice", threadId: thread.id, source: "system", text: reopened.note });
    return reopened;
  }

  /**
   * **知らせで開き直した枝を、ターンの後に畳み直す**（task-0227）。ここは繋ぎだけ
   * ——畳み直すかどうか・何を残すかは `ThreadRegistry.closeAfterNotice` が決める（D5）。
   *
   * I2 の但し書き：畳み直しは後始末なので、ここで転んでもターンは壊さない
   * （転んだことはログに残す。黙って畳んだことにはしない）。
   */
  private closeAfterNoticeTurn(thread: Thread): void {
    try {
      const closed = this.threads.closeAfterNotice(thread.id);
      if (!closed) return;
      this.broadcast({ type: "notice", threadId: thread.id, source: "system", text: closed.note });
    } catch (err) {
      console.error(`[banto] ${thread.id} を畳み直せませんでした: ${String(err)}`);
    }
  }

  /**
   * ターン1本を台帳へ書く（T1）。**観測を足すだけ**——書けなくてもターンは壊さない
   * （書き込みの失敗は TurnLog 側が console.error に出すだけ）。`source` が渡って
   * こなかったときは `unknown`。
   */
  private recordTurn(
    thread: Thread,
    source: string | undefined,
    turnStartedAt: number,
    ok: boolean,
    errorMessage?: string
  ): void {
    this.turnLog?.append({
      at: new Date(turnStartedAt).toISOString(),
      threadId: thread.id,
      threadKind: thread.kind,
      ...(thread.parentId !== undefined ? { parentId: thread.parentId } : {}),
      source: source ?? "unknown",
      durationMs: Date.now() - turnStartedAt,
      ok,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });
  }

  /**
   * **章を畳んだ印を1本入れる**（提案§3.2・PO要望 2026-08-11）。
   *
   * **ターンは回さない**（`notify` との違い）。知らせとして流していたときは、畳んだ直後の
   * 空の文脈で番頭が独りでに `thread.list`・`inbox.list`・`kobo.list` と調べ始めていた
   * ——POは何も頼んでいないのに会話が進み、畳んで軽くした文脈がその場で埋め直される。
   * 畳んだことは**画面に見えれば足りる**。番頭には章の頭に引き継ぎ資料が入っている。
   *
   * I2: 宛先不明を黙って捨てない。
   */
  markChapter(threadId: string | undefined, chapter: number, topic: string): void {
    const thread = this.threads.resolve(threadId);
    const at = new Date().toISOString();
    thread.record({ role: "chapter", chapter, topic, at });
    /**
     * **畳んだ瞬間、前章の使用量を持ち越さない**（PO報告 2026-08-14）。
     *
     * ここで消さないと、次のターンの実測が来るまで（そして畳んだ直後に繋ぎ直すたびに
     * 何度でも）前章の値が「いまの使用量」として出続ける。`tokens` を省略した
     * `context_state` で「まだ分からない」に戻す（I1: 古い値を新しい値と偽らない）。
     */
    this.contextTokens.delete(thread.id);
    this.broadcast({ type: "context_state", threadId: thread.id });
    this.broadcast({ type: "chapter_closed", threadId: thread.id, chapter, topic, at });
  }

  /**
   * 器を1つ会話へ積んで配る（ADR-0017 決定78・81）。
   *
   * **器は凍る**（決定81(c)）——記録に入ったら書き換えない。ターンは回さない：
   * 器は番頭が自分で出したものなので、自分に知らせる意味が無い（`notify` との違い）。
   *
   * I2: 宛先不明を黙って捨てない。
   */
  showUtsuwa(threadId: string | undefined, utsuwa: UtsuwaView): void {
    const thread = this.threads.resolve(threadId);
    /**
     * **面への口は増やさない**（PO報告 2026-08-10）。
     *
     * 同じ面を開き直すたびに札を積むと、番頭が1回の用件で `canvas.open` を数回呼んだだけで
     * 同じ行が並ぶ（実際に5つ並んだ）。**口は「その面へ行ける」ことを言うもの**なので、
     * 同じ行き先が2つある意味がない。既に同じ口が立っているなら、記録は増やさず配信もしない。
     */
    if (utsuwa.kind === "open" && hasSameOpen(thread.transcript, utsuwa)) return;
    thread.record({ role: "utsuwa", utsuwa });
    this.broadcast({ type: "utsuwa", threadId: thread.id, utsuwa });
  }

  /** 実際に待ち受けているポート（port: 0 のとき割り当てられた値）。 */
  get port(): number {
    const address = this.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("BantoHostServer is not listening on a TCP port");
    }
    return address.port;
  }

  /**
   * サーバを止める。セッションの後始末は呼び出し側の責務。
   *
   * **必ず返る**（imp-0037 原因3）。ここは「閉じると決めた後」なので、相手の都合で
   * 待たない——実測（Node v24 / ws 8.21）で2つの無期限が居た:
   *
   * - `ws.close()` は相手の close フレームを待つ。無応答のクライアント1本で **30秒**
   * - モジュール中継の upgrade ソケットは `this.clients` に入らないので、
   *   `httpServer.close()` が **70秒待っても返らない**（＝実質無期限）
   *
   * I2: 期限を超えたことは握りつぶさず `console.error` に残し、先へ進む。
   */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribeThreads();
    for (const thread of this.threads.list()) thread.dispose();
    /**
     * **中継の socket もここで断つ。** `this.clients` は `/ws` に来たものだけで、
     * モジュールが自分で捌いた upgrade（kobo・worker-pool・環境台帳・pi）は入らない。
     * それを残したまま `httpServer.close()` を待つのが原因3の正体だった。
     *
     * `closeAllConnections()` は**まだ upgrade されていない**接続に効く。既にモジュールへ
     * 渡した socket は http サーバの管理から外れているので、こちらで覚えていた分を destroy する。
     */
    this.httpServer.closeAllConnections();
    for (const socket of this.relayed) socket.destroy();
    this.relayed.clear();
    // 待たずに断つ。close フレームの往復を待つ相手ではない（上の30秒）
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    await withDeadline(
      new Promise<void>((resolve) => this.wss.close(() => resolve())),
      WSS_CLOSE_DEADLINE_MS,
      "WebSocket サーバ"
    );
    await withDeadline(
      new Promise<void>((resolve) => this.httpServer.close(() => resolve())),
      HTTP_CLOSE_DEADLINE_MS,
      "HTTP サーバ"
    );
  }

  // ── 接続とクライアントメッセージ ───────────────────────────────────────────

  /**
   * HTTP Upgrade（WebSocket）の入口を捌く。
   *
   * - `/ws`（BANTO_WS_PATH）→ wss（Banto 自身の配信）
   * - モジュールの到達先の下 → そのモジュール（proxy exposer の中継 URL）
   * - それ以外 → 拒否して破棄。知らない upgrade を生かし続けない
   */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? "").split("?")[0] ?? "";

    // Banto 自身の配信面。ws の `path` オプションと同じ判定（クエリを外して照合する）
    if (pathname === BANTO_WS_PATH) {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
      return;
    }

    // モジュールが自分の到達先の下で upgrade を捌く（決定27・案A）。
    // HTTP の `serve` と同じく、ホストは経路を渡すだけで中身を解釈しない
    if (this.modules) {
      for (const module of this.modules.list()) {
        if (!module.endpoint.baseUrl.startsWith("/")) continue;
        const base = module.endpoint.baseUrl.replace(/\/$/, "");
        if (!(req.url ?? "").startsWith(base)) continue;
        if (module.handleUpgrade?.(req, socket, head)) {
          /**
           * **渡した socket は覚えておく**（imp-0037 原因3）。
           *
           * `upgrade` を捌かせた時点でこの socket は http サーバの管理から外れるので、
           * `closeAllConnections()` では届かない。実測でも、中継が1本あるだけで
           * `httpServer.close()` は70秒待っても返らなかった。中身はモジュールのものだが、
           * **入口を開けたのはこちら**なので、店を閉めるときに断つのはこちらの役目。
           */
          this.relayed.add(socket);
          socket.once("close", () => this.relayed.delete(socket));
          return;
        }
      }
    }

    // I2: 誰のものでもない upgrade を黙って生かし続けない。はっきり拒否して破棄する
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  private handleConnection(ws: WebSocket, req?: http.IncomingMessage): void {
    this.clients.add(ws);
    // 繋がった直後は生きているとみなす（最初の ping まで畳まれないように）
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    ws.on("close", () => this.clients.delete(ws));
    // I2: 接続エラー（不正フレーム等）を握りつぶさずログに出し、この接続だけ閉じる。
    //     ここで受けないと unhandled 'error' で Node プロセス全体が死ぬ（WS_ERR_EXPECTED_MASK 等）。
    //     terminate() は socket を即破棄し、続けて 'close' が発火して clients から外れる
    ws.on("error", (err) => {
      console.error(`[banto-host] WebSocket connection error: ${String(err)}`, err);
      ws.terminate();
    });
    ws.on("message", (data: Buffer) => void this.handleClientMessage(ws, data));

    const threads = this.threads.list();
    // 全部畳まれていることはありうる（どの会話も畳めるため）。空状態を隠さない
    const defaultThread = threads.find((t) => t.isDefault);

    // 取次は会話に紐づかないので、welcome とは別に1通で配る
    if (this.inbox) this.send(ws, { type: "inbox_state", items: this.inbox.list() });

    this.send(ws, {
      type: "welcome",
      // スレッドを知らないクライアントとの互換。扱えるクライアントは threads を見る
      ...(defaultThread ? { sessionId: defaultThread.harness.sessionId } : {}),
      threads: threads.map((t) => t.view()),
      ...(defaultThread ? { defaultThreadId: defaultThread.id } : {}),
      tools: defaultThread?.toolNames ?? [],
      catalog: (this.catalog?.list() ?? []).map((spec) => {
        const owner = this.modules?.moduleForView(spec.kind);
        return {
          kind: spec.kind,
          title: spec.title,
          description: spec.description,
          component: spec.component,
          ...(spec.category ? { category: spec.category } : {}),
          ...(spec.icon ? { icon: spec.icon } : {}),
          // 決定25: UIはここから到達先を得る。モジュール未登録のGUIは中核由来として扱う
          module: owner?.name ?? CORE_ORIGIN,
          // 中核由来のGUIは中核の Tool 面へ向ける（ADR-0011 決定42）
          endpoint: owner?.endpoint.baseUrl ?? CORE_TOOL_BASE_URL,
        };
      }),
      // GUI を持たないモジュール（設定など）にも UI が到達できるように（決定41）
      modules: (this.modules?.list() ?? []).map((m) => ({
        name: m.name,
        title: m.title,
        description: m.description,
        baseUrl: m.endpoint.baseUrl,
      })),
    });

    // **履歴は見ている会話の分だけ配る**（inc: Android/Tailscale から使えない）。
    //
    // 以前はここで全スレッドの全文を配っており、接続のたびに 9.67MB 流れていた。
    // 会話は畳まない限り増え続けるので、遅い回線では際限なく重くなる形だった。
    // 残りは POがその会話へ移ったときに `history_request` で取りに来る。
    //
    // どの会話を見ているかは `/ws?thread=<id>` で聞く——welcome を待ってから
    // 要求させると往復が1回増え、それは回線が細いほど効いてくる。
    // 知らないID・畳んだ会話を指されたら既定へ落とす（要求は信用しない）。
    const requested = req ? new URL(req.url ?? "/", "http://x").searchParams.get("thread") : null;
    const viewing =
      threads.find((t) => t.id === requested && t.state === "open") ?? defaultThread;
    if (viewing) {
      this.send(ws, { type: "history", threadId: viewing.id, entries: viewing.transcript });
    }

    // モデルとキャンバスは全スレッドぶん配る。**こちらは履歴と違って小さく**
    // （実測で合わせて 8KB 弱）、タブの見た目と復元がこれに依存している
    for (const thread of threads) {
      // その会話が使っているモデル。**会話ごと**なので1本ずつ配る（D3）
      const model = this.modelOf(thread);
      if (model) {
        this.send(ws, {
          type: "model_state",
          threadId: thread.id,
          provider: model.provider,
          id: model.id,
          vision: model.vision,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        });
      }
      // 分かっている会話だけ。まだターンが回っていなければ配らない
      const tokens = this.contextTokens.get(thread.id);
      if (tokens !== undefined) {
        this.send(ws, { type: "context_state", threadId: thread.id, tokens });
      }
      // 後から繋いだクライアントも即座に現在の表示状態に追いつく
      if (thread.canvas) {
        const snapshot = thread.canvas.snapshot();
        this.send(ws, {
          type: "canvas_state",
          threadId: thread.id,
          tabs: snapshot.tabs,
          activeTabId: snapshot.activeTabId,
        });
      }
    }
  }

  private async handleClientMessage(ws: WebSocket, data: Buffer): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString("utf-8")) as ClientMessage;
    } catch {
      // I2: 壊れたメッセージは黙って捨てず、理由を返す
      this.send(ws, { type: "error", message: "invalid JSON" });
      return;
    }
    // 既知の type を捌いたあと message は never に絞られるため、先に控えておく
    const receivedType: unknown = (message as { type?: unknown } | null)?.type;

    // 移った先の会話の履歴を配る（接続時に配らなかった分）。
    // **要求した1人にだけ返す**——他のクライアントは別の会話を見ている
    if (message?.type === "history_request") {
      const thread = this.threads.list().find((t) => t.id === message.threadId);
      if (!thread) {
        // I2: 知らない会話を空の履歴で黙って埋めない（画面が「発言なし」と誤って出る）
        this.send(ws, { type: "error", message: `unknown thread: ${message.threadId}` });
        return;
      }
      this.send(ws, { type: "history", threadId: thread.id, entries: thread.transcript });
      return;
    }

    // 枝を開く（ADR-0017 決定77）。開いても幹と他の枝は何も変わらない（決定2）。
    // **還す条件と理由は必須**——帳簿が拒むので、ここで補わない（I2）
    if (message?.type === "thread_open") {
      try {
        await this.threads.open(
          {
            kind: "branch",
            title: message.title,
            returnCondition: message.returnCondition,
            reason: message.reason,
            // POが画面から開いた（決定77：番頭の判断でも PO の指示でも開く）
            openedBy: "po",
          },
          // どの幹の枝かは**POが居た会話**で決まる（幹は複数ある）
          message.threadId
        );
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    // 枝を畳んで幹へ還す。幹は畳めない（帳簿が拒む）
    if (message?.type === "thread_merge") {
      try {
        this.threads.merge(message.threadId, message.conclusion);
      } catch (err) {
        // I2: 幹・未知のID・空の結論を黙って成功にしない
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    if (message?.type === "thread_reopen") {
      try {
        this.threads.reopen(message.threadId);
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    // POがタブから名前を付け直す（決定25 の人側）。番頭の thread.rename と同じ帳簿を通る
    if (message?.type === "thread_rename") {
      try {
        this.threads.rename(message.threadId, message.title);
      } catch (err) {
        // I2: 空の題・未知のIDを黙って成功にしない（画面は変わったつもりのまま残る）
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    // 以降は宛先スレッドが要る。threadId 省略時は既定スレッド（互換）
    let thread: Thread;
    try {
      thread = this.threads.resolve((message as { threadId?: string } | null)?.threadId);
    } catch (err) {
      // I2: 知らないIDを既定へ黙って落とさない——別の会話に発話が紛れ込む
      this.send(ws, { type: "error", message: String(err) });
      return;
    }

    // ── 取次。**会話に紐づかない**ので、スレッドの解決より先に捌く ──────────
    if (message?.type === "inbox_answer" || message?.type === "inbox_open") {
      await this.handleInbox(ws, message, thread);
      return;
    }

    /**
     * **PO がその場で章を畳む**（提案§3.2 の人側・決定25）。
     *
     * 自動で畳むのは文脈の量が閾値に達したときだけだが、**区切りは人にも分かる**
     * ——「この話は終わったので、ここから先は別の前提で進めたい」は量では拾えない。
     * 畳めたことは `onChapterClosed` が知らせとして流す（ここでは返さない）。
     */
    if (message?.type === "chapter_close") {
      // I2: 畳めない理由はその場で言う。押したのに何も起きないのが一番困る
      if (thread.state === "closed") {
        this.send(ws, {
          type: "error",
          message: `「${thread.title}」は畳んだ会話です。開き直してから区切ってください`,
        });
        return;
      }
      if (!thread.closeChapter) {
        this.send(ws, {
          type: "error",
          message:
            "この会話では章立てが働いていません（要約に使えるモデルがありません）。" +
            "設定でモデルを採用するか、BANTO_CHAPTER_MODEL を見直してください",
        });
        return;
      }
      /**
       * **喋っている最中は畳まない。** 道具を呼んでいる途中で文脈が消えると、番頭は
       * 自分が何をしていたか分からなくなる（自動の側が `agent_end` だけを見ているのと
       * 同じ理由）。待たせるのではなく断る——POは終わってから押し直せる。
       */
      if (thread.harness.isStreaming) {
        this.send(ws, {
          type: "error",
          message: "番頭が喋っている最中は区切れません。返事が終わってから押してください",
        });
        return;
      }
      try {
        // I2: **何も起きなかったことを黙らせない**（PO報告 2026-08-11）。まだ溜まって
        //     いない章・既に畳んでいる最中は畳みようがないが、押した側には見えない
        const folded = await thread.closeChapter();
        if (!folded) {
          this.send(ws, {
            type: "error",
            message:
              "畳むものがまだありません（この章にはやり取りが溜まっていないか、いま畳んでいる最中です）",
          });
        }
      } catch (err) {
        // I2: 資料が書けなければ畳まない（ChapterKeeper の決め）。その理由をそのまま出す
        this.send(ws, { type: "error", message: `章を畳めませんでした: ${String(err)}` });
      }
      return;
    }
    // その会話で使うモデルを変える。**会話ごと**なので、他の会話は変わらない
    if (message?.type === "set_model") {
      if (!this.selectModel) {
        this.send(ws, { type: "error", message: "このホストはモデルの切替に対応していません" });
        return;
      }
      try {
        const thinking = typeof message.thinking === "string" ? message.thinking : "";
        const next = await this.selectModel(
          thread,
          message.provider,
          message.model,
          message.backend,
          thinking
        );
        // バックエンドごと変わったなら、会話のハーネスを差し替える（購読も張り直す）
        if (next.harness && next.harness !== thread.harness) {
          thread.replaceHarness(next.harness, (event) => this.handleHarnessEvent(thread, event));
        }
        thread.model = {
          ...(next.backend ? { backend: next.backend } : {}),
          provider: message.provider,
          id: next.id,
          vision: next.vision,
          ...(thinking ? { thinking } : {}),
          ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
        };
        // **前のモデルで測った文脈長は捨てる**——別のモデルの分母を使い回さない。
        // 次のターンが終われば、新しいハーネスが測った値がまた入る
        this.measuredWindow.delete(thread.id);
        this.threads.persistIndex(thread);
        // 選んだ本人だけでなく全員へ。複数の画面で同じ会話を見ている（D3）
        this.broadcast({
          type: "model_state",
          threadId: thread.id,
          ...(next.backend ? { backend: next.backend } : {}),
          provider: message.provider,
          id: next.id,
          vision: next.vision,
          ...(thinking ? { thinking } : {}),
          ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
        });
      } catch (err) {
        // I2: 切り替わらなかったことを黙らない。画面は前のモデルのままになる
        this.send(ws, { type: "error", message: `モデルを変えられません: ${String(err)}` });
      }
      return;
    }

    if (message?.type === "abort") {
      /**
       * **止めるのは「こちらが話す」ため**（imp-0048）。場を先に取ってから止める
       * ——`abort()` は待っている `prompt()` を放し、その続きが**同じマイクロタスクの
       * 波で**次の知らせを走らせる。await の後に取ったのでは間に合わない。
       */
      thread.takeFloorForPo(this.poFloorHoldMs);
      await thread.harness.abort();
      return;
    }

    // POが直接キャンバスを操作する経路。番頭が canvas.* を呼んだときと同じく Canvas を
    // 通すので、表示状態の真実は一箇所のまま（D3）——UIが独自のタブ状態を持つことはない。
    // 決定25「人がGUIでできることは番頭にもできる。ただし経路が異なる」の人側。
    if (
      message?.type === "canvas_switch" ||
      message?.type === "canvas_close" ||
      message?.type === "canvas_reorder" ||
      message?.type === "canvas_open"
    ) {
      const canvas = thread.canvas;
      if (!canvas) {
        this.send(ws, { type: "error", message: "canvas is not enabled on this host" });
        return;
      }
      try {
        if (message.type === "canvas_switch") canvas.switchTo(message.tabId);
        else if (message.type === "canvas_close") canvas.close(message.tabId);
        else if (message.type === "canvas_reorder") canvas.reorder(message.tabId, message.toIndex);
        else {
          const tab = canvas.open(message.kind, message.params ?? {}, message.title, {
            ...(message.newTab === true ? { newTab: true } : {}),
          });
          // **開いた面は会話に残す**（決定78 の「面への口」）。番頭が開いたときと同じ形
          // ——POが自分で開いた面も、あとから遡って開き直せる（決定25：経路が違うだけ）
          const spec = this.catalog?.get(tab.kind);
          this.showUtsuwa(
            thread.id,
            openUtsuwa({
              view: tab.kind,
              label: tab.title,
              ...(spec?.description ? { meta: spec.description } : {}),
              args: tab.params,
            })
          );
        }
      } catch (err) {
        // I2: 未知のタブID・未知のkindは黙って無視せず理由を返す
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    if (message?.type === "prompt") {
      /**
       * **畳んだ会話には話しかけられない**（PO報告 2026-08-10）。
       *
       * 枝を畳んだのに入力欄が生きていると、還したはずの話が続き、幹に還した結論と
       * 食い違う（実際に踏んだ）。**知らせは届く**（決定35b）ので、そちらは止めない。
       * I2: 黙って捨てず、開き直せることまで言う。
       */
      if (thread.state === "closed") {
        this.send(ws, {
          type: "error",
          message:
            thread.kind === "branch"
              ? `枝「${thread.title}」は畳みました（結論：${thread.conclusion ?? "—"}）。` +
                "続けるなら履歴から開き直してください"
              : `幹「${thread.title}」は終えました。続けるなら履歴から開き直してください`,
        });
        return;
      }
      if (
        typeof message.text !== "string" ||
        (message.text.length === 0 && (!message.attachments || message.attachments.length === 0))
      ) {
        this.send(ws, {
          type: "error",
          message: "prompt requires a non-empty text or an attachment",
        });
        return;
      }

      // 添付の扱い。画像はモデルへ直接渡し、テキストファイルは work/attachments/ に
      // 保存して file.read で読めるようにする（パス注釈をプロンプトに追記）。
      // I2: 非対応モデルへの画像は握りつぶさず、理由を返して prompt 自体を処理しない
      let text = message.text;
      const images: HarnessImage[] = [];
      // 会話に残す添付。**中身ではなく保存先だけ**を持つ（TranscriptAttachment）
      const recorded: TranscriptAttachment[] = [];
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          if (attachment.kind === "image") {
            // **その会話のモデル**で判定する（会話ごとに違う。未設定なら番頭の標準）
            const active = thread.model ?? this.hostDefaultModel();
            if (!active?.vision) {
              this.send(ws, {
                type: "error",
                message: `${active?.id ?? "現在のモデル"} は画像非対応です`,
              });
              return;
            }
            images.push({
              type: "image",
              data: attachment.dataBase64,
              mimeType: attachment.mimeType,
            });
            // 送った画像は吹き出しに残す。base64 を履歴に積まないよう、ここで保存して参照にする
            const savedName = this.saveAttachment(
              attachment.name,
              Buffer.from(attachment.dataBase64, "base64")
            );
            recorded.push({
              kind: "image",
              name: attachment.name,
              url: ATTACHMENT_URL_BASE + savedName,
              mimeType: attachment.mimeType,
            });
          } else {
            const savedName = this.saveAttachment(attachment.name, attachment.content);
            text += `\n\n[添付] ${ATTACHMENT_DIR_REL}/${savedName}（file.read で参照可）`;
            recorded.push({
              kind: "file",
              name: attachment.name,
              url: ATTACHMENT_URL_BASE + savedName,
            });
          }
        }
      }

      // 発話も履歴の一部。送った本人以外にも配る（複数クライアントで会話が揃う）。
      // 添付のみで本文が空のときは、空バブルでなく何を添付したか分かる文言で載せる
      const displayText =
        message.text.length > 0
          ? message.text
          : `[${message.attachments
              ?.map((a) => (a.kind === "image" ? "画像" : "ファイル"))
              .join("・") ?? "添付"}を添付]`;
      const withAttachments = recorded.length > 0 ? { attachments: recorded } : {};
      /**
       * **「止めて話す」**（imp-0048・提案 §4 案I）。
       *
       * 走行中に送ると既定では**いまのターンに融合**する（`steer`）。割り込んで先に
       * 答えさせたいときは、止めてから新しいターンで話す。**どちらにするかの判断は
       * ここが持つ**（D5）——画面が `abort` と `prompt` を別々に送ると、届く順や
       * 中断が効くまでの間で「融合した／しなかった」が変わる。
       */
      if (message.interrupt === true) {
        thread.takeFloorForPo(this.poFloorHoldMs);
        await thread.harness.abort();
      }
      /**
       * **場は取らない——返すだけ**（imp-0048）。
       *
       * 取るのは中断したときだけ（`abort` と `interrupt`）。走っているターンへ普通に
       * 足したときまで知らせを止めると、**PO が話している間ずっと職人の報告が止まる**
       * ——直したいのは「止めたのに、話す前に塞がる」であって、知らせを溜めることではない。
       *
       * 中断で取った場は**この発話が引き受ける**（`claimFloor`）。引き受けた者だけが
       * 返せる——中断は走っていたターンを終わらせるので、そのターンを持っていた
       * 発話の `finally` がここより先に走る。札で縛らないと、取ったばかりの場を
       * その古い `finally` が返してしまい、知らせが走り出して幹がまた塞がる。
       */
      const floor = thread.claimFloor();
      // 記録と配信で同じ時刻を使う（task-0279）——発話が積まれた瞬間を1つ作り、両方に載せる
      const at = new Date().toISOString();
      thread.record({ role: "po", text: displayText, ...withAttachments, at });
      this.broadcast({
        type: "po_message",
        threadId: thread.id,
        text: displayText,
        ...withAttachments,
        at,
      });
      // T1: ターン1本を台帳へ書く口（PO の発話＝ source "po"）
      let turnStartedAt = 0;
      let logged = false;
      const logTurn = (ok: boolean, errorMessage?: string): void => {
        if (logged) return;
        logged = true;
        this.recordTurn(thread, "po", turnStartedAt, ok, errorMessage);
      };
      /**
       * **畳んでいるなら、ここで待つ**（imp-0052）。
       *
       * 待つのは**発話を記録して配った後・`turn_start` の前**。記録より前で待つと
       * PO の言葉が30秒だけ画面から消えて「届かなかった」に見え、`turn_start` より後で
       * 待つと、まだ始まっていないターンが30秒「回答中」に見える。
       */
      await this.holdWhileClosingChapter(thread, true);
      turnStartedAt = Date.now(); // T1: 開始時刻は turn_start の直前（実測の起点）
      this.broadcast({ type: "turn_start", threadId: thread.id });

      try {
        // ストリーミング中の追加入力は steer として積む（pi の既定では例外になるため）
        await this.promptEvenWhileBusy(thread, text, {
          ...(images.length > 0 ? { images } : {}),
        });
      } catch (err) {
        // I2: ターンの失敗はクライアントへ伝える。握りつぶすと会話が無応答に見える
        thread.record({ role: "error", text: String(err) });
        logTurn(false, String(err));
        this.broadcast({ type: "turn_end", threadId: thread.id, errorMessage: String(err) });
        return;
      } finally {
        // 引き受けた場は、PO が話し終えたここで返す。待たせていた知らせが流れ出す
        if (floor !== undefined) thread.releaseFloor(floor);
      }
      const lastError = thread.getLastError();
      if (lastError) thread.record({ role: "error", text: lastError });
      logTurn(lastError === undefined, lastError);
      this.broadcast({
        type: "turn_end",
        threadId: thread.id,
        ...(lastError ? { errorMessage: lastError } : {}),
      });
      return;
    }

    this.send(ws, { type: "error", message: `unknown message type: ${String(receivedType)}` });
  }

  /**
   * 添付を `work/attachments/` に保存し、保存名を返す。テキストは文字列、画像は
   * バイト列（base64 を戻したもの）で渡す。
   *
   * **ファイル名はクライアント由来なので信頼しない**——パス区切りや `..` を剥がして
   * ベース名だけにし、タイムスタンプを前置きして衝突を避ける（I1：ずるは不可能にする）。
   * 既存の file.read と同じワークスペースのルート配下に置くので、番頭が読める。
   */
  private saveAttachment(originalName: string, content: string | Buffer): string {
    const base = path
      .basename(originalName)
      .replace(/[^\w.()\-\u3000-\u9fff\uff00-\uffef]/g, "_")
      .slice(0, 120);
    const name = `${Date.now()}-${base.length > 0 ? base : "attachment"}`;
    const dir = path.join(workspaceRoot(), ATTACHMENT_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
    return name;
  }

  /**
   * wire名を論理名へ戻す（決定22）。番頭・クライアント側は常に論理名で扱う。
   * 逆引きできない名前（pi 組み込み等、名前空間規則に従わないもの）はそのまま通す。
   */
  private toLogicalName(wireName: string): string {
    try {
      return fromWireToolName(wireName);
    } catch {
      return wireName;
    }
  }

  /**
   * ハーネスの出来事を受けて、履歴へ積み・配信する（ADR-0020 決定89）。
   *
   * **翻訳はもうここに無い。** 生のイベントを解釈していたのはバックエンド依存の仕事で、
   * ハーネスの内側へ下ろした。ここに残るのは番頭の仕事——宛先（threadId）を付け、
   * 大きすぎる中身を切り詰め（決定81）、履歴に残し、配る。
   */
  private handleHarnessEvent(thread: Thread, event: HarnessEvent): void {
    // 文脈長は**ターンが終わって初めて分かる**（Agent SDK の `result` に載る）。
    // 分かった時点で配り直さないと、目盛りは次に画面を開き直すまで出ない（task-0150）
    if (event.type === "turn_end") this.noteContextWindow(thread);
    const translated = this.toServerEvent(thread, event);
    if (!translated) return;

    // 配信すると同時に**そのスレッドの**履歴へ積む（リロード後に同じ内容が再現される）
    if (translated.type === "notice") {
      // まとめ直しの知らせ。**履歴にも残す**——再読み込みしたときに「なぜ番頭が
      // 前の話を覚えていないのか」が分からなくなる
      thread.record({ role: "notice", source: translated.source, text: translated.text });
      // 記録と配信で同じ時刻を使う（task-0279）——帳簿（recordInner）が確定させた at を
      // そのまま配信へ乗せる。リロード前の即時表示にも時刻が出る
      translated.at = thread.transcript[thread.transcript.length - 1]?.at;
    } else if (translated.type === "text_delta") {
      thread.record({ role: "banto", text: translated.delta });
      // 発話（連続する差分の1本）の最初の差分だけ at を持つ——継ぎ足しは帳簿側が
      // 元の at を保つので、そのまま配信へ乗せれば良い（task-0279）
      translated.at = thread.transcript[thread.transcript.length - 1]?.at;
    } else if (translated.type === "reasoning_delta") {
      thread.record({ role: "reasoning", text: translated.delta });
    } else if (translated.type === "reasoning_end") {
      // 本文は足さず、考えていた時間だけを最後の思考へ入れる
      thread.record({ role: "reasoning", text: "", durationMs: translated.durationMs });
    } else if (translated.type === "tool_start") {
      thread.record({
        role: "tool",
        name: translated.name,
        state: "running",
        ...(translated.input !== undefined ? { input: translated.input } : {}),
      });
    } else if (translated.type === "tool_end") {
      thread.record({
        role: "tool",
        name: translated.name,
        state: translated.isError ? "failed" : "ok",
        ...(translated.output !== undefined ? { output: translated.output } : {}),
      });
    }
    this.broadcast(translated);
  }

  /**
   * ハーネスの語彙（`HarnessEvent`）を Banto のプロトコル（`ServerEvent`）へ写す。
   *
   * **バックエンド依存の解釈はここに無い**（ADR-0020 決定89）。残っているのは
   * 番頭の仕事だけ——宛先を付ける、中身を切り詰める（決定81 `TOOL_PAYLOAD_MAX_CHARS`）、
   * 文脈の使用量を覚える。対象外は undefined（そのまま捨てる）。
   */
  private toServerEvent(thread: Thread, event: HarnessEvent): ServerEvent | undefined {
    switch (event.type) {
      case "text_delta":
        return { type: "text_delta", threadId: thread.id, delta: event.delta };
      case "reasoning_delta":
        return { type: "reasoning_delta", threadId: thread.id, delta: event.delta };
      case "reasoning_end":
        return { type: "reasoning_end", threadId: thread.id, durationMs: event.durationMs };
      case "notice":
        return { type: "notice", threadId: thread.id, source: event.source, text: event.text };
      case "turn_end": {
        // そのターンで運んだ量＝次に運ぶ量の目安。分かったときだけ画面へ出す
        if (event.contextTokens === undefined || event.contextTokens <= 0) return undefined;
        this.contextTokens.set(thread.id, event.contextTokens);
        return { type: "context_state", threadId: thread.id, tokens: event.contextTokens };
      }
      case "run_end":
        // 章を閉じるかの判定は ChapterKeeper が同じ出来事を購読して行う。画面には出さない
        return undefined;
      case "tool_start": {
        const input = clampToolPayload(event.input);
        return {
          type: "tool_start",
          threadId: thread.id,
          toolCallId: event.toolCallId,
          name: event.name,
          ...(input !== undefined ? { input } : {}),
        };
      }
      case "tool_end": {
        const output = clampToolPayload(event.output);
        return {
          type: "tool_end",
          threadId: thread.id,
          toolCallId: event.toolCallId,
          name: event.name,
          isError: event.isError,
          ...(output !== undefined ? { output } : {}),
        };
      }
    }
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  /**
   * 取次の一通を開く／答える。
   *
   * **会話と面を同時に動かす**のが取次の要点なので、両方ここで動かす——画面が2回に
   * 分けて操作すると、片方だけ動いた状態が一瞬見える。
   *
   * 答えたことは**番頭にも伝える**（会話へ知らせを差し込む）。伝えないと、番頭は
   * 自分が積んだ判断がまだ待っていると思い込んで、同じことをもう一度訊いてくる。
   */
  private async handleInbox(
    ws: WebSocket,
    message: { type: "inbox_answer" | "inbox_open"; itemId: string; actionId?: string },
    fallbackThread: Thread
  ): Promise<void> {
    if (!this.inbox) {
      this.send(ws, { type: "error", message: "このホストは取次を持っていません" });
      return;
    }
    const item = this.inbox.get(message.itemId);
    // I2: 知らない id を黙って捨てない
    if (!item) {
      this.send(ws, { type: "error", message: `取次に "${message.itemId}" という一通はありません` });
      return;
    }

    // 開く先。会話が指定されていればそこへ、面が指定されていればその会話のキャンバスへ
    const target = item.opens?.threadId ? this.threads.get(item.opens.threadId) : undefined;
    const thread = target ?? fallbackThread;
    if (item.opens?.canvas) {
      try {
        thread.canvas?.open(
          item.opens.canvas.kind,
          item.opens.canvas.params ?? {},
          item.opens.canvas.title
        );
      } catch (err) {
        // I2: 面が開けなかったことは伝える。ただし答えそのものは通す
        this.send(ws, { type: "error", message: `面を開けません: ${String(err)}` });
      }
    }

    if (message.type === "inbox_open") return;

    const action = item.actions.find((a) => a.id === message.actionId);
    // I2: 知らない選択肢はここで断る（Inbox.resolve も断るが、先に効果を走らせないため）
    if (!action) {
      this.send(ws, {
        type: "error",
        message:
          `"${message.actionId ?? ""}" は「${item.title}」の選択肢にありません` +
          `（${item.actions.map((a) => a.id).join(" / ")}）`,
      });
      return;
    }

    /**
     * 押されたことを**先に効かせる**（決定73）。
     *
     * I2: 効かせられなかったら畳まない。「許した」と記録が残るのに書けないままなのが
     * 一番たちが悪い——札は判断待ちのまま残り、POはもう一度押せる。
     */
    let effectText: string | undefined;
    if (action.effect) {
      if (!this.runInboxEffect) {
        this.send(ws, {
          type: "error",
          message: `この選択肢は処理を伴いますが、このホストは実行の口を持っていません（${action.effect.module}.${action.effect.tool}）`,
        });
        return;
      }
      try {
        effectText = await this.runInboxEffect(action.effect, {
          itemId: item.id,
          actionId: action.id,
        });
      } catch (err) {
        this.send(ws, { type: "error", message: `「${action.label}」を実行できません: ${String(err)}` });
        return;
      }
    }

    let answered: InboxItem;
    try {
      answered = this.inbox.resolve(item.id, action.id);
    } catch (err) {
      this.send(ws, { type: "error", message: String(err) });
      return;
    }

    /**
     * **知らせ（`notice: true`・決定109）はここで止める**（PO裁定 2026-08-14）。
     *
     * 結末は既に出ていて番頭にできることは無いのに、畳んだ枝のハーネスへ知らせを
     * 入れると1ターン無意味に回ってしまう。それだけでなく、読みに行くたび枝へ発話が
     * 増えては「結論は凍る」という ADR-0022 の前提が崩れる——履歴・幹の面で結末を
     * 読ませるのがこの ADR の狙いなので、読むたび中身が変わるのは本末転倒。
     *
     * `notify` 自体（決定35b：畳んだスレッドにも知らせは届く）は変えない——ここで
     * 止めるのは、取次の notice に答えたこの経路だけ。答えは `inbox.resolve` で
     * 記録済みなので、記録だけして終わる。
     */
    if (answered.notice) return;

    /**
     * 番頭へ。**POが決めたという事実**だけを渡し、解釈は番頭に任せる（D5）。
     *
     * `notify` で入れるので、記録に残り**ターンが回る**（決定73）——broadcast だけだと
     * 画面には出るが番頭は何も知らず、POは「押したのに進まない」を見ることになる
     * （実際にそうなっていた）。宛先はその一通が指す会話。
     */
    const text =
      `取次「${answered.title}」に PO が答えました：**${action.label}**\n` +
      `（求めていた判断：${answered.ask}）` +
      (effectText ? `\n結果：${effectText}` : "") +
      "\n\nこの答えを踏まえて、待っていた作業を続けてください。";
    /**
     * 待たない：ターンの完走を待つとボタンの反応が返らない。失敗は notify 側が記録する。
     *
     * **`conversation` を立てる**（T3）：`notify` で入れてはいるが、喋っているのは
     * PO 本人である。用件の枝へ回すと、PO は自分が押したボタンの続きを別の会話で
     * 探すことになる——幹を空けておく話とは無関係な一通。
     */
    void this.notify(text, {
      threadId: thread.id,
      source: answered.source.id,
      conversation: true,
    }).catch((err) => {
      this.send(ws, { type: "error", message: `番頭へ答えを伝えられません: ${String(err)}` });
    });
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

/**
 * 「まだ前のターンを処理している」という返事か（PO報告 2026-08-11）。
 *
 * ハーネスごとに文面が違いうるので、**言い回しではなく意味で拾う**。取りこぼしても
 * 従来どおり失敗するだけで、余計に拾っても steer として積み直すだけ——どちらに転んでも
 * 「PO の言葉が消える」ことにはならない側へ倒す。
 */
function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already processing|in progress|steer\(\)|busy/iu.test(message);
}

/**
 * **用件の枝**の作り（T3）。題・還す条件・理由を鍵から機械的に作る。
 *
 * 番頭が手で開く枝と同じ経路（`ThreadRegistry.open`）を通す——別口を作ると、幹の札・
 * 保存・レールの扱いが二重になる。`openedBy` は `banto`：PO の指示ではなく、番頭の側の
 * 都合（幹を空けておく）で開いた枝だから。
 */
function subjectBranchSpec(subject: NoticeSubject): ThreadSpec {
  return {
    kind: "branch",
    title: subject.label,
    returnCondition: `${subject.label} の件が終わったら、結論を1行で幹へ還す`,
    openedBy: "banto",
    reason: `${subject.label} の知らせを幹ではなくここで捌くため、機構が開きました（T3）`,
    subjectKey: subject.key,
  };
}

/**
 * **その1件だけの枝**の作り（T3・PO 指示 2026-08-15）。
 *
 * 鍵が割り出せない知らせ（system の再起動通知など）は、続きが来ても同じ枝へ結びつけ
 * ようが無い＝1件で終わる用件である。だから**常設の落ち先は作らない**——1本に積み続けると
 * 古い文脈を抱えたまま次の知らせに対応することになり、PO が名指しで否定した形へ戻る。
 *
 * 題は知らせの見出し（1行目）。**鍵は持たせない**ので、次の鍵無しの知らせは別の枝になる。
 */
function oneShotBranchSpec(text: string): ThreadSpec {
  const headline = text.split("\n", 1)[0]?.trim();
  const title = headline && headline.length > 0 ? headline : "宛先のない知らせ";
  return {
    kind: "branch",
    title,
    returnCondition: "この知らせを捌いたら、結論を1行で幹へ還す",
    openedBy: "banto",
    reason: `鍵の割り出せない知らせ1件のために機構が開きました（T3）：${title}`,
  };
}

/**
 * **畳んでよいと分かる印**を知らせの末尾に添える（T3）。
 *
 * 機構は枝を勝手に畳まない——畳むときの1行は結論であり、機構が書けば**結論の捏造**に
 * なる。代わりに「もう続きは来ない」と機構が言い切れるときだけ、そう伝える。
 *
 * - 鍵があるもの: その鍵が終端に達した知らせ（職人が落ちた・タスクがマージされた・
 *   環境が畳まれた）だけ。**1件捌くたびには添えない**——次の完了報告が「自分の答えを
 *   知らない枝」に入るため
 * - 鍵が無いもの: その1件で終わる用件なので、必ず添える
 */
function appendCloseHint(text: string, subject: NoticeSubject | undefined): string {
  if (subject && subject.terminal !== true) return text;
  const what = subject ? `「${subject.label}」の最後の知らせです` : "この1件で終わる知らせです";
  return `${text}\n\n---\nこれは${what}。捌き終えたら \`thread.merge\` でこの枝を畳み、結論を1行で幹へ還してください（T3）。`;
}
