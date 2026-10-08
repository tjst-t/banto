// **CDP の Network の知らせを、通信の記録に写す**（v4-modules.md §4.1「通信の記録」）。タブ1つにつき1つ。
// CDP が復号済みの要求と応答を返すので、TLS を割る代理も証明書も要らない。
//
// 実のヘッダ（Cookie・Set-Cookie を含む）は `…ExtraInfo` の知らせで別に来る。来る順は決まっていない
// （本体より先に来ることもある）ので、どちらが先でも合わせる。

import type { NetworkLog } from "./network-log.js";

/** CDP のセッションのうち、ここで使う形だけ（Playwright の CDPSession を渡す） */
export interface CdpLike {
  on(event: string, listener: (params: Record<string, unknown>) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface CdpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

interface CdpResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  mimeType?: string;
  timing?: Record<string, number>;
}

interface Live {
  recordId: string;
  /** CDP の時計（秒・単調） */
  startTs: number;
}

export interface RecorderOptions {
  /** 本文を取りにいかない（試験で CDP を偽物にするとき） */
  skipBodies?: boolean;
}

export function attachRecorder(log: NetworkLog, tab: () => string, cdp: CdpLike, opts: RecorderOptions = {}): void {
  const live = new Map<string, Live>();
  const extraRequestHeaders = new Map<string, Record<string, string>>();
  const extraResponseHeaders = new Map<string, Record<string, string>>();
  /** CDP の単調な時計 → 壁の時計（ms）。最初の要求の wallTime から決める */
  let offsetMs: number | undefined;
  const wall = (ts: unknown) => (typeof ts === "number" && offsetMs !== undefined ? ts * 1000 + offsetMs : Date.now());

  const kindOf = (type: string) => (type === "websocket" ? "websocket" : type === "eventsource" ? "eventsource" : "http");

  const start = (requestId: string, request: CdpRequest, type: string, ts: number, wallTime: number | undefined) => {
    if (wallTime !== undefined && offsetMs === undefined) offsetMs = wallTime * 1000 - ts * 1000;
    const extra = extraRequestHeaders.get(requestId);
    extraRequestHeaders.delete(requestId);
    const record = log.startRecord({
      tab: tab(),
      kind: kindOf(type),
      method: request.method,
      url: request.url,
      type,
      startedAt: wallTime !== undefined ? wallTime * 1000 : wall(ts),
      requestHeaders: extra ?? request.headers,
    });
    live.set(requestId, { recordId: record.id, startTs: ts });
    if (request.postData !== undefined) {
      log.setBody(record.id, "req", Buffer.from(request.postData), false);
    } else if (request.hasPostData && !opts.skipBodies) {
      cdp.send("Network.getRequestPostData", { requestId }).then(
        (r) => log.setBody(record.id, "req", Buffer.from((r as { postData: string }).postData), false),
        () => undefined, // 本文がもう無い——要求の本文は「なし」のまま（応答と違い理由を持つ欄が無い）
      );
    }
    return record.id;
  };

  const applyResponse = (recordId: string, requestId: string, response: CdpResponse) => {
    const extra = extraResponseHeaders.get(requestId);
    extraResponseHeaders.delete(requestId);
    log.update(recordId, {
      status: response.status,
      ...(response.statusText ? { statusText: response.statusText } : {}),
      responseHeaders: extra ?? response.headers,
      ...(response.mimeType ? { mimeType: response.mimeType } : {}),
      ...(response.timing ? { timing: response.timing } : {}),
    });
  };

  cdp.on("Network.requestWillBeSent", (p) => {
    const requestId = p.requestId as string;
    const ts = p.timestamp as number;
    const type = String(p.type ?? "other").toLowerCase();
    const existing = live.get(requestId);
    if (existing && p.redirectResponse) {
      // 転送：前の1件を転送の応答で閉じ、同じ requestId で次の1件を始める
      applyResponse(existing.recordId, requestId, p.redirectResponse as CdpResponse);
      log.update(existing.recordId, { done: true, durationMs: (ts - existing.startTs) * 1000 });
    }
    start(requestId, p.request as CdpRequest, type, ts, p.wallTime as number | undefined);
  });

  cdp.on("Network.requestWillBeSentExtraInfo", (p) => {
    const requestId = p.requestId as string;
    const headers = p.headers as Record<string, string>;
    const l = live.get(requestId);
    if (l) log.update(l.recordId, { requestHeaders: headers });
    else extraRequestHeaders.set(requestId, headers);
  });

  cdp.on("Network.responseReceived", (p) => {
    const l = live.get(p.requestId as string);
    if (l) applyResponse(l.recordId, p.requestId as string, p.response as CdpResponse);
  });

  cdp.on("Network.responseReceivedExtraInfo", (p) => {
    const requestId = p.requestId as string;
    const headers = p.headers as Record<string, string>;
    const l = live.get(requestId);
    // 本体の応答が先に来ていれば上書き、まだなら取っておく
    const record = l ? log.get(l.recordId) : undefined;
    if (l && record?.status !== undefined) log.update(l.recordId, { responseHeaders: headers });
    else extraResponseHeaders.set(requestId, headers);
  });

  cdp.on("Network.loadingFinished", (p) => {
    const requestId = p.requestId as string;
    const l = live.get(requestId);
    if (!l) return;
    live.delete(requestId);
    const record = log.get(l.recordId);
    log.update(l.recordId, {
      durationMs: ((p.timestamp as number) - l.startTs) * 1000,
      encodedBytes: p.encodedDataLength as number,
      ...(record?.kind === "eventsource" ? { closedAt: wall(p.timestamp) } : {}),
    });
    if (record?.kind !== "http" || opts.skipBodies) {
      log.update(l.recordId, { done: true });
      return;
    }
    cdp.send("Network.getResponseBody", { requestId }).then(
      (r) => {
        const { body, base64Encoded } = r as { body: string; base64Encoded: boolean };
        log.setBody(l.recordId, "res", base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body), base64Encoded && !isTextMime(record.mimeType));
        log.update(l.recordId, { done: true });
      },
      (err: Error) => log.update(l.recordId, { done: true, bodyUnavailable: err.message.replace(/^.*?:\s*/, "") }),
    );
  });

  cdp.on("Network.loadingFailed", (p) => {
    const requestId = p.requestId as string;
    const l = live.get(requestId);
    if (!l) return;
    live.delete(requestId);
    const reason = (p.canceled ? "canceled" : "") || (p.blockedReason ? `blocked:${String(p.blockedReason)}` : "") || String(p.errorText ?? "failed");
    log.update(l.recordId, { done: true, failed: reason, durationMs: ((p.timestamp as number) - l.startTs) * 1000 });
  });

  // ---- WebSocket --------------------------------------------------------------------------
  cdp.on("Network.webSocketCreated", (p) => {
    const requestId = p.requestId as string;
    const id = log.startRecord({
      tab: tab(),
      kind: "websocket",
      method: "GET",
      url: p.url as string,
      type: "websocket",
      startedAt: Date.now(),
      requestHeaders: {},
    }).id;
    live.set(requestId, { recordId: id, startTs: NaN });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", (p) => {
    const l = live.get(p.requestId as string);
    if (!l) return;
    l.startTs = p.timestamp as number;
    if (p.wallTime !== undefined && offsetMs === undefined) offsetMs = (p.wallTime as number) * 1000 - (p.timestamp as number) * 1000;
    log.update(l.recordId, {
      requestHeaders: (p.request as { headers: Record<string, string> }).headers,
      ...(p.wallTime !== undefined ? { startedAt: (p.wallTime as number) * 1000 } : {}),
    });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (p) => {
    const l = live.get(p.requestId as string);
    if (!l) return;
    const r = p.response as CdpResponse;
    log.update(l.recordId, {
      status: r.status,
      ...(r.statusText ? { statusText: r.statusText } : {}),
      responseHeaders: r.headers,
      ...(Number.isFinite(l.startTs) ? { durationMs: ((p.timestamp as number) - l.startTs) * 1000 } : {}),
    });
  });
  const frame = (dir: "sent" | "received") => (p: Record<string, unknown>) => {
    const l = live.get(p.requestId as string);
    if (!l) return;
    const r = p.response as { opcode: number; payloadData: string };
    log.addFrame(l.recordId, { dir, at: wall(p.timestamp), opcode: r.opcode, data: r.payloadData });
  };
  cdp.on("Network.webSocketFrameSent", frame("sent"));
  cdp.on("Network.webSocketFrameReceived", frame("received"));
  cdp.on("Network.webSocketFrameError", (p) => {
    const l = live.get(p.requestId as string);
    if (l) log.update(l.recordId, { failed: String(p.errorMessage ?? "frame error") });
  });
  cdp.on("Network.webSocketClosed", (p) => {
    const l = live.get(p.requestId as string);
    if (!l) return;
    live.delete(p.requestId as string);
    log.update(l.recordId, { done: true, closedAt: wall(p.timestamp) });
  });

  // ---- EventSource ------------------------------------------------------------------------
  cdp.on("Network.eventSourceMessageReceived", (p) => {
    const l = live.get(p.requestId as string);
    if (!l) return;
    log.addMessage(l.recordId, {
      at: wall(p.timestamp),
      event: String(p.eventName ?? "message"),
      id: String(p.eventId ?? ""),
      data: String(p.data ?? ""),
    });
  });
}

/** 文字として持ってよい MIME（CDP は文字でも base64 で返すことがある） */
export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return /^text\/|json|javascript|xml|x-www-form-urlencoded|graphql|svg/.test(mime);
}
