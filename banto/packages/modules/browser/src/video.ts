// **人の画面を動画で流す**（v4-modules.md §4.1「動画で流す——H.264 と WebCodecs」、決定・2026-10-12、ユーザー（案X））。
//
// 仮想の画面（Xvfb）を GStreamer で取り込んで H.264 に圧縮する。GStreamer は python3 の gi から動かす子プロセス1本
// （VIDEO_SCRIPT）——指示は標準入力の JSON 1行ずつ、出力は標準出力に `[長さ（4バイト、big endian）][種類（1バイト）][中身]`。
// 種類は 0＝アクセスユニット（P）・1＝アクセスユニット（キーフレーム）・2＝知らせ（JSON：ready・state・error・warning）。
// アクセスユニットの頭には取り込んだ時刻（µs、8バイト）——**音の子（audio.ts）と同じ時計**（CLOCK_MONOTONIC）で、人の画面が
// 音と映像の時刻を合わせる。
// error は流れが止まった失敗（JPEG に替える）、warning は流れを止めない失敗（止める・キーフレームの指示が効かなかった等。
// ログに残すだけ）。
//
// - **キーフレームは要求したときだけ**（`key-int-max` を大きく、`force-key-unit` で出す）。始めたときは新しい圧縮器なので
//   最初の1枚がキーフレーム
// - **品質固定（CRF 23）＋上限 6 Mbit/s＋vbv 1000ms**（2560×1600 のキーフレームが 1 MiB に収まる——段1 の実測）
// - **静止中は止める**：XDamage で画面の変化を見て、300ms 変化が無ければ流れを PAUSED にし、変化かキーフレームの要求で
//   PLAYING に戻す。キーフレームを頼んで出る前は止めない
// - マウスの矢印は絵に入れない（`show-pointer=false`——人の画面が自分の矢印を持つ）
//
// GStreamer と python3-gi はブラウザを入れる段で入れる（ensureVideo）。入れられない箱では理由を返し、人の画面は JPEG で映す。

import { spawn, type ChildProcess } from "node:child_process";

/** コンテナに入れる包み（Ubuntu 24.04 の名前。ximagesrc は good・x264enc は ugly・h264parse は bad） */
export const VIDEO_PACKAGES = [
  "python3-gi",
  "gir1.2-gstreamer-1.0",
  "gir1.2-gst-plugins-base-1.0",
  "gstreamer1.0-plugins-base",
  "gstreamer1.0-plugins-good",
  "gstreamer1.0-plugins-bad",
  "gstreamer1.0-plugins-ugly",
  "gstreamer1.0-x",
  "libxdamage1",
];

/** 静止とみなすまでの時間（段1 で決めた 300ms） */
export const VIDEO_IDLE_MS = 300;
/** 取り込む枚数（毎秒） */
export const VIDEO_FPS = 30;
/** 品質固定の値（x264 の CRF） */
export const VIDEO_CRF = 23;
/** 上限の速さ（kbit/s）と vbv の長さ（ms） */
export const VIDEO_MAX_KBPS = 6000;
export const VIDEO_VBV_MS = 1000;
/**
 * 圧縮する絵の画素数の上限（2560×1600——1280×800 のページの2倍。JPEG の上限と同じ）。越えるページ（1920×1080 を倍率2 等）は
 * 縦横同じ比で縮めて圧縮する（頭の大きさはページの CSS ピクセルのままなので、人の入力の座標は変わらない）
 */
export const MAX_VIDEO_PIXELS = 2560 * 1600;

const ELEMENTS = ["ximagesrc", "videoconvert", "videoscale", "x264enc", "h264parse", "appsink"];

/** 動かす python（gi で GStreamer、ctypes で XDamage）。引数は画面の名前（`:99`）と静止とみなす ms */
export const VIDEO_SCRIPT = String.raw`
import sys, os, json, struct, threading, ctypes, ctypes.util, time
import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gst, GstVideo, GLib

Gst.init(None)
DISPLAY = sys.argv[1]
IDLE_MS = int(sys.argv[2])
out = sys.stdout.buffer
lock = threading.Lock()

def emit(kind, payload):
    with lock:
        out.write(struct.pack(">IB", len(payload), kind))
        out.write(payload)
        out.flush()

def event(obj):
    emit(2, json.dumps(obj, ensure_ascii=False).encode())

missing = [e for e in ${JSON.stringify(ELEMENTS)} if Gst.ElementFactory.find(e) is None]
if missing:
    event({"error": "GStreamer の要素がありません: " + ", ".join(missing)})
    sys.exit(3)

class XEvent(ctypes.Union):
    _fields_ = [("type", ctypes.c_int), ("pad", ctypes.c_long * 24)]

try:
    x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    xd = ctypes.CDLL(ctypes.util.find_library("Xdamage") or "libXdamage.so.1")
except OSError as err:
    event({"error": "X のライブラリ（libX11・libXdamage）を読めません: " + str(err)})
    sys.exit(3)
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XConnectionNumber.argtypes = [ctypes.c_void_p]
x11.XPending.argtypes = [ctypes.c_void_p]
x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
x11.XFlush.argtypes = [ctypes.c_void_p]
xd.XDamageQueryExtension.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xd.XDamageCreate.restype = ctypes.c_ulong
xd.XDamageCreate.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
xd.XDamageSubtract.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]

dpy = x11.XOpenDisplay(DISPLAY.encode())
if not dpy:
    event({"error": "画面 " + DISPLAY + " を開けません"})
    sys.exit(3)
ev_base = ctypes.c_int()
err_base = ctypes.c_int()
if not xd.XDamageQueryExtension(dpy, ctypes.byref(ev_base), ctypes.byref(err_base)):
    event({"error": "画面 " + DISPLAY + " に XDamage がありません"})
    sys.exit(3)
# XDamageReportNonEmpty：空→空でないに変わったときに1回知らせる（受けたら引いて空に戻す）
damage = xd.XDamageCreate(dpy, x11.XDefaultRootWindow(dpy), 3)
x11.XFlush(dpy)

loop = GLib.MainLoop()
pipeline = None
appsink = None
state = "stopped"
last_damage = time.monotonic()
key_pending = False

def set_state(s):
    global state
    if state != s:
        state = s
        event({"state": s})

# 音の子と同じ時計（CLOCK_MONOTONIC）。取り込んだ時刻＝base time＋pts（止めて流し直しても時計の時刻のまま）
clock = Gst.SystemClock.obtain()
clock.set_property("clock-type", Gst.ClockType.MONOTONIC)

def on_sample(sink):
    global key_pending
    sample = sink.emit("pull-sample")
    buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    if ok:
        key = not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
        if key:
            key_pending = False
        # この1枚を出したパイプライン（作り直しの最中は global の pipeline が替わっている）。pts は segment の中の時刻——x264enc は
        # segment を 1000 時間ずらして出す（実測・2026-10-15：pts をそのまま足すと音より 3600000 秒先）ので、running time に直す
        owner = sink.get_parent()
        running = sample.get_segment().to_running_time(Gst.Format.TIME, buf.pts) if buf.pts != Gst.CLOCK_TIME_NONE else None
        t = owner.get_base_time() + running if owner is not None and running is not None and running >= 0 else clock.get_time()
        emit(1 if key else 0, struct.pack(">Q", t // 1000) + bytes(info.data))
        buf.unmap(info)
    return Gst.FlowReturn.OK

def build(c):
    global pipeline, appsink, key_pending, last_damage
    teardown()
    w, h, ew, eh = c["w"], c["h"], c["ew"], c["eh"]
    scale = "" if (ew, eh) == (w, h) else "videoscale ! video/x-raw,width=%d,height=%d ! " % (ew, eh)
    desc = (
        "ximagesrc display-name=%s use-damage=false show-pointer=false startx=0 starty=0 endx=%d endy=%d " % (DISPLAY, w - 1, h - 1)
        + "! video/x-raw,framerate=%d/1 ! queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 " % c["fps"]
        + "! videoconvert ! " + scale + "video/x-raw,format=I420 "
        + "! x264enc tune=zerolatency speed-preset=ultrafast pass=qual quantizer=%d key-int-max=1000000 " % c["crf"]
        + "option-string=vbv-maxrate=%d:vbv-bufsize=%d " % (c["maxKbps"], c["maxKbps"] * c["vbvMs"] // 1000)
        + "! video/x-h264,profile=constrained-baseline ! h264parse config-interval=-1 "
        + "! video/x-h264,stream-format=byte-stream,alignment=au "
        + "! appsink name=sink emit-signals=true sync=false max-buffers=4 drop=false"
    )
    pipeline = Gst.parse_launch(desc)
    pipeline.use_clock(clock)
    appsink = pipeline.get_by_name("sink")
    appsink.connect("new-sample", on_sample)
    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message::error", on_error)
    key_pending = True
    last_damage = time.monotonic()
    pipeline.set_state(Gst.State.PLAYING)
    set_state("playing")

def teardown():
    global pipeline, appsink
    if pipeline is not None:
        pipeline.set_state(Gst.State.NULL)
        pipeline.get_bus().remove_signal_watch()
        pipeline = None
        appsink = None
    set_state("stopped")

def on_error(bus, msg):
    err, dbg = msg.parse_error()
    event({"error": "%s (%s)" % (err.message, dbg)})
    teardown()

def resume():
    global last_damage
    last_damage = time.monotonic()
    if pipeline is not None and state == "paused":
        pipeline.set_state(Gst.State.PLAYING)
        set_state("playing")

def force_key():
    global key_pending
    if pipeline is None:
        return
    key_pending = True
    resume()
    appsink.send_event(GstVideo.video_event_new_upstream_force_key_unit(Gst.CLOCK_TIME_NONE, True, 0))

def drain():
    e = XEvent()
    changed = False
    while x11.XPending(dpy):
        x11.XNextEvent(dpy, ctypes.byref(e))
        if e.type == ev_base.value:
            changed = True
    if changed:
        xd.XDamageSubtract(dpy, damage, 0, 0)
        x11.XFlush(dpy)
        resume()

def on_x(fd, cond):
    drain()
    return True

def tick():
    # Xlib はほかの呼び出し（XFlush 等）の間に知らせを自分の列へ読み込むことがあり、そうなると fd は読めるようにならない
    # ——列に残った変化の知らせを見落として、止まったまま流れ直さなかった（実測・2026-10-13：試験で5回中2回。ここでも読むようにして6回中0回）
    drain()
    if pipeline is not None and state == "playing" and not key_pending and (time.monotonic() - last_damage) * 1000 >= IDLE_MS:
        pipeline.set_state(Gst.State.PAUSED)
        set_state("paused")
    return True

# 標準入力は fd を os.read で読み、改行で分けて、切れ端は自分で持つ。**sys.stdin.readline() を合図1回に1行だけ読む形に
# しない**——Node が続けて書いた2行が1回の読みでまとめて Python のバッファに入ると、2行目は fd が読める状態にならず、
# 次の指示が来るまで処理されなかった（レビューの実測・2026-10-13：key の直後の stop が 0.77 秒後、次の start が届いてから。
# python3 -u は stdin には効かない）。Xlib の列を読む drain と同じ種類の穴
stdin_rest = b""

def on_stdin(fd, cond):
    global stdin_rest
    chunk = os.read(fd, 65536)
    if not chunk:
        teardown()
        loop.quit()
        return False
    stdin_rest += chunk
    while b"\n" in stdin_rest:
        line, stdin_rest = stdin_rest.split(b"\n", 1)
        if line.strip():
            handle(line)
    return True

def handle(line):
    c = None
    try:
        c = json.loads(line)
        if c["cmd"] == "start":
            build(c)
        elif c["cmd"] == "stop":
            teardown()
        elif c["cmd"] == "key":
            force_key()
        else:
            event({"warning": "知らない指示です: " + c["cmd"]})
    except Exception as err:
        # 流し始められなかった（start）なら流れは無い——止まった失敗。止める・キーフレームの失敗は流れを止めない
        if isinstance(c, dict) and c.get("cmd") == "start":
            event({"error": "流し始められません: %s" % err})
        else:
            event({"warning": "指示を実行できません: %s" % err})

GLib.io_add_watch(x11.XConnectionNumber(dpy), GLib.IO_IN, on_x)
GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, on_stdin)
GLib.timeout_add(50, tick)
event({"ready": True})
loop.run()
`;

/** 動画で流せるかを確かめる python（要素がそろっているか）。足りなければ理由を標準出力に1行 */
const CHECK_SCRIPT = String.raw`
import sys
try:
    import gi
    gi.require_version("Gst", "1.0")
    gi.require_version("GstVideo", "1.0")
    from gi.repository import Gst, GstVideo
except Exception as err:
    print("python3 の gi で GStreamer を読めません: %s" % err)
    sys.exit(1)
Gst.init(None)
missing = [e for e in ${JSON.stringify(ELEMENTS)} if Gst.ElementFactory.find(e) is None]
if missing:
    print("GStreamer の要素がありません: " + ", ".join(missing))
    sys.exit(1)
`;

/** 動画で流せるか。流せなければ理由 */
export function checkVideo(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("python3", ["-c", CHECK_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ENOENT" ? "python3 がありません" : err.message));
    child.on("close", (code) => resolve(code === 0 ? undefined : out.trim().split("\n").at(-1) || `確かめが終了コード ${code} で終わりました`));
  });
}

export interface VideoSupport {
  available: boolean;
  /** 流せない理由（人の画面と Module のログに出す） */
  reason?: string;
}

const MANUAL = `\`sudo apt install ${VIDEO_PACKAGES.join(" ")}\``;

/**
 * GStreamer が無ければ入れる。**入れられなくてもブラウザは断らない**——人の画面は JPEG で映す（字体と同じ形——fonts.ts）。
 * sudo しない箱（`BANTO_NO_SUDO=1`）では入れようとしない
 */
export async function ensureVideo(
  install: (onProgress?: (message: string) => void) => Promise<void>,
  onProgress?: (message: string) => void,
  check: () => Promise<string | undefined> = checkVideo,
): Promise<VideoSupport> {
  const missing = await check();
  if (!missing) return { available: true };
  if (process.env.BANTO_NO_SUDO === "1") {
    return {
      available: false,
      reason: `動画で映すための GStreamer がありません（${missing}）。banto はこの実行場所で sudo しないので自動では入れません。JPEG で映します。向こうで ${MANUAL} を打ってから、ブラウザを起こし直すと動画になります`,
    };
  }
  try {
    await install(onProgress);
  } catch (err) {
    return { available: false, reason: `動画で映すための GStreamer を入れられませんでした（${(err as Error).message}）。JPEG で映します` };
  }
  const still = await check();
  return still ? { available: false, reason: `GStreamer を入れましたが、まだ動画で映せません（${still}）。JPEG で映します` } : { available: true };
}

// ---- 大きさ ------------------------------------------------------------------------------------

export interface VideoRegion {
  /** 取り込む大きさ（Xvfb の (0,0) から、デバイスピクセル） */
  w: number;
  h: number;
  /** 圧縮する大きさ（縮めないなら w・h と同じ） */
  ew: number;
  eh: number;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * ページ（CSS ピクセル）を倍率で描いた絵を取り込む範囲。**x264 は偶数の大きさしか受けない**ので、奇数なら右端・下端の
 * 1 画素を落とす。圧縮する大きさは MAX_VIDEO_PIXELS に収まるよう縦横同じ比で縮める。画面（Xvfb、デバイスピクセル）に
 * 収まらないページは取り込めない——undefined（JPEG で映す）
 */
export function videoRegion(
  page: { width: number; height: number },
  scale: number,
  screen: { width: number; height: number },
  maxPixels = MAX_VIDEO_PIXELS,
): VideoRegion | undefined {
  const w = even(Math.round(page.width * scale));
  const h = even(Math.round(page.height * scale));
  if (w > screen.width || h > screen.height) return undefined;
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return k === 1 ? { w, h, ew: w, eh: h } : { w, h, ew: even(w * k), eh: even(h * k) };
}

// ---- 流れの1通 ---------------------------------------------------------------------------------

export interface VideoHeader {
  seq: number;
  tab: string;
  /** その絵が映しているページの大きさ（CSS ピクセル）——人の入力の座標はこの大きさで返す */
  width: number;
  height: number;
  codec: "h264";
  key: boolean;
  /** 取り込んだ時刻（µs、Module の機械の CLOCK_MONOTONIC——音の頭の ts と同じ時計。人の画面が音を合わせる） */
  ts: number;
  /** 1 MiB を越えて分けたとき：何番目か（0 から）と、全部でいくつか */
  part?: number;
  parts?: number;
}

function frameMessage(header: object, body: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([len, head, body]);
}

/**
 * アクセスユニット1つを流れの1通（`[頭の長さ][頭][中身]`）にする。**1 MiB を越えるなら分ける**——頭に `part`・`parts` を付け、
 * 画面がつなぎ直してから復号する
 */
export function encodeVideoMessages(header: Omit<VideoHeader, "part" | "parts">, au: Buffer, maxBytes: number): Buffer[] {
  const whole = frameMessage(header, au);
  if (whole.length <= maxBytes) return [whole];
  // 頭の分（part・parts の桁を含めて多めに）を引いた残りで割る
  const room = maxBytes - (Buffer.byteLength(JSON.stringify(header)) + 64);
  const parts = Math.ceil(au.length / room);
  const out: Buffer[] = [];
  for (let i = 0; i < parts; i++) out.push(frameMessage({ ...header, part: i, parts }, au.subarray(i * room, (i + 1) * room)));
  return out;
}

/** Annex B のアクセスユニットから SPS を探し、WebCodecs の codec の名前（`avc1.PPCCLL`）を返す。無ければ undefined */
export function h264CodecString(au: Buffer): string | undefined {
  for (let i = 0; i + 4 < au.length; i++) {
    const start3 = au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1;
    if (!start3) continue;
    const nal = au[i + 3]!;
    if ((nal & 0x1f) === 7 && i + 6 < au.length) {
      const hex = (b: number) => b.toString(16).padStart(2, "0").toUpperCase();
      return `avc1.${hex(au[i + 4]!)}${hex(au[i + 5]!)}${hex(au[i + 6]!)}`;
    }
  }
  return undefined;
}

// ---- 子プロセス --------------------------------------------------------------------------------

export type VideoState = "stopped" | "playing" | "paused";

export interface VideoPipelineEvents {
  /** アクセスユニットが1つ出た（ts は取り込んだ時刻 µs） */
  onUnit: (au: Buffer, key: boolean, ts: number) => void;
  onState: (state: VideoState) => void;
  /** 失敗（圧縮が止まった・子が終わった）。理由つき */
  onError: (message: string) => void;
  /** 流れを止めない失敗（ログに残すだけ） */
  onWarning: (message: string) => void;
}

/** GStreamer の子プロセス1本。start で取り込む範囲を決めて流し、stop で止め（大きさを変える間）、close で終わらせる */
export class VideoPipeline {
  private readonly child: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private stderr = "";
  state: VideoState = "stopped";
  /** 出したアクセスユニットの数と合計の大きさ（状態を見る口と試験が読む） */
  units = 0;
  bytes = 0;
  keys = 0;

  constructor(display: string, private readonly events: VideoPipelineEvents, idleMs = VIDEO_IDLE_MS) {
    this.child = spawn("python3", ["-u", "-c", VIDEO_SCRIPT, display, String(idleMs)], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (c: Buffer) => this.read(c));
    this.child.stderr!.on("data", (c: Buffer) => (this.stderr = (this.stderr + c.toString()).slice(-2000)));
    this.child.on("error", (err) => this.fail(`GStreamer の子プロセスを起こせません: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) this.fail(`GStreamer の子プロセスが終わりました（${code ?? signal}）: ${this.stderr.trim().slice(-500)}`);
    });
    // 閉じた後に書いても落ちない（子が先に終わったとき）
    this.child.stdin!.on("error", () => undefined);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.state = "stopped";
    this.events.onError(message);
  }

  private read(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 5 + len) return;
      const kind = this.buf[4]!;
      const body = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (kind === 2) this.onEvent(JSON.parse(body.toString("utf8")) as { ready?: boolean; state?: VideoState; error?: string; warning?: string });
      else {
        const ts = Number(body.readBigUInt64BE(0));
        const au = body.subarray(8);
        this.units += 1;
        this.bytes += au.length;
        if (kind === 1) this.keys += 1;
        // 次の読みで中身が上書きされないよう写す
        this.events.onUnit(Buffer.from(au), kind === 1, ts);
      }
    }
  }

  private onEvent(e: { ready?: boolean; state?: VideoState; error?: string; warning?: string }): void {
    if (e.state) {
      this.state = e.state;
      this.events.onState(e.state);
    }
    if (e.warning) this.events.onWarning(e.warning);
    if (e.error) this.events.onError(e.error);
  }

  private send(command: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin!.write(JSON.stringify(command) + "\n");
  }

  /** 取り込む範囲を決めて流し始める（流れていれば作り直す——最初の1枚はキーフレーム） */
  start(region: VideoRegion): void {
    this.send({ cmd: "start", ...region, fps: VIDEO_FPS, crf: VIDEO_CRF, maxKbps: VIDEO_MAX_KBPS, vbvMs: VIDEO_VBV_MS });
  }

  /** 止める（大きさを変えている間——途中の絵を流さない） */
  stop(): void {
    this.send({ cmd: "stop" });
  }

  /** キーフレームを頼む（止まっていれば流し直す） */
  keyframe(): void {
    this.send({ cmd: "key" });
  }

  get alive(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin!.end();
    // 終わらなければ殺す
    setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
  }
}
