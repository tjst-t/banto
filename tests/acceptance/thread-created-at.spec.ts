/**
 * **「開いた時刻」は再起動を越えて変わらない**（inc: thread-104 の調査で見つけた）。
 *
 * `Thread.createdAt` は既定値が `new Date().toISOString()` で、`restore()` がそれを
 * 渡していなかった。結果、**読み戻すたびに開いた時刻が振り直されていた**——索引には
 * 保存されているのに、読み戻した値のほうが新しくなる。
 *
 * これは並び順が狂うだけの話ではない。thread-104 が自力で動かなかった件を調べたとき、
 * 索引の `createdAt` は「再起動の**後**に開かれた」と読めたが、ホストのログでは
 * 再起動の**1秒前**に開かれていた——原因の切り分けを誤らせる（I1: 事実が書き換わる）。
 *
 * `sessionFile` の名前も同じ理由で振り直されるが、そちらは影響が読み切れないので
 * ここでは触っていない（別途起票）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness } from "@banto/core";
import { ThreadRegistry, ThreadStore, type ThreadFactory } from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-created-at-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakeSession implements BantoHarness {
  readonly sessionId = "s";
  isStreaming = false;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}

  readonly backendId = "fake";
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

const factory: ThreadFactory = async () => ({ harness: new FakeSession(), tools: [] });

describe("[inc] 開いた時刻は読み戻しで振り直されない", () => {
  it("幹も枝も、再起動の前後で createdAt が変わらない", async () => {
    const store = new ThreadStore(dir);
    const before = new ThreadRegistry(factory, store);
    const trunk = await before.open(TRUNK);
    const branch = await before.open(branchSpec("枝の時刻"), trunk.id);
    const trunkOpenedAt = trunk.createdAt;
    const branchOpenedAt = branch.createdAt;

    // 同じミリ秒で読み戻すと差が出ないので、1ミリ秒だけ進める
    await new Promise((r) => setTimeout(r, 2));

    const after = new ThreadRegistry(factory, new ThreadStore(dir));
    await after.restore();

    assert.equal(after.get(trunk.id)?.createdAt, trunkOpenedAt);
    assert.equal(after.get(branch.id)?.createdAt, branchOpenedAt);
  });

  it("読み戻しても索引に書き戻される値は同じ（起動のたびに書き換わらない）", async () => {
    const store = new ThreadStore(dir);
    const before = new ThreadRegistry(factory, store);
    const trunk = await before.open(TRUNK);
    const openedAt = trunk.createdAt;

    // 2回読み戻す。振り直していれば、そのたびに新しい時刻へずれていく
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 2));
      const next = new ThreadRegistry(factory, new ThreadStore(dir));
      await next.restore();
      // 索引へ書き戻させる（題を変えれば flush が走る）
      next.rename(trunk.id, `題 ${i}`);
      assert.equal(next.get(trunk.id)?.createdAt, openedAt);
    }

    const last = new ThreadRegistry(factory, new ThreadStore(dir));
    await last.restore();
    assert.equal(last.get(trunk.id)?.createdAt, openedAt);
  });
});
