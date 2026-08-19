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
  /**
   * **止めてから話す**（imp-0048・提案 §4 案I）。
   *
   * 省略（既定）だと、走っているターンがあれば**そこへ融合する**（`steer`）
   * ——割り込んで先に答えさせるのではなく、いまの作業に足す。`true` を渡すと
   * 先にそのターンを中断してから、新しいターンとして話す。
   */
  interrupt?: boolean;
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
  /**
   * **会話を回すバックエンド**（PO裁定 2026-08-13）。provider の**上位の階層**。
   *
   * 同じ `opus` が pi（opencode zen）経由でも Claude Code 経由でも選べるので、
   * モデル名からは決まらない。省略すると、いまのバックエンドのまま。
   */
  backend?: string;
  provider: string;
  model: string;
  /** 思考レベル（2026-08-19 提案）。未指定＝サービス既定に従う（継承）。 */
  thinking?: string;
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
 * 枝を開く（ADR-0017 決定77）。**PO の指示でも番頭の判断でも開く**。
 *
 * **既存の幹・枝は何も変わらない**——会話もキャンバスもそのまま残る
 * （「目の前の話は壊れない」）。
 *
 * `returnCondition` と `reason` は**必須**。何が決まれば幹に還るかを書けないものは
 * 枝にしない（幹で話す）——ここが Slack との分岐点そのもの。
 */
export interface ThreadOpenMessage extends ThreadTarget {
  type: "thread_open";
  /**
   * どの会話から開くか。**その会話の幹が親になる**（幹は複数あるので、省くと既定の幹）。
   * 枝を指すとエラー（深さは1段）。
   */
  threadId?: string;
  title: string;
  /** 還す条件。何が決まれば幹に還るか。 */
  returnCondition: string;
  /** 開いた理由。札に出る。 */
  reason: string;
}

/**
 * 枝を畳んで幹へ還す（決定77）。**消えない**——履歴へ移り、結論1行が幹の末尾に積まれる。
 *
 * 幹は畳めない（`threadId` に幹を指すとエラー）。
 */
export interface ThreadMergeMessage {
  type: "thread_merge";
  threadId: string;
  /** 結論。**保留も結論の一種**として「保留：理由」で畳める。 */
  conclusion: string;
}

/**
 * **いま章を畳む**（提案§3.2 の人側・決定25）。
 *
 * ふだんは閾値（文脈長の割合）に達したときに自動で畳まれるが、**区切りは人にも分かる**
 * ——「この話は終わったので、ここから先は別の前提で進めたい」は閾値では拾えない。
 * 番頭の側に同じ口は無い（番頭は自分の文脈量を測って畳む側）。
 *
 * 閾値に達していなくても畳む。ただし**ターンの最中は畳まない**——道具を呼んでいる
 * 途中で文脈が消えると、番頭は自分が何をしていたか分からなくなる。
 */
export interface ChapterCloseMessage {
  type: "chapter_close";
  /** どの会話の章を畳むか。省略すると既定の宛先（幹）。 */
  threadId?: string;
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

/**
 * 取次の一通に答える（spec-design §0④）。
 *
 * **答えは番頭にも伝わる**——POが画面のボタンで決めたことを番頭が知らないと、
 * 同じことをもう一度訊いてくる。ホストが会話へ知らせを差し込む。
 */
export interface InboxAnswerMessage {
  type: "inbox_answer";
  itemId: string;
  actionId: string;
}

/**
 * 取次の一通を開く。**会話と面が同時に動く**のが取次の要点なので、
 * どちらもホスト側で動かす（画面が2回に分けて操作すると、片方だけ動いた状態が見える）。
 */
export interface InboxOpenMessage {
  type: "inbox_open";
  itemId: string;
}

/**
 * その会話の履歴を寄越せ、という要求。
 *
 * **接続時に配るのは見ている会話の分だけ**（inc: Android/Tailscale から使えない）。
 * 全スレッドの全文を配っていた頃は接続のたびに 9.67MB 流れ、遅い回線では画面が
 * 数十秒沈黙していた。他の会話は、POがそこへ移ったときに初めて取りに来る。
 *
 * 一度受け取った会話は、以後の差分がブロードキャストで届き続けるので取り直す必要はない
 * （番頭は transcript へ記録してから配るので、`history` はその時点までを必ず含む）。
 */
export interface HistoryRequestMessage {
  type: "history_request";
  threadId: string;
}

export type ClientMessage =
  | HistoryRequestMessage
  | InboxAnswerMessage
  | InboxOpenMessage
  | PromptMessage
  | AbortMessage
  | CanvasSwitchMessage
  | CanvasCloseMessage
  | CanvasReorderMessage
  | CanvasOpenMessage
  | ThreadOpenMessage
  | ThreadMergeMessage
  | ThreadReopenMessage
  | ThreadRenameMessage
  | ChapterCloseMessage
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

/** 誰が枝を開いたか（ADR-0017 決定77：番頭の判断でも PO の指示でも開く）。 */
export type BranchOpener = "banto" | "po";

/**
 * 枝から幹へ還す一言の種類（決定107）。
 *
 * **返事が要るかどうか**が分かれ目。`question` は幹の番頭に判断を求めており、
 * 枝はそれを待っている（`thread.steer` で返す）。`report` は知らせるだけで、
 * 枝はそのまま進む——受け手が読み分けられないと、問いが黙殺されるか、
 * 報告に返事を書かされるかのどちらかになる。
 */
export type BranchNoteKind = "question" | "report";

/** 会話スレッド1本の姿（幹1本と、その枝）。 */
export interface ThreadView {
  threadId: string;
  title: string;
  /**
   * 幹か枝か（ADR-0017 決定77）。**幹はプロジェクトの単位そのもの**（PO裁定 2026-08-09）
   * ——レールに並ぶ列がこれで、プロジェクトの帳簿は別に持たない（D3）。
   * 枝は還す条件を持って生まれ、畳むと結論1行がその幹に還る。
   */
  kind: "trunk" | "branch";
  /**
   * **帳場**（メインの幹。PO裁定 2026-08-10）。店にただ1つで、終えない。
   * レールの先頭に固定され、宛先の決まらない知らせはここへ来る。
   */
  isMain?: boolean;
  /** 枝の親。**常に幹**（深さは1段。枝の中に枝は作らない）。 */
  parentId?: string;
  /** 還す条件。**枝には必ずある**——書けないものは枝にしない（決定77）。 */
  returnCondition?: string;
  /** 誰が開いたか。 */
  openedBy?: BranchOpener;
  /** 開いた理由。札に必ず出す——書けないなら枝にしない、が歯止め（決定77）。 */
  openReason?: string;
  /** 畳んだときの結論（保留も結論の一種）。畳むまでは無い。 */
  conclusion?: string;
  /**
   * 畳んだときの**詳細がある**か（決定108）。中身は載せない——一覧に出るのは結論の1行で、
   * 詳細は枝を開いて（番頭なら `thread.read`）読む。
   */
  hasConclusionDetail?: boolean;
  /**
   * **未処理を抱えたまま畳んだ枝の、残作業の件数**（imp-0036）。所在が付くと消える。
   *
   * 中身は載せない——詳細と同じ扱いで、出すのは「未処理がある」という事実と件数まで。
   * 読むのは枝を開いて（番頭なら `thread.read`）から。
   */
  unsettledRemaining?: number;
  /** 未処理を降ろしたときの**所在**（起票 id・職人の sessionId・幹での委譲先）。 */
  settledWhere?: string;
  /** ハーネス側のセッションID。デバッグと突き合わせ用。 */
  sessionId: string;
  /** 既定スレッド（threadId 省略時の宛先）＝幹。 */
  isDefault: boolean;
  /**
   * 畳んだスレッドは消えない（決定30c と同じ扱い）。タブから外れて履歴へ移るだけで、
   * `thread_reopen` で同じ会話の続きから話せる。
   */
  state: "open" | "closed";
  /** 畳んだ時刻（state が closed のとき）。 */
  closedAt?: string;
  /** この会話で使っているモデル。会話ごとに持つ（未設定なら番頭の標準）。 */
  model?: { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number };
  /**
   * いま番頭が喋っている最中か。
   *
   * **忙しさの真実はホストが持つ**（D3）。UI が「自分が送ったから忙しいはず」と推測すると、
   * 職人の報告で番頭が喋り出したターン（決定29・35）を取りこぼし、中断する手段が
   * 画面から消える——実際にその不具合を踏んだ。再接続したクライアントもここを見る。
   */
  streaming: boolean;
  /**
   * 中身が分かる最初の発話の1行（履歴一覧の要約）。
   *
   * **ここに置くのは、一覧が transcript を持たずに描けるようにするため。** 接続時に
   * 配るのは見ている会話の履歴だけ（→ `HistoryRequestMessage`）なので、畳んだ会話の
   * 中身は手元に無い。要約のためだけに全文を送らせない
   */
  preview?: string;
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

/**
 * 器の役（ADR-0017 決定78）。**5役だけ**——モジュールに独自の状態名を持ち込ませない。
 * 持ち込ませると色の意味が崩れる。
 */
export type UtsuwaState = "run" | "turn" | "stop" | "warn" | "done";

/**
 * 器の語彙（ADR-0017 決定78）。**13種で打ち止め**——足すのは ADR を通す。
 *
 * `choice` だけは `canvas.show` から出せない：判断を求めるものは取次1本（決定73）で、
 * 押されたときに効く口（`InboxEffect`）を持つのは取次だけだから。画面はこの名前で
 * 取次の一通を描く（＝器の語彙としては13種）。
 */
export const UTSUWA_KINDS = [
  "list",
  "facts",
  "table",
  "diff",
  "choice",
  "stats",
  "meter",
  "spark",
  "timeline",
  "image",
  "doc",
  "quote",
  "open",
] as const;

export type UtsuwaKind = (typeof UTSUWA_KINDS)[number];

/**
 * どの器にも載る欄。
 *
 * **`at` は必須**（決定81(c)）——器は「そのときそう見えた記録」で凍るので、
 * いつの写しなのかが読めないと、いまの状態と見分けが付かない。
 */
export interface UtsuwaBase {
  /** いつの記録か。ISO8601。画面が人の単位に落とす */
  at: string;
  /** 出どころ。直せるのは登録した人なので、器にも必ず添える（決定81(d)・I2） */
  from: { module: string; tool: string; artifact: string };
  title?: string;
  /** 見出しの脇の小さい字（件数・大きさ） */
  meta?: string;
  /** 切ったこと・抜粋であることを隠さないための1行（I1） */
  note?: string;
}

/** 差分の1かたまり。 */
export interface UtsuwaHunk {
  header?: string;
  /** 行の頭（` ` 文脈 / `+` 足した / `-` 消した）と本文。 */
  lines: Array<[" " | "+" | "-", string]>;
}

/**
 * 会話に埋まる器1つ（膳＝器1つ。決定81(b)：入れ子は許さない）。
 *
 * `broken` は器ではなく**中核の振る舞い**（決定81(d)）——描けなかったことを
 * 会話に出し、番頭にも同じものを返す。
 */
export type UtsuwaView =
  | (UtsuwaBase & {
      kind: "list";
      items: Array<{ label: string; state?: UtsuwaState; meta?: string }>;
      /** 全体の件数（切って出したとき、切る前の数）。 */
      total?: number;
    })
  | (UtsuwaBase & { kind: "facts"; facts: Array<[string, string | null]> })
  | (UtsuwaBase & {
      kind: "table";
      cols: Array<{ label: string; align?: "num" }>;
      rows: Array<Array<string | number | null>>;
    })
  | (UtsuwaBase & {
      kind: "diff";
      path: string;
      added?: number;
      removed?: number;
      hunks: UtsuwaHunk[];
      truncated?: boolean;
    })
  | (UtsuwaBase & {
      kind: "choice";
      ask: string;
      /** `effect` は載せない（決定73）。画面は押されたことを投げ返すだけ。 */
      options: Array<{ id: string; label: string; tone?: "call" | "plain" | "quiet" }>;
    })
  | (UtsuwaBase & {
      kind: "stats";
      /** 値は**人の単位に落としてから**渡す（器で整形しない）。 */
      stats: Array<{ value: string; label: string; state?: UtsuwaState }>;
    })
  | (UtsuwaBase & {
      kind: "meter";
      label: string;
      value: number;
      /** 上限。分からないときはこの器を使わない——分母の無い割合は嘘になる（I1）。 */
      max: number;
      unit?: string;
      state?: UtsuwaState;
    })
  | (UtsuwaBase & {
      kind: "spark";
      label: string;
      points: number[];
      unit?: string;
      span?: string;
      /** どちらへ動けば良いか。器はこれを見て色を決める（D5）。 */
      good?: "up" | "down";
    })
  | (UtsuwaBase & {
      kind: "timeline";
      events: Array<{ at: string; label: string; state?: UtsuwaState }>;
    })
  | (UtsuwaBase & {
      kind: "image";
      /** 参照。base64 を文脈に載せない（`/api/attachments/...` 等）。 */
      src: string;
      /** 必須（I1：見えない人に「画像」とだけ出さない）。 */
      alt: string;
      w?: number;
      h?: number;
    })
  | (UtsuwaBase & {
      kind: "doc";
      excerpt: string;
      path?: string;
      truncated?: boolean;
      /** 全部を読む面への口。 */
      open?: { view: string; args?: Record<string, unknown> };
    })
  | (UtsuwaBase & { kind: "quote"; text: string; source: string; href?: string })
  | (UtsuwaBase & {
      kind: "open";
      view: string;
      label: string;
      args?: Record<string, unknown>;
    })
  | (UtsuwaBase & {
      kind: "broken";
      /** 頼まれた器の名。 */
      wanted: string;
      /** 何が足りなかったか。 */
      missing: string;
      /** 素の値。**畳んで置く**——黙って素の JSON を出さない（決定81(d)）。 */
      raw?: string;
    });

export type TranscriptEntry =
  | { role: "po"; text: string; attachments?: TranscriptAttachment[] }
  | { role: "banto"; text: string }
  /**
   * 枝の札（ADR-0017 決定77）。**写しではなく参照**なので、題も状態も生きている
   * ——画面は `branchId` から枝を引いて描く。幹に残るのはこの1行だけ。
   */
  | { role: "branch"; branchId: string }
  /**
   * 枝が幹へ還った1行（決定77）。**こちらは記録なので凍る**——畳んだ時点の結論を
   * そのまま持つ。幹は追記のみ（D3）なので、既存の行は書き換わらない。
   */
  | {
      role: "branch_result";
      branchId: string;
      title: string;
      conclusion: string;
      at: string;
      /**
       * 詳細（何を調べ・何を決め・何が残ったか）があるか（決定108）。
       * **中身は載せない**——幹に積むのは1行のままで、読むのは枝を開いてから。
       */
      hasDetail?: boolean;
    }
  /**
   * **枝から幹へ、畳む前に還した一言**（決定107）。問いか報告かを持つ。
   *
   * 知らせ（`notice`）にしないのは、枝の札・結論と**同じ列に並べる**ため——
   * 知らせで流すと他の通知に紛れ、読み返したときにどの枝の話か辿れない。
   * `branch_result` と同じく**記録なので凍る**。
   */
  | {
      role: "branch_note";
      branchId: string;
      title: string;
      kind: BranchNoteKind;
      text: string;
      at: string;
    }
  /** 番頭が器に載せた Tool の戻り値（決定78・81）。**凍る**。 */
  | { role: "utsuwa"; utsuwa: UtsuwaView }
  /**
   * **ここで章を畳んだ**という印（提案§3.2・PO要望 2026-08-11）。
   *
   * 会話の中身ではなく**区切りの目印**なので、知らせ（`notice`）ではなくこれで置く
   * ——`notice` にすると番頭のターンが回り、畳んだ直後の空の文脈で番頭が独りでに
   * 動き出す（実際にそうなっていた）。畳んだ事実は画面に出れば足り、番頭には
   * 引き継ぎ資料が章の頭に入っている。
   */
  | { role: "chapter"; chapter: number; topic: string; at: string }
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

/**
 * 番頭が器を1つ出した（ADR-0017 決定78・81）。会話へ積まれる。
 *
 * **器は凍る**ので、これ以後この器は書き換わらない——後から差分は来ない。
 */
export interface UtsuwaEvent extends ThreadScope {
  type: "utsuwa";
  utsuwa: UtsuwaView;
}

/**
 * **章を畳んだ**（提案§3.2・PO要望 2026-08-11）。会話に細い区切りの線が1本入る。
 *
 * **ターンは回らない**——`notice` で流していたときは、畳んだ直後の空の文脈で番頭が
 * 独りでに調べ物を始めていた（畳んで軽くした文脈を、その場で埋め直していた）。
 */
export interface ChapterClosedEvent extends ThreadScope {
  type: "chapter_closed";
  /** 何章目を畳んだか。 */
  chapter: number;
  /** その章が何の話だったか（引き継ぎ資料の見出し）。 */
  topic: string;
  at: string;
}

/** 枝が生まれ、幹に札が立った（決定77）。 */
export interface BranchCardEvent extends ThreadScope {
  type: "branch_card";
  branchId: string;
}

/** 枝が幹へ還った（決定77）。幹の末尾に結論1行が積まれる。 */
export interface BranchResultEvent extends ThreadScope {
  type: "branch_result";
  branchId: string;
  title: string;
  conclusion: string;
  at: string;
  /** 詳細があるか（決定108）。中身は載せない——読むのは枝を開いてから。 */
  hasDetail?: boolean;
}

/**
 * **枝から幹への相談・報告**（決定107）。幹の末尾に札が1枚立つ。
 *
 * `notice` と分けるのは、枝の札（`branch_card`）・結論（`branch_result`）と同じ列に
 * 並べるため——知らせに混ぜると、他の通知の中に紛れて辿れなくなる。
 */
export interface BranchNoteEvent extends ThreadScope {
  type: "branch_note";
  branchId: string;
  title: string;
  kind: BranchNoteKind;
  text: string;
  at: string;
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
  /** どのバックエンドで動いているか（provider の上位）。 */
  backend?: string;
  provider: string;
  /** モデル ID（表示にも使う）。 */
  id: string;
  /** 画像を読めるか。添付の可否判定に使う。 */
  vision: boolean;
  /** 思考レベル（2026-08-19 提案）。未指定＝サービス既定に従う。 */
  thinking?: string;
  /** 文脈に入る最大トークン数。分かるときだけ載る（使用量の分母になる）。 */
  contextWindow?: number;
}

/**
 * その会話がいま文脈をどれだけ使っているか。
 *
 * **実測だけを出す**（I1）——ハーネスが返したトークン数をそのまま配り、こちらで
 * 推定しない。ターンが1度も回っていない会話や、再起動直後はまだ分からないので
 * 何も配らない（「0%」と偽らない）。
 *
 * `tokens` を省略した1通は「章を畳んだ直後で、まだ分からない」を意味する
 * （PO報告 2026-08-14）。畳んだ瞬間に前章の値を出し続けないための遷移で、
 * 次のターンの実測が来ればまた通常どおり配られる。
 */
export interface ContextStateEvent extends ThreadScope {
  type: "context_state";
  /** 直近のターンで運んだトークン数（入力＋キャッシュ＋出力）。省略＝まだ分からない。 */
  tokens?: number;
}

/** 取次の一通（画面へ配る形）。三部構成は spec-ui §3。 */
export interface InboxItemView {
  id: string;
  source: { id: string; label: string };
  kind: string;
  rule?: string;
  title: string;
  why?: string;
  what: string;
  ask: string;
  /**
   * その場で押せる答え。
   *
   * **押されたときに何が起きるかは載せない**（決定73）——効かせるのはホストで、
   * 画面は「押された」を投げ返すだけ（D5）。ここに宛先を載せると、画面から
   * 任意の口を呼べることになる（承認を番頭から機構で分けた意味が無くなる）。
   */
  actions: Array<{ id: string; label: string; tone?: "call" | "plain" | "quiet" }>;
  opens?: {
    threadId?: string;
    canvas?: { kind: string; params?: Record<string, unknown>; title?: string };
    /**
     * 設定の区画（決定75）。**開くのは画面**——設定は会話に被さる面で、
     * キャンバスのタブではないのでホストからは動かせない。
     */
    settings?: { section?: string };
  };
  blocking?: number;
  /** 判断ではなく知らせ（ADR-0022 決定109・110）。判断待ちの数（`inboxPending`）に数えない。 */
  notice?: boolean;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

/**
 * 取次の中身。接続直後と、積まれた／答えが出たたびに配る。
 *
 * **会話に紐づかない**（ThreadScope を継がない）——どの会話を見ていても、
 * POを待たせているものは同じ1つの列にある。
 * D3: 件数や滞留時間は `createdAt` から導出できるので載せない。
 */
export interface InboxStateEvent {
  type: "inbox_state";
  items: InboxItemView[];
}

/** プロトコル違反・処理不能。I2: 黙って捨てずクライアントへ返す。 */
export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ServerEvent =
  | InboxStateEvent
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
  | UtsuwaEvent
  | BranchCardEvent
  | BranchResultEvent
  | BranchNoteEvent
  | ChapterClosedEvent
  | TurnStartEvent
  | TurnEndEvent
  | CanvasStateEvent
  | ErrorEvent;

/** WSのパス。Kobo（/ws）と同じ流儀。 */
export const BANTO_WS_PATH = "/ws";

/** 既定ポート。Kobo の 4500 と衝突しない値。 */
export const BANTO_DEFAULT_PORT = 4100;
