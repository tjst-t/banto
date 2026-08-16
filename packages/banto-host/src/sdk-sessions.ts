/**
 * **常駐する SDK セッションの本数を抑える**（task-0165）。
 *
 * ## なぜ要るか（推測ではなく実測）
 *
 * ホスト（`banto.service`）は 2026-08-14 以降 12 回 OOM で殺されているが、全件
 * `constraint=CONSTRAINT_MEMCG`——VM 全体は 7 GiB 空いていて、当たっていたのは
 * unit の上限 3.00 GiB のほうだった。カーネルの Tasks state ダンプでは、その 3 GiB の
 * うち **`claude` の子プロセス 12〜13 本が 2.29〜2.40 GiB（76〜80%）** を占めていた。
 * 1本あたり anon 189〜200 MiB でほぼ一定で、プロセス数が変わらない区間は横ばい
 * ——**固定集合の中で漏れているのではなく、本数がすべて**。
 *
 * 本数が増える理由は `claude-agent-harness.ts` の `dispose()` の注釈のとおり:
 * `PromptQueue` は空になっても終わらないので、参照を落とすだけでは `query()` が
 * 生き続ける。ところが `dispose()` の呼び口は「バックエンドの差し替え」と
 * 「ホストごと終了」しか無く、**しばらく触られていない会話を放す経路が1つも無かった**。
 * 開いている会話は 21 本あるので、全部に一度ずつ話しかければ 21×0.19 GiB ＝ 3.99 GiB。
 * 上限に当たるのは時間ではなく**触った会話の本数**で決まる。
 *
 * ## 何をするか
 *
 * - `SdkSessionPool` が「いま生きている本数」を持ち、アイドルと上限で畳む
 * - `PooledSdkHarness` が中身を**遅らせて組み、畳んでも札で戻す**皮になる
 *
 * 畳んでも会話は失われない——`resumeToken()` が SDK 側の会話の札を返し、次に発話が
 * 来たときはその札で組み直す（決定97・task-0104）。**利用者には見えない**：畳まれて
 * いたことを断り書きとして喋らないし、記録も札も落とさない。
 *
 * ## 効かなくても壊れない側に倒す
 *
 * 畳むのに失敗しても例外は握り潰さず記録して、会話はそのまま続けられる（I2）。
 * 皮は先に中身への参照を落とすので、後始末が失敗しても次の発話は新しい中身で通る。
 */

import type { BantoHarness, ChapterOpening, HarnessEvent, HarnessPromptOptions } from "@banto/core";

/**
 * アイドルの SDK セッションを畳むまでの既定（15分）。
 *
 * **職人側の安全弁と揃える**——`banto-worker-pool` の `DEFAULT_IDLE_TIMEOUT_MS` が
 * 同じ 15 分で、番頭と職人で「放っておかれた」の意味が違うと運用の勘が働かない。
 * 短くすると畳んだ直後に話しかけられて往復のたびに組み直しになり、長くすると
 * 上限（`DEFAULT_SDK_MAX_LIVE`）のほうが先に効いて LRU で畳まれる——どちらでも
 * 会話は続くので、ここは「勘の揃うほう」を採った。
 */
export const DEFAULT_SDK_IDLE_MS = 15 * 60 * 1000;

/**
 * 同時に生かす SDK セッションの既定の上限（8本）。
 *
 * 実測の制約は **上限本数 × 0.19 GiB ＋ node 本体 0.7 GiB ＜ 3.00 GiB**（unit の
 * `MemoryMax`）。等号ぎりぎりは 12 本だが、それは**実際に殺されたときの本数**
 * （12〜13本）そのものなので余裕が無い。8 本なら 8×0.19 ＋ 0.7 ＝ 2.22 GiB で、
 * 0.78 GiB（node 本体がもう一つ分）残る。8 本を超えて同時に会話が動くことは
 * 実運用では無く（開いている 21 本のうち動くのは数本）、超えても LRU で畳まれた側は
 * 次の発話で札から戻るだけなので、失うものは組み直しの一往復ぶんの待ちだけ。
 */
export const DEFAULT_SDK_MAX_LIVE = 8;

/** アイドルを見に行く間隔の既定。安全弁なので細かく刻む必要はない。 */
export const DEFAULT_SDK_SWEEP_MS = 60 * 1000;

/** 起こし直しの実績をどこまで遡って持つか。傾向が読めれば足りるので直近ぶんだけ。 */
const MAX_WAKE_SAMPLES = 100;

/** 器が畳む相手。会話1本につき1つ登録される。 */
export interface SdkSession {
  readonly threadId: string;
  /** いま中身（＝子プロセスを抱えたセッション）が生きているか。 */
  isLive(): boolean;
  /**
   * **いま畳んではいけない**か。
   *
   * 応答を流している最中と、章を畳んでいる最中（`ChapterKeeper.isClosing()`）。
   * ここを間違えると返事が途中で切れる。
   */
  isHeld(): boolean;
  /** 畳む。冪等。**中身を落とすのは同期**で、後始末だけが非同期。 */
  release(reason: string): Promise<void>;
}

export interface SdkSessionPoolOptions {
  /** アイドルと見なすまで（既定 `DEFAULT_SDK_IDLE_MS`）。 */
  idleMs?: number;
  /** 同時に生かす本数の上限（既定 `DEFAULT_SDK_MAX_LIVE`）。 */
  maxLive?: number;
  /** 見に行く間隔（既定 `DEFAULT_SDK_SWEEP_MS`）。 */
  sweepMs?: number;
  /** 時計。試験で進めるために差せる。 */
  now?: () => number;
  /** 記録の口。既定は `console.error`（既存の `[banto] …` の流儀）。 */
  log?: (message: string) => void;
}

/**
 * 生きている SDK セッションの帳簿。**畳む判断だけを持ち、畳み方は知らない**。
 *
 * D3: 「いま何本生きているか」は各セッションに訊いて数える（別に数えを持たない
 * ——持つと畳みそこねたときに帳簿だけが減って、実際の子プロセスが見えなくなる）。
 */
export class SdkSessionPool {
  private readonly sessions = new Map<string, SdkSession>();
  /** 最後に触られた時刻。会話ごと。 */
  private readonly touchedAt = new Map<string, number>();
  /** 起こし直しにかかった時間の控え（a10）。直近 `MAX_WAKE_SAMPLES` 件。 */
  private readonly wakes: { threadId: string; elapsedMs: number; revived: boolean }[] = [];
  private readonly idleMs: number;
  private readonly maxLive: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: SdkSessionPoolOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_SDK_IDLE_MS;
    this.maxLive = options.maxLive ?? DEFAULT_SDK_MAX_LIVE;
    this.sweepMs = options.sweepMs ?? DEFAULT_SDK_SWEEP_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** 上限（記録と画面へ出すために読める）。 */
  limit(): number {
    return this.maxLive;
  }

  /** アイドルと見なすまでの時間。 */
  idleTimeout(): number {
    return this.idleMs;
  }

  /**
   * 器の時計。**皮が「起こし直しにかかった時間」を測るのに使う**（a10）。
   *
   * 触った印と同じ時計を使う——別の時計を持つと、試験で時間を進めたときに
   * 片方だけが動いて、測った数字が誰にも確かめられなくなる。
   */
  nowMs(): number {
    return this.now();
  }

  /**
   * **起こし直しにかかった時間を控える**（a10）。
   *
   * 畳んだ会話へ話しかけたとき、利用者が待たされるのはここの時間だけである。
   * 数字が残っていれば「体感が悪い」を計測で裁ける——遅ければ `idleMs` を伸ばす
   * `maxLive` を上げる、という判断の材料になる（勘で緩めない）。
   */
  noteWake(threadId: string, elapsedMs: number, revived: boolean): void {
    this.wakes.push({ threadId, elapsedMs, revived });
    // 直近ぶんだけ持つ（帳簿を無限に伸ばさない）
    if (this.wakes.length > MAX_WAKE_SAMPLES) this.wakes.splice(0, this.wakes.length - MAX_WAKE_SAMPLES);
  }

  /**
   * 起こし直しの実績。**札から戻したぶんだけ**を数える（初回の起動は待たされたうちに
   * 入らない——畳んだせいで増えた待ちだけを見たい）。
   */
  wakeStats(): { count: number; lastMs: number | undefined; maxMs: number | undefined; totalMs: number } {
    const revived = this.wakes.filter((w) => w.revived);
    const last = revived.at(-1);
    return {
      count: revived.length,
      lastMs: last?.elapsedMs,
      maxMs: revived.length > 0 ? Math.max(...revived.map((w) => w.elapsedMs)) : undefined,
      totalMs: revived.reduce((sum, w) => sum + w.elapsedMs, 0),
    };
  }

  /** 会話を登録する。返り値は登録の解除。 */
  register(session: SdkSession): () => void {
    this.sessions.set(session.threadId, session);
    this.touchedAt.set(session.threadId, this.now());
    return () => {
      this.sessions.delete(session.threadId);
      this.touchedAt.delete(session.threadId);
    };
  }

  /** いま生きている本数。 */
  liveCount(): number {
    return this.liveIds().length;
  }

  /** いま生きている会話の id（記録に出す）。 */
  liveIds(): string[] {
    const out: string[] = [];
    for (const [id, session] of this.sessions) if (session.isLive()) out.push(id);
    return out;
  }

  /** 触った印を付ける。 */
  touch(threadId: string): void {
    if (!this.sessions.has(threadId)) return;
    this.touchedAt.set(threadId, this.now());
  }

  /**
   * **これから起こす1本ぶんの席を空ける**（a8）。発話の直前に呼ぶ。
   *
   * 上限を守るのが定期の掃除だけだと、**時間を進めずに会話を次々と触るだけで**
   * 上限を超える——実測で上限に当たったのは時間ではなく触った本数だった。
   * だから「起こす前に空ける」を発話の経路に置く。
   */
  async admit(threadId: string): Promise<void> {
    this.touch(threadId);
    await this.enforceLimit(threadId);
  }

  /**
   * 上限を超えているぶんだけ、**最も長く触られていないもの**から畳む。
   *
   * `reserve` は「これから起こす1本」——まだ生きていなくても席を数え、かつ
   * 自分自身は畳まない。
   */
  async enforceLimit(reserve?: string): Promise<void> {
    /** この回で畳めなかったもの。同じ相手を掴んで回り続けないために覚える（I2）。 */
    const stuck = new Set<string>();
    for (;;) {
      const live = this.liveIds();
      const reserving = reserve !== undefined && !live.includes(reserve) ? 1 : 0;
      if (live.length + reserving <= this.maxLive) return;
      const victim = this.oldest(live.filter((id) => id !== reserve && !stuck.has(id)));
      if (!victim) {
        /**
         * 畳める相手がいない＝生きているものが全部「畳んではいけない」最中。
         * **黙って超えない**——超えたまま進むと OOM で殺されるのが唯一の合図になる。
         */
        this.log(
          `[banto] SDK セッションが上限を超えています（生存 ${live.length + reserving}/${
            this.maxLive
          } 本）が、畳める会話がありません（走行中か章を畳んでいる最中）`
        );
        return;
      }
      if (!(await this.release(victim, "本数の上限"))) stuck.add(victim);
    }
  }

  /**
   * アイドルな会話を畳む。定期の掃除の本体。
   *
   * ついでに上限も守る——掃除の回で「畳んではいけない」が解けていることがある。
   */
  async sweep(): Promise<void> {
    const deadline = this.now() - this.idleMs;
    for (const id of this.liveIds()) {
      const at = this.touchedAt.get(id);
      if (at === undefined || at > deadline) continue;
      await this.release(id, `${Math.round(this.idleMs / 60000)}分ぶん触られていない`);
    }
    await this.enforceLimit();
  }

  /**
   * 1本畳む。畳めたら true。
   *
   * I2: 畳めなかったことを握り潰さない。**会話は続けられる**——皮は中身への参照を
   * 先に落とすので、後始末が失敗しても次の発話は新しい中身で通る。
   */
  private async release(threadId: string, reason: string): Promise<boolean> {
    const session = this.sessions.get(threadId);
    if (!session || !session.isLive()) return false;
    // 走行中・章を畳んでいる最中は畳まない（返事が途中で切れる）
    if (session.isHeld()) return false;
    try {
      await session.release(reason);
      this.log(
        `[banto] SDK セッションを畳みました（${threadId}／${reason}）。` +
          `生存 ${this.liveCount()}/${this.maxLive} 本`
      );
      return true;
    } catch (err: unknown) {
      this.log(
        `[banto] SDK セッションを畳めませんでした（${threadId}／${reason}）: ${String(err)}` +
          `——会話はそのまま続きます（生存 ${this.liveCount()}/${this.maxLive} 本）`
      );
      return false;
    }
  }

  /** 一番長く触られていないもの。 */
  private oldest(ids: readonly string[]): string | undefined {
    let best: string | undefined;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const at = this.touchedAt.get(id) ?? 0;
      if (at < bestAt) {
        bestAt = at;
        best = id;
      }
    }
    return best;
  }

  /** 定期の掃除を始める。**イベントループは掴まない**（`unref`）。 */
  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.log(`[banto] SDK セッションの掃除でしくじりました: ${String(err)}`);
      });
    }, this.sweepMs);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}

export interface PooledSdkHarnessOptions {
  threadId: string;
  pool: SdkSessionPool;
  /** 中身を組む。`resume` は前に畳んだときの札、`model` は選ばれているモデル。 */
  create(params: { resume?: string; model?: string }): BantoHarness;
  /** 起動時に索引から渡ってきた札（決定97）。 */
  resume?: string;
  /** 走り出しのモデル。 */
  model?: string;
  /**
   * **いま畳んではいけない**外側の事情。章を畳んでいる最中（`ChapterKeeper.isClosing()`）。
   * 走行中（`isStreaming`）は皮が自分で見るので、ここに書かなくてよい。
   */
  held?: () => boolean;
  log?: (message: string) => void;
}

/**
 * **中身を遅らせて組み、畳んでも札で戻す皮**（task-0165）。
 *
 * `BantoHarness` としては1本のまま生涯変わらない——`Thread.harness` も購読も
 * 差し替えずに済む（差し替えを挟むと、画面に何も流れてこないのに番頭は動いている、
 * という一番分かりにくい壊れ方をしうる／`Thread.replaceHarness` の注釈）。
 *
 * 中身が無い間の名乗り:
 * - `messageCount()` は **0**。畳んだ会話には畳む文脈が無く、`ChapterKeeper` は
 *   0 のとき何もしない（`closeChapter` の先頭・`shouldClose` の下限）。ここを
 *   前の値のままにすると、**空の文脈で章を畳もうとする**
 * - `contextTokens()` / `resumeToken()` / `sessionId` は**畳む前の値**。畳んだことで
 *   数えが 0 に戻ると、戻した瞬間に章の判定がやり直しになる
 */
export class PooledSdkHarness implements BantoHarness {
  readonly backendId = "claude-agent-sdk";
  private readonly options: PooledSdkHarnessOptions;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly log: (message: string) => void;
  private readonly unregister: () => void;
  private inner: BantoHarness | undefined;
  private innerOff: (() => void) | undefined;
  private disposed = false;
  /** 前の中身の札。畳む前に取る——取らないと戻したときに文脈が消える。 */
  private token: string | undefined;
  private model: string | undefined;
  /** 畳む前の名乗り。戻すまでの間これを答える。 */
  private lastSessionId = "";
  private lastTokens: number | undefined;
  /** 畳む前までに積んだ往復の数と文章。章を畳むときに要る（章をまたいだら捨てる）。 */
  private foldedMessages = 0;
  private foldedTranscript = "";
  /**
   * **まだ一度も話していない章の種**（決定93）。
   *
   * 章を畳んだ直後のセッションには札が無い（`startChapter` が新しい session を立てて、
   * まだ実在しない）。その状態で安全弁が畳むと、次に起こしたときは**引き継ぎ資料の
   * 入っていない系プロンプト**になる——畳んだ章の中身がまるごと落ちる。だから種を
   * 覚えておき、札が無いまま起こし直すときに掛け直す。
   */
  private pendingOpening: ChapterOpening | undefined;
  /** 直近で起こす（戻す）のにかかった時間（a10）。 */
  private wakeMs: number | undefined;

  constructor(options: PooledSdkHarnessOptions) {
    this.options = options;
    this.log = options.log ?? ((message) => console.error(message));
    this.token = options.resume;
    this.model = options.model;
    this.unregister = options.pool.register({
      threadId: options.threadId,
      isLive: () => this.inner !== undefined,
      isHeld: () => this.isHeld(),
      release: (reason) => this.release(reason),
    });
  }

  private isHeld(): boolean {
    // 応答を流している最中は畳まない（返事が途中で切れる）
    if (this.inner?.isStreaming === true) return true;
    // 章を畳んでいる最中も畳まない（`startChapter` の相手が消える）
    return this.options.held?.() === true;
  }

  get sessionId(): string {
    return this.inner?.sessionId ?? this.lastSessionId;
  }

  get isStreaming(): boolean {
    return this.inner?.isStreaming ?? false;
  }

  subscribe(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** いま中身が生きているか（記録・試験用）。 */
  isLive(): boolean {
    return this.inner !== undefined;
  }

  /**
   * 直近でこの会話を起こす（畳んであったなら戻す）のにかかったミリ秒（a10）。
   * 一度も起こしていなければ `undefined`。器ぜんたいの傾向は `pool.wakeStats()`。
   */
  lastWakeMs(): number | undefined {
    return this.wakeMs;
  }

  /**
   * **モデルを選び直す**。生きていれば畳んで、次の発話で組み直す。
   *
   * 同期で済ませる——呼び出し側（`onSelectModel`）はハーネスを受け取ってすぐ返すので、
   * 後始末を待たせない。中身への参照はその場で落ちるので、次の発話は新しいほうへ行く。
   */
  selectModel(model?: string): void {
    if (model === undefined || model === this.model) return;
    this.model = model;
    if (!this.inner) return;
    void this.release("モデルの選び直し").catch((err: unknown) => {
      this.log(`[banto] ${this.options.threadId} の SDK セッションを畳めませんでした: ${String(err)}`);
    });
  }

  /** 中身を用意する。無ければ札から組み直す（＝戻す）。 */
  private async ensure(): Promise<BantoHarness> {
    if (this.inner) return this.inner;
    // I2: 畳んだ会話へ話しかけられたら黙って捨てない
    if (this.disposed) {
      throw new Error("この会話は畳まれています（dispose 済み）。新しく組み立ててください");
    }
    const revived = this.token !== undefined;
    /**
     * **起こし直しにかかった時間を測る**（a10）。畳んだ会話へ話しかけたとき、
     * 利用者が余計に待たされるのはここ——子プロセスを立て直し、札の文脈を
     * 読み戻すまでの間である。数字が残らないと「畳むのが早すぎる」を計測で
     * 裁けず、体感の話に落ちる。
     */
    const startedAt = this.options.pool.nowMs();
    const inner = this.options.create({
      ...(this.token !== undefined ? { resume: this.token } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
    });
    // 出来事は皮の購読者へそのまま流す。**皮の購読は生涯そのまま**
    this.innerOff = inner.subscribe((event) => {
      for (const listener of [...this.listeners]) listener(event);
    });
    this.inner = inner;
    /**
     * **札が無いまま起こすときは章の種を掛け直す**。札があるなら掛けない
     * ——掛けると `startChapter` が新しいセッションを立てて、札で戻したはずの
     * 文脈をその場で捨てる（章を畳んだ意味と逆のことをする）。
     */
    if (!revived && this.pendingOpening) await inner.startChapter(this.pendingOpening);
    // 時計が巻き戻っても負の数を出さない（記録を読む人が意味を取り違える）
    const elapsedMs = Math.max(0, this.options.pool.nowMs() - startedAt);
    this.wakeMs = elapsedMs;
    this.options.pool.noteWake(this.options.threadId, elapsedMs, revived);
    /**
     * **黙って起き直さない**（a12）。静かに起きることは静かに壊れることと
     * 見分けが付かない——遅れの原因が「畳んであったのを起こしていた」なら、
     * その旨と何ミリ秒かかったかが記録に出ていないと誰にも読めない。
     */
    this.log(
      `[banto] SDK セッションを${
        revived ? `札から戻しました（${this.options.threadId}／起こし直しに ${elapsedMs}ms）` : `起こしました（${this.options.threadId}／起こすのに ${elapsedMs}ms）`
      }。生存 ${this.options.pool.liveCount()}/${this.options.pool.limit()} 本`
    );
    return inner;
  }

  /**
   * **畳む**。中身への参照はその場で落とし、後始末だけを待つ。
   *
   * 後始末が失敗しても皮は既に空なので、次の発話は新しい中身で通る
   * ——安全弁は「効かなくても壊れない」側に倒す。
   */
  async release(_reason: string): Promise<void> {
    const inner = this.inner;
    if (!inner) return;
    // 札は畳む前に取る（取らないと戻したときに別の会話になる）
    this.token = inner.resumeToken?.() ?? this.token;
    this.lastSessionId = inner.sessionId;
    this.lastTokens = inner.contextTokens() ?? this.lastTokens;
    this.foldedMessages += inner.messageCount();
    const transcript = inner.transcript();
    if (transcript.trim().length > 0) {
      this.foldedTranscript = this.foldedTranscript
        ? `${this.foldedTranscript}\n\n${transcript}`
        : transcript;
    }
    this.inner = undefined;
    this.innerOff?.();
    this.innerOff = undefined;
    await inner.dispose?.();
  }

  async prompt(text: string, options?: HarnessPromptOptions): Promise<void> {
    // 起こす前に席を空ける（a8：時間ではなく触った本数で上限に当たるため）
    await this.options.pool.admit(this.options.threadId);
    const inner = await this.ensure();
    try {
      await inner.prompt(text, options);
    } finally {
      // 「最後の発話から」を測る印。走り終わりで押し直す（長いターンを即アイドルにしない）
      this.options.pool.touch(this.options.threadId);
    }
  }

  async abort(): Promise<void> {
    await this.inner?.abort();
  }

  /**
   * `setModel` は**生やさない**（中身の `ClaudeAgentHarness` が持たないため）。
   * 生やすと「走行中に差し替えられる」と名乗ってしまい、選び直しが黙って効かない
   * ——このバックエンドのモデル差し替えは `selectModel`（組み直し）が受け持つ。
   */

  contextTokens(): number | undefined {
    return this.inner?.contextTokens() ?? this.lastTokens;
  }

  /**
   * 生きている文脈のメッセージ数。
   *
   * **畳んでいる間は 0**——畳む文脈がそこに無いので、章立てを走らせない。
   * 生きている間は畳む前のぶんを足す（畳んだことで往復の数が巻き戻ると、
   * 戻した直後の会話が「始まったばかり」に見えて章の下限に引っかかる）。
   *
   * 割り切り: **畳んでいる間は PO の「区切る」も効かない**（`closeChapter` は
   * 0 のとき何もしない）。畳まれているのは触られていない会話なので文脈は伸びて
   * おらず、次の発話で戻れば畳む前のぶんごと数え直されて普通に区切れる。
   */
  messageCount(): number {
    if (!this.inner) return 0;
    return this.foldedMessages + this.inner.messageCount();
  }

  /** 要約器へ渡す文章。畳む前のぶんを落とさない（畳んだ区間が要約から消える）。 */
  transcript(): string {
    const now = this.inner?.transcript() ?? "";
    if (!this.foldedTranscript) return now;
    return now ? `${this.foldedTranscript}\n\n${now}` : this.foldedTranscript;
  }

  /**
   * 章を畳む。**畳んでいたら先に戻す**——`startChapter` は「いまの文脈を捨てて種から
   * 始め直す」なので、捨てる相手が要る（種つきの新しいセッションもここで立つ）。
   */
  async startChapter(opening: ChapterOpening): Promise<void> {
    const inner = await this.ensure();
    await inner.startChapter(opening);
    // 章をまたいだら畳む前のぶんは捨てる（前の章の文脈は引き継がない・決定93）
    this.foldedMessages = 0;
    this.foldedTranscript = "";
    this.lastTokens = undefined;
    // 新しい章は前の札へ戻らない（`startChapter` が新しい session を立てている）
    this.token = inner.resumeToken?.();
    // まだ話していない章の種。畳まれても掛け直せるように覚えておく
    this.pendingOpening = opening;
  }

  resumeToken(): string | undefined {
    return this.inner?.resumeToken?.() ?? this.token;
  }

  contextWindow(): number | undefined {
    return this.inner?.contextWindow?.();
  }

  /** 会話ごと畳む。**戻らない**（`release` と違い、札も器の登録も落とす）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return; // 冪等
    this.disposed = true;
    this.unregister();
    const inner = this.inner;
    this.inner = undefined;
    this.innerOff?.();
    this.innerOff = undefined;
    this.listeners.clear();
    await inner?.dispose?.();
  }
}
