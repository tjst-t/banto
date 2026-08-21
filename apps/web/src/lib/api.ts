/**
 * host（apps/host/src/server.ts）の口を叩くだけの薄い層。
 *
 * ここでは何も畳まない・何も覚えない——状態は呼び出しのたびに API から取り直す
 * （規則3）。失敗はここで飲み込まず、呼び手に投げる（規則2）。
 */

import type {
  BaseResponse,
  CreateThreadResponse,
  RequestRunResponse,
  ResourceResponse,
  StateResponse,
  StreamEvent,
} from './types';

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
 * その会話の**過去のイベントをそのまま**取る（要件 A8）。
 *
 * **畳んで返してもらわない。** サーバは生のイベントを返し、並べ替えも解釈も
 * こちら側でやる——画面用の形をサーバに作らせると、それが第二の真実になる（規則3）。
 */
export async function fetchEvents(threadId: string): Promise<StreamEvent[]> {
  const res = await fetch(`/api/events?threadId=${encodeURIComponent(threadId)}`);
  const body = await asJson<{ events: StreamEvent[] }>(res);
  return body.events;
}

/** 依頼を1件投げる（要件 B1）。**投げるだけで、進まない。** */
export async function requestRun(body: {
  request: string;
  channelName?: string;
}): Promise<RequestRunResponse> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson<RequestRunResponse>(res);
}

/**
 * Factory を進める。**押したときだけ動く。**
 *
 * 時計で回さないのは、画面を閉じている間に Claude の枠を使い続けることになるため。
 * 「誰が動かしたか」が押した本人に分かる形にしてある。
 */
export async function advanceRuns(): Promise<StateResponse> {
  const res = await fetch('/api/runs/advance', { method: 'POST', body: '{}' });
  return asJson<StateResponse>(res);
}

/**
 * AI が指したものを読む（要件 C14）。**持ち主のモジュールに聞く。**
 * 画面は中身を覚えない——開くたびに読むので、いつでも現物である（規則3）。
 */
export async function fetchResource(uri: string): Promise<ResourceResponse> {
  const res = await fetch(`/api/resource?uri=${encodeURIComponent(uri)}`);
  return asJson<ResourceResponse>(res);
}

/** いまそのスレッドで決まっていること（要件 R2・R6）。 */
export async function fetchBase(threadId: string): Promise<BaseResponse> {
  const res = await fetch(`/api/base?threadId=${encodeURIComponent(threadId)}`);
  return asJson<BaseResponse>(res);
}

/**
 * 決まったことに1行足す（要件 R2）。**R8 のゲートを通る唯一の入口**（決定4）。
 *
 * 閾値を超えていれば host は 409 を返す。**ここで握りつぶさない**——
 * 断られたことと理由を、呼び手がそのまま画面に出す（規則2）。
 * **黙って新しい会話へ切り替えない**（決定4）。
 */
export async function appendBase(body: { threadId: string; text: string }): Promise<BaseResponse> {
  const res = await fetch('/api/base', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await asJson<unknown>(res);
  return fetchBase(body.threadId);
}

/**
 * 判断に答える（要件 A6）。**選ぶことも、自由に書くこともできる。**
 *
 * `optionId` を省くと自由文の答えになる。**選択肢が在っても、そうしてよい**——
 * どれも選べないのは普通のことなので、画面もそれを塞がない。
 */
export async function resolveDecision(body: {
  decisionId: string;
  answer: string;
  optionId?: string;
}): Promise<StateResponse> {
  const res = await fetch('/api/decisions/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await asJson<{ state: StateResponse }>(res);
  return result.state;
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
