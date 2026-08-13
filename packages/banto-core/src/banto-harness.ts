/**
 * **番頭のハーネス契約**（ADR-0020 決定88・89）。
 *
 * 番頭が「会話を回す」ために要るものだけを並べた、ランタイム中立の契約。
 * pi（`createAgentSession`）でも Agent SDK（`query()`）でも実装できる。
 *
 * ## なぜ `RuntimeDriver` と別なのか（決定88）
 *
 * `RuntimeDriver`（`runtime-driver.ts`）は `spawn` / `inject` / `subscribe` / `kill` で、
 * **プロセスの生死しか語彙が無い**。あれは差し替え可能性の機構ではなく**関所**である
 * ——cgroup で殺せる・隔離される・職人が記憶を持てない（D11「隠れ状態が無い＝再現可能・
 * 監査可能」）は、プロセス境界が機構として担保しているもので、抽象の中へ吸い上げると
 * 「実装の都合」に格下げされる。
 *
 * ```
 * BantoHarness（会話の契約）        ← 差し替えるのはここ：pi / Agent SDK
 *       ↑ 直に使う              ↑ プロセスの中で使う
 *     番頭                  RuntimeDriver（プロセスの監督＝関所）
 *                                   ↑
 *                                 職人
 * ```
 *
 * この2層で「pi も Agent SDK も、番頭にも職人にもなれる」の4マスが埋まる。
 *
 * D5: ここに判断は無い。契約と語彙だけ。
 * D6: 依存なし（**pi を import しない**——`banto-core-layering.spec.ts` が機械検証している）。
 */

/** 画像の中身。pi の `ImageContent` と同じ形だが、こちらは中立（決定3）。 */
export interface HarnessImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface HarnessPromptOptions {
  /**
   * 走っている最中に投げたときの振る舞い。
   * `steer`＝いまのターンへ差し込む／`followUp`＝終わってから続ける。
   */
  streamingBehavior?: "steer" | "followUp";
  images?: HarnessImage[];
}

/**
 * ハーネスが出す出来事の**語彙**。
 *
 * **これは新しく発明したものではない。** `server.ts` の `toServerEvent()` が、生の
 * ハーネスイベントを既にこの6語へ翻訳していた——正規化は存在していて、置き場所が
 * 「pi のイベントを受ける形」だっただけ。seam を切る作業は、それをこちら側へ下ろすこと。
 *
 * **思考（reasoning）は一級の要素**（決定90）。表示のためのおまけではなく、
 * 往復させないと壊れるプロトコルの一部——思考モデルは前ターンの思考を送り返すことを
 * 要求し（`reasoning_content` の無い履歴は 400 で拒否された）、分離に失敗すると
 * 思考が本文に入って**会話の記録として焼き付く**（inc-0056）。
 */
export type HarnessEvent =
  /** 機構からの知らせ（文脈のまとめ直し等）。会話に残す。 */
  | { type: "notice"; source: "system"; text: string }
  /** 本文の差分。 */
  | { type: "text_delta"; delta: string }
  /** 思考の差分。**本文とは別のチャネル**（決定90）。 */
  | { type: "reasoning_delta"; delta: string }
  /** 思考の終わり。考えていた時間だけを持つ（本文は足さない）。 */
  | { type: "reasoning_end"; durationMs: number }
  | { type: "tool_start"; toolCallId: string; name: string; input?: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean; output?: unknown }
  /**
   * モデルとの1往復が終わった。`contextTokens` はそのターンで運んだ量
   * （入力＋キャッシュ＋出力）＝次に運ぶ量の目安。分かるときだけ。
   */
  | { type: "turn_end"; contextTokens?: number }
  /**
   * **番頭が手を止めた**（道具の呼び出しも含めてひと仕事終わり、入力待ちになった）。
   *
   * **章を閉じるかの判定はここでだけ行う**——`turn_end` ではなく。ターンの途中
   * （道具を呼んでいる最中）に文脈が消えると、番頭は自分が何をしていたか分からなくなる。
   */
  | { type: "run_end" };

/** 章を開くときに渡すもの（決定93）。 */
export interface ChapterOpening {
  /**
   * 新しい章の**種**。前章の要約と引き継ぎの案内が入る。
   *
   * **実測（2026-08-12・Agent SDK）**：種はユーザーメッセージではなく**系プロンプト側**に
   * 入れないと使われなかった。実装はハーネスごとに違ってよいが、
   * 「この文章から始め直す」が守られること。
   */
  text: string;
  /** 畳む前のトークン数（記録用）。 */
  tokensBefore: number;
  /** 何章目か。 */
  chapter: number;
  /** 引き継ぎ資料の id。 */
  handoffId: string;
}

/**
 * 番頭の会話を回すハーネス。
 *
 * **含めないもの**（漏れると pi 依存が残る）: `agent.state.messages` / `SessionManager` /
 * `appendCompaction` / `buildSessionContext` / pi の `ToolDefinition` / `AgentMessage` 等。
 *
 * **seam の外に置くもの**: 章の要約・記憶の抽出に使う単発の LLM 呼び出し
 * （`completeSimple`）は**ハーネスではない**。LLM 側の関心として別に扱う。
 */
export interface BantoHarness {
  /** このバックエンドの識別子（`pi` / `claude-agent-sdk`）。設定画面と記録に出す。 */
  readonly backendId: string;
  readonly sessionId: string;
  readonly isStreaming: boolean;

  /**
   * 話しかける。**ターンが終わるまで返らない**（決定97）。
   *
   * サーバはここの解決をもって `turn_end` を配る——積んで即座に返す実装にすると、
   * **返事が来る前に画面が「終わった」になる**（Agent SDK 側で実際にそうなっていた）。
   * 中断・落ちた・畳んだときも返すこと（待ち続けると「回答中」のまま戻らない）。
   */
  prompt(text: string, options?: HarnessPromptOptions): Promise<void>;
  abort(): Promise<void>;

  /** 出来事を購読する。返り値は購読の解除。 */
  subscribe(handler: (event: HarnessEvent) => void): () => void;

  /**
   * 走っているセッションのモデルを差し替える（対応するハーネスだけ）。
   *
   * 型が `unknown` なのは、モデルの実体がハーネスのものだから——呼ぶ側は中身を
   * 知らないまま、解決した実体を受け取って渡すだけ（ADR-0010 決定3）。
   */
  setModel?(model: unknown): Promise<void>;

  // ── 章（ADR-0003 / 提案§3.2） ──────────────────────────────────────────

  /**
   * いまの文脈の使用トークン数。
   *
   * プロバイダが返した実測があればそれを使い、無ければ見積もる。**見積もりでも返す**
   * ——実測が来ない構成で章立てが黙って働かなくなるのは、閾値が無いのと同じだから。
   */
  contextTokens(): number | undefined;

  /** いま生きている文脈のメッセージ数（短すぎる会話で章を閉じないための判定に使う）。 */
  messageCount(): number;

  /** いま生きている文脈を、要約器へ渡せる文章にする。 */
  transcript(): string;

  /**
   * **文脈を捨てて、種から始め直す**（決定93）。
   *
   * 章の切れ目の意味はこれで言い切れる。pi では `appendCompaction(keepNothing)` ＋
   * `buildSessionContext`、Agent SDK では現在の `query()` を畳んで種つきで起こし直す。
   */
  startChapter(opening: ChapterOpening): Promise<void>;

  // ── 復元と後始末（決定97・task-0104） ──────────────────────────────────

  /**
   * **次の起動でこの会話を続けるための札**（決定97）。
   *
   * ADR-0020 決定89 は `restore(record)` という手続きを想定していたが、実装してみると
   * **復元は「組み立てるときに札を渡す」で足りる**——生きているハーネスへ後から文脈を
   * 差し込む口は要らない。番頭ホストはこれを索引へ保存し、次の起動で
   * 作り手（`ClaudeAgentHarnessOptions.resume`）へ渡す。
   *
   * `undefined` ＝**まだ札が無い**（一度も往復していない）か、そのバックエンドが
   * 札で復元しない（pi はセッションファイルで復元するので持たない）。
   * **無いものを名乗らないこと**——実在しない札で `resume` すると、Agent SDK は
   * `error_during_execution` を返して**何も言わずにターンを終える**（実測 2026-08-13）。
   */
  resumeToken?(): string | undefined;

  /**
   * このバックエンドが使っているモデルの文脈長（分かるときだけ）。
   *
   * 章の閾値はこれで測る。**バックエンドごとに違う**——同じ会話でも pi の
   * ローカルモデル（32k）と Claude（200k）では区切る位置がまるで変わる。
   * 分からないときは呼び出し側が自分の見積もりへ落ちる。
   */
  contextWindow?(): number | undefined;

  /**
   * **後始末**（決定97）。会話を畳むとき・ハーネスを差し替えるときに呼ぶ。
   *
   * 実装によっては子プロセスや待ち行列を抱える（Agent SDK の `query()` は
   * 「待ち行列が空になっても終わらせない」ので、放すだけでは終わらない）。
   * 呼ばれた後のハーネスは使えない。
   */
  dispose?(): Promise<void> | void;
}
