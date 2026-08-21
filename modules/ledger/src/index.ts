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
        },
        run: async (core, input) => ok(await core.requestDecision(input)),
      }),
      tool({
        name: 'resolve_decision',
        description: 'Answer a pending decision. Fails if it is not pending.',
        input: {
          decisionId: z.string().describe('Decision to answer'),
          answer: z.string().describe('The answer'),
        },
        run: async (core, { decisionId, answer }) => ok(await core.resolveDecision(decisionId, answer)),
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
