/**
 * 子プロセスとして起こした職人と、JSONL で話すための共通部品。
 *
 * pi（`pi --mode rpc`）と Claude Code（`claude-agent/host.ts`）は別のランタイムだが、
 * **1プロセス＝1人の職人・標準入出力の JSONL・pid で生死を見る**という形は同じなので、
 * 枠組みはここに1つ置く（D6：同じものを2つ書かない）。
 *
 * D5: 判断は無い。行を切ることと、待つあいだ handle を掴むことだけ。
 */

import type * as childProcess from "node:child_process";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";

// ── JSONL framing（spec: rpc.md §Framing） ───────────────────────────────────
// LF だけで切る。readline は使わない（U+2028/U+2029 でも切れてしまう）。

export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      // 末尾の CR を落とす（\r\n も受ける）
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  }

  function onEnd(): void {
    const remaining = buffer + decoder.end();
    if (remaining.length > 0) {
      const line = remaining.endsWith("\r") ? remaining.slice(0, -1) : remaining;
      if (line.length > 0) onLine(line);
    }
  }

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

/**
 * `spawn` の失敗理由が飛んでくるのを、ひと呼吸だけ待つ（PO報告 2026-08-11）。
 *
 * `spawn` は同期では失敗を返さない——`pid` が `undefined` になり、理由（ENOENT など）は
 * **次のティックで `error` イベントとして**飛ぶ。待たずに投げると「pid が取れません」
 * としか言えず、**本当の原因（作業場所が無い）が消える**。
 *
 * 待つのは1ティックだけ。理由が来なければ来ないまま進む（待ち続けない）。
 */
export async function waitForSpawnError(
  peek: () => Error | undefined
): Promise<Error | undefined> {
  if (peek()) return peek();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return peek();
}

// ── 待っている間だけ handle を掴む仕組み（inc-0020） ─────────────────────────

/**
 * 子プロセスと stdio は普段 `unref` してある——職人が残っていてもホストやテストが
 * 抜けられるようにするため。だが**その handle からの応答を待つあいだ**まで unref の
 * ままだと、他に ref された handle が無いとき Node が「やることが無い」と判断し、
 * `await` の途中でプロセスを畳む。ログもエラーも残らない。
 *
 * 「普段は放す・待つ間だけ掴む」を1か所にまとめる。待ちが重なっても数えているので、
 * 内側の待ちが終わっただけで放してしまうことはない。
 */
export interface HandleGrip {
  /** fn を待つあいだ handle を掴む。 */
  hold<T>(fn: () => Promise<T>): Promise<T>;
  /** 掴みを全部放す（プロセスが終わったとき）。 */
  release(): void;
}

export function createHandleGrip(proc: childProcess.ChildProcess): HandleGrip {
  let held = 0;
  const setRef = (on: boolean): void => {
    // 既に閉じた handle への ref/unref は無視される（例外にはならない）
    if (on) proc.ref();
    else proc.unref();
    for (const stream of [proc.stdout, proc.stderr, proc.stdin]) {
      if (!stream) continue;
      const socket = stream as unknown as net.Socket;
      if (on) socket.ref?.();
      else socket.unref?.();
    }
  };
  return {
    async hold<T>(fn: () => Promise<T>): Promise<T> {
      if (held++ === 0) setRef(true);
      try {
        return await fn();
      } finally {
        if (--held === 0) setRef(false);
      }
    },
    release(): void {
      held = 0;
      setRef(false);
    },
  };
}
