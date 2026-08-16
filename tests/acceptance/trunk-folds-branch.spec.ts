/**
 * task-0234: 幹から枝を畳める口（`thread.fold`）。
 *
 * それまで幹にできたのは `thread.steer` で「畳んでください」と頼むことだけだった。
 * だが枝は知らせが来ないと動かないので、頼んでも動くとは限らず、幹は待つしかなかった
 * ——2026-08-16、開いたままの枝が10本以上たまり、PO の画面のレールが枝の丸で埋まった
 * （PO実観測）。ここで確かめるのは、幹の判断で自分の枝を終わらせられること・その裁量が
 * 自分の枝に限られること（他人の幹の枝は畳めない・幹自身も畳めない）・走行中の枝は
 * 切らないこと・枝が自分で書いた結論が消えないこと・畳んだことが枝の記録に残ること・
 * 道具として番頭に提示されていること。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  Canvas,
  PRESENTED_TOOL_NAMES,
  ThreadRegistry,
  createCanvasCatalog,
  createThreadTools,
  type TranscriptEntry,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

/** 「幹が畳みました」の知らせ行だけを型で絞り込む。 */
function findFoldNotice(
  transcript: readonly TranscriptEntry[]
): Extract<TranscriptEntry, { role: "notice" }> | undefined {
  return transcript.find(
    (e): e is Extract<TranscriptEntry, { role: "notice" }> =>
      e.role === "notice" && /幹が畳みました/u.test(e.text)
  );
}

/** 対話ループの偽物。プロバイダは呼ばない（帳簿と道具の振る舞いだけを見る）。 */
class FakeSession implements BantoHarness {
  constructor(readonly sessionId: string) {}
  isStreaming = false;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}

  // ── BantoHarness の残り（ADR-0020 決定89）。章立てはこの試験では使わない ──
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

const catalog = createCanvasCatalog([]);

let threads: ThreadRegistry;
/** スレッドごとのハーネス。走行中を模すのに `isStreaming` を直に触る。 */
let sessions: Map<string, FakeSession>;

/** 番頭が実際に持つ形で thread.* を組む（配線を省くと、生えない道具が出る）。 */
function tool(threadId: string, name: string) {
  const found = createThreadTools({ threads, threadId }).find((t) => t.name === name);
  assert.ok(found, `${name} が生えていません`);
  return found;
}

async function text(threadId: string, name: string, args: unknown = {}): Promise<string> {
  const result = await tool(threadId, name).execute(args as never);
  return result.content.map((c) => c.text).join("");
}

beforeEach(() => {
  sessions = new Map();
  threads = new ThreadRegistry(async (threadId) => {
    const session = new FakeSession(`session-of-${threadId}`);
    sessions.set(threadId, session);
    return { harness: session, canvas: new Canvas(catalog), tools: [] };
  });
});

afterEach(() => {
  threads.dispose();
});

describe("[task-0234/a7] thread.fold は番頭に提示される道具", () => {
  it("PRESENTED_TOOL_NAMES に載っている（載らないと在庫に残るだけで番頭には見えない・決定83）", () => {
    assert.ok(PRESENTED_TOOL_NAMES.includes("thread.fold"));
  });
});

describe("[task-0234/a1] 幹から、自分の枝を畳める", () => {
  it("結論をつけて畳むと、枝は閉じて結論が残る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("もう追わない調査"), trunk.id);

    const out = await text(trunk.id, "thread.fold", {
      threadId: branch.id,
      conclusion: "前提が崩れたため打ち切り",
    });

    assert.equal(branch.state, "closed");
    assert.equal(branch.conclusion, "前提が崩れたため打ち切り");
    assert.match(out, /畳みました/u);
  });

  it("結論は必須——空では畳めない（畳んだ理由が空の枝を作らない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    await assert.rejects(
      () => text(trunk.id, "thread.fold", { threadId: branch.id, conclusion: "   " }),
      /結論は空にできません/u
    );
    assert.equal(branch.state, "open");
  });
});

describe("[task-0234/a2] 他人の幹の枝は畳めない", () => {
  it("断られる（畳めるのは、その枝を持つ幹の番頭だけ）", async () => {
    const mine = await threads.open(TRUNK);
    const other = await threads.open({ kind: "trunk", title: "隣の幹" });
    const branch = await threads.open(branchSpec("隣の調べ物"), other.id);

    await assert.rejects(
      () => text(mine.id, "thread.fold", { threadId: branch.id, conclusion: "打ち切り" }),
      /この会話の枝ではありません/u
    );
    assert.equal(branch.state, "open");
  });
});

describe("[task-0234/a3] 幹自身は畳めない", () => {
  it("幹を対象に thread.fold を呼んでも断られる（決定77：幹は永続）", async () => {
    const trunk = await threads.open(TRUNK);

    await assert.rejects(
      () => text(trunk.id, "thread.fold", { threadId: trunk.id, conclusion: "畳む" }),
      /幹は畳めません/u
    );
    assert.equal(trunk.state, "open");
  });
});

describe("[task-0234/a4] 走行中の枝は畳めない", () => {
  it("枝のターンが動いている間は断り、そうと分かる文言になる", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("走行中の枝"), trunk.id);
    const session = sessions.get(branch.id);
    assert.ok(session, "枝のハーネスが見当たりません");
    session.isStreaming = true;

    await assert.rejects(
      () => text(trunk.id, "thread.fold", { threadId: branch.id, conclusion: "打ち切り" }),
      /ターンが動いています/u
    );
    assert.equal(branch.state, "open");

    // ターンが終われば畳める（機構は正しく「いま」だけを見ている）
    session.isStreaming = false;
    await text(trunk.id, "thread.fold", { threadId: branch.id, conclusion: "打ち切り" });
    assert.equal(branch.state, "closed");
  });
});

describe("[task-0234/a5] 枝が自分で書いた結論は消えない", () => {
  it("幹が畳んでも、枝の結論はそのまま残る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("開き直った枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "枝が自分で出した結論" });
    // 知らせで開き直った状態を模す（task-0227：結論は残ったまま open に戻る）
    threads.reopen(branch.id);
    assert.equal(branch.conclusion, "枝が自分で出した結論");

    await text(trunk.id, "thread.fold", {
      threadId: branch.id,
      conclusion: "幹の判断でもう戻らないと決めた",
    });

    assert.equal(branch.state, "closed");
    assert.equal(branch.conclusion, "枝が自分で出した結論", "枝の結論は上書きされない");
  });
});

describe("[task-0234/a6] 幹が畳んだことが枝の記録に残る", () => {
  it("枝の記録に、幹が畳んだと読める行が残る（誰が畳んだかが読める）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    await text(trunk.id, "thread.fold", {
      threadId: branch.id,
      conclusion: "幹の判断で終了",
    });

    const notice = findFoldNotice(branch.transcript);
    assert.ok(notice, "枝の記録に「幹が畳みました」が残っていること");
    assert.match(notice!.text, /幹の判断で終了/u);
  });

  it("枝が自分で結論を書いていた場合も、幹が畳んだことは別行で読める", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("開き直った枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "枝自身の結論" });
    threads.reopen(branch.id);

    await text(trunk.id, "thread.fold", {
      threadId: branch.id,
      conclusion: "幹の判断で終了",
    });

    const notice = findFoldNotice(branch.transcript);
    assert.ok(notice, "枝の結論が残る場合でも、幹が畳んだ記録は別に残ること");
    assert.match(notice!.text, /幹の判断で終了/u);
    assert.match(notice!.text, /枝自身の結論/u, "上書きされた枝の結論も併せて読めること");
  });
});

describe("[task-0234] 未処理を抱えた枝を畳むには所在（where）が要る", () => {
  it("where を書かずには畳めない。書けば所在つきで畳める", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("残作業のある枝"), trunk.id);
    await text(branch.id, "thread.merge", {
      conclusion: "結論",
      remaining: ["本命1本を幹で kobo.enqueue"],
    });
    threads.reopen(branch.id);
    assert.equal(branch.hasUnsettledRemaining, true);

    await assert.rejects(
      () => text(trunk.id, "thread.fold", { threadId: branch.id, conclusion: "終了" }),
      /未処理.*所在/u
    );
    assert.equal(branch.state, "open", "所在を書かせずに畳めると、所在の無い残作業が残る");

    await text(trunk.id, "thread.fold", {
      threadId: branch.id,
      conclusion: "終了",
      where: "imp-9999 として起票した",
    });
    assert.equal(branch.state, "closed");
    assert.equal(branch.settledWhere, "imp-9999 として起票した");
  });
});
