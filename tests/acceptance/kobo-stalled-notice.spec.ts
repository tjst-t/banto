/**
 * 第2便: **滞留の知らせが番頭に届く。ただし束ねて届く**（rethink C-3 第1手の4）。
 *
 * **配線を足しただけでは足りない。** `task_stalled` を帳簿に積んでも、
 * `kobo-notice.ts` の知らせの対象に入っていなければ**誰も読まない**——今回の調査で、
 * 配線が全部あるのに一度も動いていなかった箇所が3つ見つかっている。
 *
 * **束ねる理由**：1件1通で流すと、溜まっていた分がそのまま通数になる。実測で
 * 35 件が 35 回届いた事例があり、そうなると番頭は読まなくなる＝知らせないのと同じ。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startKoboNotices, bundleStalled } from "../../packages/banto-host/src/kobo-notice.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

const HOUR = 60 * 60 * 1000;

/** `kobo.events` / `kobo.task` の代わり。工場は立てず、知らせの層だけを見る。 */
function stubTools(events: Array<Record<string, unknown>>, origins: Record<string, string>) {
  const tools = [
    {
      name: "kobo.events",
      async execute() {
        return { content: [], details: { events, origins } };
      },
    },
    {
      name: "kobo.task",
      async execute() {
        return { content: [], details: { task: { status: "queued" }, reviewStage: "banto" } };
      },
    },
  ] as unknown as NamespacedToolDefinition[];
  return tools;
}

function stalledEvent(
  eventId: number,
  taskId: string,
  dwell: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    eventId,
    type: "task_stalled",
    timestamp: new Date(0).toISOString(),
    projectTag: "p",
    taskId,
    status: "queued",
    dwellMs: dwell,
    thresholdMs: 2 * HOUR,
    blockedBy: [],
    lastChangeAt: new Date(0).toISOString(),
    ...extra,
  };
}

describe("[第2便] 滞留の知らせは束ねて届く", () => {
  it("同じ宛先の滞留は1通にまとまる（35件が35通にならない）", () => {
    const origins = Object.fromEntries(
      Array.from({ length: 35 }, (_, i) => [`p/task-${i}`, threadOrigin("th-1")])
    );
    const events = Array.from({ length: 35 }, (_, i) =>
      stalledEvent(i + 1, `task-${i}`, (i + 3) * HOUR)
    );

    const bundles = bundleStalled(events as never, origins);
    assert.equal(bundles.length, 1, `1通に束ねること（実際: ${bundles.length} 通）`);
    assert.match(bundles[0]!.text, /35 件が止まっています/);
    // 全部のタスクが1通の中に並ぶ（束ねても消えない）
    for (let i = 0; i < 35; i++) {
      assert.ok(bundles[0]!.text.includes(`task-${i}`), `task-${i} が落ちている`);
    }
  });

  it("宛先が違えば分ける（別の会話へ混ぜない）", () => {
    const origins = {
      "p/task-a": threadOrigin("th-1"),
      "p/task-b": threadOrigin("th-2"),
    };
    const bundles = bundleStalled(
      [stalledEvent(1, "task-a", 3 * HOUR), stalledEvent(2, "task-b", 4 * HOUR)] as never,
      origins
    );
    assert.equal(bundles.length, 2);
  });

  it("長く止まっているものが上に来る（読む順が判断の順）", () => {
    const origins = { "p/task-a": "", "p/task-b": "" };
    const [bundle] = bundleStalled(
      [stalledEvent(1, "task-a", 3 * HOUR), stalledEvent(2, "task-b", 20 * HOUR)] as never,
      origins
    );
    assert.ok(
      bundle!.text.indexOf("task-b") < bundle!.text.indexOf("task-a"),
      "長く止まっている方が下に来ている"
    );
  });

  it("**なぜ止まっているか**（blockedBy）が文面に出る", () => {
    const [bundle] = bundleStalled(
      [stalledEvent(1, "task-a", 19 * HOUR, { blockedBy: ["task-0099"] })] as never,
      { "p/task-a": "" }
    );
    assert.match(bundle!.text, /待ち: task-0099/);
    assert.match(bundle!.text, /19時間/);
  });

  it("求める判断に**降ろす道**（kobo.settle）が書いてある", () => {
    const [bundle] = bundleStalled([stalledEvent(1, "task-a", 5 * HOUR)] as never, {
      "p/task-a": "",
    });
    assert.match(bundle!.text, /kobo\.settle/);
    assert.match(bundle!.text, /一度だけ/, "二度鳴らないことが読み手に伝わる");
  });
});

describe("[第2便] 知らせの経路に実際に載っている（配線が動く）", () => {
  it("startKoboNotices が task_stalled を拾って届ける", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-stalled-notice-"));
    const delivered: Array<{ text: string; threadId?: string }> = [];
    const stop = startKoboNotices({
      tools: stubTools(
        [
          stalledEvent(1, "task-a", 5 * HOUR),
          stalledEvent(2, "task-b", 9 * HOUR),
        ],
        { "p/task-a": threadOrigin("th-1"), "p/task-b": threadOrigin("th-1") }
      ),
      async notify(message, target) {
        delivered.push({ text: message, ...(target.threadId ? { threadId: target.threadId } : {}) });
      },
      cursorPath: path.join(tmpDir, "cursor.json"),
      intervalMs: 60_000,
      log: () => undefined,
    });
    try {
      // 起動直後に一度引く。届くまで待つ
      const deadline = Date.now() + 5000;
      while (delivered.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        delivered.length,
        1,
        `届いたのは1通（束ねた分）であること（実際: ${delivered.length}）`
      );
      assert.match(delivered[0]!.text, /2 件が止まっています/);
      assert.equal(delivered[0]!.threadId, "th-1", "積んだ会話へ返っていない");
    } finally {
      stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
