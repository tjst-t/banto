// **長い出力は、頭と末尾だけを返し、全体はファイルに残す**（決定・2026-09-29、docs/specs/v4-modules.md §2.3）。
//
// 以前は stdout/stderr を全部ためて1通で返していた。MCP SDK の stdio は1通 10 MiB までしか受け取らず、
// 越えると host が接続を閉じて Shell が黙って消えた（`cp -al` のエラー 12.1MB）。10 MiB より手前でも、
// banto の AI（Claude Code）は MCP の結果を約10万文字で**先頭から**切るので、JSON の後ろにある終了コードが
// 見えなくなる。Claude Code・Gemini CLI・Goose と同じく、全体はファイルへ逃がし、AI には一部とパスを返す。
// 経緯と数字の根拠は docs/notes/2026-09-29-shell-output-limit.md。

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface OutputLimits {
  /** stdout と stderr の合計がこれを越えたら、長いほうをファイルへ逃がす（文字数）。 */
  inlineChars: number;
  /** 逃がしたストリームについて、返す頭の文字数。 */
  headChars: number;
  /** 逃がしたストリームについて、返す末尾の文字数。**エラーのまとめや終了の表示は末尾に出る**ので多めに取る。 */
  tailChars: number;
  /** 1本のストリームを保存する上限（バイト）。`yes` のような止まらない出力でディスクを埋めない。 */
  saveBytes: number;
  /** 残しておく回数。Shell は同じ Project の全 Thread で共有するので、読む前に消えないだけの数。 */
  keepRuns: number;
}

export const OUTPUT_LIMITS: OutputLimits = {
  inlineChars: 30_000,
  headChars: 1_000,
  tailChars: 3_000,
  saveBytes: 64 * 1024 * 1024,
  keepRuns: 20,
};

export type StreamName = "stdout" | "stderr";

export interface CapturedOutput {
  stdout: string;
  stderr: string;
  /** ファイルへ逃がしたときだけ。そのストリームの全体（`saveBytes` まで）がある。 */
  stdoutFile?: string;
  stderrFile?: string;
}

interface SavedFile {
  path: string;
  /** 置き場を作れなかったときは無い（`error` に理由）。 */
  stream?: WriteStream;
  bytes: number;
  capped: boolean;
  error?: string;
}

class StreamCapture {
  /** ファイルへ逃がすまでは全体をここに持つ。 */
  whole = "";
  head = "";
  tail = "";
  total = 0;
  file?: SavedFile;
}

let runSeq = 0;

/** 名前の並びがそのまま起きた順になる形（同じミリ秒でも連番で並ぶ）。古いものから消すのに使う。 */
function newRunId(): string {
  runSeq += 1;
  const at = new Date().toISOString().replace(/[:.]/g, "-");
  return `${at}-${String(runSeq).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * 1回の `runCommand` の出力を受け取る。**メモリに持つのは上限つき**——逃がしたあとは頭と末尾だけ。
 * ディスクへの書き込みが追いつかなくても、溜まるのは `saveBytes` までで止まる。
 */
export class OutputCapture {
  private readonly streams: Record<StreamName, StreamCapture> = {
    stdout: new StreamCapture(),
    stderr: new StreamCapture(),
  };
  private spilling = false;
  private finished = false;
  private readonly runId = newRunId();

  constructor(
    private readonly dir: string,
    private readonly limits: OutputLimits = OUTPUT_LIMITS,
  ) {}

  /** 受け取った文字数の合計（進捗の表示用）。 */
  get totalChars(): number {
    return this.streams.stdout.total + this.streams.stderr.total;
  }

  append(name: StreamName, chunk: string): void {
    // 子の終了で締めたあとに届いた分は取らない（締めたファイルには書けない）
    if (this.finished || chunk.length === 0) return;
    const s = this.streams[name];
    s.total += chunk.length;
    if (s.file) {
      s.tail = (s.tail + chunk).slice(-this.limits.tailChars);
      this.write(s.file, chunk);
      return;
    }
    s.whole += chunk;
    if (!this.spilling && this.totalChars > this.limits.inlineChars) this.spilling = true;
    if (!this.spilling) return;
    for (const which of ["stdout", "stderr"] as const) {
      const t = this.streams[which];
      if (!t.file && t.whole.length > this.limits.headChars + this.limits.tailChars) this.spill(which, t);
    }
  }

  /** 書き込みを締めて、返す形にする。ファイルは閉じ終わってから返す（AI がすぐ読めるように）。 */
  async finish(): Promise<CapturedOutput> {
    this.finished = true;
    const out: CapturedOutput = { stdout: "", stderr: "" };
    for (const which of ["stdout", "stderr"] as const) {
      const s = this.streams[which];
      if (!s.file) {
        out[which] = s.whole;
        continue;
      }
      await this.close(s.file);
      out[which] = s.head + this.elisionNote(s, s.file) + s.tail;
      if (!s.file.error) out[which === "stdout" ? "stdoutFile" : "stderrFile"] = s.file.path;
    }
    if (this.streams.stdout.file || this.streams.stderr.file) await this.prune();
    return out;
  }

  /** 子を起こせなかったときなど、返さずに終えるとき。書きかけのファイルは閉じる。 */
  async abandon(): Promise<void> {
    this.finished = true;
    for (const s of Object.values(this.streams)) if (s.file) await this.close(s.file);
  }

  private spill(which: StreamName, s: StreamCapture): void {
    const path = join(this.dir, `${this.runId}.${which}`);
    s.head = s.whole.slice(0, this.limits.headChars);
    s.tail = s.whole.slice(-this.limits.tailChars);
    const pending = s.whole;
    s.whole = "";
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      s.file = { path, bytes: 0, capped: false, error: errorText(err) };
      return;
    }
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    const file: SavedFile = { path, stream, bytes: 0, capped: false };
    // **'error' を拾わないと Shell ごと落ちる**（Node の EventEmitter）。ディスクが一杯でも、返事は返す
    stream.on("error", (err) => {
      file.error ??= errorText(err);
    });
    s.file = file;
    this.write(file, pending);
  }

  private write(file: SavedFile, chunk: string): void {
    if (!file.stream || file.error || file.capped) return;
    const buf = Buffer.from(chunk, "utf8");
    const room = this.limits.saveBytes - file.bytes;
    if (buf.length <= room) {
      file.bytes += buf.length;
      file.stream.write(buf);
      return;
    }
    // 上限ちょうどで止める。**文字の途中では切らない**（UTF-8 の続きのバイトの手前まで戻る）
    let cut = room;
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
    file.bytes += cut;
    file.stream.write(buf.subarray(0, cut));
    file.capped = true;
    file.stream.write(`\n［banto: 保存は ${formatBytes(this.limits.saveBytes)} までです。ここから先は保存していません］\n`);
  }

  private close(file: SavedFile): Promise<void> {
    const stream = file.stream;
    if (!stream || stream.closed) return Promise.resolve();
    return new Promise((resolve) => {
      stream.once("close", () => resolve());
      stream.end();
    });
  }

  private elisionNote(s: StreamCapture, file: SavedFile): string {
    const omitted = s.total - s.head.length - s.tail.length;
    const where = file.error
      ? `全体は保存できませんでした（${file.error}）`
      : file.capped
        ? `先頭の ${formatBytes(this.limits.saveBytes)} までを ${file.path} に保存しました（それより後は、ここに見えている末尾だけ）`
        : `全体は ${file.path} にあります。grep や sed -n で読めます`;
    return `\n…［出力が長いので ${formatCount(omitted)} 文字を省きました（全体 ${formatCount(s.total)} 文字）。${where}］…\n`;
  }

  /** 直近 `keepRuns` 回分だけ残す。消せなくても返事は止めない（残るのはキャッシュだけ）が、黙ってもおかない。 */
  private async prune(): Promise<void> {
    try {
      const runs = new Set<string>();
      for (const name of await readdir(this.dir)) {
        const m = /^(.+)\.(stdout|stderr)$/.exec(name);
        if (m) runs.add(m[1]!);
      }
      const old = [...runs].sort().slice(0, Math.max(0, runs.size - this.limits.keepRuns));
      for (const run of old) {
        await rm(join(this.dir, `${run}.stdout`), { force: true });
        await rm(join(this.dir, `${run}.stderr`), { force: true });
      }
    } catch (err) {
      console.error(`[shell] 古い出力のファイルを片づけられませんでした（${this.dir}）: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  return n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)} MiB` : `${formatCount(n)} バイト`;
}

/** 逃がす先。Shell のホームがあればその中のキャッシュ、無ければ一時フォルダ。 */
export function outputDirFor(homeDir: string | undefined, tmp: string): string {
  return homeDir ? join(homeDir, ".cache", "banto-shell", "output") : join(tmp, "banto-shell-output");
}
