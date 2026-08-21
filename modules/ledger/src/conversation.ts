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
import { EventLog } from '@banto/core';
import { z } from 'zod';

export const manifest: BantoModule = {
  id: 'conversation',
  description: 'いま話している会話の面。見せたいものを指す',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['conversation'],
};

export class ConversationCore {
  constructor(
    private readonly log: EventLog,
    private readonly threadId: string,
  ) {}

  /**
   * 見せたいものを指す。**開かない**（決定19）。
   *
   * 開くかどうかは人が決める——指しは会話に並ぶだけである。
   * 中身はここに写さない。開くときに持ち主のモジュールへ読みに行く（規則3）。
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
}

/** その会話に束ねた面を1つ作る。**スレッドごとに立てる。** */
export function conversationModule(log: EventLog, threadId: string): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new ConversationCore(log, threadId),
    tools: (tool) => [
      tool({
        name: 'show',
        description:
          'Point the person at something you produced or changed, so it appears in this conversation. ' +
          'Pass a banto:// uri that a module owns (for example the uri another tool just returned). ' +
          'This does not open anything — the person decides whether to look. Use it whenever you ' +
          'change or produce something they would want to see.',
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
    ],
  });
}
