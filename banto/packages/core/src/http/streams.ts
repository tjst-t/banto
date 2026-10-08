// **画面と Module の間の流れの中継**（決定・2026-10-08、アーキ仕様 §5.8）。
//
// 画面（サンドボックスのオリジンの iframe）→ host の `/api/streams`（WebSocket）→ Module の置き場の UNIX ソケット
// （WebSocket、刻印つき）。**host は中身を解釈しない**——繋がったあとは、両側のメッセージを1通ずつそのまま渡す
// （文字と2進の別も、閉じるときの番号も保つ）。中身はどこにも残さない。開いた・閉じただけを host の記録に書く。
//
// - 札（`issue`）：32 バイトの乱数・30 秒・1回だけ。持ち主・Module・画面の資源・流れの名前・params に結びつける。
//   host のメモリにだけ持つ（起こし直せば無効、画面が取り直す）
// - `/api/streams`：ログインの Cookie を見ず、札だけで通す。Origin はサンドボックスのオリジンだけ。札は最初の1通で
//   （URL はアクセスログに残る）、5 秒待って来なければ閉じる
// - 1通 1 MiB まで（超えたら 1009）。送り先に渡しきれていない量が 4 MiB を超えたら送り元から読むのを止める
//   （大きな待ち行列を持たない）。Nagle を切る・まとめる待ちを入れない・圧縮しない
// - 15 秒ごとに両側へ ping、45 秒返事が無ければ閉じる
// - iframe ごとに 8 本・Project ごとに 64 本（開いている流れと、まだ使われていない札を数える）
// - Module が閉じた・落ちたら画面の側を 1012（起こし直し中）で閉じる。Module が自分の番号（4404 など）で閉じたら
//   それを渡す
// - **いま動いているもの（`/api/admin/activity`）に数えない**——開きっぱなしの端末で起こし直しが待たされないように

import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  encodeStreamStamp,
  STREAM_MAX_MESSAGE_BYTES,
  STREAM_STAMP_HEADER,
  type StreamStamp,
} from "@banto/module-contract";

export const STREAMS_PATH = "/api/streams";
export const STREAM_TICKET_TTL_MS = 30_000;
export const STREAM_FIRST_MESSAGE_MS = 5_000;
export const STREAM_BACKPRESSURE_BYTES = 4 * 1024 * 1024;
export const STREAM_PING_MS = 15_000;
export const STREAM_PONG_TIMEOUT_MS = 45_000;
export const STREAMS_PER_FRAME = 8;
export const STREAMS_PER_PROJECT = 64;
/** 起こし直し中（Module が閉じた・落ちた、banto が止まる） */
export const STREAM_CLOSE_RESTARTING = 1012;
/** 札・Origin が違う */
const CLOSE_POLICY = 1008;
/** 1通が 1 MiB を越えた（どちら向きでも） */
const CLOSE_TOO_BIG = 1009;

/** 札を出すのを断った（HTTP の番号つき） */
export class StreamRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 札に結びつけるもの（host が確かめて組み立てたもの。画面の申告そのままではない） */
export interface StreamTarget {
  /** Module の宣言の名前（画面に見えている名前） */
  server: string;
  /** Module のプロセスの名前（置き場の名前） */
  connName: string;
  /** 待ち受けの host の側のパス */
  socketPath: string;
  stamp: StreamStamp;
  /** どの iframe からか（ログインのセッションと、親が iframe ごとに付けた印） */
  frameKey: string;
}

interface Ticket extends StreamTarget {
  expiresAt: number;
}

interface OpenStream {
  target: StreamTarget;
  client: WebSocket;
  upstream?: WebSocket;
  openedAt: number;
  /** 閉じたのは banto だと記録する（止めるとき、両側を閉じる前に） */
  markClosedByBanto?: (code: number) => void;
}

export interface StreamRelayOptions {
  /** 画面が繋ぐ住所（`wss://<banto>/api/streams`）。CSP の connect-src にも同じものを足す */
  url: string;
  /** 繋いでよい Origin（サンドボックスのオリジン） */
  allowedOrigin: string;
  /** 開閉の記録（既定は host のログ） */
  audit?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  /** 試験で縮める */
  timing?: Partial<{ ticketTtlMs: number; firstMessageMs: number; pingMs: number; pongTimeoutMs: number }>;
}

/** 画面の API の基点（`https://banto…`）から、流れの住所（`wss://banto…/api/streams`）を作る */
export function streamUrlOf(apiBaseUrl: string): string {
  const u = new URL(STREAMS_PATH, apiBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** 送れる閉じる番号か（1005・1006 などは送れない） */
function sendable(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** 閉じる理由は 123 バイトまで */
function reasonText(reason: Buffer | string): string {
  let s = typeof reason === "string" ? reason : reason.toString("utf8");
  while (Buffer.byteLength(s) > 123) s = s.slice(0, -1);
  return s;
}

const hashOf = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export class StreamRelay {
  private readonly tickets = new Map<string, Ticket>();
  private readonly open = new Set<OpenStream>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: STREAM_MAX_MESSAGE_BYTES,
  });
  private readonly now: () => number;
  private readonly audit: (entry: Record<string, unknown>) => void;
  private readonly t: { ticketTtlMs: number; firstMessageMs: number; pingMs: number; pongTimeoutMs: number };
  private readonly allowedOrigin: string;
  private closing = false;

  constructor(private readonly opts: StreamRelayOptions) {
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit ?? ((entry) => console.log("[stream-audit]", JSON.stringify(entry)));
    this.t = {
      ticketTtlMs: STREAM_TICKET_TTL_MS,
      firstMessageMs: STREAM_FIRST_MESSAGE_MS,
      pingMs: STREAM_PING_MS,
      pongTimeoutMs: STREAM_PONG_TIMEOUT_MS,
      ...opts.timing,
    };
    this.allowedOrigin = new URL(opts.allowedOrigin).origin;
  }

  get url(): string {
    return this.opts.url;
  }

  /** いま開いている流れの数（試験・記録用） */
  get openCount(): number {
    return this.open.size;
  }

  /** **札を出す**。上限を越えるなら断る（`StreamRefusal`） */
  issue(target: StreamTarget): { url: string; ticket: string; expiresAt: string } {
    if (this.closing) throw new StreamRefusal(503, "banto を起こし直しています。少し待ってからもう一度開いてください");
    const now = this.now();
    for (const [key, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(key);
    const all = [...this.tickets.values(), ...[...this.open].map((s) => s.target)];
    if (all.filter((t) => t.frameKey === target.frameKey).length >= STREAMS_PER_FRAME) {
      throw new StreamRefusal(429, `1つの画面で同時に開ける流れは ${STREAMS_PER_FRAME} 本までです`);
    }
    const project = target.stamp.projectId;
    if (project !== undefined && all.filter((t) => t.stamp.projectId === project).length >= STREAMS_PER_PROJECT) {
      throw new StreamRefusal(429, `1つの Project で同時に開ける流れは ${STREAMS_PER_PROJECT} 本までです`);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.t.ticketTtlMs;
    this.tickets.set(hashOf(ticket), { ...target, expiresAt });
    return { url: this.opts.url, ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** `/api/streams` への Upgrade なら受けて true。違う口なら false（呼ぶ側が閉じる） */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path !== STREAMS_PATH) return false;
    // Cookie や SameSite では公開先（同じサイト）と区別できないので、Origin で見る
    if (req.headers.origin !== this.allowedOrigin || this.closing) {
      this.audit({ event: "stream.refused", reason: this.closing ? "止めている間" : `Origin が違う（${req.headers.origin ?? "なし"}）` });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (client) => this.accept(client, socket as Socket));
    return true;
  }

  /** 開いている流れを全部閉じる（banto が止まる） */
  closeAll(code = STREAM_CLOSE_RESTARTING, reason = "banto を起こし直しています"): void {
    this.closing = true;
    this.tickets.clear();
    for (const s of [...this.open]) {
      // 先に「banto が閉じた」と記録する——Module の側の閉じる・失敗（繋いでいる途中を切ると error になる）を
      // Module のせいとして書かない
      s.markClosedByBanto?.(code);
      s.client.resume();
      s.client.close(code, reason);
      s.upstream?.close(1001, reason);
    }
  }

  private accept(client: WebSocket, raw: Socket): void {
    // 遅れを足さない（打鍵1つが Nagle で待たされない）
    raw.setNoDelay?.(true);
    const timer = setTimeout(() => {
      this.audit({ event: "stream.refused", reason: "札が届かなかった" });
      client.close(CLOSE_POLICY, "札が届きませんでした");
    }, this.t.firstMessageMs);
    client.once("message", (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      // 札の1通のあと、Module に繋がるまでに届いたもの（順番を保って渡す）。読むのは止める
      const early: Array<{ data: RawData; isBinary: boolean }> = [];
      const hold = (d: RawData, b: boolean) => early.push({ data: d, isBinary: b });
      const target = isBinary ? undefined : this.take(data);
      if (!target) {
        this.audit({ event: "stream.refused", reason: "札が無効（無い・切れた・使った）" });
        client.close(CLOSE_POLICY, "札が無効です");
        return;
      }
      client.on("message", hold);
      client.pause();
      this.connect(client, target, early, hold);
    });
    client.on("close", () => clearTimeout(timer));
    client.on("error", () => undefined);
  }

  /** 札を引き当てて消す（1回だけ） */
  private take(data: RawData): StreamTarget | undefined {
    let ticket: unknown;
    try {
      ticket = (JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as { ticket?: unknown }).ticket;
    } catch {
      return undefined;
    }
    if (typeof ticket !== "string") return undefined;
    const key = hashOf(ticket);
    const found = this.tickets.get(key);
    if (!found) return undefined;
    this.tickets.delete(key);
    if (found.expiresAt <= this.now()) return undefined;
    const { expiresAt: _expiresAt, ...target } = found;
    return target;
  }

  private connect(
    client: WebSocket,
    target: StreamTarget,
    early: Array<{ data: RawData; isBinary: boolean }>,
    hold: (d: RawData, b: boolean) => void,
  ): void {
    const stream: OpenStream = { target, client, openedAt: this.now() };
    this.open.add(stream);
    const base = {
      projectId: target.stamp.projectId,
      threadId: target.stamp.threadId,
      module: target.server,
      name: target.stamp.name,
      resourceUri: target.stamp.resourceUri,
    };
    // Module に繋がる前に断る。読むのを止めたままだと、画面からの閉じる返事を読めず 30 秒待つことになる
    const refuse = (reason: string) => {
      client.off("message", hold);
      client.resume();
      client.close(STREAM_CLOSE_RESTARTING, reasonText(reason));
    };
    let closedBy: string | undefined;
    const finish = (by: string, code: number) => {
      if (closedBy) return;
      closedBy = by;
      this.open.delete(stream);
      clearInterval(pinger);
      this.audit({ event: "stream.close", ...base, closedBy: by, code, durationMs: this.now() - stream.openedAt });
    };

    // パスが 107 バイトを越えても繋げるように、置き場のフォルダの番号を通して繋ぐ（`viaDirectoryFd` と同じ逃げ道）。
    // 番号は繋がる・失敗するまで持つ（パスは connect の時点で引かれる）
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(target.socketPath), "r");
    } catch (err) {
      this.open.delete(stream);
      this.audit({ event: "stream.refused", ...base, reason: `Module の待ち受けがありません（${(err as NodeJS.ErrnoException).code ?? String(err)}）` });
      refuse("Module の待ち受けがありません");
      return;
    }
    const releaseFd = () => {
      if (dirFd === undefined) return;
      closeSync(dirFd);
      dirFd = undefined;
    };
    const upstream = new WebSocket(`ws+unix:///proc/self/fd/${dirFd}/${basename(target.socketPath)}:/`, {
      headers: { [STREAM_STAMP_HEADER]: encodeStreamStamp(target.stamp) },
      perMessageDeflate: false,
      maxPayload: STREAM_MAX_MESSAGE_BYTES,
    });
    stream.upstream = upstream;
    stream.markClosedByBanto = (code) => finish("banto", code);
    let upstreamOpen = false;
    upstream.once("upgrade", releaseFd);
    upstream.once("close", releaseFd);

    // 生きているかを両側で見る（Caddy と携帯の回線が黙って切るのを避ける）
    const lastSeen = new Map<WebSocket, number>([
      [client, this.now()],
      [upstream, this.now()],
    ]);
    for (const ws of [client, upstream]) ws.on("pong", () => lastSeen.set(ws, this.now()));
    const pinger = setInterval(() => {
      for (const ws of [client, upstream]) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (this.now() - (lastSeen.get(ws) ?? 0) > this.t.pongTimeoutMs) {
          ws.terminate();
          continue;
        }
        ws.ping();
      }
    }, this.t.pingMs);
    pinger.unref();

    const pipe = (from: WebSocket, to: WebSocket) => {
      from.on("message", (data: RawData, isBinary: boolean) => {
        lastSeen.set(from, this.now());
        if (to.readyState !== WebSocket.OPEN) return;
        to.send(data, { binary: isBinary }, () => {
          if (from.isPaused && to.bufferedAmount <= STREAM_BACKPRESSURE_BYTES) from.resume();
        });
        // 渡しきれていない量が多ければ、送り元から読むのを止める（止めた分は送り元の書き込みが詰まる形で見える）
        if (to.bufferedAmount > STREAM_BACKPRESSURE_BYTES) from.pause();
      });
    };

    upstream.on("open", () => {
      upstreamOpen = true;
      this.audit({ event: "stream.open", ...base });
      pipe(upstream, client);
      client.off("message", hold);
      for (const m of early) upstream.send(m.data, { binary: m.isBinary });
      early.length = 0;
      pipe(client, upstream);
      client.resume();
    });
    upstream.on("unexpected-response", (_req, res) => {
      upstream.terminate();
      finish("module", STREAM_CLOSE_RESTARTING);
      refuse(`Module が流れを受けませんでした（${res.statusCode}）`);
    });
    // Module から 1 MiB を越えた1通が来たか。ws は Module へ 1009 を送るが、自分の close は 1006 になる
    // ——そのままだと画面に「Module が止まりました」（1012）と、起きていないことを伝えてしまう
    // 画面からの向きも同じ（画面へは ws が 1009 を送るが、記録と Module へ渡す番号が 1006 由来になる）
    let upstreamTooBig = false;
    let clientTooBig = false;
    const tooBig = (err: Error) => (err as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
    client.on("error", (err) => {
      if (tooBig(err)) clientTooBig = true;
    });
    upstream.on("error", (err) => {
      if (tooBig(err)) upstreamTooBig = true;
      // 開いたあとの失敗は close で扱う。画面の側が先に閉じた（繋いでいる途中で terminate した）なら、Module の
      // 失敗ではない——「Module に繋がりません」を記録しない・断らない
      if (upstreamOpen || closedBy) return;
      finish("module", STREAM_CLOSE_RESTARTING);
      this.audit({ event: "stream.refused", ...base, reason: `Module に繋がりません（${(err as NodeJS.ErrnoException).code ?? err.message}）` });
      refuse("Module に繋がりません");
    });
    upstream.on("close", (code: number, reason: Buffer) => {
      if (upstreamTooBig) {
        finish("module", CLOSE_TOO_BIG);
        if (client.readyState === WebSocket.OPEN) client.close(CLOSE_TOO_BIG, "Module からの1通が 1 MiB を越えました");
        return;
      }
      finish("module", code);
      if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) return;
      // Module が自分の番号で閉じたら渡す（4404 は「もう無い」）。落ちた・止まる（1006・1001）は起こし直し中
      if (sendable(code) && code !== 1001) client.close(code, reasonText(reason));
      else client.close(STREAM_CLOSE_RESTARTING, "Module が止まりました");
    });
    client.on("close", (code: number, reason: Buffer) => {
      finish("screen", clientTooBig ? CLOSE_TOO_BIG : code);
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
        return;
      }
      if (upstream.readyState !== WebSocket.OPEN) return;
      if (clientTooBig) upstream.close(CLOSE_TOO_BIG, "画面からの1通が 1 MiB を越えました");
      else upstream.close(sendable(code) ? code : 1001, reasonText(reason));
    });
  }
}
