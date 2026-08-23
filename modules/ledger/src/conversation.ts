/**
 * **いま話している会話の面**（要件 C14・決定19）。中核同梱だが、口は他と同じ（C13）。
 *
 * 持っているのは1つだけ——**AI が「これを見て」と指す**道具。
 *
 * ## なぜ道具にしたか（測ってから決めた）
 *
 * MCP には `resource_link` という正しい機構があり、道具の結果に混ぜられる。
 * **しかし Agent SDK はそれをテキストに潰す**（実測 2026-08-21）：
 *
 * ```
 * tool_result: [{"type":"text","text":"更新しました"},
 *               {"type":"text","text":"[Resource link: README.md] banto://fs/file/README.md"}]
 * ```
 *
 * `PostToolUse` フックで受けても同じだった。**その文字列を解くのは、
 * 「口を跨ぐ代償として文字列を解く」のやり直し**なので採らない。
 * 一方 `structuredContent` は潰れずに届くことも測った——つまり
 * **型の決まった道具呼び出しなら、構造は banto まで来る。**
 *
 * だから**指すことを AI の明示的な行いにする**。要件の言葉も
 * 「AI が認識してユーザに動的に提示できる」で、**AI が選んで見せる**ことそのものである。
 *
 * ## スレッドは束ねる。引数にしない
 *
 * `threadId` を引数にすると、**AI が他人の会話を指せてしまう**。
 * ここは会話ごとに1つ立てて、スレッドを閉じ込める——
 * `requiredRoot` が作業範囲を閉じ込めるのと同じ考え（要件 D4）。
 */

import { defineModule, type BantoModule, type DefinedModule } from '@banto/module-kit';
import {
  EventLog,
  appendBase as appendBaseGate,
  fold,
  invalidateBase as invalidateBaseGate,
  reactivateBase as reactivateBaseGate,
  type BaseGate,
  type InvalidateGate,
} from '@banto/core';
import { z } from 'zod';

export const manifest: BantoModule = {
  id: 'conversation',
  description: 'いま話している会話の面。見せたいものを指す',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['conversation'],
};

/** `banto://` URI を持ち主のモジュールへ読みに行く。存在しなければ投げる。 */
export type ResolveReference = (
  uri: string,
) => Promise<{ readonly text: string; readonly mimeType: string | null }>;

export class ConversationCore {
  constructor(
    private readonly log: EventLog,
    private readonly threadId: string,
    private readonly resolve: ResolveReference,
    private readonly baseLimit: number,
  ) {}

  /**
   * 見せたいものを指す。**開かない**（決定19）。
   *
   * 開くかどうかは人が決める——指しは会話に並ぶだけである。
   * 中身はここに写さない。開くときに持ち主のモジュールへ読みに行く（規則3）。
   *
   * **記録する前に、実在するか確かめる**（規則1・2、実測 2026-08-22）。
   * 確かめずに記録すると、AI が作文した uri（例：`banto://banto-v3/README.md`
   * ——どのモジュールも持っていない）がそのまま会話に残り、人が開こうとした
   * ときに初めて壊れていたと分かる。**自己申告を信頼しない**のは自分自身の
   * 出力にも掛かる。
   */
  async show(input: {
    uri: string;
    name?: string | undefined;
    mimeType?: string | undefined;
    note?: string | undefined;
  }): Promise<{ uri: string; shownIn: string }> {
    // 握りつぶさない（規則2）。**持ち主が分からない URI を黙って受けない**——
    // 受けると、人が開こうとしたときに初めて壊れる。
    let parsed: URL;
    try {
      parsed = new URL(input.uri);
    } catch {
      throw new Error(`URI として読めない: ${input.uri}`);
    }
    if (parsed.protocol !== 'banto:') {
      throw new Error(
        `banto:// の URI だけを指せる: ${input.uri}` +
          `（モジュールが持っているものを指す。外部の URL は本文に書く）`,
      );
    }

    try {
      await this.resolve(input.uri);
    } catch (cause) {
      throw new Error(
        `${input.uri} は実在しない（${cause instanceof Error ? cause.message : String(cause)}）。` +
          `道具が返した uri だけを渡せる——自分で作文しない。`,
      );
    }

    await this.log.append({
      type: 'reference.recorded',
      threadId: this.threadId,
      uri: input.uri,
      // 名前が無ければ URI をそのまま出す。**当てずっぽうで縮めない。**
      name: input.name ?? input.uri,
      mimeType: input.mimeType ?? null,
      note: input.note ?? null,
    });

    return { uri: input.uri, shownIn: this.threadId };
  }

  /**
   * base への追記を、AI からも呼べる口にする（バックログ「AI が base へ自分で
   * 書き込む」・2026-08-22）。**ゲートは `appendBase` に1本化されている**
   * （`LedgerCore` の同じ注記を見よ）——ここで `log.append` を直に呼ばず、
   * 人の追記（`POST /api/base`）と同じ入口を通す。二重の入口を作らない（規則3）。
   *
   * 断られても例外にしない。**閾値超えは「止まる」であって「壊れた」ではない**
   * （`base.ts` の設計）——`appendBase` 自身が決定待ちを立てるので、ここは
   * その結果をそのまま返すだけでよい。
   */
  async appendToBase(input: { text: string }): Promise<BaseGate> {
    const state = fold(await this.log.read());
    return appendBaseGate(this.log, state, this.threadId, input.text, this.baseLimit);
  }

  /**
   * 訂正は無効化で行う（PO指摘 2026-08-22）。**削除ではない**——`base.appended`
   * はログに残ったまま、`effectiveBase` がこの行を読み飛ばすようになるだけ。
   * 追記で訂正するより良い理由：無効化した行の文字数は閾値の予算から外れる
   * ——訂正のたびに base が肥えていくのを避けられる。
   *
   * 自分のスレッドが自分で追記した行だけを対象にできる（`invalidateBase` が強制）。
   */
  async invalidateBase(input: { baseVersion: number }): Promise<InvalidateGate> {
    const state = fold(await this.log.read());
    return invalidateBaseGate(this.log, state, this.threadId, input.baseVersion);
  }

  /** `invalidateBase` の逆。無効化した行を、また効くようにする。 */
  async reactivateBase(input: { baseVersion: number }): Promise<InvalidateGate> {
    const state = fold(await this.log.read());
    return reactivateBaseGate(this.log, state, this.threadId, input.baseVersion);
  }
}

/**
 * その会話に束ねた面を1つ作る。**スレッドごとに立てる。**
 *
 * `baseLimit` は呼び手（host）が持つ既定値をそのまま渡してもらう——ここで
 * 独自の既定値は持たない。既定は `DEFAULT_BASE_LIMIT_CHARACTERS` の1箇所だけ
 * （規則3）。
 */
export function conversationModule(
  log: EventLog,
  threadId: string,
  resolve: ResolveReference,
  baseLimit: number,
): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new ConversationCore(log, threadId, resolve, baseLimit),
    tools: (tool) => [
      tool({
        name: 'show',
        description:
          'Point the person at something so it appears in this conversation for them to open. ' +
          'Call this both when they ask you to open, show, or look at something, and when you ' +
          'produce or change something unprompted that they would want to see — describing the ' +
          'content in your reply is not a substitute for calling this. Pass a banto:// uri that a ' +
          'module owns — use the exact uri another tool just returned to you, never one you ' +
          'construct yourself. This checks the uri resolves before recording it, so a made-up uri ' +
          'is declined, not silently shown. This does not open anything — the person decides ' +
          'whether to look. If you have no uri for something (you only read its content, or no ' +
          'tool gave you one), say so instead of guessing one.',
        input: {
          uri: z.string().describe('banto:// uri owned by a module'),
          name: z.string().optional().describe('Short label for the person'),
          mimeType: z.string().optional().describe('Hint for how to render it'),
          note: z.string().optional().describe('One line on why they should look'),
        },
        output: { uri: z.string(), shownIn: z.string() },
        run: async (core, input) => core.show(input),
        summary: (v) => `会話に出した: ${v.uri}`,
      }),
      tool({
        name: 'append_base',
        description:
          "Permanently record a fact or decision for this conversation, separate from the " +
          "message history. This is the durable record that survives context compaction and " +
          "carries over when the person forks this conversation — call it when you and the " +
          "person settle something that later turns (or forks) need to know, not for things " +
          "that are only useful right now. Keep entries concise and only write settled " +
          "conclusions, not scratch notes or things still being discussed — if you get one " +
          "wrong, call invalidate_base on it rather than appending a correction on top. There " +
          "is a size limit: past it, the append is declined (not silently dropped) and the " +
          "person is asked whether to start a fresh conversation instead — check the ok field " +
          "and tell the person if it was declined.",
        input: {
          text: z.string().describe('The fact or decision to append, as one durable line'),
        },
        output: {
          ok: z.boolean(),
          baseVersion: z.number().optional().describe('Present when ok is true'),
          reason: z.string().optional().describe('Present when ok is false'),
          characters: z.number(),
          wouldBe: z.number().optional().describe('Present when ok is false'),
          limit: z.number(),
        },
        run: async (core, input) => core.appendToBase(input),
        summary: (v) =>
          v.ok
            ? `決まったことに追記した（第${v.baseVersion}版、${v.characters}/${v.limit}文字）`
            : `追記を断った: ${v.reason}`,
      }),
      tool({
        name: 'invalidate_base',
        description:
          "Retract a fact you (or the person) previously recorded with append_base, because it " +
          "turned out wrong or is no longer true. This does not delete it — it stops counting " +
          "toward the size limit and stops being shown to future turns and forks, but the " +
          "original record stays in history. Prefer this over appending a correction on top: " +
          "a correction leaves the wrong fact still consuming budget, this frees it. You can " +
          "only retract entries this conversation itself appended — pass the baseVersion number " +
          "shown for that entry.",
        input: {
          baseVersion: z.number().describe('The baseVersion of the entry to retract'),
        },
        output: {
          ok: z.boolean(),
          reason: z.string().optional().describe('Present when ok is false'),
        },
        run: async (core, input) => core.invalidateBase(input),
        summary: (v) => (v.ok ? '無効化した' : `無効化を断った: ${v.reason}`),
      }),
      tool({
        name: 'reactivate_base',
        description:
          'Undo invalidate_base — make a previously retracted entry count again. Same ' +
          'restriction: only entries this conversation itself appended.',
        input: {
          baseVersion: z.number().describe('The baseVersion of the entry to reactivate'),
        },
        output: {
          ok: z.boolean(),
          reason: z.string().optional().describe('Present when ok is false'),
        },
        run: async (core, input) => core.reactivateBase(input),
        summary: (v) => (v.ok ? '有効化した' : `有効化を断った: ${v.reason}`),
      }),
    ],
  });
}
