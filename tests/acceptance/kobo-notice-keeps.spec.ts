/**
 * 落ちた札に**そこまでの作業の在り処**を添える（realign 第2便）。
 *
 * **困っていたこと**：落ちた札を受け取った番頭がまず知りたいのは「やり直しか、拾えるのか」
 * である。機構は職人の成果を取り置くようになった（枝 `banto/keep/<project>/<taskId>/…`）が、
 * **その在り処が札に無ければ番頭は知らない**——既にあるコミットを捨てて最初からやり直す
 * 判断をしてしまう。
 *
 * 守ること:
 *   1. 載せるのは `task_failed` **だけ**。監査の不通過には載せない（職人はまだ生きている）
 *   2. 引けなくても**知らせ自体は必ず出る**（届かないより粗い方がまし）
 *   3. 取り置きが無ければ**何も足さない**（「ありません」を毎回出すと札が読みにくくなる）
 *
 * **`worker.keeps` は別の枝（kobo/realign-2b）にある。** ここは `invoke` を差し替えて
 * 3通り（返ってきた／空／落ちた）を見る——`invoke` は Tool 名で引く汎用の口なので、
 * 呼び先が無い構成でも catch されて何も足さずに成立する。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";
import { threadOrigin } from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

const KEEP = "banto/keep/banto/task-0042/20260814T101500-claude-agent";
const KEEP2 = "banto/keep/banto/task-0042/20260814T121500-claude-agent";

interface Delivered {
  text: string;
  threadId?: string;
}

/**
 * 知らせの層を1周だけ回して、届いた札を返す。
 *
 * `keeps` は `worker.keeps` の振る舞い（返り／例外）を差し替えるためのもの。
 */
async function deliverOnce(opts: {
  event: Record<string, unknown>;
  keeps?: () => Promise<Record<string, unknown>>;
}): Promise<Delivered[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-notice-keeps-"));
  const delivered: Delivered[] = [];
  const calls: string[] = [];

  const tools = [
    {
      name: "kobo.events",
      async execute() {
        return {
          content: [],
          details: {
            events: [opts.event],
            origins: { "banto/task-0042": threadOrigin("th-1") },
          },
        };
      },
    },
    {
      name: "kobo.task",
      async execute() {
        return {
          content: [],
          details: { task: { status: "failed", title: "道具定義の書き直し" }, reviewStage: "banto" },
        };
      },
    },
    // **在るときだけ登録する。** 登録しなければ「呼び先がまだ無い構成」そのものになる
    ...(opts.keeps
      ? [
          {
            name: "worker.keeps",
            async execute() {
              calls.push("worker.keeps");
              return { content: [], details: await opts.keeps!() };
            },
          },
        ]
      : []),
  ] as unknown as NamespacedToolDefinition[];

  const stop = startKoboNotices({
    tools,
    async notify(message, target) {
      delivered.push({ text: message, ...(target.threadId ? { threadId: target.threadId } : {}) });
    },
    cursorPath: path.join(tmpDir, "cursor.json"),
    intervalMs: 60_000,
    log: () => undefined,
  });
  try {
    const deadline = Date.now() + 5000;
    while (delivered.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return delivered;
  } finally {
    stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const failedEvent = {
  eventId: 1,
  type: "task_failed",
  timestamp: new Date(0).toISOString(),
  projectTag: "banto",
  taskId: "task-0042",
  reason: "agent_exited_without_report",
};

describe("[第2便] 落ちた札に、そこまでの作業の在り処が載る", () => {
  it("取り置きが返ってきたら、枝と読み方が1行で載る", async () => {
    const delivered = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ keeps: [{ branch: KEEP }] }),
    });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.text, /そこまでの作業は/);
    assert.ok(delivered[0]!.text.includes(KEEP), "枝の名前が載っていない");
    assert.ok(
      delivered[0]!.text.includes(`git log -p ${KEEP}`),
      "**読み方**が載っていない（枝名だけでは、何が残っているか確かめられない）"
    );
  });

  it("**位置は「求める判断」の直前**（`envUrl` と同じ扱い）", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ keeps: [{ branch: KEEP }] }),
    });
    const keepAt = notice!.text.indexOf("そこまでの作業は");
    const adviceAt = notice!.text.indexOf("**求める判断**");
    const happenedAt = notice!.text.indexOf("**起きたこと**");
    assert.ok(happenedAt < keepAt, "「起きたこと」より前に出ている");
    assert.ok(keepAt < adviceAt, "「求める判断」より後に出ている");
  });

  it("2本以上あるなら**新しい方**を出し、本数を添える（拾い残しを黙らせない）", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ keeps: [{ branch: KEEP }, { branch: KEEP2 }] }),
    });
    assert.ok(notice!.text.includes(KEEP2), "新しい方が出ていない");
    assert.match(notice!.text, /他に 1 本/);
  });

  it("項目が文字列で返る形でも読める", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ keeps: [KEEP] }),
    });
    assert.ok(notice!.text.includes(KEEP));
  });
});

describe("[第2便] 在り処が無い・引けないときも、知らせは必ず出る", () => {
  it("取り置きが空なら**何も足さない**（「ありません」を毎回出さない）", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ keeps: [] }),
    });
    assert.ok(notice, "知らせが出ていない");
    assert.doesNotMatch(notice!.text, /そこまでの作業/);
    assert.doesNotMatch(notice!.text, /取り置き/);
    // 本体は今までどおり出る
    assert.match(notice!.text, /task-0042 が止まりました/);
    assert.match(notice!.text, /\*\*求める判断\*\*/);
  });

  it("`worker.keeps` が落ちても知らせは出る（届かないより粗い方がまし）", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => {
        throw new Error("worker pool に届きません");
      },
    });
    assert.ok(notice, "取り置きが引けないだけで知らせが消えている");
    assert.match(notice!.text, /task-0042 が止まりました/);
    assert.doesNotMatch(notice!.text, /そこまでの作業/);
  });

  it("**呼び先がまだ無い構成でも成立する**（`worker.keeps` を登録しない）", async () => {
    const [notice] = await deliverOnce({ event: failedEvent });
    assert.ok(notice, "呼び先が無いだけで知らせが消えている");
    assert.match(notice!.text, /task-0042 が止まりました/);
    assert.doesNotMatch(notice!.text, /そこまでの作業/);
  });

  it("読めない形が返ってきたら**推測で枝名を組み立てない**", async () => {
    const [notice] = await deliverOnce({
      event: failedEvent,
      keeps: async () => ({ branches: [KEEP] }), // 想定と違う形
    });
    assert.ok(notice);
    assert.doesNotMatch(
      notice!.text,
      /そこまでの作業/,
      "存在するか分からない枝を番頭に `git log` させることになる"
    );
  });
});

describe("[第2便] 載せるのは落ちたときだけ", () => {
  it("監査の不通過（audit_verdict fail）には載せない——職人はまだ生きている", async () => {
    const delivered = await deliverOnce({
      event: {
        eventId: 2,
        type: "audit_verdict",
        timestamp: new Date(0).toISOString(),
        projectTag: "banto",
        taskId: "task-0042",
        verdict: "fail",
        findings: ["a2 が未検証"],
      },
      keeps: async () => ({ keeps: [{ branch: KEEP }] }),
    });
    assert.equal(delivered.length, 1, "監査の札そのものは出ること");
    assert.match(delivered[0]!.text, /監査に落ちました/);
    assert.doesNotMatch(delivered[0]!.text, /そこまでの作業/);
  });
});
