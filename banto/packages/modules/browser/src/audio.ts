// **人の画面に音を流す**（v4-modules.md §4.1「動画で流す」の段4「音」、Backlog #283）。
//
// Module が起こすブラウザの音は、コンテナの中に立てた PulseAudio の**空のシンク**（`module-null-sink`、名前 `banto`）へ出す
// （chrome.ts が `PULSE_SERVER` で教える）。シンクのモニタ（`banto.monitor`）を GStreamer で Opus に圧縮し、映像と同じ流れ
// （アーキ仕様 §5.8）に載せる。GStreamer は映像とは**別の子プロセス**（AUDIO_SCRIPT）——映像の子は大きさを変える間や静止で
// 止まり、失敗したら JPEG に替わるが、音はそのどれとも関わりなく流す。片方の失敗がもう片方を止めない。
//
// - 指示は無い。起こしたら流し、標準入力を閉じたら終わる。出力は映像の子と同じ形：`[長さ（4バイト）][種類（1バイト）][中身]`。
//   種類は 0＝Opus の1包み（頭に取り込んだ時刻 µs（8バイト）と長さ µs（4バイト））・2＝知らせ（JSON：ready・sound・error）
// - **時刻は映像と同じ時計**（GStreamer の system clock＝CLOCK_MONOTONIC）。取り込んだ時刻＝パイプラインの base time＋running time
//   （pts を segment で直したもの）。
//   映像の子も同じ時計で印を付けるので、人の画面は音と映像の時刻を比べられる（同じ機械の CLOCK_MONOTONIC）
// - **鳴っていない間は送らない**：シンクのモニタは誰も鳴らしていなくても 0 の音を出し続ける。0 だけの音が AUDIO_SILENT_MS
//   続いたら包みを出さず（`sound: false` を知らせる）、0 でない音が来たらすぐ出す（`sound: true`）
//
// PulseAudio はブラウザを入れる段で入れる（ensureAudio）。入れられない箱では理由を返し、人の画面は音無しで映す。

import { spawn, type ChildProcess } from "node:child_process";

/** コンテナに入れる包み（Ubuntu 24.04 の名前。pulsesrc は gstreamer1.0-plugins-good・opusenc は -base——映像と同じ包み） */
export const AUDIO_PACKAGES = ["pulseaudio"];

/** 0 だけの音がこれだけ続いたら、鳴っていないとみなして送るのをやめる（映像の静止と同じ 300ms） */
export const AUDIO_SILENT_MS = 300;
/** Opus の1包みの長さ（ms）。短いほど遅れが小さく、1通あたりの頭の分が増える（毎秒 50 通） */
export const AUDIO_FRAME_MS = 20;
/** Opus の速さ（kbit/s、VBR）。ステレオの音楽でも聞き分けにくい値で、映像（2 Mbit/s 前後）の数 % */
export const AUDIO_KBPS = 64;
export const AUDIO_RATE = 48000;
export const AUDIO_CHANNELS = 2;
/** PulseAudio に作る空のシンクの名前（モニタは `banto.monitor`） */
export const AUDIO_SINK = "banto";

const ELEMENTS = ["pulsesrc", "audioconvert", "audioresample", "opusenc", "appsink"];

/** 動かす python（gi で GStreamer）。引数は PulseAudio の口（`unix:/…/native`）・モニタの名前・0 が続いたとみなす ms・速さ・1包みの ms */
export const AUDIO_SCRIPT = String.raw`
import sys, os, json, struct, threading
import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib

Gst.init(None)
SERVER, DEVICE = sys.argv[1], sys.argv[2]
SILENT_NS = int(sys.argv[3]) * 1000000
KBPS, FRAME_MS = int(sys.argv[4]), int(sys.argv[5])
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

desc = (
    "pulsesrc server=%s device=%s client-name=banto-browser-audio latency-time=10000 buffer-time=200000 " % (SERVER, DEVICE)
    + "! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=${AUDIO_RATE},channels=${AUDIO_CHANNELS} "
    + "! opusenc name=enc bitrate=%d frame-size=%d " % (KBPS * 1000, FRAME_MS)
    + "! appsink name=sink emit-signals=true sync=false max-buffers=50 drop=false"
)
pipeline = Gst.parse_launch(desc)
# 映像の子と同じ時計（CLOCK_MONOTONIC）。pulsesrc は自分の時計を出すが、それでは映像と比べられない
clock = Gst.SystemClock.obtain()
clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
pipeline.use_clock(clock)

# 最後に 0 でない音を取り込んだ時刻（ns、時計の時刻）。None は一度も鳴っていない
last_sound = None
sounding = False

def clock_time(buf, segment):
    # pts は segment の中の時刻——running time に直してから base time を足す（映像の子と同じ）
    running = segment.to_running_time(Gst.Format.TIME, buf.pts) if buf.pts != Gst.CLOCK_TIME_NONE and segment is not None else None
    return pipeline.get_base_time() + running if running is not None and running >= 0 else clock.get_time()

raw_segment = None

def on_raw(pad, info):
    global last_sound, raw_segment
    buf = info.get_buffer()
    if raw_segment is None:
        ev = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
        raw_segment = ev.parse_segment() if ev is not None else None
    ok, m = buf.map(Gst.MapFlags.READ)
    if ok:
        data = m.data
        # 0 だけか（C で数える——1包み 3840 バイト）
        if bytes(data).count(0) != len(data):
            last_sound = clock_time(buf, raw_segment)
        buf.unmap(m)
    return Gst.PadProbeReturn.OK

pipeline.get_by_name("enc").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_raw)

def on_sample(sink):
    global sounding
    sample = sink.emit("pull-sample")
    buf = sample.get_buffer()
    t = clock_time(buf, sample.get_segment())
    now = last_sound is not None and t <= last_sound + SILENT_NS
    if now != sounding:
        sounding = now
        event({"sound": now})
    if now:
        ok, m = buf.map(Gst.MapFlags.READ)
        if ok:
            dur = buf.duration if buf.duration != Gst.CLOCK_TIME_NONE else FRAME_MS * 1000000
            emit(0, struct.pack(">QI", t // 1000, dur // 1000) + bytes(m.data))
            buf.unmap(m)
    return Gst.FlowReturn.OK

loop = GLib.MainLoop()

def on_error(bus, msg):
    err, dbg = msg.parse_error()
    event({"error": "%s (%s)" % (err.message, dbg)})
    pipeline.set_state(Gst.State.NULL)
    loop.quit()

def on_stdin(fd, cond):
    if not os.read(fd, 65536):
        loop.quit()
        return False
    return True

pipeline.get_by_name("sink").connect("new-sample", on_sample)
bus = pipeline.get_bus()
bus.add_signal_watch()
bus.connect("message::error", on_error)
GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, on_stdin)
if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
    event({"error": "音の取り込みを始められません（PulseAudio %s の %s）" % (SERVER, DEVICE)})
    sys.exit(3)
event({"ready": True})
loop.run()
pipeline.set_state(Gst.State.NULL)
`;

/** 音を流せるかを確かめる python（PulseAudio のプログラムと GStreamer の要素がそろっているか）。足りなければ理由を1行 */
const CHECK_SCRIPT = String.raw`
import sys, shutil
if shutil.which("pulseaudio") is None:
    print("pulseaudio がありません")
    sys.exit(1)
try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except Exception as err:
    print("python3 の gi で GStreamer を読めません: %s" % err)
    sys.exit(1)
Gst.init(None)
missing = [e for e in ${JSON.stringify(ELEMENTS)} if Gst.ElementFactory.find(e) is None]
if missing:
    print("GStreamer の要素がありません: " + ", ".join(missing))
    sys.exit(1)
`;

/** 音を流せるか。流せなければ理由 */
export function checkAudio(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("python3", ["-c", CHECK_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ENOENT" ? "python3 がありません" : err.message));
    child.on("close", (code) => resolve(code === 0 ? undefined : out.trim().split("\n").at(-1) || `確かめが終了コード ${code} で終わりました`));
  });
}

export interface AudioSupport {
  available: boolean;
  /** 流せない理由（人の画面と Module のログに出す） */
  reason?: string;
}

const MANUAL = `\`sudo apt install --no-install-recommends ${AUDIO_PACKAGES.join(" ")}\``;

/**
 * PulseAudio が無ければ入れる。**入れられなくてもブラウザは断らない**——人の画面は音無しで映す（映像の ensureVideo と同じ形）。
 * sudo しない箱（`BANTO_NO_SUDO=1`）では入れようとしない
 */
export async function ensureAudio(
  install: (onProgress?: (message: string) => void) => Promise<void>,
  onProgress?: (message: string) => void,
  check: () => Promise<string | undefined> = checkAudio,
): Promise<AudioSupport> {
  const missing = await check();
  if (!missing) return { available: true };
  if (process.env.BANTO_NO_SUDO === "1") {
    return {
      available: false,
      reason: `音を流すための PulseAudio がありません（${missing}）。banto はこの実行場所で sudo しないので自動では入れません。音無しで映します。向こうで ${MANUAL} を打ってから、ブラウザを起こし直すと音が出ます`,
    };
  }
  try {
    await install(onProgress);
  } catch (err) {
    return { available: false, reason: `音を流すための PulseAudio を入れられませんでした（${(err as Error).message}）。音無しで映します` };
  }
  const still = await check();
  return still ? { available: false, reason: `PulseAudio を入れましたが、まだ音を流せません（${still}）。音無しで映します` } : { available: true };
}

// ---- 流れの1通 ---------------------------------------------------------------------------------

export interface AudioHeader {
  seq: number;
  codec: "opus";
  /** 取り込んだ時刻（µs、Module の機械の CLOCK_MONOTONIC——映像の頭の ts と同じ時計） */
  ts: number;
  /** 長さ（µs） */
  dur: number;
}

/** Opus の1包みを流れの1通（`[頭の長さ][頭][中身]`——映像・JPEG と同じ形）にする */
export function encodeAudioMessage(header: AudioHeader, packet: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([len, head, packet]);
}

// ---- 子プロセス --------------------------------------------------------------------------------

export interface AudioPipelineEvents {
  /** Opus の1包み（鳴っている間だけ来る） */
  onPacket: (packet: Buffer, ts: number, dur: number) => void;
  /** 鳴り始めた・やんだ */
  onSound: (sounding: boolean) => void;
  /** 失敗（取り込みが止まった・子が終わった）。理由つき */
  onError: (message: string) => void;
}

/** GStreamer の子プロセス1本。起こしたら流し、close で終わらせる */
export class AudioPipeline {
  private readonly child: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private stderr = "";
  sounding = false;
  /** 出した包みの数と合計の大きさ（状態を見る口と試験が読む） */
  packets = 0;
  bytes = 0;

  constructor(server: string, private readonly events: AudioPipelineEvents, silentMs = AUDIO_SILENT_MS) {
    this.child = spawn(
      "python3",
      ["-u", "-c", AUDIO_SCRIPT, server, `${AUDIO_SINK}.monitor`, String(silentMs), String(AUDIO_KBPS), String(AUDIO_FRAME_MS)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout!.on("data", (c: Buffer) => this.read(c));
    this.child.stderr!.on("data", (c: Buffer) => (this.stderr = (this.stderr + c.toString()).slice(-2000)));
    this.child.on("error", (err) => this.fail(`音の子プロセスを起こせません: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) this.fail(`音の子プロセスが終わりました（${code ?? signal}）: ${this.stderr.trim().slice(-500)}`);
    });
    // 閉じた後に書いても落ちない（子が先に終わったとき）
    this.child.stdin!.on("error", () => undefined);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.sounding = false;
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
      if (kind === 2) {
        const e = JSON.parse(body.toString("utf8")) as { ready?: boolean; sound?: boolean; error?: string };
        if (e.sound !== undefined) {
          this.sounding = e.sound;
          this.events.onSound(e.sound);
        }
        if (e.error) this.fail(e.error);
      } else {
        const ts = Number(body.readBigUInt64BE(0));
        const dur = body.readUInt32BE(8);
        const packet = Buffer.from(body.subarray(12));
        this.packets += 1;
        this.bytes += packet.length;
        this.events.onPacket(packet, ts, dur);
      }
    }
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
