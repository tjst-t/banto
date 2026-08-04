/**
 * 応答を待つあいだの handle の掴み（inc-0020）。
 *
 * ドライバは子プロセスと stdio を `unref` している——職人が残っていてもホストや
 * テストが抜けられるようにするため。ところが**その handle からの応答を待つ**ので、
 * 他に ref された handle が無いとき Node が「やることが無い」と判断し、`await` の
 * 途中でプロセスを畳んでしまう。ログもエラーも残らない。
 *
 * 直し方は「普段は放す・待つ間だけ掴む」。ここで固定したいのはその数え方——
 * 待ちが重なったとき、内側が終わっただけで放してしまうと元の穴が開く。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as childProcess from "node:child_process";

import { createHandleGrip } from "@banto/worker-pool";

/** ref / unref の呼ばれ方だけを見る偽のプロセス。 */
function fakeProc(): {
  proc: childProcess.ChildProcess;
  /** いま掴んでいるか（proc と全 stdio が ref されているか）。 */
  held: () => boolean;
  calls: string[];
} {
  const calls: string[] = [];
  let procRef = true;
  const streams = ["stdout", "stderr", "stdin"].map((name) => {
    const state = { name, ref: true };
    return {
      state,
      stream: {
        ref: () => {
          state.ref = true;
          calls.push(`${name}:ref`);
        },
        unref: () => {
          state.ref = false;
          calls.push(`${name}:unref`);
        },
      },
    };
  });
  const proc = {
    ref: () => {
      procRef = true;
      calls.push("proc:ref");
    },
    unref: () => {
      procRef = false;
      calls.push("proc:unref");
    },
    stdout: streams[0]!.stream,
    stderr: streams[1]!.stream,
    stdin: streams[2]!.stream,
  } as unknown as childProcess.ChildProcess;

  return { proc, held: () => procRef && streams.every((s) => s.state.ref), calls };
}

describe("応答を待つあいだだけ handle を掴む（inc-0020）", () => {
  it("待っている間は掴み、終わったら放す", async () => {
    const { proc, held } = fakeProc();
    const grip = createHandleGrip(proc);

    let insideHeld: boolean | undefined;
    await grip.hold(async () => {
      insideHeld = held();
    });

    assert.equal(insideHeld, true, "待っている間は proc と stdio が ref されている");
    assert.equal(held(), false, "終わったら放す（ホストが抜けられなくならない）");
  });

  it("待ちが重なっても、全部終わるまで放さない", async () => {
    const { proc, held } = fakeProc();
    const grip = createHandleGrip(proc);

    let release1: (() => void) | undefined;
    const outer = grip.hold(() => new Promise<void>((r) => (release1 = r)));

    let heldAfterInner: boolean | undefined;
    await grip.hold(async () => {
      // 内側の待ち。ここが終わっても外側はまだ待っている
    });
    heldAfterInner = held();

    release1!();
    await outer;

    assert.equal(heldAfterInner, true, "内側が終わっただけでは放さない");
    assert.equal(held(), false, "外側も終われば放す");
  });

  it("待ちの中で例外が出ても放す", async () => {
    const { proc, held } = fakeProc();
    const grip = createHandleGrip(proc);

    await assert.rejects(() =>
      grip.hold(async () => {
        throw new Error("応答が来なかった");
      })
    );
    assert.equal(held(), false, "失敗しても掴んだままにしない");
  });

  it("release() は待ちの数に関わらず放す（プロセスが終わったとき）", async () => {
    const { proc, held } = fakeProc();
    const grip = createHandleGrip(proc);

    let never: (() => void) | undefined;
    const pending = grip.hold(() => new Promise<void>((r) => (never = r)));
    assert.equal(held(), true);

    // 職人のプロセスが落ちた。待ちは宙に浮くが、掴みは残してはいけない
    grip.release();
    assert.equal(held(), false, "終わったプロセスの掴みでホストを引き留めない");

    never!();
    await pending;
  });
});
