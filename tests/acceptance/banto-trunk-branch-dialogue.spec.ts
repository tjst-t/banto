/**
 * **幹と枝が対話できる**（決定105〜108。PO指示 2026-08-13。ADR-0017 決定77 の訂正）。
 *
 * 決定77 では、幹と枝の間を通るのは**2行だけ**だった——「枝が開いた」札と、畳むときの
 * 結論1行。実運用で痛みになったのは3つ:
 *
 * 1. 枝の中で何が起きているか幹から見えない（止まっているのか進んでいるのかも分からない）
 * 2. 開いたあとの枝へ話しかけられない（`thread.open` の `message` が最初で最後）
 * 3. 枝から幹へ相談できない（畳むまで黙るか、結論を捏造して畳むかの二択）
 *
 * ここで確かめるのは、その3つが開いたことと、**開けたせいで壊れてはいけないもの**:
 * 幹は端から端まで読める帯のままか（詳細を幹へ流さない）、幹をまたいで中身が読めないか、
 * 往復が機構で止まるか（P4）。
 *
 * 実プロバイダは呼ばない。対話ループは偽物に差し替え、帳簿と配信の振る舞いを見る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Canvas,
  PRESENTED_TOOL_NAMES,
  ThreadRegistry,
  createCanvasCatalog,
  createThreadTools,
  resetSendCounters,
  type ServerEvent,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import type { BantoHarness, HarnessEvent } from "@banto/core";

/** 対話ループの偽物（`banto-threads.spec.ts` と同じ形）。 */
class FakeSession implements BantoHarness {
  readonly sessionId: string;
  isStreaming = false;
  prompts: string[] = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  constructor(id: string) {
    this.sessionId = id;
  }
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
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

const catalog = createCanvasCatalog([]);

let server: BantoHostServer | undefined;
let threads: ThreadRegistry;
/** 渡された言伝（`thread.steer` の宛先と本文）。 */
let delivered: Array<{ threadId: string; message: string }>;
/** 幹のターンだけ回した分（`thread.consult`）。 */
let nudged: Array<{ threadId: string; message: string }>;

/** 番頭が実際に持つ形で thread.* を組む（配線を省くと、生えない道具が出る）。 */
function toolsFor(threadId: string) {
  return createThreadTools({
    threads,
    threadId,
    deliver: async (to, message) => {
      delivered.push({ threadId: to, message });
    },
    nudge: async (to, message) => {
      nudged.push({ threadId: to, message });
    },
  });
}

function tool(threadId: string, name: string) {
  const found = toolsFor(threadId).find((t) => t.name === name);
  assert.ok(found, `${name} が生えていません`);
  return found;
}

async function text(threadId: string, name: string, args: unknown): Promise<string> {
  const result = await tool(threadId, name).execute(args as never);
  return result.content.map((c) => c.text).join("");
}

beforeEach(() => {
  resetSendCounters();
  delivered = [];
  nudged = [];
  threads = new ThreadRegistry(async (threadId) => ({
    harness: new FakeSession(`session-of-${threadId}`),
    canvas: new Canvas(catalog),
    tools: [],
  }));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  threads.dispose();
});

describe("[決定105] 幹から枝の中身を読む", () => {
  it("生きている枝の様子と、記録の末尾が読める", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("再現条件の特定"), trunk.id);
    for (let i = 1; i <= 30; i++) branch.record({ role: "po", text: `${i}回目の指示` });
    branch.record({ role: "banto", text: "10回中3回落ちました" });

    const out = await text(trunk.id, "thread.read", { threadId: branch.id });

    assert.match(out, /枝「再現条件の特定」/u);
    assert.match(out, /開いている/u);
    assert.match(out, /還す条件：/u);
    assert.match(out, /記録 全 31 件のうち 12〜31 件目/u, "既定は末尾20件");
    assert.match(out, /番頭: 10回中3回落ちました/u);
    assert.doesNotMatch(out, /PO: 1回目の指示/u, "全文は返さない（末尾から切る）");
    assert.match(out, /前を読む: thread\.read/u, "遡る手立てを示す");
  });

  it("畳んだ枝も読める（中身は消えていない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("sopsの一般化"), trunk.id);
    branch.record({ role: "banto", text: "適用先が1つしかありません" });
    threads.merge(branch.id, "保留：適用先が1つしかない");

    const out = await text(trunk.id, "thread.read", { threadId: branch.id });

    assert.match(out, /畳んである/u);
    assert.match(out, /結論：保留：適用先が1つしかない/u);
    assert.match(out, /番頭: 適用先が1つしかありません/u);
  });

  it("offset と limit で頭から辿れる。続きの案内が出る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("長い調べ物"), trunk.id);
    for (let i = 1; i <= 50; i++) branch.record({ role: "po", text: `${i}件目` });

    const out = await text(trunk.id, "thread.read", {
      threadId: branch.id,
      offset: 1,
      limit: 5,
    });

    assert.match(out, /記録 全 50 件のうち 1〜5 件目/u);
    assert.match(out, /PO: 1件目/u);
    assert.doesNotMatch(out, /PO: 6件目/u);
    assert.match(out, /続きを読む: thread\.read\(\{ threadId: "[^"]+", offset: 6, limit: 5 \}\)/u);
  });

  /**
   * **幹をまたいで中身は読めない。** 記憶も文脈も幹ごとに分かれている（ADR-0003 追補）ので、
   * 隣の幹の会話が読めると分けた意味が消える。伝えたいことがあるなら言伝（`thread.send`）。
   */
  it("別の幹の会話は読めない（I2：黙って読ませない）", async () => {
    const mine = await threads.open({ kind: "trunk", title: "banto開発" });
    const other = await threads.open({ kind: "trunk", title: "ひらがなアプリ" });
    const theirBranch = await threads.open(branchSpec("音声認識"), other.id);

    await assert.rejects(
      () => tool(mine.id, "thread.read").execute({ threadId: theirBranch.id } as never),
      /別の幹の会話です/u
    );
    await assert.rejects(
      () => tool(mine.id, "thread.read").execute({ threadId: other.id } as never),
      /別の幹の会話です/u
    );
    // 自分の幹と、その枝は読める
    const own = await threads.open(branchSpec("自分の枝"), mine.id);
    await tool(mine.id, "thread.read").execute({ threadId: own.id } as never);
    await tool(mine.id, "thread.read").execute({ threadId: mine.id } as never);
  });

  it("知らないIDは断る（I2）", async () => {
    const trunk = await threads.open(TRUNK);
    await assert.rejects(
      () => tool(trunk.id, "thread.read").execute({ threadId: "thread-999" } as never),
      /という会話はありません/u
    );
  });

  it("畳んだ枝は thread.list からも引ける（読むには id が要る）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("済んだ調べ物"), trunk.id);
    threads.merge(branch.id, "決まった");

    const open = await text(trunk.id, "thread.list", {});
    assert.doesNotMatch(open, /済んだ調べ物/u, "既定は開いているものだけ（今までどおり）");

    const all = await text(trunk.id, "thread.list", { includeClosed: true });
    assert.match(all, /済んだ調べ物/u);
    assert.match(all, /［畳んである］/u);
    assert.match(all, /結論：決まった/u);
  });
});

describe("[決定106] 開いた後の枝へ言伝を渡す", () => {
  it("自分の枝へ届く。出所は幹として名乗る（POの発言に見せない）", async () => {
    const trunk = await threads.open({ kind: "trunk", title: "banto開発" });
    const branch = await threads.open(branchSpec("再現条件の特定"), trunk.id);

    const out = await text(trunk.id, "thread.steer", {
      threadId: branch.id,
      message: "計測は要らなくなった。再現条件だけで畳んでよい",
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.threadId, branch.id);
    assert.match(delivered[0]!.message, /幹「banto開発」から/u);
    assert.match(delivered[0]!.message, /再現条件だけで畳んでよい/u);
    assert.match(out, /枝「再現条件の特定」へ渡しました/u);
  });

  it("幹へは渡せない（thread.send の担当）。他の幹の枝にも渡せない", async () => {
    const mine = await threads.open({ kind: "trunk", title: "banto開発" });
    const other = await threads.open({ kind: "trunk", title: "ひらがなアプリ" });
    const theirs = await threads.open(branchSpec("音声認識"), other.id);
    const steer = tool(mine.id, "thread.steer");

    await assert.rejects(() => steer.execute({ threadId: other.id, message: "x" } as never), /幹です/u);
    await assert.rejects(
      () => steer.execute({ threadId: theirs.id, message: "x" } as never),
      /この幹の枝ではありません/u
    );
    assert.deepEqual(delivered, []);
  });

  it("枝から枝へは渡せない（深さは1段・決定77）", async () => {
    const trunk = await threads.open(TRUNK);
    const a = await threads.open(branchSpec("枝A"), trunk.id);
    const b = await threads.open(branchSpec("枝B"), trunk.id);

    await assert.rejects(
      () => tool(a.id, "thread.steer").execute({ threadId: b.id, message: "x" } as never),
      /枝から枝へは渡せません/u
    );
    assert.deepEqual(delivered, []);
  });

  it("畳んだ枝・空の言伝は断る（I2）", async () => {
    const trunk = await threads.open(TRUNK);
    const closed = await threads.open(branchSpec("済んだ枝"), trunk.id);
    const open = await threads.open(branchSpec("生きている枝"), trunk.id);
    threads.merge(closed.id, "決まった");
    const steer = tool(trunk.id, "thread.steer");

    await assert.rejects(
      () => steer.execute({ threadId: closed.id, message: "x" } as never),
      /畳んであります/u
    );
    await assert.rejects(
      () => steer.execute({ threadId: open.id, message: "  " } as never),
      /空の言伝/u
    );
    assert.deepEqual(delivered, []);
  });

  /** P4: 親子の往復は仕事そのものなので幹どうしより緩いが、無限には続かせない。 */
  it("往復が続きすぎたら断る（10分で10通）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    const steer = tool(trunk.id, "thread.steer");

    for (let i = 0; i < 10; i++) await steer.execute({ threadId: branch.id, message: `${i}` } as never);
    await assert.rejects(
      () => steer.execute({ threadId: branch.id, message: "11通目" } as never),
      /続きすぎ/u
    );
    assert.equal(delivered.length, 10, "上限を超えた分は届いてはいけない");
  });

  it("deliver を渡さない構成では生えない", async () => {
    const trunk = await threads.open(TRUNK);
    const names = createThreadTools({ threads, threadId: trunk.id }).map((t) => t.name);
    assert.ok(!names.includes("thread.steer"));
    assert.ok(names.includes("thread.read"), "読む口は配信が要らないので常に生える");
  });
});

describe("[決定107] 枝から幹へ、畳む前に相談する", () => {
  it("幹に札が立ち、幹の番頭のターンが回る", async () => {
    const trunk = await threads.open({ kind: "trunk", title: "banto開発" });
    const branch = await threads.open(branchSpec("再現条件の特定"), trunk.id);

    const out = await text(branch.id, "thread.consult", {
      kind: "question",
      message: "前提だった計測が無い。取り直すか、別筋にするか",
    });

    // ①札（幹の記録に、枝の札・結論と同じ列で残る）
    const notes = trunk.transcript.filter((e) => e.role === "branch_note");
    assert.equal(notes.length, 1);
    assert.deepEqual(
      notes[0]!.role === "branch_note" && {
        branchId: notes[0].branchId,
        title: notes[0].title,
        kind: notes[0].kind,
        text: notes[0].text,
      },
      {
        branchId: branch.id,
        title: "再現条件の特定",
        kind: "question",
        text: "前提だった計測が無い。取り直すか、別筋にするか",
      }
    );
    // ②幹のターンは回る（読ませないと相談にならない）
    assert.equal(nudged.length, 1);
    assert.equal(nudged[0]!.threadId, trunk.id);
    assert.match(nudged[0]!.message, /枝「再現条件の特定」からの問いです/u);
    assert.match(nudged[0]!.message, /thread\.steer/u, "返し方を書いておく");
    // ③知らせの行では積まない（同じ一言が2行に見える）
    assert.deepEqual(trunk.transcript.filter((e) => e.role === "notice"), []);
    assert.match(out, /幹「banto開発」へ問いを還しました/u);
    // ④枝は畳まれない。開いたまま続けられる
    assert.equal(branch.state, "open");
  });

  it("報告は返事を待たない（問いと読み分けられる）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("調べ物"), trunk.id);

    const out = await text(branch.id, "thread.consult", {
      kind: "report",
      message: "思っていたより大きい。3日はかかる",
    });

    const note = trunk.transcript.find((e) => e.role === "branch_note");
    assert.equal(note?.role === "branch_note" && note.kind, "report");
    assert.match(nudged[0]!.message, /報告です/u);
    assert.match(out, /返事は要りません/u);
  });

  it("幹からは還せない（還す先が無い）・畳んだ枝からも還せない（I2）", async () => {
    const trunk = await threads.open(TRUNK);
    const closed = await threads.open(branchSpec("済んだ枝"), trunk.id);
    threads.merge(closed.id, "決まった");

    await assert.rejects(
      () => tool(trunk.id, "thread.consult").execute({ kind: "report", message: "x" } as never),
      /これは幹です/u
    );
    await assert.rejects(
      () => tool(closed.id, "thread.consult").execute({ kind: "report", message: "x" } as never),
      /畳んであります/u
    );
    assert.deepEqual(nudged, []);
    assert.deepEqual(trunk.transcript.filter((e) => e.role === "branch_note"), []);
  });

  it("空の相談は還せない。断ったものは札にしない（幹の帯に嘘を残さない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    await assert.rejects(
      () => tool(branch.id, "thread.consult").execute({ kind: "question", message: " " } as never),
      /空の相談/u
    );
    assert.deepEqual(trunk.transcript.filter((e) => e.role === "branch_note"), []);
  });

  it("往復が続きすぎたら断る（10分で10通）。断った分の札は立たない", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    const consult = tool(branch.id, "thread.consult");

    for (let i = 0; i < 10; i++) await consult.execute({ kind: "report", message: `${i}` } as never);
    await assert.rejects(
      () => consult.execute({ kind: "report", message: "11通目" } as never),
      /続きすぎ/u
    );
    assert.equal(trunk.transcript.filter((e) => e.role === "branch_note").length, 10);
    assert.equal(nudged.length, 10);
  });

  it("nudge を渡さない構成では生えない", async () => {
    const trunk = await threads.open(TRUNK);
    const names = createThreadTools({ threads, threadId: trunk.id }).map((t) => t.name);
    assert.ok(!names.includes("thread.consult"));
  });

  /**
   * **埋没しない見え方**（決定77 の不変条件をそのまま引き継ぐ）。画面へ配らないと、
   * 幹を開いている PO には何も起きていないように見える。
   */
  it("画面へ配られる（branch_note が幹のイベントとして流れる）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("再現条件の特定"), trunk.id);
    server = await BantoHostServer.start({ threads, port: 0, catalog });
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(
      `ws://localhost:${server.port}${BANTO_WS_PATH}`,
      (e) => events.push(e)
    );
    try {
      await text(branch.id, "thread.consult", { kind: "question", message: "どちらの筋で行くか" });
      const seen = await new Promise<ServerEvent>((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const found = events.find((e) => e.type === "branch_note");
          if (found) {
            clearInterval(tick);
            resolve(found);
          } else if (Date.now() - started > 2000) {
            clearInterval(tick);
            reject(new Error(`timed out. seen: ${events.map((e) => e.type).join(", ")}`));
          }
        }, 10);
      });
      assert.equal(seen.type === "branch_note" && seen.threadId, trunk.id);
      assert.equal(seen.type === "branch_note" && seen.branchId, branch.id);
      assert.equal(seen.type === "branch_note" && seen.kind, "question");
    } finally {
      client.close();
    }
  });
});

describe("[決定108] 畳むときの詳細は枝に残る（幹は1行のまま）", () => {
  it("調べたこと・決めたこと・残ったことを渡せる。幹に積まれるのは結論1行だけ", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("間欠的に落ちる試験"), trunk.id);

    await text(branch.id, "thread.merge", {
      conclusion: "inc-0048 を起票し task-0091 を積んだ",
      investigated: ["10回走らせて3回落ちた", "単体では落ちない"],
      decided: ["待ちを延ばす対策は採らない（P6）"],
      remaining: ["task-0091 の実装は未着手"],
    });

    const result = trunk.transcript.find((e) => e.role === "branch_result");
    assert.ok(result?.role === "branch_result");
    assert.equal(result.conclusion, "inc-0048 を起票し task-0091 を積んだ");
    assert.equal(result.hasDetail, true, "詳細が在ることは幹に出す");
    // **幹の帯は読めるまま**——詳細の本文は幹に流れない
    const trunkText = JSON.stringify(trunk.transcript);
    assert.doesNotMatch(trunkText, /10回走らせて3回落ちた/u);
    assert.doesNotMatch(trunkText, /待ちを延ばす対策は採らない/u);
  });

  it("詳細は枝を開けば読める（thread.read の頭書きに出る）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("間欠的に落ちる試験"), trunk.id);
    await text(branch.id, "thread.merge", {
      conclusion: "inc-0048 を起票した",
      investigated: ["10回走らせて3回落ちた"],
      remaining: ["task-0091 の実装は未着手"],
    });

    const out = await text(trunk.id, "thread.read", { threadId: branch.id });
    assert.match(out, /## 調べたこと/u);
    assert.match(out, /10回走らせて3回落ちた/u);
    assert.match(out, /## 残ったこと/u);
    assert.match(out, /task-0091 の実装は未着手/u);
    assert.doesNotMatch(out, /## 決めたこと/u, "書かれなかった欄は出さない");
  });

  it("詳細なしでも今までどおり畳める（結論1行だけ）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    await text(branch.id, "thread.merge", { conclusion: "幹で話せば足りる話でした" });

    const result = trunk.transcript.find((e) => e.role === "branch_result");
    assert.ok(result?.role === "branch_result");
    assert.equal(result.hasDetail, undefined);
    assert.equal(branch.conclusionDetail, undefined);
    assert.equal(branch.state, "closed");
  });
});

/**
 * **道具の一覧は2つある**（inc-0050 の罠）。在庫に足しただけでは番頭の手に無い（決定82）
 * ——提示の表に載っていなければ、入れた意味がそのまま消える。
 */
describe("[決定82] 対話の3本は番頭に提示される", () => {
  it("提示の表に thread.read / thread.steer / thread.consult がある", () => {
    for (const name of ["thread.read", "thread.steer", "thread.consult"] as const) {
      assert.ok(PRESENTED_TOOL_NAMES.includes(name), `${name} が提示の表にない`);
    }
  });

  it("配線が揃った番頭の在庫にも同じ3本がある（表と在庫が食い違わない）", async () => {
    const trunk = await threads.open(TRUNK);
    const names = toolsFor(trunk.id).map((t) => t.name);
    for (const name of ["thread.read", "thread.steer", "thread.consult"] as const) {
      assert.ok(names.includes(name), `${name} が在庫にない`);
    }
  });
});
