/**
 * imp-0036: 枝で「残ったこと」に書いた仕事が、幹に届かないまま消える。
 *
 * 2026-08-15、枝「器が使えない件」(thread-86) は `remaining` に本命の直しを書いて畳んだのに、
 * 起票も無く職人も立たず、PO が「修正は積んでいるのか」と聞くまで宙に浮いていた。
 * 落ちたのは**受け皿**の側：
 *
 *   - `remaining` は幹へ流れない（決定108・これは正しい設計で、ここでも変えない）
 *   - 畳んだ枝は `thread.list` の既定から外れる。**残作業を抱えた枝と、きれいに片付いた枝が
 *     一覧で区別できなかった**
 *
 * ここで縛るのは3つ：
 *
 *   1. 残作業を書いて畳んだ枝は、**畳んだあとも既定の一覧に「未処理 N件」で出続ける**
 *   2. 出すのは**件数だけ**——中身は幹へ流さない（決定108 は動かさない）
 *   3. 降ろすには**所在**が要る（`thread.settle`）。「片付いた」と言うだけでは降りない
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  Canvas,
  PRESENTED_TOOL_NAMES,
  ThreadRegistry,
  ThreadStore,
  createCanvasCatalog,
  createThreadTools,
  type ThreadFactory,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

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

/** 事故の再現：残作業を書いて枝を畳む。 */
async function foldWithRemaining(trunkId: string, title = "器が使えない件") {
  const branch = await threads.open(branchSpec(title), trunkId);
  await text(branch.id, "thread.merge", {
    conclusion: "器の寛容化を推す",
    investigated: ["器の中では docker に届かない"],
    remaining: ["本命1本を幹で kobo.enqueue：器の寛容化＋栞に鍵名"],
  });
  return branch;
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

describe("[imp-0036] 残作業を抱えたまま畳んだ枝は、既定の一覧から消えない", () => {
  it("既定の thread.list に「畳んである・未処理 N件」で出る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);

    // 幹の番頭が次のターンで引く形（includeClosed を付けない）
    const out = await text(trunk.id, "thread.list", {});
    assert.match(out, /器が使えない件/u, "未処理を抱えた枝は畳んでも一覧に出る");
    assert.match(out, /［畳んである・未処理 1件］/u);
    assert.match(out, new RegExp(branch.id, "u"), "降ろす先を指せるよう id も出す");
  });

  it("出すのは件数だけ——残作業の中身は一覧にも幹にも流れない（決定108 は動かさない）", async () => {
    const trunk = await threads.open(TRUNK);
    await foldWithRemaining(trunk.id);

    const out = await text(trunk.id, "thread.list", {});
    assert.doesNotMatch(out, /kobo\.enqueue/u, "残作業の本文は一覧に出さない");
    assert.doesNotMatch(out, /器の中では docker に届かない/u, "調べたことも出さない");
    // 幹の帯も今までどおり——積まれるのは結論1行だけ
    const trunkText = JSON.stringify(trunk.transcript);
    assert.doesNotMatch(trunkText, /kobo\.enqueue/u);
  });

  it("残作業を書かずに畳んだ枝は、今までどおり既定の一覧から外れる", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("幹で足りた話"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "幹で話せば足りる話でした" });

    const out = await text(trunk.id, "thread.list", {});
    assert.doesNotMatch(out, /幹で足りた話/u, "片付いた枝まで残すと一覧が信用を失う");
    assert.equal(branch.hasUnsettledRemaining, false);
  });

  it("空白だけの行は未処理に数えない（一覧の件数と中身がずれる）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "結論", remaining: ["  ", ""] });

    assert.equal(branch.remainingCount, 0);
    assert.doesNotMatch(await text(trunk.id, "thread.list", {}), /未処理/u);
  });

  it("再起動を越えても未処理は残る（消えたら、いちばん忘れやすい形に戻る）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remainders-"));
    try {
      const factory: ThreadFactory = async (threadId) => ({
        harness: new FakeSession(`session-of-${threadId}`),
        tools: [],
      });
      threads.dispose();
      threads = new ThreadRegistry(factory, new ThreadStore(dir));
      const trunk = await threads.open(TRUNK);
      const branch = await foldWithRemaining(trunk.id);
      threads.flushAll();

      const second = new ThreadRegistry(factory, new ThreadStore(dir));
      await second.restore();
      const restored = second.resolve(branch.id);
      assert.equal(restored.remainingCount, 1);
      assert.equal(restored.hasUnsettledRemaining, true);
      second.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[imp-0036] 畳んだその場で未処理を言う", () => {
  it("thread.merge の返りが、未処理の件数と降ろし方をその場で告げる", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("器が使えない件"), trunk.id);

    const out = await text(branch.id, "thread.merge", {
      conclusion: "器の寛容化を推す",
      // 所在つきで書く（所在の無い行は (d) が畳ませない——それは下の describe で見る）
      remaining: ["本命1本を幹で kobo.enqueue", "SKILL の誤例も直す（imp-0035 に足した）"],
    });

    assert.match(out, /未処理 2件/u);
    assert.match(out, /thread\.settle/u, "降ろす道をその場で示す（次のターンには別件へ移る）");
    assert.match(out, new RegExp(branch.id, "u"));
  });

  it("残作業が無ければ今までどおり黙って畳む", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);

    const out = await text(branch.id, "thread.merge", { conclusion: "保留：計測が足りない" });
    assert.doesNotMatch(out, /未処理/u);
  });
});

describe("[imp-0036] 降ろすには所在が要る（thread.settle）", () => {
  it("所在を書いて降ろすと、既定の一覧から消える", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);

    await text(trunk.id, "thread.settle", {
      threadId: branch.id,
      where: "imp-0035 として起票し職人へ委譲した",
    });

    assert.doesNotMatch(await text(trunk.id, "thread.list", {}), /器が使えない件/u);
    // 畳んだ枝として引けることは変わらない
    assert.match(await text(trunk.id, "thread.list", { includeClosed: true }), /器が使えない件/u);
  });

  it("所在は枝の記録に残る（降ろす口が消しゴムにならないように）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);

    await text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035 で起票済み" });

    assert.equal(branch.settledWhere, "imp-0035 で起票済み");
    const recorded = branch.transcript.filter(
      (e): e is typeof e & { text: string } => "text" in e && e.text.includes("所在")
    );
    assert.equal(recorded.length, 1, "どこへ行ったかを後から辿れること");
    assert.match(recorded[0]!.text, /imp-0035 で起票済み/u);
  });

  it("空の所在は断る（「片付いた」と言うだけでは降りない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);

    await assert.rejects(
      () => text(trunk.id, "thread.settle", { threadId: branch.id, where: "   " }),
      /所在は空にできません/u
    );
    assert.equal(branch.hasUnsettledRemaining, true, "断ったなら未処理は降りていない");
  });

  it("未処理の無い枝は降ろせない（I2: 黙って成功にしない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    await text(branch.id, "thread.merge", { conclusion: "結論" });

    await assert.rejects(
      () => text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035" }),
      /未処理はありません/u
    );
  });

  it("別の幹の枝は降ろせない（降ろせるのは、その枝を持つ幹の番頭だけ）", async () => {
    const mine = await threads.open(TRUNK);
    const other = await threads.open({ kind: "trunk", title: "隣の幹" });
    const branch = await foldWithRemaining(other.id);

    await assert.rejects(
      () => text(mine.id, "thread.settle", { threadId: branch.id, where: "imp-0035" }),
      /この会話の枝ではありません/u
    );
    assert.equal(branch.hasUnsettledRemaining, true);
  });

  it("隣の枝からも降ろせない（降ろすのは幹の仕事）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);
    const sibling = await threads.open(branchSpec("別の調べ物"), trunk.id);

    await assert.rejects(
      () => text(sibling.id, "thread.settle", { threadId: branch.id, where: "imp-0035" }),
      /この会話の枝ではありません/u
    );
  });

  it("枝を開いて読んだときも、未処理と降ろし方が頭書きに出る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);

    const before = await text(trunk.id, "thread.read", { threadId: branch.id });
    assert.match(before, /未処理：1件/u);
    assert.match(before, /thread\.settle/u);
    // 中身（残作業の本文）は詳細として読める——読みに来た番頭には見せる（決定108）
    assert.match(before, /kobo\.enqueue/u);

    await text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035 で起票済み" });
    const after = await text(trunk.id, "thread.read", { threadId: branch.id });
    assert.match(after, /未処理の所在：imp-0035 で起票済み/u);
    assert.doesNotMatch(after, /所在はまだ書かれていません/u);
  });

  it("同じ所在で二度降ろしても足さない（冪等）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);
    const before = branch.transcript.length;

    await text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035" });
    await text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035" });

    assert.equal(branch.transcript.length, before + 1);
  });

  it("降ろしたあとに残作業を書いて畳み直すと、また未処理として立つ", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await foldWithRemaining(trunk.id);
    await text(trunk.id, "thread.settle", { threadId: branch.id, where: "imp-0035" });

    await threads.reopen(branch.id);
    await text(branch.id, "thread.merge", {
      conclusion: "やはりもう1本要る",
      remaining: ["器の寛容化は別途 imp-0037 として起票した"],
    });

    assert.equal(branch.hasUnsettledRemaining, true, "新しい言明には新しい所在が要る");
    assert.match(await text(trunk.id, "thread.list", {}), /未処理 1件/u);
  });
});

/**
 * **道具の一覧は2つある**（inc-0050 の罠）。在庫に足しただけでは番頭の手に無い（決定82）
 * ——降ろす口が提示から漏れると、番頭の手には「消えない行」だけが残る。
 */
describe("[imp-0036/決定82] 降ろす口は番頭に提示される", () => {
  it("提示の表に thread.settle がある", () => {
    assert.ok(PRESENTED_TOOL_NAMES.includes("thread.settle"));
  });
});

/**
 * 言葉の側（imp-0036）。機構だけ直しても、**畳む前に所在を持たせろ**が書かれていなければ
 * 番頭は同じところで落ちる。道具の説明と SKILL の両方に手順が要る。
 */
describe("[imp-0036] 畳む前の手順が言葉になっている", () => {
  it("thread.merge の説明が「残作業には所在を持たせろ」と言う", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝"), trunk.id);
    const description = tool(branch.id, "thread.merge").description ?? "";

    assert.match(description, /所在/u);
    assert.match(description, /imp-NNNN/u, "起票 id を例示して促す");
    assert.match(description, /次の一手/u, "conclusion を「〜を推す」で終わらせない");
    assert.match(description, /thread\.settle/u);
  });

  it("SKILL trunk-and-branch に畳む前の手順が入っている", () => {
    const skill = fs.readFileSync(
      path.join(
        import.meta.dirname,
        "../../packages/banto-host/skills/trunk-and-branch/SKILL.md"
      ),
      "utf8"
    );
    assert.match(skill, /所在/u);
    assert.match(skill, /thread\.settle/u);
    assert.match(skill, /次の一手/u);
  });
});
