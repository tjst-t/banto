// **人の画面——流れ「browser」**（v4-modules.md §4.1「人の画面」、アーキ仕様 §5.8）。
//
// 画面1つにつき流れ1本。流れごとに別の相手（パソコンと携帯で同時に映してよい）。中身の約束：
//
// - Module→画面（2進）：絵1枚＝`[頭の長さ（4バイト、big endian）][頭（JSON）][JPEG]`。頭は
//   `{ seq, tab, width, height }`——番号・タブ・その絵が映しているページの大きさ（CSS ピクセル）。人の入力の座標は
//   この大きさで返してもらう
// - Module→画面（文字の JSON）：`state`（動いているか・タブ・選んでいるタブ・ページの大きさ・「AI に触らせない」）・
//   `progress`（ブラウザを入れている間）・`ai`（AI が触った——帯と枠）・`error`（人の操作が失敗した理由）・
//   `log`（通信とコンソールの記録が変わった。欄を取り直す合図）
// - 画面→Module（文字の JSON）：`ack`（描き終えた絵の番号）・`size`・`visible`・`mouse`・`key`・`touch`・`insertText`・
//   `tab`・`navigate`・`history`・`fit`・`start`（parseViewMessage）
//
// **絵の流量は受け取りの印で絞る**：画面ごとに、送った絵の印が返るまで次を送らず、その間の新しい絵は最新の1枚だけ
// 残す。**誰も映していない（流れが0本・どの画面も裏に回った）間は screencast を止める**。CDP の screencast は
// いま選んでいるタブに1本だけ張り、全部の画面で分ける。
//
// 映した絵・打った中身はどこにも残さない（Module のログに書くのは開いた・閉じた・失敗の理由だけ）。

import type { StreamHandler, StreamStamp, WebSocket } from "@banto/stream-server";
import { STREAM_MAX_MESSAGE_BYTES } from "@banto/module-contract";
import type { CDPSession, Page } from "playwright-core";
import { DEFAULT_VIEWPORT, type BrowserSession, type TabInfo } from "./session.js";
import type { StateFile } from "./state.js";
import type { NetworkLog } from "./network-log.js";
import type { ViewHooks } from "./tools.js";

/**
 * screencast の既定（v4-modules.md §4.1「人の画面で決めたこと」——画質70・間引かない）。**間引かない**：`everyNthFrame` を 2 に
 * すると、ページが静かになる直前の最後の描画が捨てられ、人の画面が古い絵のまま止まる（実測・2026-10-10——google.com/sorry で
 * reCAPTCHA の枠の文字が描かれた最後の1枚が来ず、9回中6回。1 なら6回中0回）。流量は画面の受け取りの印で絞る
 */
export const SCREENCAST_QUALITY = 70;
export const SCREENCAST_EVERY_NTH_FRAME = 1;
/** 静かなページは screencast を張っても絵が来ない（実測・2026-10-10）——これだけ待って来なければ1枚撮って送る */
const FIRST_FRAME_WAIT_MS = 150;
/** 記録が変わった合図を間引く */
const LOG_NOTICE_MS = 300;
/**
 * screencast を張る・止める CDP の呼び出し1つの上限。張り直しは1つずつ流すので、1つが返らないと後ろが全部止まる
 * （画面を閉じても screencast が止まらない）——越えたら理由つきで諦めて次へ進む
 */
const CDP_STEP_MS = 5_000;

/** 返らない呼び出しで後ろを止めない。越えたら何が返らなかったかを言って投げる */
function bounded<T>(label: string, work: Promise<T>, ms = CDP_STEP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} が ${ms}ms 返りませんでした`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export interface FrameHeader {
  seq: number;
  tab: string;
  /** その絵が映しているページの大きさ（CSS ピクセル） */
  width: number;
  height: number;
}

/** 絵1枚を流れの1通にする */
export function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([len, head, jpeg]);
}

/** 流れの1通から絵を読む（試験と、画面の読み方の見本） */
export function decodeFrame(data: Buffer): { header: FrameHeader; jpeg: Buffer } {
  const len = data.readUInt32BE(0);
  return { header: JSON.parse(data.subarray(4, 4 + len).toString("utf8")) as FrameHeader, jpeg: data.subarray(4 + len) };
}

export interface ViewerSize {
  /** 絵を出す場所の大きさ（CSS ピクセル） */
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** 画面の大きさとして受ける範囲。外れたら undefined（断る——黙って丸めない） */
export function parseViewerSize(width: unknown, height: unknown, dpr: unknown): ViewerSize | undefined {
  const edge = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 10_000;
  if (!edge(width) || !edge(height)) return undefined;
  const ratio = dpr === undefined ? 1 : dpr;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0.25 || ratio > 8) return undefined;
  return { width, height, devicePixelRatio: ratio };
}

/**
 * **絵1枚の画素数の上限**（1.6 メガ画素＝1600×1000）。流れの1通は 1 MiB まで（アーキ仕様 §5.8）で、越えると host が
 * 1009 で閉じ、画面は繋ぎ直すたびに同じ大きさの絵でまた切れる。実測（2026-10-10、JPEG 画質70）：文字の多いページで
 * 約 0.33 KiB／千画素、乱れた絵（雑音）で約 0.45 KiB／千画素——上限で雑音でも約 725 KiB に収まる。それでも越えた絵は送らない（deliver）
 */
export const MAX_FRAME_PIXELS = 1_600_000;

/**
 * **screencast の大きさの上限**：映している画面のうち一番大きいもの（デバイスピクセル）に合わせ、ページの大きさ
 * （CSS ピクセル——絵はそれより大きくならない、§4.1「実測」）で頭を押さえる。小さな揺れで張り直さないよう 64 で丸める。
 * そのうえで、絵（ページを縦横同じ比で縮めたもの）が MAX_FRAME_PIXELS を越えないよう縮める
 */
export function screencastLimits(viewers: ViewerSize[], viewport: { width: number; height: number }): { maxWidth: number; maxHeight: number } {
  const up = (n: number) => Math.ceil(n / 64) * 64;
  let w = 0;
  let h = 0;
  for (const v of viewers) {
    w = Math.max(w, v.width * v.devicePixelRatio);
    h = Math.max(h, v.height * v.devicePixelRatio);
  }
  const maxWidth = Math.min(viewport.width, up(w || viewport.width));
  const maxHeight = Math.min(viewport.height, up(h || viewport.height));
  // 絵はページの比のまま、両方の上限に収まるまで縮む
  const scale = Math.min(maxWidth / viewport.width, maxHeight / viewport.height);
  const cap = Math.sqrt(MAX_FRAME_PIXELS / (viewport.width * viewport.height));
  if (scale <= cap) return { maxWidth, maxHeight };
  return { maxWidth: Math.floor(viewport.width * cap), maxHeight: Math.floor(viewport.height * cap) };
}

/** 上限のうちに収まる縮め方（最初の1枚を撮るときの倍率。screencast の絵と同じ大きさになる） */
export function frameScale(limits: { maxWidth: number; maxHeight: number }, viewport: { width: number; height: number }): number {
  return Math.min(1, limits.maxWidth / viewport.width, limits.maxHeight / viewport.height);
}

// ---- 画面→Module のメッセージ ----------------------------------------------------------------------

export type MouseButton = "left" | "middle" | "right" | "none";

export type ViewMessage =
  | { type: "ack"; seq: number }
  | { type: "size"; size: ViewerSize }
  | { type: "visible"; visible: boolean }
  | {
      type: "mouse";
      event: "down" | "up" | "move" | "wheel";
      x: number;
      y: number;
      button: MouseButton;
      buttons: number;
      clickCount: number;
      modifiers: number;
      deltaX: number;
      deltaY: number;
    }
  | { type: "key"; event: "down" | "up"; key: string; code: string; keyCode: number; text?: string; modifiers: number }
  | { type: "touch"; event: "start" | "move" | "end" | "cancel"; points: Array<{ x: number; y: number; id: number }>; modifiers: number }
  | { type: "insertText"; text: string }
  | { type: "tab"; action: "select" | "close"; tab: string }
  | { type: "tab"; action: "new" }
  | { type: "navigate"; url: string }
  | { type: "history"; action: "back" | "forward" | "reload" }
  | { type: "fit"; on: boolean }
  | { type: "start" };

const num = (v: unknown, fallback?: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isInteger(v) ? v : fallback);

/** 画面からの1通を読む。読めなければ理由（流れを閉じる——黙って捨てない） */
export function parseViewMessage(raw: string): ViewMessage | { error: string } {
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "JSON のオブジェクトではありません" };
    m = parsed as Record<string, unknown>;
  } catch {
    return { error: "JSON ではありません" };
  }
  switch (m.type) {
    case "ack":
      return Number.isInteger(m.seq) ? { type: "ack", seq: m.seq as number } : { error: "ack に seq がありません" };
    case "size": {
      const size = parseViewerSize(m.width, m.height, m.dpr);
      return size ? { type: "size", size } : { error: "画面の大きさ（width・height・dpr）が範囲の外です" };
    }
    case "visible":
      return typeof m.visible === "boolean" ? { type: "visible", visible: m.visible } : { error: "visible は true / false です" };
    case "mouse": {
      const x = num(m.x);
      const y = num(m.y);
      if (!["down", "up", "move", "wheel"].includes(m.event as string) || x === undefined || y === undefined) {
        return { error: "mouse の event・x・y が読めません" };
      }
      const button = ["left", "middle", "right", "none"].includes(m.button as string) ? (m.button as MouseButton) : "none";
      return {
        type: "mouse",
        event: m.event as "down" | "up" | "move" | "wheel",
        x,
        y,
        button,
        buttons: int(m.buttons, 0),
        clickCount: int(m.clickCount, m.event === "down" || m.event === "up" ? 1 : 0),
        modifiers: int(m.modifiers, 0),
        deltaX: num(m.deltaX, 0)!,
        deltaY: num(m.deltaY, 0)!,
      };
    }
    case "key":
      if ((m.event !== "down" && m.event !== "up") || typeof m.key !== "string") return { error: "key の event・key が読めません" };
      return {
        type: "key",
        event: m.event,
        key: m.key,
        code: typeof m.code === "string" ? m.code : "",
        keyCode: int(m.keyCode, 0),
        ...(typeof m.text === "string" && m.text !== "" ? { text: m.text } : {}),
        modifiers: int(m.modifiers, 0),
      };
    case "touch": {
      if (!["start", "move", "end", "cancel"].includes(m.event as string) || !Array.isArray(m.points)) {
        return { error: "touch の event・points が読めません" };
      }
      const points: Array<{ x: number; y: number; id: number }> = [];
      for (const p of m.points as unknown[]) {
        const q = p as Record<string, unknown>;
        const x = num(q?.x);
        const y = num(q?.y);
        if (x === undefined || y === undefined) return { error: "touch の点に x・y がありません" };
        points.push({ x, y, id: int(q.id, 0) });
      }
      return { type: "touch", event: m.event as "start" | "move" | "end" | "cancel", points, modifiers: int(m.modifiers, 0) };
    }
    case "insertText":
      return typeof m.text === "string" ? { type: "insertText", text: m.text } : { error: "insertText に text がありません" };
    case "tab":
      if (m.action === "new") return { type: "tab", action: "new" };
      if ((m.action === "select" || m.action === "close") && typeof m.tab === "string") return { type: "tab", action: m.action, tab: m.tab };
      return { error: "tab の action・tab が読めません" };
    case "navigate":
      return typeof m.url === "string" && m.url.trim() !== "" ? { type: "navigate", url: normalizeUrl(m.url) } : { error: "navigate に url がありません" };
    case "history":
      return m.action === "back" || m.action === "forward" || m.action === "reload"
        ? { type: "history", action: m.action }
        : { error: "history の action は back・forward・reload です" };
    case "fit":
      return typeof m.on === "boolean" ? { type: "fit", on: m.on } : { error: "fit の on は true / false です" };
    case "start":
      return { type: "start" };
    default:
      return { error: "知らないメッセージです" };
  }
}

/** URL 欄に打ったもの：scheme が無ければ http:// を足す（localhost:3000 を打つのが一番多い） */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|blob):/i.test(url)) return url;
  return `http://${url}`;
}

// ---- AI が触ったこと ---------------------------------------------------------------------------------

export interface AiActionEvent {
  /** 帯に出す文（「『送る』を押しました」） */
  text: string;
  tab: string;
  /** どの Thread の AI か（host の刻印。無ければ出さない） */
  thread?: string;
  /** 触った要素の枠（ページの CSS ピクセル） */
  box?: { x: number; y: number; width: number; height: number };
}

// ---- 流れ ----------------------------------------------------------------------------------------

interface Frame {
  seq: number;
  tab: string;
  data: Buffer;
}

interface Viewer {
  ws: WebSocket;
  stamp: StreamStamp;
  size: ViewerSize;
  visible: boolean;
  /** 送って、まだ受け取りの印が返っていない絵の番号 */
  waiting: number | undefined;
  /** 印を待つ間に来た、最新の1枚 */
  pending: Frame | undefined;
  release: () => void;
}

interface Cast {
  tab: string;
  page: Page;
  cdp: CDPSession;
  key: string;
  gotFrame: boolean;
  /** 上限を越えた絵を捨てている間（理由を言うのは越え始めた1度だけ） */
  oversized?: boolean;
}

export interface BrowserViewDeps {
  session: BrowserSession;
  state: StateFile;
  log: NetworkLog;
  /** Module のログ（中身は書かない） */
  logLine?: (line: string) => void;
  /** 1通の上限（既定は流れの口の 1 MiB。試験が越えた絵の扱いを見るときだけ小さくする） */
  maxMessageBytes?: number;
}

export class BrowserView implements ViewHooks {
  private readonly viewers = new Set<Viewer>();
  private cast: Cast | undefined;
  private last: Frame | undefined;
  private seq = 0;
  /** screencast の張り直しは1つずつ */
  private chain: Promise<void> = Promise.resolve();
  /** 「画面に合わせる」を入れている画面（ページの大きさは1つなので、合わせるのは1つの画面だけ） */
  private fitOwner: Viewer | undefined;
  /** 「画面に合わせる」で大きさを変えたタブ（切ったら全部を既定に戻す） */
  private readonly fitted = new Set<Page>();
  private starting = false;
  private stateTimer: NodeJS.Timeout | undefined;
  private logTimer: NodeJS.Timeout | undefined;
  private readonly logLine: (line: string) => void;

  constructor(private readonly deps: BrowserViewDeps) {
    this.logLine = deps.logLine ?? ((line) => process.stderr.write(`[browser] ${line}\n`));
    deps.session.subscribe(() => this.refresh());
    deps.log.onChange = () => this.logChanged();
  }

  /** 流れ「browser」の受け口 */
  handler(): StreamHandler {
    return (ws, stamp) => this.attach(ws, stamp);
  }

  /** 状態を見る口（getBrowserStatus）が返す */
  status(): { viewers: number; watching: number; screencasting: boolean; screencastTab?: string } {
    return {
      viewers: this.viewers.size,
      watching: [...this.viewers].filter((v) => v.visible).length,
      screencasting: this.cast !== undefined,
      ...(this.cast ? { screencastTab: this.cast.tab } : {}),
    };
  }

  aiAction(event: AiActionEvent): void {
    this.broadcast({ type: "ai", ...event });
  }

  refresh(): void {
    // タブができた・切り替わった——「画面に合わせる」が入っていれば、いま選んでいるタブにも効かせる
    if (this.fitOwner) void this.applyFit();
    this.scheduleState();
    this.reconcile();
  }

  async close(): Promise<void> {
    for (const v of this.viewers) v.ws.close(1001, "Module が止まります");
    await this.chain;
    await this.stopCast();
  }

  // ---- 繋ぐ・閉じる ----

  private attach(ws: WebSocket, stamp: StreamStamp): void {
    const p = stamp.params;
    const size = parseViewerSize(p.width, p.height, p.dpr);
    if (!size) {
      ws.close(1008, "画面の大きさ（width・height・dpr）が範囲の外です");
      return;
    }
    const viewer: Viewer = {
      ws,
      stamp,
      size,
      visible: p.visible !== false,
      waiting: undefined,
      pending: undefined,
      release: this.deps.session.hold(),
    };
    this.viewers.add(viewer);
    this.logLine(`人の画面が開きました（いま ${this.viewers.size} 本${stamp.threadId ? "・会話の中" : ""}）`);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, "2進は受けません（文字の JSON で送ってください）");
        return;
      }
      const message = parseViewMessage(data.toString());
      if ("error" in message) {
        ws.close(1008, message.error.slice(0, 40));
        return;
      }
      this.onMessage(viewer, message);
    });
    ws.on("close", () => {
      this.viewers.delete(viewer);
      viewer.release();
      if (this.fitOwner === viewer) {
        // 合わせていた画面が閉じた——ページの大きさを元に戻す（ほかの画面と AI が、閉じた画面の大きさのまま見ないように）
        this.fitOwner = undefined;
        void this.unfit();
      }
      this.logLine(`人の画面が閉じました（いま ${this.viewers.size} 本）`);
      this.refresh();
    });
    this.scheduleState();
    void this.start();
  }

  /** 人が画面を開いた・起こしてと頼んだ：ブラウザを起こし（入れるのが要れば入れる）、映す */
  private async start(): Promise<void> {
    if (!this.deps.session.running) {
      this.starting = true;
      this.scheduleState();
      try {
        await this.deps.session.ensure((message) => this.broadcast({ type: "progress", message }));
      } catch (err) {
        this.logLine(`ブラウザを起こせませんでした: ${(err as Error).message}`);
        this.broadcast({ type: "error", message: `ブラウザを起こせませんでした：${(err as Error).message}` });
      } finally {
        this.starting = false;
      }
    }
    this.refresh();
  }

  // ---- 画面からのメッセージ ----

  private onMessage(v: Viewer, m: ViewMessage): void {
    switch (m.type) {
      case "ack":
        if (v.waiting === m.seq) {
          v.waiting = undefined;
          const next = v.pending;
          v.pending = undefined;
          if (next) this.sendFrame(v, next);
        }
        return;
      case "size":
        v.size = m.size;
        if (this.fitOwner === v) void this.applyFit();
        this.reconcile();
        return;
      case "visible":
        if (v.visible === m.visible) return;
        v.visible = m.visible;
        if (!m.visible) v.pending = undefined;
        this.reconcile();
        if (m.visible) this.offerLast(v);
        return;
      case "mouse":
        this.input("Input.dispatchMouseEvent", {
          type: { down: "mousePressed", up: "mouseReleased", move: "mouseMoved", wheel: "mouseWheel" }[m.event],
          x: m.x,
          y: m.y,
          button: m.button,
          buttons: m.buttons,
          clickCount: m.clickCount,
          modifiers: m.modifiers,
          ...(m.event === "wheel" ? { deltaX: m.deltaX, deltaY: m.deltaY } : {}),
        }, v);
        return;
      case "key":
        this.input("Input.dispatchKeyEvent", {
          // 文字を伴う押し下げは keyDown（文字が入る）、伴わないもの（矢印・Backspace 等）は rawKeyDown
          type: m.event === "up" ? "keyUp" : m.text ? "keyDown" : "rawKeyDown",
          key: m.key,
          code: m.code,
          windowsVirtualKeyCode: m.keyCode,
          nativeVirtualKeyCode: m.keyCode,
          modifiers: m.modifiers,
          ...(m.text && m.event === "down" ? { text: m.text, unmodifiedText: m.text } : {}),
        }, v);
        return;
      case "touch":
        this.input("Input.dispatchTouchEvent", {
          type: { start: "touchStart", move: "touchMove", end: "touchEnd", cancel: "touchCancel" }[m.event],
          touchPoints: m.points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
          modifiers: m.modifiers,
        }, v);
        return;
      case "insertText":
        this.input("Input.insertText", { text: m.text }, v);
        return;
      case "tab":
        void this.act(v, async () => {
          const s = this.deps.session;
          if (m.action === "new") {
            await s.ensure();
            await s.newTab();
          } else if (m.action === "select") s.select(m.tab);
          else await s.close(m.tab);
        });
        return;
      case "navigate":
        void this.act(v, async () => {
          await this.deps.session.ensure();
          const { page } = await this.deps.session.currentOrNew();
          await page.goto(m.url, { timeout: 30_000 });
        });
        return;
      case "history":
        void this.act(v, async () => {
          const { page } = this.deps.session.page();
          if (m.action === "back") await page.goBack({ timeout: 15_000 });
          else if (m.action === "forward") await page.goForward({ timeout: 15_000 });
          else await page.reload({ timeout: 30_000 });
        });
        return;
      case "fit":
        if (m.on) {
          // タブがまだ無くても入れておく——できたタブに効かせる（refresh から applyFit）
          this.fitOwner = v;
          void this.applyFit();
        } else if (this.fitOwner === v) {
          this.fitOwner = undefined;
          void this.unfit();
        }
        this.scheduleState();
        return;
      case "start":
        void this.start();
        return;
    }
  }

  /** 人の入力を、いま映しているタブへそのまま渡す（映していなければ、人は何も見ていない——捨てる） */
  private input(method: string, params: Record<string, unknown>, v: Viewer): void {
    const cast = this.cast;
    if (!cast) return;
    // Playwright の CDPSession は名前ごとに型が付く——ここでは名前を文字で渡す
    (cast.cdp as unknown as { send(m: string, p: unknown): Promise<unknown> }).send(method, params).catch((err: Error) => {
      if (this.cast !== cast) return; // 張り直した・閉じた——古い口の失敗は人に見せない
      this.sendText(v, { type: "error", message: `入力を渡せませんでした：${err.message.split("\n")[0]}` });
    });
  }

  /** 人の操作（タブ・URL・戻る等）。失敗は理由をその画面に返す */
  private async act(v: Viewer, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.sendText(v, { type: "error", message: (err as Error).message.split("\n")[0] ?? String(err) });
    }
    this.refresh();
  }

  private fitSize(v: Viewer): { width: number; height: number } {
    return { width: Math.max(200, Math.round(v.size.width)), height: Math.max(200, Math.round(v.size.height)) };
  }

  /**
   * 「画面に合わせる」を、いま選んでいるタブに効かせる。タブが無ければ何もしない——できたとき（session の変化 → refresh）に
   * もう一度呼ばれる。もう合っていれば何もしない（refresh から何度呼ばれても回り続けない）
   */
  private async applyFit(): Promise<void> {
    const owner = this.fitOwner;
    const s = this.deps.session;
    if (!owner || !s.running || s.current === undefined) return;
    try {
      const { page } = s.page();
      const want = this.fitSize(owner);
      const now = page.viewportSize();
      if (now && now.width === want.width && now.height === want.height) return;
      this.fitted.add(page);
      await page.setViewportSize(want);
    } catch (err) {
      this.logLine(`ページの大きさを画面に合わせられませんでした: ${(err as Error).message}`);
      return;
    }
    this.refresh();
  }

  /** 「画面に合わせる」を切った・持っていた画面が閉じた：合わせたタブを全部、既定の大きさに戻す */
  private async unfit(): Promise<void> {
    const pages = [...this.fitted];
    this.fitted.clear();
    for (const page of pages) {
      if (page.isClosed()) continue;
      await page.setViewportSize(DEFAULT_VIEWPORT).catch((err: Error) => this.logLine(`ページの大きさを戻せませんでした: ${err.message}`));
    }
    this.refresh();
  }

  // ---- screencast ----

  /** 映している画面・選んでいるタブ・大きさに合わせて、screencast を張る・張り直す・止める */
  private reconcile(): void {
    this.chain = this.chain
      .then(() => this.reconcileNow())
      .catch((err: Error) => {
        this.logLine(`screencast を張れませんでした: ${err.message}`);
        this.broadcast({ type: "error", message: `画面を映せませんでした：${err.message.split("\n")[0]}` });
      });
  }

  private async reconcileNow(): Promise<void> {
    const watchers = [...this.viewers].filter((v) => v.visible);
    const s = this.deps.session;
    const target = watchers.length > 0 && s.running && s.current !== undefined ? s.page() : undefined;
    if (!target || target.page.isClosed()) {
      await this.stopCast();
      return;
    }
    const viewport = target.page.viewportSize() ?? DEFAULT_VIEWPORT;
    const limits = screencastLimits(
      watchers.map((v) => v.size),
      viewport,
    );
    const key = `${target.id} ${viewport.width}x${viewport.height} ${limits.maxWidth}x${limits.maxHeight}`;
    if (this.cast && this.cast.key === key && this.cast.page === target.page) return;
    await this.stopCast();
    const cdp = await bounded("CDP の口を開く", s.newCdp(target.page));
    const cast: Cast = { tab: target.id, page: target.page, cdp, key, gotFrame: false };
    this.cast = cast;
    try {
      await this.startCast(cast, limits, viewport);
    } catch (err) {
      // 張りかけの screencast を残さない——残すと「同じ形で張ってある」と見て、次の張り直しで直らない
      if (this.cast === cast) await this.stopCast();
      throw err;
    }
  }

  private async startCast(cast: Cast, limits: { maxWidth: number; maxHeight: number }, viewport: { width: number; height: number }): Promise<void> {
    const cdp = cast.cdp;
    cdp.on("Page.screencastFrame", (f) => this.onFrame(cast, f, viewport));
    await bounded(
      "Page.startScreencast",
      cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: SCREENCAST_QUALITY,
        everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
        ...limits,
      }),
    );
    // 静かなページは変わるまで絵が来ない——1枚撮って送る（開いた画面が空のままにならない）
    await new Promise((r) => setTimeout(r, FIRST_FRAME_WAIT_MS));
    if (this.cast !== cast || cast.gotFrame) return;
    // screencast と同じ上限で撮る（ページ全体の大きさで撮ると、携帯の小さな画面でも 1 MiB を越えうる）。clip はページの
    // 座標なので、スクロールした位置（visual viewport の pageX・pageY）から切る（実測・2026-10-10——0,0 では先頭が写る）
    const metrics = await bounded("Page.getLayoutMetrics", cdp.send("Page.getLayoutMetrics"));
    const shot = await bounded(
      "Page.captureScreenshot",
      cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: SCREENCAST_QUALITY,
        clip: {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: viewport.width,
          height: viewport.height,
          scale: frameScale(limits, viewport),
        },
      }),
    );
    if (this.cast !== cast || cast.gotFrame) return;
    const seq = ++this.seq;
    this.deliver(cast, { seq, tab: cast.tab, data: encodeFrame({ seq, tab: cast.tab, ...viewport }, Buffer.from(shot.data, "base64")) }, viewport);
  }

  private onFrame(cast: Cast, f: { data: string; sessionId: number }, viewport: { width: number; height: number }): void {
    // CDP には受け取ったとすぐ返す。画面ごとの流量は画面の印で絞る（CDP では間引かない——最後の1枚を捨てないため）
    cast.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined); // 閉じた口——次の張り直しで直る
    if (this.cast !== cast) return;
    cast.gotFrame = true;
    // 頭の大きさは張ったときのページの大きさ（張ったままの screencast はその大きさの絵を出す）。絵に付いてくる
    // `metadata.deviceWidth`・`deviceHeight` は使わない——縮めて流すとき、縮めた絵の大きさを返すことがある
    // （実測・2026-10-10：2560×1440 を 1685×948 に縮めて、20回中2回。人の入力の座標がずれる）
    const { width, height } = viewport;
    const seq = ++this.seq;
    this.deliver(cast, { seq, tab: cast.tab, data: encodeFrame({ seq, tab: cast.tab, width, height }, Buffer.from(f.data, "base64")) }, viewport);
    // ページの大きさが変わった（AI の resize・人の「画面に合わせる」）——張り直すと新しい大きさの絵になる
    const now = cast.page.viewportSize();
    if (now && (now.width !== viewport.width || now.height !== viewport.height)) this.refresh();
  }

  private deliver(cast: Cast, frame: Frame, page: { width: number; height: number }): void {
    // **1 MiB を越える絵は送らない**——送ると host が流れを 1009 で閉じ、画面は繋ぎ直すたびに同じ絵でまた切れる（理由が人に
    // 届かない）。上限の画素数（MAX_FRAME_PIXELS）で抑えているので、来るのは極端な絵だけ。理由は越え始めたときに1度だけ言う
    if (frame.data.length > (this.deps.maxMessageBytes ?? STREAM_MAX_MESSAGE_BYTES)) {
      if (!cast.oversized) {
        cast.oversized = true;
        const kib = Math.round(frame.data.length / 1024);
        this.logLine(`絵が ${kib} KiB で流れの1通の上限を越えたので送りませんでした（ページ ${page.width}×${page.height}）`);
        this.broadcast({
          type: "error",
          message: `ページの絵が ${kib} KiB で、流れの1通の上限（1 MiB）を越えるので映せません（ページ ${page.width}×${page.height}）。ページを小さくすると映ります`,
        });
      }
      return;
    }
    cast.oversized = false;
    this.last = frame;
    for (const v of this.viewers) {
      if (!v.visible) continue;
      if (v.waiting !== undefined) v.pending = frame;
      else this.sendFrame(v, frame);
    }
  }

  /** 開いた・前に戻った画面に、いま映しているタブの最後の1枚を出す（静かなページは次の絵が来ない） */
  private offerLast(v: Viewer): void {
    const last = this.last;
    if (!last || !this.cast || last.tab !== this.cast.tab || !v.visible) return;
    if (v.waiting !== undefined) v.pending = last;
    else this.sendFrame(v, last);
  }

  private sendFrame(v: Viewer, frame: Frame): void {
    if (v.ws.readyState !== v.ws.OPEN) return;
    v.waiting = frame.seq;
    v.ws.send(frame.data, { binary: true });
  }

  private async stopCast(): Promise<void> {
    const cast = this.cast;
    if (!cast) return;
    this.cast = undefined;
    // タブが閉じた・ブラウザが止まった後なら口はもう無い（投げる）——止めたいのは同じ。返らないときだけ記録する
    const timedOut = (err: Error) => {
      if (err.message.includes("返りませんでした")) this.logLine(err.message);
    };
    await bounded("Page.stopScreencast", cast.cdp.send("Page.stopScreencast")).catch(timedOut);
    await bounded("CDP の口を閉じる", cast.cdp.detach()).catch(timedOut);
  }

  // ---- 文字のメッセージ ----

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      // タブが閉じた直後などで読めなかった——記録して、次の変化で送り直す（投げると受け口が無く Module ごと落ちる）
      this.sendState().catch((err: Error) => this.logLine(`画面に様子を送れませんでした: ${err.message}`));
    }, 30);
  }

  private async sendState(): Promise<void> {
    if (this.viewers.size === 0) return;
    const s = this.deps.session;
    let tabs: TabInfo[] = [];
    let viewport: { width: number; height: number } | undefined;
    if (s.running) {
      tabs = await s.listTabs();
      const current = tabs.find((t) => t.current);
      if (current) viewport = s.page(current.id).page.viewportSize() ?? undefined;
    }
    const st = this.deps.state.get();
    // 画面ごとに「自分が合わせているか」だけ違う
    for (const v of this.viewers) {
      this.sendText(v, {
        type: "state",
        running: s.running,
        starting: this.starting,
        aiBlocked: st.aiBlocked,
        tabs,
        current: s.current ?? null,
        viewport: viewport ?? null,
        fit: this.fitOwner === v,
        fitByOther: this.fitOwner !== undefined && this.fitOwner !== v,
        log: this.deps.log.stats(),
        ...(s.lastStop ? { lastStop: s.lastStop } : {}),
      });
    }
  }

  private logChanged(): void {
    if (this.logTimer || this.viewers.size === 0) return;
    this.logTimer = setTimeout(() => {
      this.logTimer = undefined;
      this.broadcast({ type: "log", ...this.deps.log.stats() });
    }, LOG_NOTICE_MS);
    this.logTimer.unref();
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const v of this.viewers) this.sendText(v, message);
  }

  private sendText(v: Viewer, message: Record<string, unknown>): void {
    if (v.ws.readyState === v.ws.OPEN) v.ws.send(JSON.stringify(message));
  }
}
