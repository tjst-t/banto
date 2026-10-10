// **tmux の制御モード（`tmux -C`）の client 1つ**（v4-modules.md §4.6、実測・2026-10-08）。
//
// 制御モードは pty が要らず、標準入出力の行で tmux と話せる：
// - 送る：コマンドを1行ずつ（`;` で並べた1行は、間に端末の出力を挟まずに続けて走る——実測）
// - 受ける：コマンドの返事は `%begin <時刻> <番号> <印>` … `%end`（失敗は `%error`）で囲まれる。印が 1 なら自分が送った
//   コマンドの返事で、`;` で並べたものはコマンドごとに1組ずつ返る。囲みの外は通知（`%output %<pane> <中身>` など）
// - `%output` の中身は、空白より小さい文字と `\` が `\ooo`（8進）になっている。ほかのバイト（UTF-8 も）はそのまま

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ControlHandlers {
  /** ペインの出力（もとのバイト列に戻したもの） */
  onOutput(paneId: string, data: Buffer): void;
  /** `%output` 以外の通知の行（`%exit` を含む） */
  onNotification?(line: string): void;
  /** client が終わった（tmux が閉じた・プロセスが落ちた） */
  onExit(reason: string): void;
}

/** `%output` の中身を、もとのバイト列に戻す */
export function unescapeOutput(escaped: Buffer): Buffer {
  const out = Buffer.allocUnsafe(escaped.length);
  let n = 0;
  for (let i = 0; i < escaped.length; i++) {
    const b = escaped[i]!;
    if (b === 0x5c && i + 3 < escaped.length && isOctal(escaped[i + 1]) && isOctal(escaped[i + 2]) && isOctal(escaped[i + 3])) {
      out[n++] = ((escaped[i + 1]! - 0x30) << 6) | ((escaped[i + 2]! - 0x30) << 3) | (escaped[i + 3]! - 0x30);
      i += 3;
      continue;
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

function isOctal(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x37;
}

interface Pending {
  resolve(lines: string[]): void;
  reject(err: Error): void;
}

export class TmuxControlClient {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: Pending[] = [];
  /** いま読んでいる返事の囲み（自分のコマンドのものか・中身） */
  private block: { number: string; own: boolean; lines: string[] } | undefined;
  private exited = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: ControlHandlers,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    // 閉じた先へ書いたときの EPIPE は、終わったこととして exit の側で扱う
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => this.finish(`tmux を起こせませんでした: ${err.message}`));
    child.on("exit", (code, signal) => {
      this.finish(stderr.trim() || `tmux の client が終わりました（${code ?? signal}）`);
    });
  }

  /**
   * コマンドを1行で送り、それぞれの返事（出力の行）を返す。`commands` は `;` で並べて1行にする——間に端末の出力を
   * 挟まない。どれかが `%error` なら投げる
   */
  run(commands: string[]): Promise<string[][]> {
    if (this.exited) return Promise.reject(new Error("tmux の client はもう終わっています"));
    const replies = commands.map(
      () =>
        new Promise<string[]>((resolve, reject) => {
          this.pending.push({ resolve, reject });
        }),
    );
    this.child.stdin.write(`${commands.join(" ; ")}\n`);
    return Promise.all(replies);
  }

  /** client を閉じる（セッションは残る） */
  close(): void {
    if (this.exited) return;
    // 空の行で client が切り離される（制御モードの決まり）
    this.child.stdin.end("\n");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGTERM");
    }, 2000).unref();
  }

  private finish(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.splice(0)) p.reject(new Error(reason));
    this.handlers.onExit(reason);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, start);
      if (nl < 0) break;
      this.onLine(this.buffer.subarray(start, nl));
      start = nl + 1;
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);
  }

  private onLine(raw: Buffer): void {
    if (this.block) {
      const text = raw.toString("utf8");
      const end = /^%(end|error) \S+ (\S+) /.exec(text);
      if (end && end[2] === this.block.number) {
        const block = this.block;
        this.block = undefined;
        if (!block.own) return;
        const waiter = this.pending.shift();
        if (!waiter) return;
        if (end[1] === "error") waiter.reject(new Error(block.lines.join("\n") || "tmux のコマンドが失敗しました"));
        else waiter.resolve(block.lines);
        return;
      }
      this.block.lines.push(text);
      return;
    }
    // `%output %<pane> <中身>`——中身はバイト列のまま戻す（UTF-8 が行の途中で切れていない保証は無いが、行は丸ごと来る）
    if (raw.subarray(0, 8).toString("latin1") === "%output ") {
      const sp = raw.indexOf(0x20, 8);
      if (sp < 0) return;
      this.handlers.onOutput(raw.subarray(8, sp).toString("latin1"), unescapeOutput(raw.subarray(sp + 1)));
      return;
    }
    const text = raw.toString("utf8");
    const begin = /^%begin \S+ (\S+) (\S+)/.exec(text);
    if (begin) {
      // 印の下位ビットが 1 なら、この client が送ったコマンドの返事
      this.block = { number: begin[1]!, own: (Number(begin[2]) & 1) === 1, lines: [] };
      return;
    }
    this.handlers.onNotification?.(text);
  }
}
