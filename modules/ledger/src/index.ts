/**
 * ledger モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * **中核同梱だが、口は他のモジュールと同じ**（要件 C13）。
 */

import { defineModule, ok, type BantoModule, type DefinedModule } from '@banto/module-kit';
import { EventLog } from '@banto/core';
import { z } from 'zod';

import { LedgerCore } from './core.js';

export const manifest: BantoModule = {
  id: 'ledger',
  description: 'イベントログの面。判断を立てる・答える・読む（任意の追記は開けない）',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['ledger'],
};

export function ledgerModule(log: EventLog): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new LedgerCore(log),
    tools: (tool) => [
      tool({
        name: 'request_decision',
        description:
          'Raise something a human must decide. Idempotent per decisionId: raising the same id twice does nothing.',
        input: {
          decisionId: z.string().describe('Caller-chosen id. Same id = same decision.'),
          source: z.enum(['thread', 'factory', 'observer']).describe('Where this came from'),
          threadId: z.string().nullable().describe('Thread it belongs to, or null'),
          question: z.string().describe('What the human has to decide'),
          options: z
            .array(
              z.object({
                id: z.string().describe('Key the requester reads. Not the label.'),
                label: z.string(),
                detail: z.string().optional().describe('What happens if this is chosen'),
              }),
            )
            .optional()
            .describe('Offered choices. Answering is never limited to these.'),
        },
        output: { decisionId: z.string() },
        // exactOptionalPropertyTypes: undefined を渡すのとキーを省くのは別扱い。
        // **黙って undefined を通さない**——省くなら省く。`detail` も同じ理由で組み直す。
        run: async (core, { options, ...rest }) => ({
          decisionId: await core.requestDecision({
            ...rest,
            ...(options === undefined
              ? {}
              : {
                  options: options.map((o) => ({
                    id: o.id,
                    label: o.label,
                    ...(o.detail === undefined ? {} : { detail: o.detail }),
                  })),
                }),
          }),
        }),
        summary: (v) => v.decisionId,
      }),
      tool({
        name: 'resolve_decision',
        description:
          'Answer a pending decision. Pass optionId to pick an offered choice, or omit it and write your own answer — none of the choices fitting is a normal case. The answer is delivered back into the thread’s conversation.',
        input: {
          decisionId: z.string().describe('Decision to answer'),
          answer: z.string().describe('The answer, in words'),
          optionId: z
            .string()
            .optional()
            .describe('Id of the chosen option. Omit to answer freely.'),
        },
        output: {
          decisionId: z.string(),
          optionId: z.string().nullable(),
          deliveredTo: z.string().nullable().describe('Thread the answer was delivered to'),
        },
        run: async (core, { decisionId, answer, optionId }) =>
          core.resolveDecision(decisionId, answer, optionId),
        summary: (v) =>
          `${v.decisionId}: ${v.optionId ?? '自由文'}` +
          (v.deliveredTo === null ? '（返す会話は無い）' : `→ ${v.deliveredTo}`),
      }),
      tool({
        name: 'pending_decisions',
        description: 'List decisions waiting on a human, oldest first.',
        input: {},
        run: async (core) => ok(JSON.stringify(await core.pending(), null, 2)),
      }),
      tool({
        name: 'read_events',
        description: 'Read the event log as-is, optionally filtered to one thread. Nothing is folded.',
        input: { threadId: z.string().optional().describe('Filter to this thread') },
        run: async (core, { threadId }) => ok(JSON.stringify(await core.read(threadId))),
      }),
    ],
  });
}

export { LedgerCore } from './core.js';
export {
  ConversationCore,
  conversationModule,
  manifest as conversationManifest,
  type ResolveReference,
} from './conversation.js';
