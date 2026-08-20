/**
 * host（apps/host/src/server.ts）の口を叩くだけの薄い層。
 *
 * ここでは何も畳まない・何も覚えない——状態は呼び出しのたびに API から取り直す
 * （規則3）。失敗はここで飲み込まず、呼び手に投げる（規則2）。
 */

import type { CreateThreadResponse, StateResponse, StreamEvent } from './types';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return (await res.json()) as T;
}

export async function fetchState(): Promise<StateResponse> {
  const res = await fetch('/api/state');
  return asJson<StateResponse>(res);
}

export async function createThread(body: {
  channelName?: string;
  title?: string;
}): Promise<CreateThreadResponse> {
  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson<CreateThreadResponse>(res);
}

/**
 * `/api/prompt` は SSE をレスポンスボディとして返す（EventSource は使えない——
 * POST の応答なので `fetch` + ストリーム読みで自前でパースする。README の通り）。
 *
 * `data: <json>\n\n` の並びを1フレームずつ切り出して yield する。
 * 切れ目をまたいだチャンクにも対応するため、バッファに残りを持ち越す。
 */
export async function* streamPrompt(
  threadId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch('/api/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, text }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length));
        if (dataLines.length === 0) continue;

        const parsed = JSON.parse(dataLines.join('\n')) as StreamEvent;
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
