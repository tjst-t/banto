/**
 * 章立て（提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.2）。
 *
 * ## 何をするか
 *
 * pi の自動コンパクションを**切る**。代わりに、文脈が閾値に達したら
 * **番頭がターン境界で章を閉じる**——引き継ぎ資料を書き出し、次の章は見出しだけを
 * 持って始まる。
 *
 * ## なぜコンパクションより良いか
 *
 * - **タイミング**: 95%で強制的に走るのではなく、余力のあるうちに区切りで閉じる
 * - **情報**: 元のトランスクリプトは pi のセッションファイルに残る（D3）。資料は導出値で作り直せる
 * - **キャッシュ**: 新しい章＝新しい小さなプレフィックス。章の間ずっとキャッシュが効く
 * - **記憶の注入**: 章の頭は決定28 が許した「セッション開始時」に当たる合法的な注入点になる
 *
 * ## pi の機構に乗る
 *
 * 章の境界は pi の**コンパクションエントリ**として書く（`fromHook: true`）。これにより
 * `buildSessionContext` がそのまま境界を解釈でき、セッションツリーの形も壊れない。
 * 違うのは中身だけ——pi が入れるのは会話のLLM要約だが、ここが入れるのは
 * **引き継ぎ資料への参照**である（要約ではないので情報を失わない）。
 *
 * `firstKeptEntryId` に境界より前のどのエントリとも一致しない値を渡すと、
 * `buildSessionContext` は境界より前を1件も残さない（`session-manager.js` の
 * `foundFirstKept` を参照）。章は「畳む」ので、これが望む挙動。
 *
 * D5: 判断は「いつ閉じるか」の閾値だけ。資料の中身は要約器（注入する）が作る。
 * I2: 資料が書けなかったら章を閉じない——引き継ぎ無しで文脈だけ消すのが最悪。
 */

import type { BantoHarness } from "@banto/core";
import { renderArtifactIndex, type ArtifactStore } from "./artifacts.js";
import {
  renderChapterOpening,
  type HandoffRecord,
  type HandoffStore,
  type HandoffSummary,
} from "./handoffs.js";

/** 章を閉じるときに要約器へ渡すもの。 */
export interface ChapterInput {
  /** 会話の書き起こし（PO の発言と番頭の発話。ツール出力は入れない）。 */
  transcript: string;
  /** 何章目か。 */
  chapter: number;
}

/** 要約器の返り値。 */
export interface ChapterHandoff {
  summary: HandoffSummary;
  /** 詳細な本文（資料に書かれる。文脈には載らない）。 */
  body: string;
}

/**
 * `shouldClose()` の判定1回分のスナップショット（a1・inc-0075）。
 *
 * **畳まなかったときも含めて**外から読めるようにする。inc-0075 では「試行して
 * 失敗した」のか「そもそも試行していない」（`shouldClose` が false で早期 return
 * した）のかの区別が付かず、`git log` と systemd の再起動時刻を突き合わせる
 * 遠回りが要った。この形を見れば一目で分かる。
 */
export interface ChapterEvaluation {
  /** 判定した時刻（epoch ms）。 */
  at: number;
  /** いまの文脈長（トークン）。測れなければ undefined。 */
  tokens: number | undefined;
  /** 文脈窓。測れなければ undefined（＝章立てはそもそも働かない）。 */
  window: number | undefined;
  /** 閾値（比率）。この仕事では変えない——見直すときの材料は下記 `checkStale` を参照。 */
  thresholdRatio: number;
  /** 畳むと判断したか。 */
  willClose: boolean;
}

export interface ChapterKeeperOptions {
  /**
   * 会話を回しているハーネス（ADR-0020 決定89）。
   *
   * **pi の `AgentSession` を直に持たない。** 章に要るのは「いまの量」「短すぎないか」
   * 「書き起こし」「捨てて種から始め直す」の4つで、どれも `BantoHarness` の語彙で言える。
   */
  harness: BantoHarness | (() => BantoHarness);
  store: HandoffStore;
  threadId: string;
  /**
   * 引き継ぎ資料を書く。**別のモデル・別の呼び出し**にすること（決定28）——
   * 本セッションのプレフィックスに触らないので、キャッシュを壊さない。
   */
  summarize: (input: ChapterInput) => Promise<ChapterHandoff>;
  /**
   * 文脈がこの割合を超えたら章を閉じる。既定 0.6。
   *
   * 低すぎると章が増えて資料のコストが嵩み、高すぎると閉じる余力が無くなる
   * （そこがコンパクションの失敗そのもの）。
   */
  thresholdRatio?: number;
  /** モデルの文脈長。分からなければ章立ては働かない（閾値を判定できない）。 */
  contextWindow?: number;
  /**
   * これ未満のやり取りでは閉じない。既定4（＝2往復）。
   * 始まったばかりの会話を畳んでも、引き継ぐものが無い。
   */
  minMessages?: number;
  /**
   * この会話の退避先（提案§3.1）。渡すと、章を閉じるときに**退避したものの一覧を
   * 引き継ぎ資料へ機械的に書き込む**（PO指摘 2026-08-05）。
   *
   * 渡さないと、畳んだ番頭は栞（artifact のID）を見失う——手元に引換券があるのに
   * 番号を忘れた状態になる。要約器のプロンプトで頼むだけでは、書かれるかがモデル任せ。
   */
  artifacts?: ArtifactStore;
  /** 章を閉じたことを知らせる（画面に出す）。 */
  onChapterClosed?: (record: HandoffRecord) => void;
  /**
   * **章を閉じられなかったことを知らせる**（inc-0050）。
   *
   * 畳めないと文脈は増え続けるので、黙って retry を重ねると「そのうち何も入らなくなる」
   * 形で行き詰まる。POに見える形で出す口を持つ（I2）。
   */
  onCloseFailed?: (error: unknown) => void;
  /**
   * 記憶の抽出（提案§3.4・決定28）。**章を閉じるときだけ発火する**——
   * これが論文のいう explicit gate で、毎ターン走らせないことが劣化への対処になる。
   *
   * 失敗しても章は閉じる（task-0022 a5：会話を止めない。I2 のためログには残す）。
   */
  extractMemories?: (transcript: string) => Promise<void>;
  /**
   * 「長く章が畳めていない」と見なすまでの時間（ms・a2・inc-0075）。既定4時間。
   *
   * inc-0075 は**12時間以上0本**が誰にも気づかれなかった。それよりずっと手前で
   * 気づけるよう短めに取っているが、**畳まないこと自体は異常ではない**（文脈が
   * 伸びていなければ畳む必要が無い）ので、下げすぎると平常運転でも鳴る（過検知）。
   */
  staleAfterMs?: number;
  /**
   * 長く畳めていないことを知らせる（a2）。渡さなくても journal に警告ログは出る
   * ——**「誰かが見に行かないと分からない」形にしない**ため、ログ自体を主な
   * 気づき方にしている（`checkStale` 参照）。これは取次などへ回すための受け皿。
   */
  onLongWithoutClose?: (info: { threadId: string; sinceMs: number; evaluation: ChapterEvaluation }) => void;
}

/** 既定の閾値。提案§6 論点2。 */
export const DEFAULT_CHAPTER_THRESHOLD_RATIO = 0.6;
/** 既定の下限。task-0056 a2「数往復未満の短い会話では引き継ぎを生成しない」。 */
export const DEFAULT_MIN_MESSAGES = 4;
/** 既定の「長く畳めていない」しきい値。a2・inc-0075 の理由は `ChapterKeeperOptions.staleAfterMs` 参照。 */
export const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export class ChapterKeeper {
  private readonly options: ChapterKeeperOptions;
  /**
   * **いまのハーネスを毎回引く**（PO要望 2026-08-13 の差し替えに追随するため）。
   *
   * 生成時のものを掴んでいると、会話の途中でバックエンドを替えたときに
   * **動いていないほうを見張り続ける**——自動の章立ては永久に畳まれず、
   * 「区切る」を押すと話していないほうのセッションが畳まれる。
   */
  private get harness(): BantoHarness {
    const h = this.options.harness;
    return typeof h === "function" ? h() : h;
  }
  private closing = false;
  /**
   * **畳んでいる間だけ未解決**の掛け金（imp-0052）。
   *
   * 畳みには要約で30秒ほどかかる。その最中に届いた発話を**これから捨てるセッション**へ
   * 渡すと、答えかけたところで `startChapter` に切られる（トランスクリプトの末尾が
   * `[Request interrupted by user]` になる・thread-85 第9章で実際に起きた）。
   * 待たせる側（server）はこれを待ってから流す。
   */
  private settled: { promise: Promise<void>; release: () => void } | undefined;
  private unsubscribe: (() => void) | undefined;

  /** `shouldClose()` を直近1回分だけ憶えておく（a1）。 */
  private lastEvaluation: ChapterEvaluation | undefined;
  /** 見張りを始めた時刻。まだ一度も畳んでいないときの「畳めていない期間」の起点（a2）。 */
  private readonly startedAt = Date.now();
  /** 最後に章を閉じた時刻。以後はここが起点になる（a2）。 */
  private lastClosedAt: number | undefined;
  /** 判定ログを最後に出した時刻・比率（間引きに使う。a1）。 */
  private lastLoggedAt: number | undefined;
  private lastLoggedRatio: number | undefined;
  /** 「長く畳めていない」警告を最後に出した時刻（間引きに使う。a2）。 */
  private lastStaleWarnAt: number | undefined;

  /** いま章を畳んでいるか（imp-0052：畳み中の発話を待たせるのに使う）。 */
  isClosing(): boolean {
    return this.closing;
  }

  /**
   * 直近の `shouldClose()` の判定結果（a1・inc-0075）。まだ一度も判定していなければ
   * `undefined`。**「判定したか」自体もこれで分かる**——`undefined` は判定にすら
   * 来ていない（`run_end` がまだ一度も来ていない、など）、`willClose: false` は
   * 「判定した上で畳まないと決めた」で、両者は別の状態として区別できる。
   */
  evaluation(): ChapterEvaluation | undefined {
    return this.lastEvaluation;
  }

  /**
   * **畳み終わるまで待つ。** 畳んでいなければ即座に返る（imp-0052）。
   *
   * 解けるのは `startChapter` が済んで**新しい章のセッションが立った後**。
   * 畳みが失敗したときも解ける——I2：待たせたまま消さない。
   */
  async whenSettled(): Promise<void> {
    const gate = this.settled;
    if (gate) await gate.promise;
  }

  constructor(options: ChapterKeeperOptions) {
    this.options = options;
  }

  /**
   * 見張りを始める。
   *
   * 自動コンパクションを切るのは**ハーネスの生成時**に移した（ADR-0020 決定89）——
   * 「章の境界は番頭が持つ」は契約の前提であって、見張りを始めたかどうかとは別。
   */
  start(): void {
    this.unsubscribe = this.harness.subscribe((event) => {
      // **手を止めたときだけ**見る（`run_end`）。ターンの途中で畳まない——道具を
      // 呼んでいる最中に文脈が消えると、番頭は自分が何をしていたか分からなくなる
      if (event.type !== "run_end") return;
      // I2: 畳めなかったことを握りつぶさない。`void` のままだと unhandled rejection に
      //     なって**どこにも出ない**——資料が空だった件（inc-0050）が見えなかった一因
      void this.maybeCloseChapter().catch((err: unknown) => {
        console.error(`[banto] ${this.options.threadId} の章を閉じられませんでした: ${String(err)}`);
        this.options.onCloseFailed?.(err);
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * いまの文脈の使用トークン数。
   *
   * プロバイダが返した実測（`usage`）があればそれを使い、無ければ見積もる。
   * **見積もりでも判定する**——実測が来ない構成（テスト・一部プロバイダ）で章立てが
   * 黙って働かなくなるのは、閾値が無いのと同じだから。
   */
  contextTokens(): number | undefined {
    return this.harness.contextTokens();
  }

  /**
   * 判定に使う文脈長。**ハーネスが知っていればそちらが勝つ**（決定97・task-0104）。
   *
   * 渡される既定はこの会話の pi モデルのもの——バックエンドを Claude に替えても
   * ローカルモデルの文脈長で測っていて、区切る位置がまるで違っていた。
   */
  private contextWindow(): number | undefined {
    return this.harness.contextWindow?.() ?? this.options.contextWindow;
  }

  /**
   * 閾値を超えているか。
   *
   * **判定の分岐は変えていない**（a4）——早期 return の位置・条件は元のまま。
   * 変えたのは、どの分岐で return するときも `evaluate()` を通して結果を憶える
   * ようにしたところだけ（a1）。
   */
  shouldClose(): boolean {
    const window = this.contextWindow();
    const ratio = this.options.thresholdRatio ?? DEFAULT_CHAPTER_THRESHOLD_RATIO;
    if (!window || window <= 0) {
      return this.evaluate({ tokens: undefined, window, thresholdRatio: ratio, willClose: false });
    }
    if (this.harness.messageCount() < (this.options.minMessages ?? DEFAULT_MIN_MESSAGES)) {
      return this.evaluate({ tokens: this.contextTokens(), window, thresholdRatio: ratio, willClose: false });
    }
    const tokens = this.contextTokens();
    if (tokens === undefined) {
      return this.evaluate({ tokens: undefined, window, thresholdRatio: ratio, willClose: false });
    }
    return this.evaluate({ tokens, window, thresholdRatio: ratio, willClose: tokens >= window * ratio });
  }

  /**
   * `shouldClose()` の1回分を記録し、必要なら journal へ出す（a1・a2）。
   *
   * ここを判定の唯一の出口にすることで、「判定したのに記録し忘れる」経路を無くす。
   */
  private evaluate(fields: Omit<ChapterEvaluation, "at">): boolean {
    const ev: ChapterEvaluation = { at: Date.now(), ...fields };
    this.lastEvaluation = ev;
    this.maybeLog(ev);
    this.checkStale(ev);
    return ev.willClose;
  }

  /** 値が動いたと見なす最小差分（tokens/window の比率）。 */
  private static readonly LOG_RATIO_DELTA = 0.05;
  /** 動かなくても、この間隔では journal に一度は出す（間引きすぎて痕跡が消えるのを防ぐ）。 */
  private static readonly LOG_INTERVAL_MS = 30 * 60 * 1000;

  /**
   * 判定結果を journal へ出す（a1）。**毎ターンは出さない**——比率が動いたとき、
   * または最後に出してから一定時間（`LOG_INTERVAL_MS`）が経ったときだけ出す。
   * 後者が無いと、比率がぴったり同じ値で張り付いたときに一切記録が残らず、
   * 「畳めていない期間」があとから journal を読んでも分からなくなる。
   */
  private maybeLog(ev: ChapterEvaluation): void {
    const ratio = ev.window && ev.tokens !== undefined ? ev.tokens / ev.window : undefined;
    const moved =
      ratio !== undefined &&
      (this.lastLoggedRatio === undefined ||
        Math.abs(ratio - this.lastLoggedRatio) >= ChapterKeeper.LOG_RATIO_DELTA);
    const dueByInterval =
      this.lastLoggedAt === undefined || ev.at - this.lastLoggedAt >= ChapterKeeper.LOG_INTERVAL_MS;
    if (!moved && !dueByInterval) return;
    this.lastLoggedAt = ev.at;
    this.lastLoggedRatio = ratio;
    console.log(
      `[banto] ${this.options.threadId} 章判定: tokens=${ev.tokens ?? "?"} window=${ev.window ?? "?"} ` +
        `threshold=${ev.thresholdRatio} willClose=${ev.willClose}`,
    );
  }

  /**
   * 「長く章が畳めていない」ことを知らせる（a2・inc-0075）。
   *
   * **「畳むべきなのに畳めていない」までは厳密に見分けない。** それをやるには
   * 「文脈がどれだけ伸びれば畳むべきか」を決める必要があり、今回は閾値0.6の
   * 見直し自体が幹の裁定で保留になっている（正確な計測になった結果、いまは
   * 遅め＝安全側に倒れているため）。まず「畳まないこと自体は異常ではない」
   * 前提の上で、**最後に閉じてから長い時間が経っている**ことだけを知らせる。
   * 過検知でうるさくするより、静かに止まる事故（inc-0075）を防ぐのが目的。
   *
   * **閾値0.6を見直すときは**、ここで出す `ratio`（tokens/window）を実際に章が
   * 閉じた時点で集めて分布を見るとよい——inc-0075 の時点では実測 約0.30 で、
   * 0.6 の半分だった。「畳まれた章の ratio がどこに集まっているか」が、
   * 下げるべきかどうかの判断材料になる。
   */
  private checkStale(ev: ChapterEvaluation): void {
    const staleAfterMs = this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const since = ev.at - (this.lastClosedAt ?? this.startedAt);
    if (since < staleAfterMs) return;
    // 一度出したら、次はさらに staleAfterMs 経つまで出さない（間引く）
    if (this.lastStaleWarnAt !== undefined && ev.at - this.lastStaleWarnAt < staleAfterMs) return;
    this.lastStaleWarnAt = ev.at;
    const hours = (since / (60 * 60 * 1000)).toFixed(1);
    const ratio = ev.window && ev.tokens !== undefined ? (ev.tokens / ev.window).toFixed(2) : "?";
    console.warn(
      `[banto] ${this.options.threadId} は${hours}時間、章を1本も畳んでいません` +
        `（tokens=${ev.tokens ?? "?"} window=${ev.window ?? "?"} ratio=${ratio} threshold=${ev.thresholdRatio}）。` +
        "畳まないこと自体は異常ではない（文脈が伸びていなければ不要）が、続くようなら見ておくこと。",
    );
    this.options.onLongWithoutClose?.({ threadId: this.options.threadId, sinceMs: since, evaluation: ev });
  }

  /** 閾値を超えていれば章を閉じる。超えていなければ何もしない。 */
  async maybeCloseChapter(): Promise<HandoffRecord | undefined> {
    if (this.closing) return undefined;
    if (!this.shouldClose()) return undefined;
    return this.closeChapter();
  }

  /**
   * いま章を閉じる（閾値に依らない。PO・番頭が明示的に区切るときにも使う）。
   *
   * I2: 資料を書けなかったら**畳まない**。引き継ぎの無いまま文脈だけ消えるのが
   *     いちばん困る——それはコンパクションの失敗より悪い。
   */
  async closeChapter(): Promise<HandoffRecord | undefined> {
    if (this.closing) return undefined;
    this.closing = true;
    // 掛け金を掛けてから畳む。**掛ける前に await を挟まない**——挟むと、その隙に
    // 届いた発話が「畳んでいない」と見て古いセッションへ入る（imp-0052）
    let release: () => void = () => {};
    this.settled = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    try {
      const { store, threadId, summarize } = this.options;
      const harness = this.harness;
      if (harness.messageCount() === 0) return undefined;

      const chapter = store.nextChapter(threadId);
      const transcript = harness.transcript();
      const handoff = await summarize({ transcript, chapter });

      // 退避したものの索引を資料へ足す。**要約器の出力の後ろに機械的に付ける**——
      // 要約器が書いてくれることを当てにしない（PO指摘 2026-08-05）
      const artifacts = this.options.artifacts?.list() ?? [];
      const index = renderArtifactIndex(artifacts);
      const body = index === "" ? handoff.body : `${handoff.body.trimEnd()}\n\n${index}`;

      const record = store.write({ threadId, summary: handoff.summary, body });

      const tokensBefore = this.contextTokens() ?? 0;
      /**
       * **文脈を捨てて、種から始め直す**（ADR-0020 決定93）。
       *
       * 「境界より前は1件も残さない」という意図は、以前は pi の語彙
       * （`appendCompaction(keepNothing)` ＋ `buildSessionContext`）で書かれていた。
       * ハーネスの語彙へ移したので、Agent SDK では `query()` の起こし直しとして
       * 同じ意味が実装できる。
       */
      await harness.startChapter({
        text: renderChapterOpening(record, { artifactCount: artifacts.length }),
        tokensBefore,
        chapter: record.chapter,
        handoffId: record.id,
      });

      // 記憶の抽出はここが唯一の発火点（explicit gate）。**待たない**——
      // 資料は既に書けており文脈も畳んだので、抽出の遅れで会話を止める理由が無い
      // （task-0022 a5）。失敗はログに残す（I2）
      if (this.options.extractMemories) {
        void this.options.extractMemories(transcript).catch((err: unknown) => {
          console.error(`[banto] ${threadId} の記憶抽出に失敗しました: ${String(err)}`);
        });
      }

      // a2: 「長く畳めていない」の起点をここでリセットする。次に鳴るのはまた
      // staleAfterMs 経ってから
      this.lastClosedAt = Date.now();
      this.lastStaleWarnAt = undefined;
      this.options.onChapterClosed?.(record);
      return record;
    } finally {
      this.closing = false;
      /**
       * **必ず放す**（I2）。畳めなかったとき・要約器が投げたときも待たせたままにしない
       * ——放さないと、畳み中に届いた発話がどこへも届かずに消える（imp-0052）。
       * 順序は `finally` のここ1点でしか解かないので、待っている発話は届いた順に流れる。
       */
      const gate = this.settled;
      this.settled = undefined;
      gate?.release();
    }
  }
}

/**
 * 章を閉じるときに要約器へ渡す書き起こし。
 *
 * **PO の発言と番頭の発話に限る**（決定28：ツール出力からは抽出しない）。ここで
 * ファイルの中身や Web ページを混ぜると、外部の文字列が引き継ぎ資料を汚し、
 * それが次の章の前提として効き続ける。
 */
export function renderTranscript(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text.trim() === "") continue;
    lines.push(`${message.role === "user" ? "PO" : "番頭"}: ${text}`);
  }
  return lines.join("\n\n");
}

/** メッセージの本文を取り出す。ツール呼び出し・ツール結果は落とす。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
}
