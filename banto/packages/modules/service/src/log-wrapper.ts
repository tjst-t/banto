#!/usr/bin/env node
// **サービスの起動役**（systemd の ExecStart から起こされる）。使い方：`node log-wrapper.js <サービスの置き場> [<出口の箱>]`
//
// 役目は4つ（docs/specs/v4-modules.md §4.2「実装で守る細部」）：
//   1. 置き場の `command.sh` を /bin/sh で走らせる（AI の書いたコマンドを unit に書かない——エスケープの誤りと
//      `systemctl cat` での露出を避ける）
//   2. 標準出力・標準エラーを**時刻つき**で `log` に書く。大きくなったら `log.1` へ回す
//      （systemd の `append:` は時刻を付けない）
//   3. **どう終わったかを `exit.json` に書く**——止められたのか・自分で終わったのか・落ちたのか。
//      systemd は止まった unit の終わり方を忘れる（実測・2026-09-27、systemd 255：人の stop・終了コード 0・
//      一度も起動していない、の3つが同じ記録になる）ので、ここで覚える
//   4. **落ちたら出来事 `service.crashed` を出口の箱に書く**（追加・2026-10-16、アーキ仕様 §4.3「最初に出す出来事」、
//      Backlog #347）。Module が寝ていても失くさない——Module は繋がったときに箱を host へ出す。止められた・自分で
//      終わった（終了コード 0）は落ちていないので書かない。起こし直しの上限に当たった（`service.gave-up`）は systemd に
//      聞かないと見えないので出さない
//
// 止められたとき（SIGTERM）は終了コード 0 で抜ける——systemd の `Restart=on-failure` に起こし直させない。
// 子が信号で死んだときは 128＋番号で抜ける——落ちた扱いにして起こし直させる。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, renameSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { constants } from "node:os";
import { basename, join } from "node:path";
import { EventOutbox, type EmittedEvent } from "@banto/module-contract";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** 落ちた出来事の `text` に添える、ログの末尾の行数 */
export const CRASH_LOG_LINES = 50;

/** 出来事の名前（宣言の `events` と揃える——core の目録 `modules/declaration.ts`） */
export const SERVICE_CRASHED_EVENT = "service.crashed";

/** その仕事を始めた呼び出しの印（Module が登録から写す。起動役が出来事の `causedBy` に添える） */
export const CAUSE_FILE = "cause.json";

export interface ExitRecord {
  at: string;
  code: number | null;
  signal: string | null;
  /** banto か人が止めた（この起動役が SIGTERM／SIGINT を受けた） */
  stopRequested: boolean;
}

/** 行の頭に時刻を付ける（ISO 8601、UTC）。標準エラーは印を付けて見分けられるようにする */
export function stamp(line: string, stream: "out" | "err", now: Date = new Date()): string {
  return `${now.toISOString()}${stream === "err" ? " [stderr]" : ""} ${line}\n`;
}

class RotatingLog {
  private stream: WriteStream;
  private bytes: number;
  constructor(private readonly path: string, private readonly maxBytes: number) {
    this.bytes = sizeOf(path);
    this.stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  }
  write(text: string): void {
    if (this.bytes + text.length > this.maxBytes && this.bytes > 0) {
      this.stream.end();
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        // 回せなくても書き続ける（ログのために本体を止めない）
      }
      this.stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
      this.bytes = 0;
    }
    this.stream.write(text);
    this.bytes += Buffer.byteLength(text);
  }
  end(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let rest = "";
  return {
    push(chunk) {
      const text = rest + chunk.toString("utf8");
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    },
    flush() {
      if (rest !== "") onLine(rest);
      rest = "";
    },
  };
}

/** 落ちたか（止められた・終了コード 0 で自分で終わったは落ちていない——`state.ts` の crashed と同じ見分け） */
export function crashed(record: ExitRecord): boolean {
  return !record.stopRequested && (record.signal !== null || record.code !== 0);
}

/** **落ちた出来事**。属性は名乗り（`service`・`exitCode`・`signal`）のとおり、`text` はログの末尾 */
export function crashEvent(name: string, record: ExitRecord, tail: string[], causedBy?: { callId: string }): EmittedEvent {
  return {
    name: SERVICE_CRASHED_EVENT,
    eventId: randomUUID(),
    occurredAt: record.at,
    fields: {
      service: name,
      ...(record.code !== null ? { exitCode: record.code } : {}),
      ...(record.signal !== null ? { signal: record.signal } : {}),
    },
    text:
      `Service「${name}」が落ちました（${record.signal ? `信号 ${record.signal}` : `終了コード ${record.code}`}）。` +
      (tail.length > 0 ? `ログの末尾 ${tail.length} 行：\n${tail.join("")}` : "ログは空です"),
    ...(causedBy ? { causedBy } : {}),
  };
}

function readCause(dir: string): { callId: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, CAUSE_FILE), "utf8")) as { callId?: unknown };
    return typeof raw.callId === "string" && raw.callId !== "" ? { callId: raw.callId } : undefined;
  } catch {
    return undefined;
  }
}

export async function main(dir: string, outboxDir?: string): Promise<never> {
  const log = new RotatingLog(join(dir, "log"), LOG_MAX_BYTES);
  writeFileSync(join(dir, "started.json"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }) + "\n");

  const child = spawn("/bin/sh", [join(dir, "command.sh")], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  // 落ちたときに出来事へ添えるログの末尾（ファイルを読み直さない——回したあとでも直近が残る）
  const tail: string[] = [];
  const keep = (text: string) => {
    tail.push(text);
    if (tail.length > CRASH_LOG_LINES) tail.shift();
  };
  const out = lineSplitter((l) => {
    const t = stamp(l, "out");
    log.write(t);
    keep(t);
  });
  const err = lineSplitter((l) => {
    const t = stamp(l, "err");
    log.write(t);
    keep(t);
  });
  child.stdout.on("data", (c: Buffer) => out.push(c));
  child.stderr.on("data", (c: Buffer) => err.push(c));

  let stopRequested = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      stopRequested = true;
      // systemd は cgroup の全員に同じ信号を送る（KillMode=control-group）ので、子にも届いている。
      // 手で起こした場合に備えて、子にも送る
      child.kill(sig);
    });
  }

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
    child.on("error", (e) => {
      log.write(stamp(`起動できませんでした: ${e.message}`, "err"));
      resolve({ code: 127, signal: null });
    });
  });
  out.flush();
  err.flush();
  const record: ExitRecord = { at: new Date().toISOString(), code, signal, stopRequested };
  writeFileSync(join(dir, "exit.json"), JSON.stringify(record) + "\n");
  if (outboxDir && crashed(record)) {
    // 書けなくても終わり方は変えない（systemd の起こし直しを、出来事のために止めない）——理由はログに残す
    try {
      new EventOutbox({ dir: outboxDir, log: (m) => log.write(stamp(m, "err")) }).write(crashEvent(basename(dir), record, tail, readCause(dir)));
    } catch (e) {
      log.write(stamp(`落ちた出来事を出口の箱に書けませんでした: ${e instanceof Error ? e.message : String(e)}`, "err"));
    }
  }
  log.write(
    stamp(
      stopRequested
        ? "（止められました）"
        : signal
          ? `（信号 ${signal} で終わりました）`
          : `（終了コード ${code} で終わりました）`,
      "out",
    ),
  );
  await log.end();
  if (stopRequested) process.exit(0);
  if (signal) process.exit(128 + (constants.signals[signal] ?? 1));
  process.exit(code ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith("log-wrapper.js")) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使い方: log-wrapper.js <サービスの置き場> [<出口の箱>]");
    process.exit(2);
  }
  await main(dir, process.argv[3]);
}
