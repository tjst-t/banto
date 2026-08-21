/**
 * SDK のメッセージを畳む形を固定する。
 *
 * **ここは実際に壊れた**（2026-08-21）。同じ `message.id` の1通目が `thinking` だけで、
 * id で重複除去してから本文を見ていたため、**相手の発言がログに残らなかった**。
 * 送信中は画面に出るので、開き直すまで誰も気づかない類の壊れ方だった。
 *
 * 本物を1回走らせて見つけたが、**1回走らせただけでは「たまたま通った」と
 * 区別できない**ので、形をここで固定する。
 */

import { describe, expect, it } from 'vitest';

import { AgentSdkRunner, type QueryInput } from './index.js';

const input = { threadId: 't1', queryId: 'q1' } as unknown as QueryInput;

/** SDK が実際に出す形（実測）。thinking だけの通と、text の通が同じ id で続く。 */
const assistant = (id: string, blocks: unknown[], usage = true) =>
  ({
    type: 'assistant',
    message: {
      id,
      content: blocks,
      ...(usage
        ? {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
              output_tokens: 5,
            },
          }
        : {}),
    },
  }) as never;

describe('assistant メッセージの畳み方', () => {
  it('同じ id で thinking → text と来ても、本文が拾える', () => {
    const runner = new AgentSdkRunner();
    const seen = new Set<string>();
    let turn = 0;
    const next = () => turn++;

    const first = runner.translate(input, assistant('msg_1', [{ type: 'thinking' }]), seen, next);
    const second = runner.translate(
      input,
      assistant('msg_1', [{ type: 'text', text: 'はい。' }]),
      seen,
      next,
    );

    const all = [...first, ...second];
    // **本文は毎通から拾う。** 1通目で打ち切ると、ここが 0 件になる。
    expect(all.filter((e) => e.type === 'message.recorded')).toHaveLength(1);
    expect(all.find((e) => e.type === 'message.recorded')).toMatchObject({
      role: 'assistant',
      text: 'はい。',
    });
    // **usage は id ごとに1回だけ。** 数えると 1.81 倍に膨らんだのがこの数字である。
    expect(all.filter((e) => e.type === 'turn.usage')).toHaveLength(1);
  });

  it('thinking と tool_use はログに入れない', () => {
    const events = new AgentSdkRunner().translate(
      input,
      assistant('msg_2', [
        { type: 'thinking', thinking: '考えている' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ]),
      new Set(),
      () => 0,
    );
    expect(events.filter((e) => e.type === 'message.recorded')).toHaveLength(0);
  });

  it('複数の text ブロックは1つにまとめる', () => {
    const events = new AgentSdkRunner().translate(
      input,
      assistant('msg_3', [
        { type: 'text', text: '前半' },
        { type: 'text', text: '後半' },
      ]),
      new Set(),
      () => 0,
    );
    expect(events.find((e) => e.type === 'message.recorded')).toMatchObject({ text: '前半\n後半' });
  });

  // 「測れなかった」と「0 だった」を区別する（toTurnUsage の注記）。
  it('usage が読めなければ、そのターンは数えない', () => {
    const events = new AgentSdkRunner().translate(
      input,
      assistant('msg_4', [{ type: 'text', text: 'ok' }], false),
      new Set(),
      () => 0,
    );
    expect(events.filter((e) => e.type === 'turn.usage')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'message.recorded')).toHaveLength(1);
  });
});
