// **出口の箱**（追加・2026-10-16、アーキ仕様 §4.3「取りこぼさない——出口の箱」）。Transactional Outbox と同じ形（規則12）。
//
// 出す側は出来事をまず自分の置き場に書き（`write`）、host が「受け取った」と返したら消す（`flush`）。繋がっていない・
// 起こし直しの間に起きたものは、次に繋がったとき古い順に出し直す。重複は host が `eventId` で落とす（出し直しても二度は
// 動かない）。
//
// - **1件1ファイル**（`<起きた時刻>-<eventId の指紋>.json`）。書き手が別のプロセス（Service の unit の起動役）でも、
//   書きかけを読ませない（別名に書いて置き換える）・追記の取り合いが無い
// - 箱は **7日・1000件まで**。古いものから捨て、捨てた数をログに残す（`log`）
// - host が断った（宣言違反）ものは出し直しても通らないので捨て、ログに残す。繋がらない・答えが無い（一時の失敗）は残して
//   次に回す

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmittedEvent } from "./events.js";

export const OUTBOX_LIMITS = {
  /** 箱に置いておく日数 */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** 箱に置いておく件数 */
  maxItems: 1000,
} as const;

/** host に1件知らせた結果。`accepted`＝受け取った（消す）、`refused`＝断った（出し直しても通らないので消す）、投げたら残す */
export type OutboxSendResult = { accepted: true } | { refused: string };

export interface EventOutboxOptions {
  /** 箱の置き場（Module の状態の置き場の下の1つのフォルダ） */
  dir: string;
  now?: () => Date;
  log?: (message: string) => void;
  limits?: Partial<OutboxLimits>;
}

export type OutboxLimits = Record<keyof typeof OUTBOX_LIMITS, number>;

const SUFFIX = ".json";

export class EventOutbox {
  private readonly dir: string;
  private readonly limits: OutboxLimits;
  private flushing: Promise<{ sent: number; left: number }> | undefined;

  constructor(private readonly opts: EventOutboxOptions) {
    this.dir = opts.dir;
    this.limits = { ...OUTBOX_LIMITS, ...opts.limits };
  }

  /** 出来事を箱に書く（host に出す前に）。書いたあと上限を超えた分を古いものから捨てる */
  write(event: EmittedEvent): void {
    mkdirSync(this.dir, { recursive: true });
    const occurred = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurred)) throw new Error(`occurredAt が時刻として読めません（${event.occurredAt}）`);
    // 名前の頭を起きた時刻にする——並べれば古い順になる（同じ時刻は eventId の指紋で決まった順）
    const file = `${String(occurred).padStart(15, "0")}-${createHash("sha256").update(event.eventId).digest("hex").slice(0, 16)}${SUFFIX}`;
    const tmp = join(this.dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(event), { mode: 0o600 });
    renameSync(tmp, join(this.dir, file));
    this.prune();
  }

  /** 箱の中身（古い順） */
  list(): EmittedEvent[] {
    return this.files().flatMap((f) => {
      const e = this.read(f);
      return e ? [e] : [];
    });
  }

  /**
   * **古い順に出す**。受け取られた・断られたものは消し、一時の失敗（投げた）で止まる——次に繋がったときにまた呼ぶ。
   * 同時に呼ばれたら、走っている1回の結果を返す（同じものを二度出さない）
   */
  flush(send: (event: EmittedEvent) => Promise<OutboxSendResult>): Promise<{ sent: number; left: number }> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce(send).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushOnce(send: (event: EmittedEvent) => Promise<OutboxSendResult>): Promise<{ sent: number; left: number }> {
    this.prune();
    let sent = 0;
    const files = this.files();
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const event = this.read(file);
      if (!event) continue;
      let result: OutboxSendResult;
      try {
        result = await send(event);
      } catch (err) {
        // 繋がっていない・答えが無い——残して次に回す
        this.log(`[outbox] 出来事 ${event.name}（${event.eventId}）を出せませんでした（あとで出し直します）：${err instanceof Error ? err.message : String(err)}`);
        return { sent, left: files.length - i };
      }
      if ("refused" in result) this.log(`[outbox] host が出来事 ${event.name}（${event.eventId}）を断ったので捨てます：${result.refused}`);
      else sent++;
      rmSync(join(this.dir, file), { force: true });
    }
    return { sent, left: 0 };
  }

  /** 7日を過ぎたもの・1000件を超えた分を古いものから捨てる */
  private prune(): void {
    const files = this.files();
    const cutoff = this.now().getTime() - this.limits.maxAgeMs;
    let dropped = 0;
    files.forEach((f, i) => {
      const at = Number(f.slice(0, f.indexOf("-")));
      if (at < cutoff || files.length - i > this.limits.maxItems) {
        rmSync(join(this.dir, f), { force: true });
        dropped++;
      }
    });
    if (dropped > 0) this.log(`[outbox] 出口の箱から古い出来事を ${dropped} 件捨てました（${this.limits.maxItems} 件・${Math.round(this.limits.maxAgeMs / 86_400_000)} 日まで）`);
  }

  private files(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names.filter((n) => n.endsWith(SUFFIX) && !n.startsWith(".")).sort();
  }

  private read(file: string): EmittedEvent | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), "utf8")) as EmittedEvent;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // 壊れたものは出し直しても通らない——捨ててログに残す（黙って残し続けると箱が詰まる）
      this.log(`[outbox] 読めない出来事を捨てます（${file}）：${err instanceof Error ? err.message : String(err)}`);
      rmSync(join(this.dir, file), { force: true });
      return undefined;
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }
}

/**
 * **`relayEmitEvent` の答えを、箱の結果に読む**（`callTool` の結果をそのまま渡す）。host は受け取った・断ったを本文の JSON で
 * 返す。エラーの結果（`isError`）・読めない答えは一時の失敗として投げる——箱に残して出し直す
 */
export function readEmitReply(result: { content?: unknown; isError?: unknown }): OutboxSendResult {
  const first = Array.isArray(result.content) ? (result.content[0] as { type?: unknown; text?: unknown } | undefined) : undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  if (result.isError === true) throw new Error(text || "host が出来事を受け取れませんでした");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`host の答えが読めません：${text.slice(0, 200)}`);
  }
  const r = parsed as { accepted?: unknown; refused?: unknown };
  if (r.accepted === true) return { accepted: true };
  if (typeof r.refused === "string") return { refused: r.refused };
  throw new Error(`host の答えが読めません：${text.slice(0, 200)}`);
}
