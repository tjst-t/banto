/**
 * 番頭ホストの WS プロトコル（task-0009）。
 *
 * Kobo が「HTTP＋WS、GUI/CLI はその同格クライアント」という形をとるのに合わせ、
 * Banto も同じ形にする。CLI も WebUI もこの1つの契約にぶら下がる。
 *
 * 番頭側は常に**論理名**（`kobo.query.ready` 等）で通知する。wire名（`kobo__query__ready`）は
 * プロバイダとの境界に閉じ、クライアントには漏らさない（ADR-0010 決定22）。
 *
 * **会話スレッド（番頭の分身。ADR-0010 決定2・task-0035）**：ホストは会話を複数持つ。
 * クライアント → サーバのメッセージは `threadId` で宛先を指す。**省略時は既定スレッド**
 * ——スレッドを知らない既存クライアントがそのまま動くようにするため。
 * サーバ → クライアントのイベントには常に `threadId` が載るので、1つの接続で
 * 複数スレッドを同時に描ける（タブ表示はこれで成り立つ）。
 *
 * D6: 型定義のみ。依存なし。
 */

// ── Client → Server ──────────────────────────────────────────────────────────

/**
 * 宛先のスレッド。**省略時は既定スレッド**（スレッドを知らないクライアントとの互換）。
 */
export interface ThreadTarget {
  threadId?: string;
}

/**
 * チャットに添付されたファイル。
 *
 * - `image`: モデルへ直接渡す（vision 対応モデルのみ。base64 は `data:` を除いた実データ）。
 * - `file`: テキストファイル。内容をそのまま載せ、ホストが `work/attachments/` に保存して
 *   `file.read` で読めるようにする。
 */
export type Attachment =
  | { kind: "image"; name: string; mimeType: string; dataBase64: string }
  | { kind: "file"; name: string; content: string };

/** 番頭に発話する。ターンが走り、結果はイベントとして返る。 */
export interface PromptMessage extends ThreadTarget {
  type: "prompt";
  text: string;
  /** 添付ファイル。省略時は無し（添付を知らないクライアントとの互換）。 */
  attachments?: Attachment[];
}

/** 実行中のターンを中断する。 */
export interface AbortMessage extends ThreadTarget {
  type: "abort";
}

/**
 * この会話で使うモデルを変える。
 *
 * **会話ごとに持つ**（PO裁定 2026-08-04）。同じ番頭でも、話題ごとに向いたモデルが違う
 * ——重い設計の相談と軽い調べ物を同じモデルで続ける必要はない。選んだモデルはその会話に
 * 残り、再起動しても続く。**新しい会話は設定の「番頭の標準」から始まる**。
 */
export interface SetModelMessage extends ThreadTarget {
  type: "set_model";
  provider: string;
  model: string;
}

/** POが直接タブを切り替える。番頭の canvas.switch と同じ結果になる。 */
export interface CanvasSwitchMessage extends ThreadTarget {
  type: "canvas_switch";
  tabId: string;
}

/** POが直接タブを閉じる。 */
export interface CanvasCloseMessage extends ThreadTarget {
  type: "canvas_close";
  tabId: string;
}

/** POがタブをドラッグして並べ替える。 */
export interface CanvasReorderMessage extends ThreadTarget {
  type: "canvas_reorder";
  tabId: string;
  toIndex: number;
}

/**
 * POがカタログから自分でGUIを開く。番頭の canvas.open と同じ結果になる。
 * 決定25「人がGUIでできることは番頭にもできる。ただし経路が異なる」の人側。
 */
export interface CanvasOpenMessage extends ThreadTarget {
  type: "canvas_open";
  kind: string;
  params?: Record<string, unknown>;
  title?: string;
  newTab?: boolean;
}

/**
 * いまの会話を畳んで、新しい会話を始める（＝置き換え）。
 *
 * **畳むだけで消さない**（PO要望 2026-07-31）。以前は会話を捨てていたため、あとから
 * 見返すことも再開することもできなかった——決定30c で「畳んでも記録は残る」に揃えた以上、
 * ここだけ黙って消えるのは筋が通らない。畳んだ会話は履歴に並び、再開できる。
 *
 * `thread_open` との違いは**いまの会話を畳むかどうか**だけ：
 * - `thread_open`：会話を増やす（いまの会話は開いたまま並行する）
 * - `new_session`：いまの話は切り上げて、新しく始める（タブの本数は変わらない）
 */
export interface NewSessionMessage extends ThreadTarget {
  type: "new_session";
}

/**
 * 新しい会話スレッドを開く（番頭の分身。決定2）。
 *
 * **既存のスレッドは何も変わらない**——会話もキャンバスもそのまま残る
 * （「目の前の話は壊れない」）。
 */
export interface ThreadOpenMessage {
  type: "thread_open";
  title?: string;
}

/**
 * スレッドを畳む。**消えない**——タブから外れて履歴へ移るだけ。
 * 既定スレッドは畳めない（会話の宛先が無くなるため）。
 */
export interface ThreadCloseMessage {
  type: "thread_close";
  threadId: string;
}

/** 畳んだスレッドを開き直す。会話はそのまま残っているので続きから話せる。 */
export interface ThreadReopenMessage {
  type: "thread_reopen";
  threadId: string;
}

/**
 * 会話に名前を付け直す（PO要望 2026-08-05）。番頭の `thread.rename` と同じ結果になる
 * ——決定25「人がGUIでできることは番頭にもできる。ただし経路が異なる」の人側。
 *
 * **番頭と違い、どの会話でも指せる**。POはタブを右クリックして選ぶので、
 * 「いま見ている会話」とは限らない。
 */
export interface ThreadRenameMessage {
  type: "thread_rename";
  threadId: string;
  title: string;
}

export type ClientMessage =
  | PromptMessage
  | AbortMessage
  | CanvasSwitchMessage
  | CanvasCloseMessage
  | CanvasReorderMessage
  | CanvasOpenMessage
  | NewSessionMessage
  | ThreadOpenMessage
  | ThreadCloseMessage
  | ThreadReopenMessage
  | ThreadRenameMessage
  | SetModelMessage;

// ── Server → Client ──────────────────────────────────────────────────────────

/**
 * どのスレッドの出来事か。**サーバ→クライアントでは常に載る**（省略しない）。
 * クライアントは自分が描いているスレッドの分だけ拾えばよい。
 */
export interface ThreadScope {
  threadId: string;
}

/** キャンバスに開けるGUIのカタログエントリ（UIがコンポーネントを解決するのに使う）。 */
export interface CatalogEntryView {
  kind: string;
  title: string;
  description: string;
  /** 描画する React コンポーネントのエクスポート名（決定17・決定12）。 */
  component: string;
  category?: string;
  icon?: string;
  /** このGUIを提供しているモジュール名（決定25・27）。 */
  module: string;
  /**
   * そのモジュールへの到達先（決定25）。UI はここからデータを取りに行く——
   * コンポーネント側にエンドポイントを直書きしない。組み込みモジュールは
   * `/api/...` のような相対パスで、UI が自分のオリジンに解決する。
   */
  endpoint: string;
}

/** 会話スレッド1本の姿（タブの1つ）。 */
export interface ThreadView {
  threadId: string;
  title: string;
  /** ハーネス側のセッションID。デバッグと突き合わせ用。 */
  sessionId: string;
  /** 既定スレッド（threadId 省略時の宛先）。閉じられない。 */
  isDefault: boolean;
  /**
   * 畳んだスレッドは消えない（決定30c と同じ扱い）。タブから外れて履歴へ移るだけで、
   * `thread_reopen` で同じ会話の続きから話せる。
   */
  state: "open" | "closed";
  /** 畳んだ時刻（state が closed のとき）。 */
  closedAt?: string;
  /** この会話で使っているモデル。会話ごとに持つ（未設定なら番頭の標準）。 */
  model?: { provider: string; id: string; vision: boolean; contextWindow?: number };
  /**
   * いま番頭が喋っている最中か。
   *
   * **忙しさの真実はホストが持つ**（D3）。UI が「自分が送ったから忙しいはず」と推測すると、
   * 職人の報告で番頭が喋り出したターン（決定29・35）を取りこぼし、中断する手段が
   * 画面から消える——実際にその不具合を踏んだ。再接続したクライアントもここを見る。
   */
  streaming: boolean;
}

/** 接続直後に1度だけ送られる。 */
export interface WelcomeEvent {
  type: "welcome";
  /**
   * 既定スレッドのセッションID。**スレッドを知らないクライアントとの互換**のために残す
   * ——スレッドを扱うクライアントは `threads` を見ること。
   * 開いている会話が1本も無ければ undefined（空状態）。
   */
  sessionId?: string;
  /** スレッドの一覧（畳んだものも含む。決定2）。 */
  threads: ThreadView[];
  /**
   * `threadId` 省略時の宛先。**固定ではなく開いている先頭**が担う。
   * 全部畳まれていれば undefined——空状態を隠さない。
   */
  defaultThreadId?: string;
  /** 番頭が使えるToolの論理名一覧。 */
  tools: string[];
  /** キャンバスに開けるGUIの一覧。 */
  catalog: CatalogEntryView[];
  /**
   * 登録されているモジュールと到達先。
   *
   * **GUI を持たないモジュールにも届くようにするため**（決定41）。カタログは面の一覧なので、
   * キャンバスに出ないモジュール（設定など）はそこに現れない——UI が「モジュール名から
   * 到達先を引く」ための表がここ。URL を UI に直書きしないという点は決定25 のまま。
   */
  modules: ModuleEndpointView[];
}

/** モジュール1つの到達先（GUI の有無によらず全部載る）。 */
export interface ModuleEndpointView {
  name: string;
  title: string;
  description: string;
  baseUrl: string;
}

/** スレッドが増減した・名前が変わった。開閉のたびに全クライアントへ配る。 */
export interface ThreadStateEvent {
  type: "thread_state";
  threads: ThreadView[];
}

/**
 * 会話の1行。ホスト側が真実を持ち、接続時に history として丸ごと配る。
 * これによりリロードしても会話が消えず、途中から繋いだクライアントも履歴を見られる（D3）。
 */
/**
 * 知らせの出所。**POでも番頭でもない誰か**が誰なのかを表す。
 *
 * これが無いと、外から入る知らせが全部同じ札で出る——番頭が別の会話を開いたときの
 * 最初の一言まで「職人」に見えた（PO報告 2026-07-31）。出所を偽らない（I1）。
 *
 * 文字列なのは、モジュールが増えるたびに型を広げないため（Kobo 等）。
 * UI は知らない出所を素通しで表示する。
 */
export type NoticeSource =
  /** 職人（Worker Pool）からの報告・質問（決定29）。 */
  | "worker"
  /** 別の会話（分身）から渡された最初の一言（決定2・thread.open）。 */
  | "thread"
  /** 出所を名乗れないもの。既定。 */
  | "system"
  | (string & {});

/**
 * 会話に残る添付。**中身そのものは持たない**（D3）。
 *
 * 画像を base64 のまま履歴に積むと JSONL が肥大化し、再読み込みのたびに同じ塊が
 * 流れる。保存先への URL だけを持ち、実体は `GET /api/attachments/{name}` で取る。
 */
export interface TranscriptAttachment {
  kind: "image" | "file";
  /** POが選んだときのファイル名（表示用）。 */
  name: string;
  /** ホストが保存した先。`/api/attachments/...`。 */
  url: string;
  /** 画像の MIME。表示側が img で出すかの判断に使う。 */
  mimeType?: string;
}

export type TranscriptEntry =
  | { role: "po"; text: string; attachments?: TranscriptAttachment[] }
  | { role: "banto"; text: string }
  /**
   * 番頭の思考（ハーネスの thinking）。本文とは別に積む——応答と混ぜると、
   * どこまでが考えでどこからが答えなのか読めなくなる。
   * `durationMs` は考え終わったときに入る（「X秒間考えました」の表示に使う）。
   */
  | { role: "reasoning"; text: string; durationMs?: number }
  /** POでも番頭でもない知らせ（職人からの報告・質問、別の会話からの引き継ぎ等）。 */
  | { role: "notice"; source: NoticeSource; text: string }
  /**
   * ツールの呼び出し。`input`／`output` は**ハーネスが出したものをそのまま**載せる
   * （大きすぎるものは切り詰める。`TOOL_PAYLOAD_MAX_CHARS`）。
   */
  | {
      role: "tool";
      name: string;
      state: "running" | "ok" | "failed";
      input?: unknown;
      output?: unknown;
    }
  | { role: "error"; text: string };

/**
 * 会話履歴。接続直後に**スレッドごとに1通ずつ**送られる。
 * 1つの接続で複数スレッドを描けるのはこのため（タブ表示）。
 */
export interface HistoryEvent extends ThreadScope {
  type: "history";
  entries: TranscriptEntry[];
}

/**
 * 番頭への知らせが会話に入った（職人からの報告・質問など。決定29）。
 * POの発話ではないので po_message とは別にする——UIで見分けがつかないと、
 * 誰が言ったことなのか分からなくなる。
 */
export interface NoticeEvent extends ThreadScope {
  type: "notice";
  /** 誰からの知らせか。UIの札に出す（出所を偽らない・I1）。 */
  source: NoticeSource;
  text: string;
}

/** POの発話。送った本人以外のクライアントにも届く。 */
export interface PoMessageEvent extends ThreadScope {
  type: "po_message";
  text: string;
  /** 一緒に送られた添付（表示用の参照。実体は URL の先）。 */
  attachments?: TranscriptAttachment[];
}

/** アシスタント応答のテキスト差分。 */
export interface TextDeltaEvent extends ThreadScope {
  type: "text_delta";
  delta: string;
}

/**
 * 番頭の思考の差分（ハーネスの thinking_delta）。
 * 本文の差分と分けて送る——混ぜると、受け取った側で分けられなくなる。
 */
export interface ReasoningDeltaEvent extends ThreadScope {
  type: "reasoning_delta";
  delta: string;
}

/**
 * 思考の終わり。**考えていた時間はホストが測る**（D3）——クライアントは
 * 途中から繋ぐことがあり、最初の差分を見ていないと時間を出せない。
 */
export interface ReasoningEndEvent extends ThreadScope {
  type: "reasoning_end";
  durationMs: number;
}

/** Tool実行の開始。name は論理名（決定22）。 */
export interface ToolStartEvent extends ThreadScope {
  type: "tool_start";
  toolCallId: string;
  name: string;
  /** 呼び出しの引数。ハーネスが出したものをそのまま（大きすぎるものは切り詰め）。 */
  input?: unknown;
}

/** Tool実行の終了。name は論理名（決定22）。 */
export interface ToolEndEvent extends ThreadScope {
  type: "tool_end";
  toolCallId: string;
  name: string;
  isError: boolean;
  /** 実行の結果。ハーネスが出したものをそのまま（大きすぎるものは切り詰め）。 */
  output?: unknown;
}

/** ターンの終わり。クライアントは入力可能状態に戻ってよい。 */
/**
 * ターンの始まり。**PO の発話で始まったとは限らない**——職人の報告（決定29e）でも
 * 番頭は喋り出す。UI はこれを見て「中断」を出す。
 */
export interface TurnStartEvent extends ThreadScope {
  type: "turn_start";
}

export interface TurnEndEvent extends ThreadScope {
  type: "turn_end";
  /** プロバイダ側でエラーが起きた場合の説明。正常時は undefined。 */
  errorMessage?: string;
}

/** キャンバスに開かれているタブ（表示状態の配信用）。 */
export interface CanvasTabView {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown>;
  /** 内容の版。タブを使い回して開き直すたびに増える（UIの描画キーに含める）。 */
  rev: number;
}

/**
 * キャンバスの表示状態。接続直後と、状態が変わるたびに送られる。
 * D3: 真実はホスト側の Canvas が持ち、UIはこれを描くだけで独自状態を持たない。
 */
export interface CanvasStateEvent extends ThreadScope {
  type: "canvas_state";
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
}

/**
 * その会話で使っているモデル。接続直後（会話ごとに1通）と、切り替わるたびに配る。
 *
 * D3: どのモデルで喋っているかの真実はホストが持つ。UI は選ばせるだけで、
 * 「選んだつもり」の状態を自分で覚えない（切替に失敗したら画面は前のまま）。
 */
export interface ModelStateEvent extends ThreadScope {
  type: "model_state";
  provider: string;
  /** モデル ID（表示にも使う）。 */
  id: string;
  /** 画像を読めるか。添付の可否判定に使う。 */
  vision: boolean;
  /** 文脈に入る最大トークン数。分かるときだけ載る（使用量の分母になる）。 */
  contextWindow?: number;
}

/**
 * その会話がいま文脈をどれだけ使っているか。
 *
 * **実測だけを出す**（I1）——ハーネスが返したトークン数をそのまま配り、こちらで
 * 推定しない。ターンが1度も回っていない会話や、再起動直後はまだ分からないので
 * 何も配らない（「0%」と偽らない）。
 */
export interface ContextStateEvent extends ThreadScope {
  type: "context_state";
  /** 直近のターンで運んだトークン数（入力＋キャッシュ＋出力）。 */
  tokens: number;
}

/** プロトコル違反・処理不能。I2: 黙って捨てずクライアントへ返す。 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ServerEvent =
  | WelcomeEvent
  | ThreadStateEvent
  | HistoryEvent
  | PoMessageEvent
  | NoticeEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ModelStateEvent
  | ContextStateEvent
  | ToolStartEvent
  | ToolEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | CanvasStateEvent
  | ErrorEvent;

/** WSのパス。Kobo（/ws）と同じ流儀。 */
export const BANTO_WS_PATH = "/ws";

/** 既定ポート。Kobo の 3000 と衝突しない値。 */
export const BANTO_DEFAULT_PORT = 4100;
