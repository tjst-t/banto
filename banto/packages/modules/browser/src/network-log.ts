// **通信とコンソールの記録**（v4-modules.md §4.1「通信の記録」）。ブラウザが出す通信だけ。
//
// 置き場は Module の置き場（Event Store には入れない）。**新しいものから一定の量だけ持ち、古いものから捨てる**
// ——件数と本文の合計に上限を置く。目次（本文以外）は `index.json` に、本文は1件ずつ `bodies/` のファイルに置く
// （本文は一度書けば変わらない。目次だけを間を置いて書き直す）。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactHeaders } from "./redact.js";

export type RecordKind = "http" | "websocket" | "eventsource";

export interface WsFrame {
  /** sent（ページ→サーバ）・received */
  dir: "sent" | "received";
  at: number;
  opcode: number;
  /** 文字のフレームはそのまま、2進は base64（opcode 2）。長いものは切る */
  data: string;
  size: number;
}

export interface EsMessage {
  at: number;
  event: string;
  id: string;
  data: string;
}

export interface BodyInfo {
  /** 全体の大きさ（バイト） */
  size: number;
  /** 持っている大きさ（1件の上限で切ったら size より小さい） */
  stored: number;
  base64: boolean;
}

export interface NetworkRecord {
  id: string;
  tab: string;
  kind: RecordKind;
  method: string;
  url: string;
  /** CDP の resourceType を小文字で（document・xhr・fetch・script・websocket・eventsource …） */
  type: string;
  startedAt: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** 失敗の理由（net::ERR_… 等）。取り消されたものも入る */
  failed?: string;
  durationMs?: number;
  encodedBytes?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timing?: Record<string, number>;
  requestBody?: BodyInfo;
  responseBody?: BodyInfo;
  /** 本文を取れなかった理由（ブラウザが先に捨てた・応答に本文が無い等） */
  bodyUnavailable?: string;
  frames?: WsFrame[];
  framesDropped?: number;
  messages?: EsMessage[];
  closedAt?: number;
  done: boolean;
}

export type ConsoleLevel = "error" | "warning" | "info" | "log" | "debug";

export interface ConsoleEntry {
  id: string;
  tab: string;
  level: ConsoleLevel;
  /** console の出力か、ページの例外（捕まえられなかった throw） */
  kind: "console" | "exception";
  text: string;
  url?: string;
  line?: number;
  stack?: string;
  at: number;
}

export interface Limits {
  maxRecords: number;
  /** 本文（要求と応答）・WebSocket のフレーム・EventSource のメッセージの合計 */
  maxBodyBytes: number;
  /** 1件の本文で持つ上限（越えたら頭だけ持ち、全体の大きさを添える） */
  maxBodyPerRecord: number;
  maxFramesPerSocket: number;
  maxFrameBytes: number;
  maxConsole: number;
}

/**
 * 上限の数字（仮・2026-10-08。v4-modules.md §4.1「まだ決めていない」）。開発中のアプリの数分ぶんを持てる量にした
 */
export const DEFAULT_LIMITS: Limits = {
  maxRecords: 2000,
  maxBodyBytes: 50 * 1024 * 1024,
  maxBodyPerRecord: 2 * 1024 * 1024,
  maxFramesPerSocket: 500,
  maxFrameBytes: 64 * 1024,
  maxConsole: 1000,
};

export interface NetworkQuery {
  tab?: string;
  urlContains?: string;
  method?: string;
  /** failed・error（failed と 4xx/5xx）・pending・2xx…5xx・数字そのもの */
  status?: string;
  type?: string;
  /** 記録の id（`r12`——それより新しいもの）か時刻（ISO 8601） */
  since?: string;
  limit?: number;
}

export interface ConsoleQuery {
  tab?: string;
  level?: ConsoleLevel;
  /** 記録の id（`c5`）か時刻（ISO 8601） */
  since?: string;
  limit?: number;
}

const INDEX_VERSION = 1;

interface IndexFile {
  version: number;
  nextRecord: number;
  nextConsole: number;
  records: NetworkRecord[];
  console: ConsoleEntry[];
}

export class NetworkLog {
  private records = new Map<string, NetworkRecord>();
  private bodies = new Map<string, Buffer>(); // `${id}.req` / `${id}.res`
  private consoleEntries: ConsoleEntry[] = [];
  private nextRecord = 1;
  private nextConsole = 1;
  private bodyBytes = 0;
  private saveTimer: NodeJS.Timeout | undefined;
  /** 書き出しの失敗（規則2——黙って捨てず、次の読み出しで理由を見せる） */
  lastSaveError: string | undefined;
  /** 記録が増えた・変わった・消えた（人の画面の通信とコンソールの欄に知らせる。間引くのは受け手） */
  onChange: (() => void) | undefined;

  constructor(
    private readonly dir: string | undefined,
    readonly limits: Limits = DEFAULT_LIMITS,
  ) {
    if (dir) this.load();
  }

  // ---- 書く ----------------------------------------------------------------------------------

  startRecord(fields: Omit<NetworkRecord, "id" | "done">): NetworkRecord {
    const record: NetworkRecord = { ...fields, id: `r${this.nextRecord++}`, done: false };
    this.records.set(record.id, record);
    this.evict();
    this.scheduleSave();
    return record;
  }

  /** 記録が捨てられていたら何もしない（古いものから捨てたあとに、遅れて届いた知らせ） */
  update(id: string, patch: Partial<NetworkRecord>): void {
    const record = this.records.get(id);
    if (!record) return;
    Object.assign(record, patch);
    this.scheduleSave();
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  setBody(id: string, which: "req" | "res", data: Buffer, base64: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    const key = `${id}.${which}`;
    const stored = data.length > this.limits.maxBodyPerRecord ? data.subarray(0, this.limits.maxBodyPerRecord) : data;
    this.dropBody(key);
    this.bodies.set(key, stored);
    this.bodyBytes += stored.length;
    const info: BodyInfo = { size: data.length, stored: stored.length, base64 };
    if (which === "req") record.requestBody = info;
    else record.responseBody = info;
    if (this.dir) this.writeBodyFile(key, stored);
    this.evict();
    this.scheduleSave();
  }

  addFrame(id: string, frame: Omit<WsFrame, "size" | "data"> & { data: string }): void {
    const record = this.records.get(id);
    if (!record) return;
    const size = Buffer.byteLength(frame.data);
    const data = size > this.limits.maxFrameBytes ? Buffer.from(frame.data).subarray(0, this.limits.maxFrameBytes).toString() : frame.data;
    record.frames ??= [];
    record.frames.push({ ...frame, data, size });
    this.bodyBytes += Buffer.byteLength(data);
    if (record.frames.length > this.limits.maxFramesPerSocket) {
      const dropped = record.frames.shift()!;
      this.bodyBytes -= Buffer.byteLength(dropped.data);
      record.framesDropped = (record.framesDropped ?? 0) + 1;
    }
    this.evict();
    this.scheduleSave();
  }

  addMessage(id: string, message: EsMessage): void {
    const record = this.records.get(id);
    if (!record) return;
    const data = message.data.length > this.limits.maxFrameBytes ? message.data.slice(0, this.limits.maxFrameBytes) : message.data;
    record.messages ??= [];
    record.messages.push({ ...message, data });
    this.bodyBytes += Buffer.byteLength(data);
    if (record.messages.length > this.limits.maxFramesPerSocket) {
      const dropped = record.messages.shift()!;
      this.bodyBytes -= Buffer.byteLength(dropped.data);
      record.framesDropped = (record.framesDropped ?? 0) + 1;
    }
    this.evict();
    this.scheduleSave();
  }

  addConsole(entry: Omit<ConsoleEntry, "id">): ConsoleEntry {
    const full = { ...entry, id: `c${this.nextConsole++}` };
    this.consoleEntries.push(full);
    while (this.consoleEntries.length > this.limits.maxConsole) this.consoleEntries.shift();
    this.scheduleSave();
    return full;
  }

  clear(): void {
    this.records.clear();
    this.bodies.clear();
    this.consoleEntries = [];
    this.bodyBytes = 0;
    this.onChange?.();
    if (this.dir) {
      rmSync(join(this.dir, "bodies"), { recursive: true, force: true });
      this.saveNow();
    }
  }

  // ---- 読む ----------------------------------------------------------------------------------

  get(id: string): NetworkRecord | undefined {
    return this.records.get(id);
  }

  body(id: string, which: "req" | "res"): Buffer | undefined {
    return this.bodies.get(`${id}.${which}`);
  }

  stats(): { records: number; bodyBytes: number; console: number } {
    return { records: this.records.size, bodyBytes: this.bodyBytes, console: this.consoleEntries.length };
  }

  /** 新しい順 */
  query(q: NetworkQuery = {}): NetworkRecord[] {
    const sinceId = q.since !== undefined ? parseSince(q.since, "r") : undefined;
    const out: NetworkRecord[] = [];
    const all = [...this.records.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i]!;
      if (q.tab !== undefined && r.tab !== q.tab) continue;
      if (q.urlContains !== undefined && !r.url.toLowerCase().includes(q.urlContains.toLowerCase())) continue;
      if (q.method !== undefined && r.method.toUpperCase() !== q.method.toUpperCase()) continue;
      if (q.type !== undefined && r.type !== q.type.toLowerCase()) continue;
      if (q.status !== undefined && !matchesStatus(r, q.status)) continue;
      if (sinceId !== undefined) {
        if (sinceId.kind === "id" && idNumber(r.id) <= sinceId.n) continue;
        if (sinceId.kind === "time" && r.startedAt <= sinceId.n) continue;
      }
      out.push(r);
      if (q.limit !== undefined && out.length >= q.limit) break;
    }
    return out;
  }

  /** 新しい順 */
  queryConsole(q: ConsoleQuery = {}): ConsoleEntry[] {
    const since = q.since !== undefined ? parseSince(q.since, "c") : undefined;
    const out: ConsoleEntry[] = [];
    for (let i = this.consoleEntries.length - 1; i >= 0; i--) {
      const c = this.consoleEntries[i]!;
      if (q.tab !== undefined && c.tab !== q.tab) continue;
      if (q.level !== undefined && c.level !== q.level) continue;
      if (since !== undefined) {
        if (since.kind === "id" && idNumber(c.id) <= since.n) continue;
        if (since.kind === "time" && c.at <= since.n) continue;
      }
      out.push(c);
      if (q.limit !== undefined && out.length >= q.limit) break;
    }
    return out;
  }

  /** 記録に残っているタブの番号の最大（無ければ 0）。タブの id を記録と混ざらないように続きから振るのに使う */
  maxTabNumber(): number {
    let max = 0;
    const take = (tab: string) => {
      const m = /^t(\d+)$/.exec(tab);
      if (m) max = Math.max(max, Number(m[1]));
    };
    for (const r of this.records.values()) take(r.tab);
    for (const c of this.consoleEntries) take(c.tab);
    return max;
  }

  /** いまの記録の番号の境目（browserAct が「その間に起きたこと」を数えるのに使う） */
  marks(): { record: number; console: number } {
    return { record: this.nextRecord - 1, console: this.nextConsole - 1 };
  }

  // ---- 捨てる・持つ -------------------------------------------------------------------------

  private evict(): void {
    while (this.records.size > this.limits.maxRecords || (this.bodyBytes > this.limits.maxBodyBytes && this.records.size > 0)) {
      const oldest = this.records.keys().next().value as string;
      this.removeRecord(oldest);
    }
  }

  private removeRecord(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.dropBody(`${id}.req`);
    this.dropBody(`${id}.res`);
    for (const f of record.frames ?? []) this.bodyBytes -= Buffer.byteLength(f.data);
    for (const m of record.messages ?? []) this.bodyBytes -= Buffer.byteLength(m.data);
    this.records.delete(id);
  }

  private dropBody(key: string): void {
    const existing = this.bodies.get(key);
    if (!existing) return;
    this.bodyBytes -= existing.length;
    this.bodies.delete(key);
    if (this.dir) rmSync(join(this.dir, "bodies", key), { force: true });
  }

  private writeBodyFile(key: string, data: Buffer): void {
    const dir = join(this.dir!, "bodies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, key), data);
  }

  private scheduleSave(): void {
    this.onChange?.();
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 500);
    this.saveTimer.unref();
  }

  /** 目次を書く。止めるときにも呼ぶ */
  saveNow(): void {
    if (!this.dir) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const index: IndexFile = {
        version: INDEX_VERSION,
        nextRecord: this.nextRecord,
        nextConsole: this.nextConsole,
        records: [...this.records.values()],
        console: this.consoleEntries,
      };
      const tmp = join(this.dir, "index.json.tmp");
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, join(this.dir, "index.json"));
      this.lastSaveError = undefined;
    } catch (err) {
      this.lastSaveError = (err as Error).message;
    }
  }

  private load(): void {
    const path = join(this.dir!, "index.json");
    if (!existsSync(path)) return;
    // 壊れていたら止める（規則2）——黙って空から始めると、人が「記録が消えた」理由を追えない
    const index = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
    if (index.version !== INDEX_VERSION) throw new Error(`通信の記録の形が読めません（version ${index.version}）: ${path}`);
    this.nextRecord = index.nextRecord;
    this.nextConsole = index.nextConsole;
    this.consoleEntries = index.console;
    const bodyDir = join(this.dir!, "bodies");
    const files = new Set(existsSync(bodyDir) ? readdirSync(bodyDir) : []);
    for (const r of index.records) {
      // 書いている途中で止まった記録は、終わらないまま残る——終わったことにする
      if (!r.done) r.done = true;
      this.records.set(r.id, r);
      for (const f of r.frames ?? []) this.bodyBytes += Buffer.byteLength(f.data);
      for (const m of r.messages ?? []) this.bodyBytes += Buffer.byteLength(m.data);
      for (const which of ["req", "res"] as const) {
        const key = `${r.id}.${which}`;
        if (!files.has(key)) {
          // 本文のファイルが無い（書く前に止まった）——持っていないことにする
          if (which === "req") delete r.requestBody;
          else delete r.responseBody;
          continue;
        }
        const data = readFileSync(join(bodyDir, key));
        this.bodies.set(key, data);
        this.bodyBytes += data.length;
        files.delete(key);
      }
    }
    // 目次に無い本文（目次を書く前に捨てた等）は消す
    for (const orphan of files) rmSync(join(bodyDir, orphan), { force: true });
    this.evict();
  }
}

// ---- 絞り込み・書き方 ---------------------------------------------------------------------------

export function matchesStatus(r: NetworkRecord, status: string): boolean {
  const s = status.toLowerCase();
  if (s === "failed") return r.failed !== undefined;
  if (s === "pending") return !r.done;
  if (s === "error") return r.failed !== undefined || (r.status !== undefined && r.status >= 400);
  const range = /^([1-5])xx$/.exec(s);
  if (range) return r.status !== undefined && Math.floor(r.status / 100) === Number(range[1]);
  if (/^\d{3}$/.test(s)) return r.status === Number(s);
  return false;
}

export const STATUS_FILTER_PATTERN = /^(failed|pending|error|[1-5]xx|\d{3})$/i;

function idNumber(id: string): number {
  return Number(id.slice(1));
}

export function parseSince(since: string, prefix: "r" | "c"): { kind: "id"; n: number } | { kind: "time"; n: number } {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(since);
  if (m) return { kind: "id", n: Number(m[1]) };
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`since は記録の id（${prefix}12 の形）か時刻（ISO 8601）です: ${JSON.stringify(since)}`);
  return { kind: "time", n: t };
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function statusText(r: NetworkRecord): string {
  if (r.failed !== undefined) return `failed(${r.failed})`;
  if (r.kind === "websocket") return r.closedAt ? "closed" : r.status !== undefined ? `open(${r.status})` : "connecting";
  if (r.status !== undefined) return String(r.status);
  return r.done ? "-" : "pending";
}

/** 1件1行：id・メソッド・状態・種類・大きさ・かかった時間・URL */
export function formatLine(r: NetworkRecord): string {
  const ms = r.durationMs !== undefined ? `${Math.round(r.durationMs)}ms` : "-";
  return `${r.id} ${r.tab} ${r.method} ${statusText(r)} ${r.type} ${formatBytes(r.encodedBytes ?? r.responseBody?.size)} ${ms} ${r.url}`;
}

export type DetailPart = "all" | "headers" | "request" | "response" | "frames";

/** 1件の詳細を文にする。redact なら秘密のヘッダの値を伏せる（AI へ） */
export function formatDetail(
  log: NetworkLog,
  r: NetworkRecord,
  opts: { part: DetailPart; maxBytes: number; redact: boolean },
): string {
  const lines: string[] = [];
  const headers = (h: Record<string, string> | undefined) =>
    Object.entries(opts.redact && h ? redactHeaders(h) : (h ?? {})).map(([k, v]) => `  ${k}: ${v}`);
  const want = (p: DetailPart) => opts.part === "all" || opts.part === p;
  lines.push(`${r.id} ${r.method} ${r.url}`);
  lines.push(`タブ: ${r.tab}　種類: ${r.type}　状態: ${statusText(r)}${r.statusText ? ` ${r.statusText}` : ""}`);
  lines.push(`始まり: ${new Date(r.startedAt).toISOString()}　かかった時間: ${r.durationMs !== undefined ? `${Math.round(r.durationMs)}ms` : "-"}　転送: ${formatBytes(r.encodedBytes)}`);
  if (r.mimeType) lines.push(`MIME: ${r.mimeType}`);
  if (want("headers")) {
    lines.push("要求のヘッダ:", ...headers(r.requestHeaders));
    if (r.responseHeaders) lines.push("応答のヘッダ:", ...headers(r.responseHeaders));
    if (r.timing) lines.push(`タイミング（ms）: ${JSON.stringify(r.timing)}`);
  }
  const body = (which: "req" | "res", info: BodyInfo | undefined, title: string) => {
    if (!info) {
      lines.push(`${title}: ${which === "res" && r.bodyUnavailable ? `（取れませんでした：${r.bodyUnavailable}）` : "（なし）"}`);
      return;
    }
    const data = log.body(r.id, which);
    if (!data) {
      lines.push(`${title}: （持っていません）`);
      return;
    }
    const shown = data.subarray(0, opts.maxBytes);
    const text = info.base64 ? shown.toString("base64") : shown.toString("utf8");
    const cut = info.size > shown.length;
    lines.push(
      `${title}（${info.base64 ? "base64・" : ""}全体 ${info.size.toLocaleString("en-US")} バイト${cut ? `、頭の ${shown.length.toLocaleString("en-US")} バイトだけ` : ""}）:`,
      text,
    );
  };
  if (want("request")) body("req", r.requestBody, "要求の本文");
  if (want("response") && r.kind === "http") body("res", r.responseBody, "応答の本文");
  if (want("frames") && r.kind === "websocket") {
    lines.push(`フレーム（${r.frames?.length ?? 0} 件${r.framesDropped ? `、古い ${r.framesDropped} 件は捨てた` : ""}）:`);
    let budget = opts.maxBytes;
    for (const f of r.frames ?? []) {
      const payload = f.data.slice(0, Math.max(0, budget));
      budget -= payload.length;
      lines.push(`  ${new Date(f.at).toISOString()} ${f.dir === "sent" ? "→" : "←"} op${f.opcode} ${f.size}B ${payload}${payload.length < f.data.length ? "…" : ""}`);
      if (budget <= 0) {
        lines.push("  …（maxBytes に達したのでここまで）");
        break;
      }
    }
  }
  if (want("frames") && r.kind === "eventsource") {
    lines.push(`メッセージ（${r.messages?.length ?? 0} 件）:`);
    for (const m of r.messages ?? []) lines.push(`  ${new Date(m.at).toISOString()} event=${m.event} id=${m.id} ${m.data.slice(0, opts.maxBytes)}`);
  }
  return lines.join("\n");
}

// ---- HAR（人の画面の「HAR で保存」、#242 が使う）---------------------------------------------

export function toHar(log: NetworkLog, q: NetworkQuery = {}): unknown {
  const records = log.query({ ...q, limit: undefined }).filter((r) => r.kind !== "eventsource").reverse();
  const pairs = (h: Record<string, string> | undefined) =>
    Object.entries(h ?? {}).flatMap(([name, value]) => value.split("\n").map((v) => ({ name, value: v })));
  return {
    log: {
      version: "1.2",
      creator: { name: "banto-module-browser", version: "0.1.0" },
      pages: [],
      entries: records.map((r) => {
        const req = log.body(r.id, "req");
        const res = log.body(r.id, "res");
        const url = safeUrl(r.url);
        return {
          startedDateTime: new Date(r.startedAt).toISOString(),
          time: r.durationMs ?? -1,
          _tab: r.tab,
          ...(r.failed ? { _error: r.failed } : {}),
          request: {
            method: r.method,
            url: r.url,
            httpVersion: "",
            headers: pairs(r.requestHeaders),
            queryString: url ? [...url.searchParams].map(([name, value]) => ({ name, value })) : [],
            cookies: [],
            headersSize: -1,
            bodySize: r.requestBody?.size ?? 0,
            ...(req ? { postData: { mimeType: r.requestHeaders["content-type"] ?? r.requestHeaders["Content-Type"] ?? "", text: req.toString(r.requestBody?.base64 ? "base64" : "utf8") } } : {}),
          },
          response: {
            status: r.status ?? 0,
            statusText: r.statusText ?? "",
            httpVersion: "",
            headers: pairs(r.responseHeaders),
            cookies: [],
            content: {
              size: r.responseBody?.size ?? 0,
              mimeType: r.mimeType ?? "",
              ...(res ? { text: res.toString(r.responseBody?.base64 ? "base64" : "utf8"), ...(r.responseBody?.base64 ? { encoding: "base64" } : {}) } : {}),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: r.encodedBytes ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: r.durationMs ?? -1, receive: 0 },
          ...(r.kind === "websocket"
            ? {
                _resourceType: "websocket",
                _webSocketMessages: (r.frames ?? []).map((f) => ({ type: f.dir === "sent" ? "send" : "receive", time: f.at / 1000, opcode: f.opcode, data: f.data })),
              }
            : { _resourceType: r.type }),
        };
      }),
    },
  };
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
