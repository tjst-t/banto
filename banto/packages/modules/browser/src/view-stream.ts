// **人の画面——流れ「browser」**（v4-modules.md §4.1「人の画面」、アーキ仕様 §5.8）。
//
// 画面1つにつき流れ1本。流れごとに別の相手（パソコンと携帯で同時に映してよい）。中身の約束：
//
// - Module→画面（2進）：絵1枚＝`[頭の長さ（4バイト、big endian）][頭（JSON）][中身]`。頭は
//   `{ seq, tab, width, height }`——番号・タブ・その絵が映しているページの大きさ（CSS ピクセル）。人の入力の座標は
//   この大きさで返してもらう。中身は JPEG か、**動画のときは H.264 のアクセスユニット**（Annex B）——頭に
//   `codec: "h264"`・`key`（キーフレームか）・`ts`（取り込んだ時刻 µs）、1 MiB を越えて分けたときは `part`・`parts`
//   （v4-modules.md §4.1「動画で流す」）。**音は Opus の1包み**——頭は `{ seq, codec: "opus", ts, dur }`（取り込んだ時刻と長さ、
//   µs。ts は映像と同じ時計）
// - Module→画面（文字の JSON）：`state`（動いているか・タブ・選んでいるタブ・ページの大きさ・「AI に触らせない」）・
//   `progress`（ブラウザを入れている間）・`ai`（AI が触った——帯と枠）・`error`（人の操作が失敗した理由）・
//   `log`（通信とコンソールの記録が変わった。欄を取り直す合図）
// - 画面→Module（文字の JSON）：`ack`（描き終えた絵の番号）・`size`・`visible`・`mouse`・`key`・`touch`・`insertText`・
//   `tab`・`navigate`・`history`・`fit`・`start`・`keyframe`（復号に失敗した——キーフレームから送り直して）・
//   `codec`（H.264 を描けなくなった——JPEG に替えて）・`audio`（音を出す・止める）（parseViewMessage）
//
// **動画で流す**：params の `codec` が `"h264"` の画面（WebCodecs の VideoDecoder で描ける画面）には、仮想の画面を GStreamer で
// 圧縮した H.264 を流す（video.ts）。子プロセスは1本で、動画の画面の全部で分ける。新しく繋いだ・前に戻った画面には
// キーフレームを要求し、それが来るまでその画面には送らない。動画の流れは受け取りの印で絞らない（P フレームは単独で捨てられない
// ——詰まったときの扱いは段3）。描けない画面・GStreamer が無い・ページが仮想の画面より大きいときは JPEG（screencast）で映す
//
// **絵の流量は受け取りの印で絞る**：画面ごとに、送った絵の印が返るまで次を送らず、その間の新しい絵は最新の1枚だけ
// 残す。**誰も映していない（流れが0本・どの画面も裏に回った）間は screencast を止める**。CDP の screencast は
// いま選んでいるタブに1本だけ張り、全部の画面で分ける。
//
// **音**：「音を出す」を押した画面（params の `audio`・`audio` の知らせ）が見えている間だけ、ブラウザの音（PulseAudio の空の
// シンク）を Opus で流す（audio.ts）。子プロセスは1本で、音を出している画面の全部で分ける。どの画面も音を出していない・
// 見えていない間は子を止める（誰も聞いていない音は流さない）。音を流せない（PulseAudio が無い・立たない・子が落ちた）ときは
// 理由を `audioUnavailable` で伝え、映像は今どおり
//
// 映した絵・打った中身はどこにも残さない（Module のログに書くのは開いた・閉じた・失敗の理由だけ）。

import type { StreamHandler, StreamStamp, WebSocket } from "@banto/stream-server";
import { STREAM_MAX_MESSAGE_BYTES } from "@banto/module-contract";
import type { CDPSession, Page } from "playwright-core";
import { DEFAULT_VIEWPORT, type BrowserSession, type TabInfo } from "./session.js";
import { VideoPipeline, encodeVideoMessages, videoRegion, type VideoRegion, type VideoState } from "./video.js";
import { AudioPipeline, encodeAudioMessage } from "./audio.js";
import { browserScale } from "./chrome.js";
import { searchHome, urlBarTarget } from "./search.js";
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
/**
 * 絵が 1 MiB を越えたら画質をこれずつ下げて張り直し（SCREENCAST_MIN_QUALITY まで）、それでも越えたら画素数の上限を
 * SHRINK ずつ縮める（MAX_FRAME_PIXELS まで）。それでも越えた絵は送らずに理由を出す（v4-modules.md §4.1「高精細の画面」）
 */
export const SCREENCAST_QUALITY_STEP = 10;
export const SCREENCAST_MIN_QUALITY = 40;
const SHRINK = 0.75;
/** 静かなページは screencast を張っても絵が来ない（実測・2026-10-10）——これだけ待って来なければ1枚撮って送る */
const FIRST_FRAME_WAIT_MS = 150;
/** 大きさを変える前に、動画の取り込みが止まるのを待つ上限 */
const VIDEO_STOP_WAIT_MS = 1_000;
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

/** JPEG の大きさ（SOF の印から読む）。読めなければ undefined */
export function jpegSize(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}

/**
 * 絵がページと同じ比か（丸めの分は許す）。**倍率で起こすと、起こして数秒の間に1枚だけ窓の素の大きさ（ページ 1280×744 の
 * 2倍）の絵が来ることがある**（実測・2026-10-11：倍率2で10回中1〜2回。1倍では10回中0回。こちらのページの大きさの上書きを
 * 外しても起きる——起こした直後に Google Chrome の窓の枠が細くなるときのもの）。頭はページの大きさを言うので、そのまま
 * 送ると人の画面で絵が縦に伸び、入力の座標もずれる
 */
export function sameAspect(jpeg: { width: number; height: number }, page: { width: number; height: number }): boolean {
  return Math.abs(jpeg.width / jpeg.height / (page.width / page.height) - 1) <= 0.02;
}

/** 画面が描ける絵の形（params の `codec`。無ければ JPEG） */
export type ViewCodec = "h264" | "jpeg";

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
 * **1倍の絵1枚の画素数の上限**（1.6 メガ画素＝1600×1000）。流れの1通は 1 MiB まで（アーキ仕様 §5.8）で、越えると host が
 * 1009 で閉じ、画面は繋ぎ直すたびに同じ大きさの絵でまた切れる。実測（2026-10-10、JPEG 画質70）：文字の多いページで
 * 約 0.33 KiB／千画素、乱れた絵（雑音）で約 0.45 KiB／千画素——上限で雑音でも約 725 KiB に収まる。縮めて張り直す下限でもある
 */
export const MAX_FRAME_PIXELS = 1_600_000;
/**
 * **倍率を上げても越えない画素数**（2560×1600——1280×800 のページの2倍）。1倍の上限を倍率の2乗で上げると2倍で 6.4 メガ画素に
 * なり、1 MiB に収まらない：実測（2026-10-11、文字の多いページ）で 2560×1600 は画質70で 1060 KiB・60で 903 KiB、
 * 3840×2160 は画質40でも 1425 KiB。ここまでなら画質60で収まる
 */
export const MAX_HIDPI_FRAME_PIXELS = 2560 * 1600;

/** 倍率で描いているときの画素数の上限（1倍の上限×倍率の2乗。MAX_HIDPI_FRAME_PIXELS で頭を押さえる） */
export function maxFramePixels(scale: number): number {
  return Math.max(MAX_FRAME_PIXELS, Math.min(MAX_FRAME_PIXELS * scale * scale, MAX_HIDPI_FRAME_PIXELS));
}

/** 最初に張るときの画質：1倍の上限までは70、越える大きさ（倍率で描いた絵）は60（1 MiB に収まる見込み——上の実測） */
export function initialQuality(pixels: number): number {
  return pixels <= MAX_FRAME_PIXELS ? SCREENCAST_QUALITY : SCREENCAST_QUALITY - SCREENCAST_QUALITY_STEP;
}

/**
 * **screencast の大きさの上限**：映している画面のうち一番大きいもの（デバイスピクセル）に合わせ、ページをブラウザの描く倍率で
 * 描いた大きさ（絵はそれより大きくならない）で頭を押さえる。小さな揺れで張り直さないよう 64 で丸める。
 * そのうえで、絵（ページを縦横同じ比で縮めたもの）が maxPixels を越えないよう縮める
 */
export function screencastLimits(
  viewers: ViewerSize[],
  viewport: { width: number; height: number },
  scale = 1,
  maxPixels = maxFramePixels(scale),
): { maxWidth: number; maxHeight: number } {
  const up = (n: number) => Math.ceil(n / 64) * 64;
  // 倍率は 0.25 刻み（1.25・1.5・1.75 もある）なので、ページ×倍率は端数になりうる。Page.startScreencast の maxWidth・maxHeight は
  // 整数しか受けず、端数だと「Invalid parameters」で画面が映らなかった（実機・2026-10-13、倍率 1.25 の画面で 833×605 のページ）
  const full = { width: Math.floor(viewport.width * scale), height: Math.floor(viewport.height * scale) };
  let w = 0;
  let h = 0;
  for (const v of viewers) {
    w = Math.max(w, v.width * v.devicePixelRatio);
    h = Math.max(h, v.height * v.devicePixelRatio);
  }
  const maxWidth = Math.min(full.width, up(w || full.width));
  const maxHeight = Math.min(full.height, up(h || full.height));
  // 絵はページの比のまま、両方の上限に収まるまで縮む
  const k = Math.min(maxWidth / full.width, maxHeight / full.height);
  const cap = Math.sqrt(maxPixels / (full.width * full.height));
  if (k <= cap) return { maxWidth, maxHeight };
  return { maxWidth: Math.floor(full.width * cap), maxHeight: Math.floor(full.height * cap) };
}

/** 描いた絵（ページ×倍率）を上限のうちに収める縮め方（1以下） */
export function frameScale(limits: { maxWidth: number; maxHeight: number }, viewport: { width: number; height: number }, scale = 1): number {
  return Math.min(1, limits.maxWidth / (viewport.width * scale), limits.maxHeight / (viewport.height * scale));
}

/** 上限のうちに来る絵の画素数（ページの比のまま縮む） */
export function framePixels(limits: { maxWidth: number; maxHeight: number }, viewport: { width: number; height: number }, scale = 1): number {
  const k = frameScale(limits, viewport, scale);
  return Math.round(viewport.width * scale * k) * Math.round(viewport.height * scale * k);
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
  | { type: "start" }
  | { type: "keyframe" }
  | { type: "codec"; codec: ViewCodec }
  | { type: "audio"; on: boolean };

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
      // URL か検索する言葉かは、開くときに設定の検索エンジンで決める（search.ts の urlBarTarget）
      return typeof m.url === "string" && m.url.trim() !== "" ? { type: "navigate", url: m.url.trim() } : { error: "navigate に url がありません" };
    case "history":
      return m.action === "back" || m.action === "forward" || m.action === "reload"
        ? { type: "history", action: m.action }
        : { error: "history の action は back・forward・reload です" };
    case "fit":
      return typeof m.on === "boolean" ? { type: "fit", on: m.on } : { error: "fit の on は true / false です" };
    case "start":
      return { type: "start" };
    case "keyframe":
      return { type: "keyframe" };
    case "codec":
      return m.codec === "h264" || m.codec === "jpeg" ? { type: "codec", codec: m.codec } : { error: "codec は h264・jpeg です" };
    case "audio":
      return typeof m.on === "boolean" ? { type: "audio", on: m.on } : { error: "audio の on は true / false です" };
    default:
      return { error: "知らないメッセージです" };
  }
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
  /** 画面が描ける形（H.264 を描けると言った画面だけ "h264"） */
  codec: ViewCodec;
  /** いま送っている形（reconcile が決める。H.264 を描ける画面でも、流せないときは JPEG） */
  mode: ViewCodec;
  /** 動画：キーフレームが来るまで送らない（新しく繋いだ・前に戻った・復号に失敗した） */
  needKey: boolean;
  /** 音を出している（人が「音を出す」を押した画面だけ。押すまでは流さない——自動再生の決まり） */
  audio: boolean;
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
  /** 張ったときの画質と画素数の上限（越えたら下げて張り直す——squeeze） */
  quality: number;
  /** 張ったときの上限で来る絵の画素数 */
  pixels: number;
  gotFrame: boolean;
  /** 比の違う絵を捨てた（記録は1度だけ） */
  misshapen?: boolean;
  /** 上限を越えた絵を捨てている間（理由を言うのは越え始めた1度だけ） */
  oversized?: boolean;
}

/** 動画の子プロセスと、流している範囲 */
interface VideoCast {
  pipeline: VideoPipeline;
  /** 流している範囲の印（範囲が変わったら作り直す）。undefined は止めている（大きさを変えている間） */
  key: string | undefined;
  /** 流している絵が映すページの大きさ（CSS ピクセル）——頭に書く */
  viewport: { width: number; height: number };
  /**
   * キーフレームから流し直した、前に出ているタブ（session.front）。替わったら（人の画面のタブの切り替え・＋）流し直して
   * キーフレームを出す——静かなページでは前に出しても XDamage が来ないことがあり、来ても前に出し終える前の変化で、
   * 絵の頭は前のタブのまま止まる（Backlog #342）
   */
  front: string | undefined;
  state: VideoState;
  /** 止まったら呼ぶ（大きさを変える前に待つ——beforeResize） */
  onStopped?: () => void;
}

/** 音の子プロセス */
interface AudioCast {
  pipeline: AudioPipeline;
}

/** 状態を見る口（getBrowserStatus の view）が返すもの */
export interface ViewStatus {
  viewers: number;
  watching: number;
  /** 絵を流しているか（JPEG の screencast か動画のどちらか） */
  screencasting: boolean;
  screencastTab?: string;
  /** 動画の子プロセスが動いている間だけ：状態・出したアクセスユニットの数・キーフレームの数・合計の大きさ・動画で見ている画面の数 */
  video?: { state: VideoState; units: number; keys: number; bytes: number; viewers: number };
  /** 音の子プロセスが動いている間だけ：鳴っているか・出した包みの数・合計の大きさ・音を出している画面の数 */
  audio?: { sounding: boolean; packets: number; bytes: number; viewers: number };
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
  /**
   * 人の入力を渡す CDP の口（いま映しているタブに1本）。screencast の口とは別に持つ——動画で映している間は screencast を
   * 張らないので、screencast の口に入力を載せると動画の画面からの入力が届かない
   */
  private control: { page: Page; cdp: CDPSession } | undefined;
  private video: VideoCast | undefined;
  /**
   * 動画が失敗した理由（ブラウザが動いている間は動画を使わない）。**ブラウザが止まったら消す**——起こし直したら試し直す。
   * 仮想の画面の名前では比べない：Xvfb は空いている一番小さい番号を選ぶので、起こし直しても同じ名前（:99 等）になる
   */
  private videoFailure: string | undefined;
  private audio: AudioCast | undefined;
  /** 音が失敗した理由（動画と同じく、ブラウザが止まったら消して試し直す） */
  private audioFailure: string | undefined;
  private audioSeq = 0;
  private last: Frame | undefined;
  private seq = 0;
  /** screencast の張り直しは1つずつ */
  private chain: Promise<void> = Promise.resolve();
  /** 人の入力は1つずつ（input） */
  private inputChain: Promise<void> = Promise.resolve();
  /** 「画面に合わせる」を入れている画面（ページの大きさは1つなので、合わせるのは1つの画面だけ） */
  private fitOwner: Viewer | undefined;
  /**
   * 1 MiB を越えて下げた画質・画素数の上限。同じタブ・ページの大きさ・映す画面の大きさ（base）の間は下げたまま
   * （上げ直すとまた越える）。どれかが変わったら最初から
   */
  private squeeze: { base: string; quality?: number; maxPixels?: number } | undefined;
  /** 「画面に合わせる」で大きさを変えた（切ったら既定に戻す） */
  private fitted = false;
  private starting = false;
  private stateTimer: NodeJS.Timeout | undefined;
  private logTimer: NodeJS.Timeout | undefined;
  private readonly logLine: (line: string) => void;

  constructor(private readonly deps: BrowserViewDeps) {
    this.logLine = deps.logLine ?? ((line) => process.stderr.write(`[browser] ${line}\n`));
    deps.session.subscribe(() => {
      if (!deps.session.running) {
        this.videoFailure = undefined;
        this.audioFailure = undefined;
      }
      this.refresh();
    });
    deps.session.beforeResize = () => this.pauseVideo();
    deps.log.onChange = () => this.logChanged();
  }

  /** 流れ「browser」の受け口 */
  handler(): StreamHandler {
    return (ws, stamp) => this.attach(ws, stamp);
  }

  /** 状態を見る口（getBrowserStatus）が返す */
  status(): ViewStatus {
    const video = this.video;
    const audio = this.audio;
    const videoOn = video !== undefined && video.key !== undefined;
    const tab = this.cast?.tab ?? (videoOn ? this.deps.session.current : undefined);
    return {
      viewers: this.viewers.size,
      watching: [...this.viewers].filter((v) => v.visible).length,
      screencasting: this.cast !== undefined || videoOn,
      ...(tab !== undefined ? { screencastTab: tab } : {}),
      ...(video
        ? {
            video: {
              state: video.state,
              units: video.pipeline.units,
              keys: video.pipeline.keys,
              bytes: video.pipeline.bytes,
              viewers: [...this.viewers].filter((v) => v.visible && v.mode === "h264").length,
            },
          }
        : {}),
      ...(audio
        ? {
            audio: {
              sounding: audio.pipeline.sounding,
              packets: audio.pipeline.packets,
              bytes: audio.pipeline.bytes,
              viewers: this.audioListeners().length,
            },
          }
        : {}),
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
    await this.dropControl();
    this.closeVideo();
    this.closeAudio();
  }

  // ---- 繋ぐ・閉じる ----

  private attach(ws: WebSocket, stamp: StreamStamp): void {
    const p = stamp.params;
    const size = parseViewerSize(p.width, p.height, p.dpr);
    if (!size) {
      ws.close(1008, "画面の大きさ（width・height・dpr）が範囲の外です");
      return;
    }
    const codec: ViewCodec = p.codec === "h264" ? "h264" : "jpeg";
    const viewer: Viewer = {
      ws,
      stamp,
      size,
      visible: p.visible !== false,
      codec,
      mode: "jpeg",
      needKey: true,
      audio: p.audio === true,
      waiting: undefined,
      pending: undefined,
      release: this.deps.session.hold(),
    };
    this.viewers.add(viewer);
    this.rememberScale();
    this.logLine(`人の画面が開きました（いま ${this.viewers.size} 本${stamp.threadId ? "・会話の中" : ""}・${codec === "h264" ? "H.264 を描ける" : "JPEG"}）`);
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

  /**
   * 開いている画面のうち一番大きい倍率を、次にブラウザを起こすときの描く倍率として覚える（state の viewScale）。
   * **動いているブラウザの倍率は変えない**——起こすときにしか決められず（chrome.ts）、起こし直すと開いているページが消える。
   * 低い倍率で動いている間に高い画面が開いたら、次に起こすまで今の倍率の絵を引き伸ばして映す
   */
  private rememberScale(): void {
    let dpr = 0;
    for (const v of this.viewers) dpr = Math.max(dpr, v.size.devicePixelRatio);
    if (dpr === 0) return;
    const scale = browserScale(dpr);
    if (this.deps.state.get().viewScale === scale) return;
    this.deps.state.set({ viewScale: scale });
    const running = this.deps.session.scale;
    if (running !== undefined && running < scale) this.logLine(`人の画面の倍率は ${scale} ですが、ブラウザは ${running} 倍で描いています（次に起こしたときから ${scale} 倍）`);
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
        this.rememberScale();
        if (this.fitOwner === v) void this.applyFit();
        this.reconcile();
        return;
      case "visible":
        if (v.visible === m.visible) return;
        v.visible = m.visible;
        if (!m.visible) v.pending = undefined;
        // 裏に回っている間の P フレームは送っていない——前に戻ったらキーフレームから
        else v.needKey = true;
        this.reconcile();
        if (m.visible && v.mode === "jpeg") this.offerLast(v);
        return;
      case "keyframe":
        // 復号に失敗した：キーフレームから送り直す
        v.needKey = true;
        if (v.mode === "h264") this.video?.pipeline.keyframe();
        return;
      case "codec":
        if (v.codec === m.codec) return;
        v.codec = m.codec;
        this.logLine(`人の画面が ${m.codec === "jpeg" ? "H.264 を描けなくなったので JPEG に替えました" : "H.264 で描けると言いました"}`);
        v.needKey = true;
        this.reconcile();
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
            // 人の新しいタブは検索エンジンのトップで開く（v4-modules.md §4.1「新しいタブと URL 欄の検索」）。読み込みは待たない
            // ——人のブラウザと同じく、届かなければそのタブにブラウザの失敗のページが出る
            await s.ensure();
            await s.newTab(undefined, searchHome(this.deps.state.get()));
          } else if (m.action === "select") s.select(m.tab);
          else await s.close(m.tab);
        });
        return;
      case "navigate":
        void this.act(v, async () => {
          await this.deps.session.ensure();
          const { page } = await this.deps.session.currentOrNew();
          // URL らしくなければ検索エンジンで調べる（search.ts）
          await page.goto(urlBarTarget(m.url, this.deps.state.get()), { timeout: 30_000 });
        });
        return;
      case "history":
        void this.act(v, async () => {
          const { page } = this.deps.session.page();
          // 移ったところまで待つ（キャッシュから戻すと load が来ない——tools.ts の back）
          if (m.action === "back") await page.goBack({ waitUntil: "commit", timeout: 15_000 });
          else if (m.action === "forward") await page.goForward({ waitUntil: "commit", timeout: 15_000 });
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
      case "audio":
        if (v.audio === m.on) return;
        v.audio = m.on;
        this.logLine(`人の画面が音を${m.on ? "出しました" : "止めました"}`);
        this.reconcile();
        return;
    }
  }

  /**
   * 人の入力を、いま映しているタブへそのまま渡す（映していなければ、人は何も見ていない——捨てる）。**1つずつ、前の応答を
   * 待ってから次を渡す**——CDP の Input.* は投げた順に処理されるとは限らない。タッチ（ブラウザのプロセスの入力の経路を通る）の
   * 後に続けて投げた insertText（描画のプロセスへ直に行く）が追い越し、入力欄に焦点が来る前に文字が入って消えた
   * （実測・2026-10-11、Backlog #260：読み込んだばかりのページで初めての指のすぐ後の insertText が、待たずに流すと20回中20回消え、
   * 待つと40回中0回）。1つが返らなくても後ろを止めないよう、張り直しと同じ上限を付ける
   */
  private input(method: string, params: Record<string, unknown>, v: Viewer): void {
    const control = this.control;
    if (!control) return;
    this.inputChain = this.inputChain.then(() =>
      // Playwright の CDPSession は名前ごとに型が付く——ここでは名前を文字で渡す
      bounded(method, (control.cdp as unknown as { send(m: string, p: unknown): Promise<unknown> }).send(method, params)).then(
        () => undefined,
        (err: Error) => {
          if (this.control !== control) return; // タブが替わった・閉じた——古い口の失敗は人に見せない
          this.sendText(v, { type: "error", message: `入力を渡せませんでした：${err.message.split("\n")[0]}` });
        },
      ),
    );
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
      const want = this.fitSize(owner);
      const now = s.viewport();
      if (now.width === want.width && now.height === want.height) return;
      this.fitted = true;
      await s.setViewport(want);
    } catch (err) {
      this.logLine(`ページの大きさを画面に合わせられませんでした: ${(err as Error).message}`);
      return;
    }
    this.refresh();
  }

  /** 「画面に合わせる」を切った・持っていた画面が閉じた：ページの大きさを既定に戻す */
  private async unfit(): Promise<void> {
    if (!this.fitted) return;
    this.fitted = false;
    if (this.deps.session.running) {
      await this.deps.session.setViewport(DEFAULT_VIEWPORT).catch((err: Error) => this.logLine(`ページの大きさを戻せませんでした: ${err.message}`));
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
    const visible = [...this.viewers].filter((v) => v.visible);
    const s = this.deps.session;
    // 音はタブに関わらず（裏のタブの音も、人のブラウザと同じく鳴る）。音を出している画面が見えている間だけ流す
    this.reconcileAudio();
    const target = visible.length > 0 && s.running && s.current !== undefined ? s.page() : undefined;
    if (!target || target.page.isClosed()) {
      this.closeVideo();
      await this.stopCast();
      await this.dropControl();
      return;
    }
    if (this.control?.page !== target.page) {
      await this.dropControl();
      this.control = { page: target.page, cdp: await bounded("CDP の口を開く", s.newCdp(target.page)) };
    }
    const viewport = s.viewport();
    const scale = s.scale ?? 1;
    // 動画で流せるなら、H.264 を描ける画面には動画で。流せないとき（GStreamer が無い・失敗した・ページが仮想の画面より大きい）は JPEG
    const region = this.videoRegionNow(viewport, scale);
    for (const v of visible) {
      const mode: ViewCodec = region && v.codec === "h264" ? "h264" : "jpeg";
      if (v.mode !== mode) {
        v.mode = mode;
        v.needKey = true;
        v.waiting = undefined;
        v.pending = undefined;
        if (mode === "jpeg") this.offerLast(v);
      }
    }
    const videoWatchers = visible.filter((v) => v.mode === "h264");
    if (videoWatchers.length > 0 && region) this.runVideo(region, viewport, videoWatchers);
    else this.closeVideo();
    const watchers = visible.filter((v) => v.mode === "jpeg");
    if (watchers.length === 0) {
      await this.stopCast();
      return;
    }
    const sizes = watchers.map((v) => v.size);
    const base = `${target.id} ${viewport.width}x${viewport.height} @${scale} ${sizes.map((v) => `${v.width}x${v.height}@${v.devicePixelRatio}`).join(",")}`;
    if (this.squeeze?.base !== base) this.squeeze = { base };
    const maxPixels = this.squeeze.maxPixels ?? maxFramePixels(scale);
    const limits = screencastLimits(sizes, viewport, scale, maxPixels);
    const pixels = framePixels(limits, viewport, scale);
    const quality = this.squeeze.quality ?? initialQuality(pixels);
    const key = `${target.id} ${viewport.width}x${viewport.height} @${scale} ${limits.maxWidth}x${limits.maxHeight} q${quality}`;
    if (this.cast && this.cast.key === key && this.cast.page === target.page) return;
    await this.stopCast();
    const cdp = await bounded("CDP の口を開く", s.newCdp(target.page));
    const cast: Cast = { tab: target.id, page: target.page, cdp, key, quality, pixels, gotFrame: false };
    this.cast = cast;
    try {
      await this.startCast(cast, limits, viewport, scale);
    } catch (err) {
      // 張りかけの screencast を残さない——残すと「同じ形で張ってある」と見て、次の張り直しで直らない
      if (this.cast === cast) await this.stopCast();
      throw err;
    }
  }

  private async startCast(
    cast: Cast,
    limits: { maxWidth: number; maxHeight: number },
    viewport: { width: number; height: number },
    scale: number,
  ): Promise<void> {
    const cdp = cast.cdp;
    cdp.on("Page.screencastFrame", (f) => this.onFrame(cast, f, viewport));
    await bounded(
      "Page.startScreencast",
      cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: cast.quality,
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
        quality: cast.quality,
        clip: {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: viewport.width,
          height: viewport.height,
          // clip の scale はページを描いた倍率に掛かる（倍率2で 1 なら CSS の2倍の絵）——screencast の絵と同じ大きさにする
          scale: frameScale(limits, viewport, scale),
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
    // ページの大きさが変わった（AI の resize・人の「画面に合わせる」）——張り直すと新しい大きさの絵になる
    const now = this.deps.session.viewport();
    if (now.width !== viewport.width || now.height !== viewport.height) this.refresh();
    // 頭の大きさは張ったときのページの大きさ（張ったままの screencast はその大きさの絵を出す）。絵に付いてくる
    // `metadata.deviceWidth`・`deviceHeight` は使わない——縮めて流すとき、縮めた絵の大きさを返すことがある
    // （実測・2026-10-10：2560×1440 を 1685×948 に縮めて、20回中2回。人の入力の座標がずれる）
    const { width, height } = viewport;
    const jpeg = Buffer.from(f.data, "base64");
    // 比の違う絵は送らない（sameAspect）。窓の大きさが落ち着けば、正しい絵が続けて来る
    const size = jpegSize(jpeg);
    if (!size || !sameAspect(size, viewport)) {
      if (!cast.misshapen) this.logLine(`ページ（${width}×${height}）と比の違う絵（${size ? `${size.width}×${size.height}` : "大きさが読めない"}）を捨てました`);
      cast.misshapen = true;
      return;
    }
    cast.gotFrame = true;
    const seq = ++this.seq;
    this.deliver(cast, { seq, tab: cast.tab, data: encodeFrame({ seq, tab: cast.tab, width, height }, jpeg) }, viewport);
  }


  private deliver(cast: Cast, frame: Frame, page: { width: number; height: number }): void {
    // **1 MiB を越える絵は送らない**——送ると host が流れを 1009 で閉じ、画面は繋ぎ直すたびに同じ絵でまた切れる（理由が人に
    // 届かない）。上限の画素数（MAX_FRAME_PIXELS）で抑えているので、来るのは極端な絵だけ。理由は越え始めたときに1度だけ言う
    if (frame.data.length > (this.deps.maxMessageBytes ?? STREAM_MAX_MESSAGE_BYTES)) {
      if (!cast.oversized) {
        cast.oversized = true;
        const kib = Math.round(frame.data.length / 1024);
        // まず画質を下げ、次に画素数の上限を縮めて張り直す（この絵は捨てる——張り直した絵か、撮った1枚が次に来る）
        if (this.squeezeDown(cast)) {
          const sq = this.squeeze!;
          this.logLine(`絵が ${kib} KiB で流れの1通の上限を越えたので、画質 ${sq.quality}${sq.maxPixels ? `・${Math.round(sq.maxPixels / 1000)} 千画素まで` : ""}で張り直します`);
          this.reconcile();
          return;
        }
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
      if (!v.visible || v.mode !== "jpeg") continue;
      if (v.waiting !== undefined) v.pending = frame;
      else this.sendFrame(v, frame);
    }
  }

  /** 越えた絵を張ったときの画質・上限から1段下げる。もう下げられなければ false */
  private squeezeDown(cast: Cast): boolean {
    const sq = this.squeeze;
    if (!sq || this.cast !== cast) return false;
    if (cast.quality > SCREENCAST_MIN_QUALITY) {
      sq.quality = Math.max(SCREENCAST_MIN_QUALITY, cast.quality - SCREENCAST_QUALITY_STEP);
      return true;
    }
    // 縮めるのは来ている絵の画素数から（上限より小さな絵——画面が小さい——で上限だけ縮めても、絵は変わらない）
    if (cast.pixels > MAX_FRAME_PIXELS) {
      sq.quality = cast.quality;
      sq.maxPixels = Math.max(MAX_FRAME_PIXELS, Math.floor(cast.pixels * SHRINK));
      return true;
    }
    return false;
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

  private async dropControl(): Promise<void> {
    const control = this.control;
    if (!control) return;
    this.control = undefined;
    // タブが閉じた後なら口はもう無い（投げる）——閉じたいのは同じ。返らないときだけ記録する（stopCast と同じ）
    await bounded("CDP の口を閉じる", control.cdp.detach()).catch((err: Error) => {
      if (err.message.includes("返りませんでした")) this.logLine(err.message);
    });
  }

  // ---- 動画 ----

  /** 動画で流せない理由（H.264 を描ける画面に出す）。流せる・ブラウザが動いていなければ undefined */
  private videoNote(): string | undefined {
    const d = this.deps.session.display;
    if (!d) return undefined;
    if (!d.video.available) return d.video.reason;
    if (this.videoFailure !== undefined) return this.videoFailure;
    const scale = this.deps.session.scale ?? 1;
    if (!videoRegion(this.deps.session.viewport(), scale, d.screen)) {
      return `ページ（${this.deps.session.viewport().width}×${this.deps.session.viewport().height}）が仮想の画面（${Math.round(d.screen.width / scale)}×${Math.round(d.screen.height / scale)}）より大きいので、動画で映せません。JPEG で映しています`;
    }
    return undefined;
  }

  /** いま動画で流せるなら、取り込む範囲 */
  private videoRegionNow(viewport: { width: number; height: number }, scale: number): VideoRegion | undefined {
    const d = this.deps.session.display;
    if (!d || !d.video.available || this.videoFailure !== undefined) return undefined;
    return videoRegion(viewport, scale, d.screen);
  }

  /** 動画を流す：子プロセスが無ければ起こし、範囲が変わったら作り直す。キーフレームを待っている画面があれば頼む */
  private runVideo(region: VideoRegion, viewport: { width: number; height: number }, watchers: Viewer[]): void {
    const s = this.deps.session;
    const d = s.display!;
    // 大きさを変えている間は流さない（変え終えたら次の reconcile で流し直す）
    if (s.resizing) {
      if (this.video && this.video.key !== undefined) {
        this.video.key = undefined;
        this.video.pipeline.stop();
      }
      return;
    }
    if (!this.video) {
      const cast: VideoCast = { pipeline: undefined as unknown as VideoPipeline, key: undefined, viewport, front: undefined, state: "stopped" };
      cast.pipeline = new VideoPipeline(d.name, {
        onUnit: (au, key, ts) => this.onVideoUnit(cast, au, key, ts),
        onState: (state) => {
          cast.state = state;
          if (state === "stopped") {
            cast.onStopped?.();
            cast.onStopped = undefined;
          }
        },
        onError: (message) => this.onVideoError(cast, message),
        onWarning: (message) => this.logLine(`動画の子プロセスの知らせ（流れは止めない）: ${message}`),
      });
      this.video = cast;
      this.logLine(`動画で流し始めます（仮想の画面 ${d.name}）`);
    }
    const video = this.video;
    const key = `${region.w}x${region.h}>${region.ew}x${region.eh} ${viewport.width}x${viewport.height}`;
    // 前に出し終えたタブが替わった：替えた先の絵をキーフレームから送る（前のタブの P フレームの続きにしない）
    if (video.front !== s.front) {
      video.front = s.front;
      for (const v of watchers) v.needKey = true;
    }
    if (video.key !== key) {
      video.key = key;
      video.viewport = { ...viewport };
      for (const v of watchers) v.needKey = true;
      // 作り直した圧縮器の最初の1枚はキーフレーム
      video.pipeline.start(region);
      return;
    }
    if (watchers.some((v) => v.needKey)) video.pipeline.keyframe();
  }

  private onVideoUnit(cast: VideoCast, au: Buffer, key: boolean, ts: number): void {
    if (this.video !== cast || cast.key === undefined) return;
    // 映っているタブ（前に出し終えたタブ。選んだ直後はまだ前のタブの絵）
    const tab = this.deps.session.front ?? this.deps.session.current;
    if (tab === undefined) return;
    const seq = ++this.seq;
    let messages: Buffer[] | undefined;
    for (const v of this.viewers) {
      if (!v.visible || v.mode !== "h264" || v.ws.readyState !== v.ws.OPEN) continue;
      if (v.needKey) {
        if (!key) continue;
        v.needKey = false;
      }
      messages ??= encodeVideoMessages({ seq, tab, ...cast.viewport, codec: "h264", key, ts }, au, this.deps.maxMessageBytes ?? STREAM_MAX_MESSAGE_BYTES);
      for (const m of messages) v.ws.send(m, { binary: true });
    }
  }

  private onVideoError(cast: VideoCast, message: string): void {
    // 止めた後の古い子の知らせ（作り直した後・閉じた後）は今の流れの失敗ではない
    if (this.video !== cast) return;
    this.logLine(`動画で流せなくなりました（JPEG に替えます）: ${message}`);
    this.videoFailure = `動画で流せなくなりました（${message.split("\n")[0]}）。JPEG で映しています`;
    this.video = undefined;
    cast.pipeline.close();
    cast.onStopped?.();
    this.scheduleState();
    this.reconcile();
  }

  /**
   * 大きさを変える前（session の beforeResize）：取り込みを止め、止まったと子プロセスが言うまで待つ——それまでに出た絵は
   * 変える前の絵なので送ってよい。待ちきれなければ（子が詰まっている）理由を残して進む
   */
  private async pauseVideo(): Promise<void> {
    const video = this.video;
    if (!video || video.key === undefined) return;
    video.key = undefined;
    if (video.state === "stopped") return;
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), VIDEO_STOP_WAIT_MS);
      video.onStopped = () => {
        clearTimeout(timer);
        resolve(true);
      };
      video.pipeline.stop();
    });
    if (!stopped) this.logLine(`動画の取り込みが ${VIDEO_STOP_WAIT_MS}ms で止まりませんでした（大きさを変えます）`);
  }

  private closeVideo(): void {
    const video = this.video;
    if (!video) return;
    this.video = undefined;
    video.pipeline.close();
    video.onStopped?.();
    this.logLine("動画を止めました（動画で見ている画面がありません）");
  }

  // ---- 音 ----

  /** 音を出していて、見えている画面 */
  private audioListeners(): Viewer[] {
    return [...this.viewers].filter((v) => v.visible && v.audio);
  }

  /** 音を流せない理由（ブラウザが動いていて、流せないとき）。流せる・動いていなければ undefined */
  private audioNote(): string | undefined {
    const d = this.deps.session.display;
    if (!d) return undefined;
    if (!d.audio.available) return d.audio.reason;
    return this.audioFailure;
  }

  /** 音を出している画面が見えていれば子を起こし、居なければ止める */
  private reconcileAudio(): void {
    const d = this.deps.session.display;
    const route = d && this.deps.session.running && d.audio.available && this.audioFailure === undefined ? d.audio : undefined;
    if (!route || this.audioListeners().length === 0) {
      this.closeAudio();
      return;
    }
    if (this.audio) return;
    const cast: AudioCast = { pipeline: undefined as unknown as AudioPipeline };
    cast.pipeline = new AudioPipeline(route.server, {
      onPacket: (packet, ts, dur) => this.onAudioPacket(cast, packet, ts, dur),
      onSound: (sounding) => this.logLine(sounding ? "ブラウザの音が鳴り始めました" : "ブラウザの音がやみました"),
      onError: (message) => this.onAudioError(cast, message),
    });
    this.audio = cast;
    this.logLine("音を流し始めます");
  }

  private onAudioPacket(cast: AudioCast, packet: Buffer, ts: number, dur: number): void {
    if (this.audio !== cast) return;
    let message: Buffer | undefined;
    for (const v of this.audioListeners()) {
      if (v.ws.readyState !== v.ws.OPEN) continue;
      message ??= encodeAudioMessage({ seq: ++this.audioSeq, codec: "opus", ts, dur }, packet);
      v.ws.send(message, { binary: true });
    }
  }

  private onAudioError(cast: AudioCast, message: string): void {
    if (this.audio !== cast) return;
    this.logLine(`音を流せなくなりました（音無しにします）: ${message}`);
    this.audioFailure = `音を流せなくなりました（${message.split("\n")[0]}）。音無しで映しています`;
    this.audio = undefined;
    cast.pipeline.close();
    this.scheduleState();
  }

  private closeAudio(): void {
    const audio = this.audio;
    if (!audio) return;
    this.audio = undefined;
    audio.pipeline.close();
    this.logLine("音を止めました（音を出して見ている画面がありません）");
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
      if (tabs.some((t) => t.current)) viewport = s.viewport();
    }
    const videoNote = this.videoNote();
    const audioNote = this.audioNote();
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
        // H.264 を描ける画面に、動画で映せない理由（JPEG で映している）
        ...(v.codec === "h264" && videoNote ? { videoUnavailable: videoNote } : {}),
        // 音を流せない理由（画面は「音を出す」の代わりに「音無し」と出す）
        ...(audioNote ? { audioUnavailable: audioNote } : {}),
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
