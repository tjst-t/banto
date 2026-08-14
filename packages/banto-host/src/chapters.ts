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
}

/** 既定の閾値。提案§6 論点2。 */
export const DEFAULT_CHAPTER_THRESHOLD_RATIO = 0.6;
/** 既定の下限。task-0056 a2「数往復未満の短い会話では引き継ぎを生成しない」。 */
export const DEFAULT_MIN_MESSAGES = 4;

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
  private unsubscribe: (() => void) | undefined;

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

  /** 閾値を超えているか。 */
  shouldClose(): boolean {
    const window = this.contextWindow();
    if (!window || window <= 0) return false;
    if (this.harness.messageCount() < (this.options.minMessages ?? DEFAULT_MIN_MESSAGES)) {
      return false;
    }
    const tokens = this.contextTokens();
    if (tokens === undefined) return false;
    const ratio = this.options.thresholdRatio ?? DEFAULT_CHAPTER_THRESHOLD_RATIO;
    return tokens >= window * ratio;
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

      this.options.onChapterClosed?.(record);
      return record;
    } finally {
      this.closing = false;
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
