/**
 * task-0289: 残高切れ・認証切れで会話が応答できないとき、そうと分かる形で残して幹へ上げる。
 *
 * ## 背景（実測）
 *
 * 2026-08-19、工場が17時間止まった。原因は工場ではなく、知らせの受け手だった枝が
 * OpenRouter のクレジット切れ（402 Insufficient credits）でターンを回せなくなっていたこと。
 * `journalctl` を `Insufficient credits` で引いても3日ぶんで0件（実測）——エラーが残るのは
 * 会話の jsonl だけで、しかもその会話は畳んだ枝なので誰も開かない。
 *
 * ## ここで確かめること
 *
 * - a1: 「呼べない系」のエラーでターンが落ちたとき、会話 id・出所・モデル座標・理由が
 *   `console.error` へ出る（出所を問わない）
 * - a2: 出所が自分以外（kobo/worker/nudge/thread）のとき、親の幹（枝なら親・幹なら帳場）
 *   へ札が1枚立ち、「どの会話が・どの知らせを・なぜ捌けなかったか」が載る
 * - a3: 同じ会話・同じ理由の札は10分に1回まで（連打しない）
 * - a4: 「呼べない系」でない普通の失敗（中断・道具のエラー）では何もしない
 *
 * 実プロバイダは呼ばない。`getLastError` を会話ごとに差し替えられる偽のハーネスで、
 * 「プロンプト自体は通ったが、応答はエラーだった」という実際のOpenRouter/opencodeの
 * 壊れ方を再現する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  ThreadRegistry,
  type ServerEvent,
  type Thread,
  type ThreadSpec,
} from "@banto/host";
import { withinLlmUnavailableCooldown } from "../../packages/banto-host/src/llm-unavailable.js";
import { branchSpec } from "./threadSpecs.js";

/** 帳場（メインの幹）。店にただ1つ・PO裁定 2026-08-10。 */
const MAIN: ThreadSpec = { kind: "trunk", main: true };

/** 対話ループの偽物。プロンプト自体は必ず通る（実物の壊れ方＝応答がエラーだった、を再現する）。 */
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

let server: BantoHostServer | undefined;
let threads: ThreadRegistry;
let sessions: Map<string, FakeSession>;
/** そのスレッドの `getLastError()` が返す値。会話ごとに差し替えて壊れ方を再現する。 */
let errorFor: Map<string, string | undefined>;
let errorLines: string[];
let restoreConsoleError: (() => void) | undefined;

function captureConsoleError(): () => void {
  const original = console.error;
  errorLines = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- console.error の可変長引数をそのまま受ける (I4)
  console.error = ((...args: any[]) => {
    errorLines.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
  return () => {
    console.error = original;
  };
}

beforeEach(async () => {
  sessions = new Map();
  errorFor = new Map();
  threads = new ThreadRegistry(async (threadId) => {
    const session = new FakeSession(`session-of-${threadId}`);
    sessions.set(threadId, session);
    return {
      harness: session,
      tools: [],
      getLastError: () => errorFor.get(threadId),
    };
  });
  restoreConsoleError = captureConsoleError();
  server = await BantoHostServer.start({ threads, port: 0 });
});

afterEach(async () => {
  restoreConsoleError?.();
  await server?.close();
  server = undefined;
  threads.dispose();
});

/** 条件が満たされるまで待つ（`nudge` は待たずに幹のターンを起こすため・a2）。 */
async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 幹の帯に立った札（branch_note）で、この枝を指すもの。 */
function notesFor(trunk: Thread, branchId: string) {
  return trunk.transcript.filter(
    (e): e is Extract<Thread["transcript"][number], { role: "branch_note" }> =>
      e.role === "branch_note" && e.branchId === branchId
  );
}

describe("[task-0289/a1] 呼べない系のエラーは journal（console.error）へ出す", () => {
  it("会話 id・出所・モデル座標・理由が1行に載る", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("レビュー待ちの枝"), main.id);
    branch.model = { provider: "openrouter", id: "opencode-go/deepseek-v4-flash", vision: false };
    errorFor.set(
      branch.id,
      '401: {"type":"CreditsError","message":"Insufficient balance: 到達不能"}'
    );

    await server!.notify("レビューが終わりました", { threadId: branch.id, source: "worker" });

    const line = errorLines.find((l) => l.includes(branch.id));
    assert.ok(line, `会話 id を含む行が出ていない（実際: ${JSON.stringify(errorLines)}）`);
    assert.match(line!, /worker/u, "出所が載っていない");
    assert.match(line!, /openrouter\/opencode-go\/deepseek-v4-flash/u, "モデル座標が載っていない");
    assert.match(line!, /CreditsError|Insufficient balance/u, "理由が載っていない");
  });

  it("出所が PO 自身でも journal へは出る（a1 は出所を問わない）", async () => {
    const main = await threads.open(MAIN);
    errorFor.set(main.id, "403: invalid api key");

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(
      `ws://localhost:${server!.port}${BANTO_WS_PATH}`,
      (e) => events.push(e),
      main.id
    );
    await until(() => events.some((e) => e.type === "welcome"), "welcome");
    client.send({ type: "prompt", text: "何か聞きたいこと", threadId: main.id });
    await until(() => events.some((e) => e.type === "turn_end"), "turn_end");
    client.close();

    const line = errorLines.find((l) => l.includes(main.id));
    assert.ok(line, "PO の発話が落ちても journal に出ていない");
    assert.match(line!, /po/u, "出所（po）が載っていない");
  });
});

describe("[task-0289/a4] 呼べない系ではない普通の失敗では何もしない", () => {
  it("Request was aborted では journal 行も幹の札も立たない", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("中断された枝"), main.id);
    errorFor.set(branch.id, "Request was aborted");

    await server!.notify("知らせです", { threadId: branch.id, source: "worker" });

    assert.equal(
      errorLines.some((l) => l.includes("モデルを呼べません")),
      false,
      "呼べない系ではないのに journal 行が出ている"
    );
    assert.equal(notesFor(main, branch.id).length, 0, "呼べない系ではないのに幹へ札が立っている");
  });

  it("道具のエラー（tool error 風の文言）でも立たない", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("道具が失敗した枝"), main.id);
    errorFor.set(branch.id, "file.read: no such file or directory");

    await server!.notify("知らせです", { threadId: branch.id, source: "worker" });

    assert.equal(errorLines.some((l) => l.includes("モデルを呼べません")), false);
    assert.equal(notesFor(main, branch.id).length, 0);
  });
});

describe("[task-0289/a2] 自分以外が起こしたターンが落ちたら、親の幹へ札が立つ", () => {
  it("枝なら親の幹へ。札に会話・知らせの頭・なぜ捌けなかったかが載る（source: worker）", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("レビュー待ちの枝"), main.id);
    branch.model = { provider: "openrouter", id: "deepseek-v4-flash", vision: false };
    errorFor.set(
      branch.id,
      '401: {"type":"CreditsError","message":"Insufficient balance: 到達不能"}'
    );

    const noticeText =
      "task-0279 はレビュー待ちです。".repeat(10) + "末尾はここまでは載らないはず";
    await server!.notify(noticeText, { threadId: branch.id, source: "worker" });

    const notes = notesFor(main, branch.id);
    assert.equal(notes.length, 1, "幹に札が立っていない");
    const note = notes[0]!;
    assert.match(String(note.text), new RegExp(branch.id), "どの会話かが載っていない");
    assert.match(
      String(note.text),
      /CreditsError|Insufficient balance/u,
      "なぜ捌けなかったか（理由）が載っていない"
    );
    assert.ok(
      String(note.text).includes(noticeText.slice(0, 50)),
      "捌けなかった知らせの本文の頭が載っていない"
    );
    assert.ok(
      !String(note.text).includes("末尾はここまでは載らないはず"),
      "頭200字を超えて全文が載っている"
    );

    // 記述どおり「幹のターンを起こす」（気づかせるのが目的で、札を積むだけでは足りない）
    await until(() => (sessions.get(main.id)?.prompts.length ?? 0) > 0, "幹のターンが起きること");
  });

  it("幹（帳場ではない幹）が落ちたら帳場へ（source: kobo）", async () => {
    const main = await threads.open(MAIN);
    const projectTrunk = await threads.open({ kind: "trunk", title: "別プロジェクトの幹" });
    errorFor.set(projectTrunk.id, "402: Insufficient credits");

    await server!.notify("task_stalled のお知らせです", {
      threadId: projectTrunk.id,
      source: "kobo",
      conversation: true,
    });

    const notes = notesFor(main, projectTrunk.id);
    assert.equal(notes.length, 1, "帳場に札が立っていない");
    assert.match(String(notes[0]!.text), /Insufficient credits/u);
  });

  it("出所が nudge（枝からの相談の返し先）でも本物の nudge() 経路で立つ", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("相談中の枝"), main.id);
    errorFor.set(branch.id, "401 Unauthorized");

    await server!.nudge(branch.id, "幹からの返事です");

    assert.equal(notesFor(main, branch.id).length, 1, "nudge 経路で落ちても幹に札が立っていない");
  });

  it("出所が thread（他の幹からの言伝）でも立つ", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("言伝を受けた枝"), main.id);
    errorFor.set(branch.id, "403 Unauthorized");

    await server!.notify("別の幹からの言伝です", { threadId: branch.id, source: "thread" });

    assert.equal(notesFor(main, branch.id).length, 1);
  });

  it("自分（po・system）が起こしたターンでは札を立てない", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("PO と話している枝"), main.id);
    errorFor.set(branch.id, "402: Insufficient credits");

    await server!.notify("機構からの一文です", { threadId: branch.id, source: "system" });

    assert.equal(notesFor(main, branch.id).length, 0, "自分（system）の発話なのに札が立っている");
  });
});

describe("[task-0289/a3] 同じ会話・同じ理由の札は連打しない（10分に1回まで）", () => {
  it("立て続けに同じ理由で落ちても、札は1枚のまま", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("連打してくる枝"), main.id);
    errorFor.set(branch.id, "402: Insufficient credits");

    await server!.notify("1通目", { threadId: branch.id, source: "worker" });
    await server!.notify("2通目", { threadId: branch.id, source: "worker" });
    await server!.notify("3通目", { threadId: branch.id, source: "worker" });

    assert.equal(
      notesFor(main, branch.id).length,
      1,
      `10分以内の連打は1枚に抑えること（実際: ${notesFor(main, branch.id).length}枚）`
    );
  });

  it("理由が違えば別に立つ（別の壊れ方は別に知らせる）", async () => {
    const main = await threads.open(MAIN);
    const branch = await threads.open(branchSpec("壊れ方が変わる枝"), main.id);

    errorFor.set(branch.id, "402: Insufficient credits");
    await server!.notify("1通目", { threadId: branch.id, source: "worker" });

    errorFor.set(branch.id, "401: Unauthorized");
    await server!.notify("2通目", { threadId: branch.id, source: "worker" });

    assert.equal(notesFor(main, branch.id).length, 2, "理由が違うのに束ねている");
  });

  it("会話が違えば別に立つ（他の会話の連打で抑えない）", async () => {
    const main = await threads.open(MAIN);
    const branchA = await threads.open(branchSpec("枝A"), main.id);
    const branchB = await threads.open(branchSpec("枝B"), main.id);
    errorFor.set(branchA.id, "402: Insufficient credits");
    errorFor.set(branchB.id, "402: Insufficient credits");

    await server!.notify("Aから", { threadId: branchA.id, source: "worker" });
    await server!.notify("Bから", { threadId: branchB.id, source: "worker" });

    assert.equal(notesFor(main, branchA.id).length, 1);
    assert.equal(notesFor(main, branchB.id).length, 1);
  });
});

describe("[task-0289] 連打の間隔（純粋関数・境界）", () => {
  it("既定は10分。10分未満は抑え、10分ちょうど以上で解禁", () => {
    const cooldownMs = 10 * 60_000;
    assert.equal(withinLlmUnavailableCooldown(1_000, 1_000 + cooldownMs - 1, cooldownMs), true);
    assert.equal(withinLlmUnavailableCooldown(1_000, 1_000 + cooldownMs, cooldownMs), false);
    assert.equal(withinLlmUnavailableCooldown(undefined, 1_000, cooldownMs), false, "履歴が無ければ抑えない");
  });
});
