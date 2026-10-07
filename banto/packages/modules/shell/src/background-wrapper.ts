#!/usr/bin/env node
// **待たずに流したコマンドの起動役**（決定・2026-10-07、docs/specs/v4-modules.md §2.3「待たない形」）。
// 使い方：`node background-wrapper.js <コマンドの置き場> <環境のファイル>`。systemd のユーザー単位から起こされる
// （`background-launcher.ts`）——Shell の Module とは別のプロセスで、Shell や banto を起こし直しても動き続ける。
//
// 役目（Service の `log-wrapper.ts` と同じ形）：
//   1. 環境のファイル（コンテナの中の tmpfs、0600）を読んで**すぐ消す**。秘密（envSecrets）の値はここにだけある
//      ——systemd の単位のプロパティにも、host のディスクにも書かない
//   2. `job.json` のコマンドを `/bin/sh -c` で走らせ、stdout と stderr を**1つのファイルに出た順で**書く
//   3. **どう終わったかを `exit.json` に書く**——終了コード・信号・止められたか・時間切れか・出力の末尾
//   4. `secretFiles` を消す（待つ形と同じく、コマンドが終わったら必ず）

import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import {
  EXIT_FILE,
  JOB_FILE,
  OUTPUT_FILE,
  OUTPUT_SAVE_BYTES,
  STARTED_FILE,
  startTicksOf,
  tailLines,
  writeJsonAtomic,
  type ExitRecord,
  type JobRecord,
} from "./background-files.js";

/** 止めると頼まれてから、子が終わるのを待つ時間。過ぎたらグループごと SIGKILL */
const KILL_GRACE_MS = 8_000;
/** 子が終わってから、出力の管が閉じるのを待つ時間（`&` で残した孫が管を持ったままのことがある） */
const DRAIN_MS = 2_000;
/** 末尾を作るために手元に持つ量（文字） */
const KEEP_TAIL_CHARS = 128 * 1024;

export async function main(dir: string, envFile: string): Promise<never> {
  const exitPath = join(dir, EXIT_FILE);
  const fail = (error: string): never => {
    writeJsonAtomic(exitPath, {
      at: new Date().toISOString(),
      code: null,
      signal: null,
      stopRequested: false,
      timedOut: false,
      outputBytes: 0,
      capped: false,
      tail: "",
      error,
    } satisfies ExitRecord);
    process.exit(0);
  };

  // ---- 1. 環境を読んで、すぐ消す --------------------------------------------------------------
  let envText: string | undefined;
  let envError: unknown;
  try {
    envText = readFileSync(envFile, "utf8");
  } catch (err) {
    envError = err;
  }
  try {
    unlinkSync(envFile);
  } catch {
    // もう無い
  }
  let env: NodeJS.ProcessEnv;
  try {
    if (envText === undefined) throw envError;
    env = JSON.parse(envText) as NodeJS.ProcessEnv;
  } catch (err) {
    // **環境（秘密）が無いまま走らせない**——秘密なしで黙って動くより、起こせなかったと分かるほうがよい（規則2）
    return fail(`コマンドの環境を読めませんでした（${err instanceof Error ? err.message : String(err)}）`);
  }
  let job: JobRecord;
  try {
    job = JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")) as JobRecord;
  } catch (err) {
    return fail(`コマンドの記録を読めませんでした（${err instanceof Error ? err.message : String(err)}）`);
  }

  writeJsonAtomic(join(dir, STARTED_FILE), { pid: process.pid, startTicks: startTicksOf(process.pid), at: new Date().toISOString() });

  // ---- 2. 走らせる -----------------------------------------------------------------------------
  const out: WriteStream = createWriteStream(join(dir, OUTPUT_FILE), { flags: "w", mode: 0o600 });
  let writeError: string | undefined;
  // 'error' を拾わないと起動役ごと落ちる（ディスクがいっぱい等）。落ちても子は走らせ続け、終わり方は書く
  out.on("error", (err) => {
    writeError = err.message;
  });
  let outputBytes = 0;
  let savedBytes = 0;
  let capped = false;
  let tail = "";
  let tailFromMiddle = false;
  const take = (chunk: string) => {
    const bytes = Buffer.byteLength(chunk);
    outputBytes += bytes;
    if (savedBytes < OUTPUT_SAVE_BYTES && !writeError) {
      out.write(chunk);
      savedBytes += bytes;
    } else {
      capped = true;
    }
    tail += chunk;
    if (tail.length > KEEP_TAIL_CHARS * 2) {
      tail = tail.slice(-KEEP_TAIL_CHARS);
      tailFromMiddle = true;
    }
  };

  // 子は自分のプロセスグループで起こす——止めるとき・時間切れのときに、子が起こした孫まで止める
  const child = spawn("/bin/sh", ["-c", job.command], {
    cwd: job.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", take);
  child.stderr.on("data", take);

  let stopRequested = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // もう居ない
    }
  };
  const stopChild = (signal: NodeJS.Signals) => {
    killGroup(signal);
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      stopRequested = true;
      // systemd は cgroup の全員に同じ信号を送るので子にも届いているが、手で起こした場合に備えて送る
      stopChild("SIGTERM");
    });
  }
  if (job.timeoutSec !== undefined && job.timeoutSec > 0) {
    setTimeout(() => {
      timedOut = true;
      stopChild("SIGTERM");
    }, job.timeoutSec * 1000).unref();
  }

  const ended = await new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    let exited: { code: number | null; signal: string | null } | undefined;
    child.on("error", (err) => resolve({ code: 127, signal: null, error: `起こせませんでした: ${err.message}` }));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      setTimeout(() => resolve(exited!), DRAIN_MS).unref();
    });
    child.on("close", (code, signal) => resolve(exited ?? { code, signal }));
  });
  if (killTimer) clearTimeout(killTimer);

  // ---- 3. 終わり方を書く ----------------------------------------------------------------------
  await new Promise<void>((resolve) => out.end(resolve));
  for (const path of job.secretFiles ?? []) {
    try {
      unlinkSync(path);
    } catch {
      // もう無い
    }
  }
  const record: ExitRecord = {
    at: new Date().toISOString(),
    code: ended.code,
    signal: ended.signal,
    stopRequested,
    timedOut,
    outputBytes,
    capped,
    tail: tailLines(tail, tailFromMiddle),
    ...(ended.error ? { error: ended.error } : writeError ? { error: `出力をファイルに書けませんでした: ${writeError}` } : {}),
  };
  writeJsonAtomic(exitPath, record);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("background-wrapper.js")) {
  const [dir, envFile] = process.argv.slice(2);
  if (!dir || !envFile) {
    console.error("使い方: background-wrapper.js <コマンドの置き場> <環境のファイル>");
    process.exit(2);
  }
  await main(dir, envFile);
}
