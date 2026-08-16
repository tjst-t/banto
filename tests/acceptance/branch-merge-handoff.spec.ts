/**
 * imp-0070: **枝を畳むときに「幹の一手」を渡せる**（task-0158）。
 *
 * ADR-0025 決定120 で「知らせは幹のターンを起こさない」を敷いたあと、**枝が畳まれても
 * 幹は動かない**ようになった。2026-08-16、task-0152 が着地したのに幹が次の一手
 * （banto の再起動＝稼働への反映）を踏まなかったのはこれが理由——機構が T3 で立てた
 * 用件枝が承認もマージ確認も済ませて**静かに畳み**、幹は起きなかった。
 *
 * 開ける穴は1つだけ:
 *   - **保つ線**：知らせ（職人・工房・環境・system）は幹のターンを起こさない（決定120）
 *   - **足す線**：枝の結論に**幹が次に踏む一手**が含まれるときだけ、幹のターンを1本起こす
 *
 * ここで確かめること:
 *   1. `handoff` を非空で畳むと、幹へ nudge が1件（本文に結論と一手の両方）
 *   2. `handoff` 無しで畳むと nudge は0件（幹の末尾には結論1行が積まれている）
 *   3. 同じ枝を畳み直しても nudge は1件のまま（二重に起こさない）
 *   4. `nudge` 未配線で `handoff` を渡すと断られ、枝は開いたまま（状態を触っていない）
 *   5. `handoff` は畳んだあと `thread.read` で読める（枝に残る）
 *   6. 道具の説明・SKILL・枝のシステム文言に「幹の一手があるなら書け」の案内がある
 *   7. 知らせでは依然として幹のターンが起きない（この仕事で壊していない）
 *
 * 実プロバイダは呼ばない。1〜6 は `banto-trunk-branch-dialogue.spec.ts` と同じ土台
 * （nudge を差し替えて数える）、7 は `subject-branch-delivery.spec.ts` と同じ土台
 * （本物のサーバと T1 の台帳）で見る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import {
  BantoHostServer,
  Canvas,
  ThreadRegistry,
  createCanvasCatalog,
  createMemoryTools,
  createThreadTools,
  resetSendCounters,
  type Thread,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog } from "../../packages/banto-host/src/turn-log.js";

/** 対話ループの偽物（`banto-trunk-branch-dialogue.spec.ts` と同じ形）。 */
class FakeSession implements BantoHarness {
  readonly sessionId: string;
  isStreaming = false;
  prompts: string[] = [];

  constructor(id = "test-session") {
    this.sessionId = id;
  }
  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}

  readonly backendId = "fake";
  contextWindow(): number | undefined {
    return undefined;
  }
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

const SKILL_PATH = path.join(
  import.meta.dirname,
  "../../packages/banto-host/skills/trunk-and-branch/SKILL.md"
);
const BIN_PATH = path.join(import.meta.dirname, "../../packages/banto-host/src/bin.ts");

describe("[imp-0070] 畳むときに幹の一手を渡す", () => {
  const catalog = createCanvasCatalog([]);
  let threads: ThreadRegistry;
  /** 幹のターンだけ回した分（`thread.consult` と同じ経路）。 */
  let nudged: Array<{ threadId: string; message: string }>;
  let delivered: Array<{ threadId: string; message: string }>;

  /** 番頭が実際に持つ形で thread.* を組む（配線を省くと、生えない道具が出る）。 */
  function toolsFor(threadId: string, wireNudge = true) {
    return createThreadTools({
      threads,
      threadId,
      deliver: async (to, message) => {
        delivered.push({ threadId: to, message });
      },
      ...(wireNudge
        ? {
            nudge: async (to: string, message: string) => {
              nudged.push({ threadId: to, message });
            },
          }
        : {}),
    });
  }

  function tool(threadId: string, name: string, wireNudge = true) {
    const found = toolsFor(threadId, wireNudge).find((t) => t.name === name);
    assert.ok(found, `${name} が生えていません`);
    return found;
  }

  async function text(threadId: string, name: string, args: unknown): Promise<string> {
    const result = await tool(threadId, name).execute(args as never);
    return result.content.map((c) => c.text).join("");
  }

  beforeEach(() => {
    resetSendCounters();
    nudged = [];
    delivered = [];
    threads = new ThreadRegistry(async (threadId) => ({
      harness: new FakeSession(`session-of-${threadId}`),
      canvas: new Canvas(catalog),
      tools: [],
    }));
  });

  afterEach(() => {
    threads.dispose();
  });

  it("一手を書いて畳むと、幹のターンが1本だけ起きる（本文に結論と一手の両方）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("task-0152 の着地"), trunk.id);

    const out = await text(branch.id, "thread.merge", {
      conclusion: "task-0152 は着地した（マージ確認まで済み）",
      handoff: "task-0152 が着地したので banto を再起動して反映してほしい",
    });

    // ①幹のターンは1本だけ。宛先は親の幹
    assert.equal(nudged.length, 1);
    assert.equal(nudged[0]!.threadId, trunk.id);
    // ②幹はこの枝の中を見ていない。題・結論・一手・読み返し方が本文に入っている
    const message = nudged[0]!.message;
    assert.match(message, /枝「task-0152 の着地」/u, "どの枝の話か");
    assert.match(message, /task-0152 は着地した（マージ確認まで済み）/u, "結論");
    assert.match(message, /banto を再起動して反映してほしい/u, "幹の一手");
    assert.match(message, new RegExp(`thread\\.read\\(\\{ threadId: "${branch.id}"`, "u"), "引き方");
    // ③幹の帯は太らせない——積むのは結論1行のまま（決定77・決定108）
    const result = trunk.transcript.filter((e) => e.role === "branch_result");
    assert.equal(result.length, 1);
    assert.equal(
      result[0]!.role === "branch_result" && result[0].conclusion,
      "task-0152 は着地した（マージ確認まで済み）"
    );
    assert.doesNotMatch(
      result[0]!.role === "branch_result" ? result[0].conclusion : "",
      /再起動/u,
      "一手を結論行に混ぜない"
    );
    // ④渡ったことは畳んだその場で番頭にも言う（渡したつもりにさせない・I2）
    assert.match(out, /幹へ一手を渡しました/u);
    assert.equal(branch.state, "closed");
  });

  it("一手が無い結論では幹のターンは起きない（従来どおり結論1行だけ）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("調べ物"), trunk.id);

    await text(branch.id, "thread.merge", { conclusion: "保留：計測が足りない" });

    assert.deepEqual(nudged, [], "知らせで幹を起こさない線はそのまま");
    const last = trunk.transcript.at(-1);
    assert.equal(last?.role, "branch_result");
    assert.equal(last?.role === "branch_result" && last.conclusion, "保留：計測が足りない");
    assert.equal(branch.state, "closed");
  });

  it("空白だけの一手は書かなかったのと同じ（幹は起きない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("調べ物"), trunk.id);

    await text(branch.id, "thread.merge", { conclusion: "片付いた", handoff: "   " });

    assert.deepEqual(nudged, []);
  });

  it("畳み直しても幹は二度起きない（一度きりの札は帳簿が持つ）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("task-0152 の着地"), trunk.id);
    const args = {
      conclusion: "task-0152 は着地した",
      handoff: "banto を再起動して反映してほしい",
    };

    await text(branch.id, "thread.merge", args);
    const out = await text(branch.id, "thread.merge", args);

    assert.equal(nudged.length, 1, "畳み直しで幹をもう一度起こさない");
    // I2: 渡っていないのに「渡しました」と答えない
    assert.match(out, /既に一手を渡してあります/u);
    // 帳簿の側でも一度きり——道具を通さず直に呼んでも増えない
    const again = threads.merge(branch.id, args.conclusion, { handoff: args.handoff });
    assert.equal(again.handoffToDeliver, undefined);
  });

  it("nudge が配線されていない構成で一手を渡すと断られ、枝は開いたまま", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("task-0152 の着地"), trunk.id);
    const merge = tool(branch.id, "thread.merge", false);

    await assert.rejects(
      () =>
        merge.execute({
          conclusion: "task-0152 は着地した",
          handoff: "banto を再起動して反映してほしい",
        } as never),
      /nudge が渡されていません/u
    );

    // 状態は触っていない（書き直して畳み直せる）
    assert.equal(branch.state, "open");
    assert.equal(branch.conclusion, undefined);
    assert.equal(branch.handoff, undefined);
    assert.deepEqual(
      trunk.transcript.filter((e) => e.role === "branch_result"),
      []
    );
  });

  it("nudge 未配線でも、一手を書かない畳み方はそのまま通る", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("調べ物"), trunk.id);

    await tool(branch.id, "thread.merge", false).execute({ conclusion: "片付いた" } as never);

    assert.equal(branch.state, "closed");
    assert.equal(trunk.transcript.filter((e) => e.role === "branch_result").length, 1);
  });

  it("渡した一手は畳んだあとも枝に残り、thread.read で読める", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("task-0152 の着地"), trunk.id);

    await text(branch.id, "thread.merge", {
      conclusion: "task-0152 は着地した",
      handoff: "banto を再起動して反映してほしい",
      decided: ["マージ確認まで枝で済ませる"],
    });

    // 幹から開いて読む（この枝が幹に何を渡したのかが辿れること）
    const read = await text(trunk.id, "thread.read", { threadId: branch.id });
    assert.match(read, /幹へ渡した一手/u);
    assert.match(read, /banto を再起動して反映してほしい/u);
    assert.equal(branch.handoff, "banto を再起動して反映してほしい");
  });

  it("往復の上限は一手には掛からない（上限で畳めなくならない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("長い相談"), trunk.id);

    // 幹と枝の上限（10分で10通）を使い切る
    for (let i = 0; i < 10; i++) {
      await text(branch.id, "thread.consult", { kind: "report", message: `${i}件目` });
    }
    await assert.rejects(
      () => tool(branch.id, "thread.consult").execute({ kind: "report", message: "11件目" } as never),
      /続きすぎています/u
    );

    // 畳むのは1枝1回。上限で弾くと畳めなくなる——弾くべきは往復であって受け渡しではない
    await text(branch.id, "thread.merge", {
      conclusion: "決着した",
      handoff: "banto を再起動して反映してほしい",
    });
    assert.equal(branch.state, "closed");
    assert.equal(nudged.filter((n) => n.message.includes("幹の一手")).length, 1);
  });

  describe("言葉の側（書けと言われていなければ書かない）", () => {
    it("thread.merge の説明が「幹の一手があるなら handoff に書け」と言う", async () => {
      const trunk = await threads.open(TRUNK);
      const branch = await threads.open(branchSpec("枝"), trunk.id);
      const merge = tool(branch.id, "thread.merge");
      const description = merge.description ?? "";

      assert.match(description, /handoff/u);
      assert.match(description, /幹が次に踏む一手/u);
      assert.match(description, /書かなければ幹は動かない/u);
      // thread.consult との使い分け（枝が生きているうちの問い／畳むときの受け渡し）
      assert.match(description, /thread\.consult/u);
      // 欄の説明にも書く（説明文だけ長くしても、欄を埋めるときに読まれない）
      const handoff = (merge.parameters as { properties?: Record<string, { description?: string }> })
        .properties?.["handoff"];
      assert.match(handoff?.description ?? "", /幹が次に踏む一手/u);
      // 既存の線（imp-0036）を緩めていない
      assert.match(description, /所在/u);
    });

    it("SKILL trunk-and-branch に「一手を渡す」と今日の教訓が入っている", () => {
      const skill = fs.readFileSync(SKILL_PATH, "utf8");

      assert.match(skill, /handoff/u);
      assert.match(skill, /幹が次に踏む一手/u);
      // 教訓：合図を頼む相手は、そのタスクを握っている枝でなければならない
      assert.match(skill, /合図を頼む相手は、そのタスクを握っている枝/u);
      assert.match(skill, /観測/u);
      // 既存の手順（imp-0036）はそのまま
      assert.match(skill, /thread\.settle/u);
    });

    it("枝のシステム文言（bin.ts）にも同じ線が書いてある", () => {
      const bin = fs.readFileSync(BIN_PATH, "utf8");

      // 会話の節（幹の番頭が読む側）
      assert.match(bin, /If folding a branch leaves a move for the trunk to make, write it in handoff/u);
      // 枝のシステム文言（用件枝の中の番頭が読む側——ここが今回書かなかった当人）
      assert.match(bin, /\*\*If folding leaves a move for the trunk to make, write it in handoff\.\*\*/u);
      assert.match(bin, /wakes the trunk exactly once/u);
      // 既存の線（imp-0036）は緩めていない
      assert.match(
        bin,
        /thread\.merge refuses to fold a branch when a line of remaining has no whereabouts/u
      );
    });
  });
});

/**
 * **保つ線**（ADR-0025 決定120・T3）。一手の穴を開けたせいで、知らせまで幹を起こす
 * ようになっていないことを、この spec の中でも1本押さえる。
 */
describe("[決定120] 知らせでは依然として幹のターンが起きない", () => {
  let dir: string;
  let store: JsonlMemoryStore;
  let threads: ThreadRegistry;
  let server: BantoHostServer | undefined;
  let ledger: TurnLog;

  function sessionOf(thread: Thread): FakeSession {
    return thread.harness as unknown as FakeSession;
  }

  /** そのスレッドで回ったターンの本数（T1 の台帳から）。 */
  function turnsOf(threadId: string): number {
    return ledger.readAll().filter((e) => e.threadId === threadId).length;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-merge-handoff-"));
    store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
    ledger = new TurnLog(path.join(dir, "turns.jsonl"));
    threads = new ThreadRegistry(async () => ({
      harness: new FakeSession(),
      tools: createMemoryTools(new ScopedMemory(store)),
    }));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    threads.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("職人・工房・環境・system のどれでも幹のターンは0本のまま", async () => {
    const trunk = await threads.open(TRUNK);
    server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });

    await server.notify("職人が完了を報告しました", {
      source: "worker",
      subject: { key: "worker:sess-9", label: "職人 sess-9" },
    });
    await server.notify("task-0152 がマージ待ちに入りました", {
      source: "kobo",
      subject: { key: "kobo:banto/task-0152", label: "task-0152" },
    });
    await server.notify("環境 env-3 の用意が済みました", {
      source: "env",
      subject: { key: "env:env-3", label: "環境 env-3" },
    });
    await server.notify("ホストを再起動しました", { source: "system" });

    // 幹は黙ったまま＝PO の入力を待てる
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0, "知らせで幹のターンが回っている");
    // 捌く場所は枝（対応をやめたわけではない）
    const branches = threads.list({ kind: "branch" }).filter((t) => t.parentId === trunk.id);
    assert.equal(branches.length, 4);
    for (const branch of branches) assert.equal(turnsOf(branch.id) > 0, true);
  });
});
