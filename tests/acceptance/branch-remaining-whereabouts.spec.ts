/**
 * imp-0036(d)(c): **所在の無い残作業では畳ませない**／**未処理の件数を幹の文脈に1行**。
 *
 * すでに入っていたのは「畳んだあとも一覧に出続ける」「所在を書いて降ろす口」までで、
 * 残っていたのは2つ——**そもそも所在の無いまま畳ませない**ことと、**気づく契機**。
 *
 * 実際に2度落ちている。①調査だけ終わって直しが存在しない（thread-86）。②**幹の判断が
 * 要る「問い」**が `remaining` に流れ込み、答えを待つ相手が居るのに約25分放置された
 * （thread-96）。②のほうが悪い——聞かれたことが誰にも届かない。
 *
 * ここで縛るのは：
 *
 *   (d) 所在の無い行があれば `thread.merge` は**断る**。断り文には**直し方**——
 *       所在の足し方と、**判断を仰ぐなら `thread.consult`** という道（例文まで）
 *   (c) 幹の文脈に「未処理を抱えた枝 N件」が1行入る。**0件では出ない・枝には出ない**。
 *       そして**ターンは起こさない**（ADR-0025 決定120）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BantoHarness, ChapterOpening, HarnessEvent } from "@banto/core";
import {
  Canvas,
  ThreadRegistry,
  WHEREABOUTS_WORDS,
  createCanvasCatalog,
  createThreadTools,
  hasWhereabouts,
  unsettledRemainingLine,
  withUnsettledRemainingNotice,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

/** 対話ループの偽物。**渡された本文をそのまま覚える**（1行が足されたかを見るため）。 */
class FakeSession implements BantoHarness {
  constructor(readonly sessionId: string) {}
  isStreaming = false;
  readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}

  // ── BantoHarness の残り（ADR-0020 決定89）。章立てはこの試験では使わない ──
  readonly backendId = "fake";
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return this.prompts.length;
  }
  transcript(): string {
    return "";
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
}

const catalog = createCanvasCatalog([]);

let threads: ThreadRegistry;

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

/** 畳もうとして返ってきた断り文を取り出す（通ってしまったらそこで落とす）。 */
async function refusalOf(threadId: string, remaining: string[]): Promise<string> {
  try {
    await text(threadId, "thread.merge", { conclusion: "結論", remaining });
  } catch (err) {
    return String(err);
  }
  assert.fail(`所在の無い残作業で畳めてしまった: ${JSON.stringify(remaining)}`);
}

beforeEach(() => {
  threads = new ThreadRegistry(async (threadId) => ({
    harness: new FakeSession(`session-of-${threadId}`),
    canvas: new Canvas(catalog),
    tools: [],
  }));
});

afterEach(() => {
  threads.dispose();
});

describe("[imp-0036(d)] 所在の無い残作業では畳ませない", () => {
  it("所在の無い行があると断る——枝は畳まれず、開いたまま残る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("レビュー環境"), trunk.id);

    await assert.rejects(
      () =>
        text(branch.id, "thread.merge", {
          conclusion: "レビュー環境は task-0026 時点のまま",
          remaining: ["レビュー環境を立て直すか、このまま畳むか"],
        }),
      /所在の無い行/u
    );

    assert.equal(branch.state, "open", "断ったなら畳まれていない");
    assert.equal(branch.conclusion, undefined, "結論も書き込まれていない");
    // 幹の帯にも何も積まれていない（断ったことは幹の記録ではない）
    assert.doesNotMatch(JSON.stringify(trunk.transcript), /立て直すか/u);
  });

  it("断り文が**直し方**を書く——どの行か・所在の足し方・thread.consult の道", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("レビュー環境"), trunk.id);

    const refusal = await refusalOf(branch.id, ["レビュー環境を立て直すか、このまま畳むか"]);

    // ①どの行が欠けているか（そのまま引く。言い換えると番頭が別の行を直す）
    assert.match(refusal, /「レビュー環境を立て直すか、このまま畳むか」/u);
    // ②所在の足し方の例（起票 id・職人の sessionId・幹での委譲予定）
    assert.match(refusal, /imp-0036 として起票した/u);
    assert.match(refusal, /職人 [0-9a-f-]{36} へ委譲した/u);
    assert.match(refusal, /幹で委譲予定/u);
    // ③判断を仰ぐなら thread.consult——枝が生きているうちに聞く道と、その例文
    assert.match(refusal, /thread\.consult/u);
    assert.match(refusal, /枝が生きているいま/u);
    assert.match(refusal, /kind: "question"/u);
    // 所在と見なす語も読める形で出す（何を書けば通るのかを推測させない）
    assert.match(refusal, /所在と見なす語：/u);
  });

  it("所在があれば通る——起票 id・職人の sessionId・文言のどれでもよい", async () => {
    const trunk = await threads.open(TRUNK);
    const ok = [
      "器の寛容化 → imp-0035 として起票した",
      "残りの直し → 職人 019fbd87-4c21-7b3e-9a55-1f0e2d3c4b5a が持っている",
      "main への取り込みは幹で委譲予定",
      "レビュー環境の扱いは thread.consult で幹へ渡した・回答待ち",
      "task-0092 を積んだ",
    ];
    for (const [i, line] of ok.entries()) {
      const branch = await threads.open(branchSpec(`枝${i}`), trunk.id);
      await text(branch.id, "thread.merge", { conclusion: "結論", remaining: [line] });
      assert.equal(branch.state, "closed", `所在のある行を断っている: ${line}`);
      assert.equal(branch.remainingCount, 1);
    }
  });

  it("1行でも所在が無ければ断る（残りが揃っていても通さない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    const refusal = await refusalOf(branch.id, [
      "栞に鍵名を足す → imp-0035 として起票した",
      "SKILL の誤例も直す",
    ]);

    assert.match(refusal, /「SKILL の誤例も直す」/u);
    assert.doesNotMatch(refusal, /「栞に鍵名/u, "所在のある行は引かない（直す先を惑わせる）");
    assert.equal(branch.state, "open");
  });

  it("残作業を書かなければ今までどおり畳める（緩さは変えない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    await text(branch.id, "thread.merge", { conclusion: "幹で話せば足りる話でした" });
    assert.equal(branch.state, "closed");

    // 空白だけの行も同じ（数えない＝検査もしない）
    const blank = await threads.open(branchSpec("空白"), trunk.id);
    await text(blank.id, "thread.merge", { conclusion: "結論", remaining: ["  ", ""] });
    assert.equal(blank.state, "closed");
    assert.equal(blank.remainingCount, 0);
  });

  it("畳み直しでも抜け道にならない（冪等の早期 return より手前で断る）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "同じ結論" });

    await assert.rejects(
      () =>
        text(branch.id, "thread.merge", {
          conclusion: "同じ結論",
          remaining: ["あとで考える"],
        }),
      /所在の無い行/u
    );
    assert.equal(branch.hasUnsettledRemaining, false, "未処理が所在なしで立っていない");
  });

  it("断るのは**帳簿**（道具を経由しない呼び出しも通さない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    assert.throws(
      () => threads.merge(branch.id, "結論", { remaining: ["あとでやる"] }),
      /所在の無い行/u
    );
  });

  it("所在と見なす語は**読める形で並んでいる**（日本語を含む・理由つき）", () => {
    assert.ok(WHEREABOUTS_WORDS.length >= 10, "1本の正規表現に押し込めない");
    for (const entry of WHEREABOUTS_WORDS) {
      assert.ok(entry.word.length > 0);
      assert.ok(entry.why.length > 0, `${entry.word} になぜ所在なのかが書かれていない`);
    }
    const words = WHEREABOUTS_WORDS.map((w) => w.word);
    for (const word of ["起票", "委譲", "待ち", "職人"]) {
      assert.ok(words.includes(word), `日本語の所在「${word}」が見当たらない`);
    }
  });

  it("英字の語は語の切れ目で見る（`pool` や `report` を所在に化けさせない）", () => {
    assert.equal(hasWhereabouts("pool を畳むか決める"), false);
    assert.equal(hasWhereabouts("report をもう一度読む"), false);
    assert.equal(hasWhereabouts("PO 判断待ち"), true);
    assert.equal(hasWhereabouts("worker.delegate で渡した"), true);
  });
});

describe("[imp-0036(c)] 未処理を抱えた枝の件数が、幹の文脈に1行入る", () => {
  /** 未処理を1件抱えた枝を畳む。 */
  async function foldWithRemaining(trunkId: string, title: string): Promise<string> {
    const branch = await threads.open(branchSpec(title), trunkId);
    await text(branch.id, "thread.merge", {
      conclusion: "結論",
      remaining: [`${title}の直し → 幹で委譲予定`],
    });
    return branch.id;
  }

  /** 本番と同じ皮を掛けたハーネスと、その素の入れ物。 */
  function wrapped(threadId: string, kind: "trunk" | "branch") {
    const fake = new FakeSession(`session-of-${threadId}`);
    const harness = withUnsettledRemainingNotice(fake, {
      kind,
      branches: () => threads.unsettledBranches(threadId),
    });
    return { fake, harness };
  }

  it("幹のターンに1行入る——件数と枝の id が出て、そこから引ける", async () => {
    const trunk = await threads.open(TRUNK);
    const branchId = await foldWithRemaining(trunk.id, "器が使えない件");
    const { fake, harness } = wrapped(trunk.id, "trunk");

    await harness.prompt("次の用件をお願いします");

    const sent = fake.prompts[0] ?? "";
    assert.match(sent, /次の用件をお願いします/u, "PO の言葉はそのまま残る");
    assert.match(sent, /未処理を抱えたまま畳んだ枝が 1件/u);
    assert.match(sent, new RegExp(branchId, "u"), "どの枝かを指せる");
    assert.match(sent, /器が使えない件/u);
    assert.match(sent, /thread\.settle/u, "降ろす道まで書く（気づかせるだけにしない）");
    assert.match(sent, /thread\.read/u, "中身を読む道も書く");
  });

  it("**0件では何も足さない**（毎ターン「0件」と出る行は読み飛ばされる）", async () => {
    const trunk = await threads.open(TRUNK);
    const { fake, harness } = wrapped(trunk.id, "trunk");

    await harness.prompt("次の用件");
    assert.equal(fake.prompts[0], "次の用件", "本文が1文字も変わらない");

    // きれいに畳んだ枝が居ても増えない
    const branch = await threads.open(branchSpec("片付いた枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "片付いた" });
    await harness.prompt("その次");
    assert.equal(fake.prompts[1], "その次");
  });

  it("**枝には出さない**（降ろせるのは、その枝を持つ幹の番頭だけ）", async () => {
    const trunk = await threads.open(TRUNK);
    await foldWithRemaining(trunk.id, "器が使えない件");
    const sibling = await threads.open(branchSpec("別の調べ物"), trunk.id);
    const { fake, harness } = wrapped(sibling.id, "branch");

    await harness.prompt("枝への言伝");
    assert.equal(fake.prompts[0], "枝への言伝");
  });

  it("隣の幹の未処理は数えない（自分で降ろせないものを毎ターン見せない）", async () => {
    const mine = await threads.open(TRUNK);
    const other = await threads.open({ kind: "trunk", title: "隣の幹" });
    await foldWithRemaining(other.id, "隣の件");
    const { fake, harness } = wrapped(mine.id, "trunk");

    await harness.prompt("こちらの用件");
    assert.equal(fake.prompts[0], "こちらの用件");
  });

  it("降ろせば次のターンから消える（呼ぶたびに数え直す）", async () => {
    const trunk = await threads.open(TRUNK);
    const branchId = await foldWithRemaining(trunk.id, "器が使えない件");
    const { fake, harness } = wrapped(trunk.id, "trunk");

    await harness.prompt("1回目");
    assert.match(fake.prompts[0] ?? "", /未処理を抱えたまま畳んだ枝が 1件/u);

    await text(trunk.id, "thread.settle", { threadId: branchId, where: "imp-0035 で起票済み" });
    await harness.prompt("2回目");
    assert.equal(fake.prompts[1], "2回目", "降ろしたのに出続けると、一覧と同じく信用を失う");
  });

  it("多いときは先頭いくつか＋残り件数（1行に収める）", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `thread-${i}`,
      title: `枝${i}`,
      remainingCount: i + 1,
    }));
    const line = unsettledRemainingLine(many) ?? "";

    assert.match(line, /枝が 5件/u);
    assert.match(line, /thread-0/u);
    assert.match(line, /thread-2/u);
    assert.doesNotMatch(line, /thread-3/u, "全部並べると1行に収まらない");
    assert.match(line, /ほか2件/u, "落とした分は件数で言う（黙って切らない）");
    assert.equal(line.includes("\n"), false, "1行であること");
  });

  it("0件は `undefined`（「足すものが無い」を空文字と混ぜない）", () => {
    assert.equal(unsettledRemainingLine([]), undefined);
  });

  it("**ターンは起こさない**（ADR-0025 決定120）——足すのは既に始まったターンの本文だけ", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("器が使えない件"), trunk.id);
    const trunkHarness = trunk.harness as FakeSession;
    // 数え始めは**枝を開いた後**（開いた札は決定77 のもので、この便の話ではない）
    const before = trunkHarness.prompts.length;
    const trunkEntries = trunk.transcript.length;

    await text(branch.id, "thread.merge", {
      conclusion: "結論",
      remaining: ["器の寛容化 → 幹で委譲予定"],
    });

    assert.equal(trunkHarness.prompts.length, before, "未処理が立っても幹は起きない");
    // 幹に積まれるのは結論1行だけ（札も知らせも増やさない）
    assert.equal(trunk.transcript.length, trunkEntries + 1);
    assert.equal(trunk.transcript[trunkEntries]?.role, "branch_result");
  });
});

/**
 * 配線の検査（本番の経路に掛かっているか）。**組み立てで掛け忘れると、試験だけが通る。**
 */
describe("[imp-0036] 配線", () => {
  const bin = fs.readFileSync(
    path.join(import.meta.dirname, "../../packages/banto-host/src/bin.ts"),
    "utf8"
  );

  it("幹の1行は、ハーネスの継ぎ目で両バックエンドに掛かっている", () => {
    assert.match(bin, /withUnsettledRemainingNotice\(harness, \{/u, "皮が使われていない");
    assert.match(bin, /kind: identity\?\.kind/u, "幹か枝かが渡っていない");
    assert.match(
      bin,
      /branches: \(\) => threads\.unsettledBranches\(threadId\)/u,
      "その幹の未処理を数えていない"
    );
    // pi と claude-agent-sdk の両方（片方だけに掛かる形は、過去に一度やっている）
    assert.match(bin, /const piHarness: BantoHarness = unsettledNotice\(/u);
    assert.match(bin, /return unsettledNotice\(withTurnBudgetReset\(claudeHarness, turnBudget\)\)/u);
  });

  it("道具の説明が「所在が無ければ断る」「判断は thread.consult」と言う", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    const merge = tool(branch.id, "thread.merge");

    assert.match(merge.description ?? "", /断る/u);
    assert.match(merge.description ?? "", /thread\.consult/u);
    // 引数の説明にも書く（説明文だけ長くしても、欄を埋めるときに読まれない）
    const remaining = (merge.parameters as { properties?: Record<string, { description?: string }> })
      .properties?.["remaining"];
    assert.match(remaining?.description ?? "", /所在/u);
  });

  it("番頭のシステムプロンプトにも同じ線が書いてある（bin.ts の SYSTEM_PROMPT）", () => {
    assert.match(bin, /thread\.merge refuses to fold a branch when a line of remaining has no whereabouts/u);
    assert.match(bin, /ask for it with thread\.consult while the branch is still alive/u);
  });
});
