/**
 * task-0035: 会話スレッド＝番頭の分身（ADR-0010 決定2）。
 *
 * `docs/vision.md` の「番頭は分身する。関心事ごとにインスタンスへ分かれて並行し…
 * 割り込みが PO の文脈を壊さない」の機構。見たいのは**並行しても混ざらないこと**で、
 * とくに決定2 の「キャンバスはスレッド1本につき1つ。既存の会話のキャンバスを上書きしない」。
 *
 * 実プロバイダは呼ばない。対話ループは偽物に差し替え、配信と帳簿の振る舞いを見る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Canvas,
  MAX_THREAD_TITLE_LENGTH,
  ThreadRegistry,
  createCanvasCatalog,
  createCanvasTools,
  createThreadTools,
  bindToolArgs,
  isBantoOrigin,
  threadIdOfOrigin,
  threadOrigin,
  type HostSession,
  type ServerEvent,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { defineNamespacedTool } from "@banto/core";
import { Type } from "typebox";

/** 対話ループの偽物。prompt は記録するだけで、イベントは emit で好きに起こす。 */
class FakeSession implements HostSession {
  readonly sessionId: string;
  isStreaming = false;
  prompts: string[] = [];
  disposed = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(id: string) {
    this.sessionId = id;
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

const catalog = createCanvasCatalog([
  {
    kind: "demo.hello",
    title: "ハロー",
    description: "テスト用",
    component: "DemoHello",
    parameters: { type: "object", properties: {} },
  },
  {
    kind: "demo.notes",
    title: "メモ",
    description: "テスト用",
    component: "DemoNotes",
    parameters: { type: "object", properties: {} },
  },
]);

let server: BantoHostServer | undefined;
let threads: ThreadRegistry;
/** 作られた順のスレッド部品。テストから中身を覗くため。 */
let made: Array<{ session: FakeSession; canvas: Canvas }>;

beforeEach(() => {
  made = [];
  threads = new ThreadRegistry(async (threadId) => {
    const session = new FakeSession(`session-of-${threadId}`);
    const canvas = new Canvas(catalog);
    made.push({ session, canvas });
    return {
      session,
      canvas,
      tools: [
        ...createCanvasTools(canvas, catalog),
        ...createThreadTools({ threads, threadId }),
      ],
    };
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  threads.dispose();
});

async function start(): Promise<string> {
  await threads.open(TRUNK);
  server = await BantoHostServer.start({ threads, port: 0, catalog });
  return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
}

/** 条件が満たされるまで待つ（イベントではなく副作用を見るとき）。 */
async function waitForValue(ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > timeoutMs) throw new Error("待っていたことが起きませんでした");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 指定の型のイベントが来るまで待つ。 */
function waitFor(
  events: ServerEvent[],
  match: (e: ServerEvent) => boolean,
  timeoutMs = 2000
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find(match);
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out. seen: ${events.map((e) => e.type).join(", ")}`));
      }
    }, 10);
  });
}

describe("[task-0088/a1] 幹はプロジェクトの単位で、畳めない（ADR-0017 決定77）", () => {
  it("[task-0088/a1] 幹は何本でも開ける（幹＝プロジェクト・PO裁定 2026-08-09）", async () => {
    const a = await threads.open({ kind: "trunk", title: "banto" });
    const b = await threads.open({ kind: "trunk", title: "自宅サーバ" });
    assert.deepEqual(threads.trunks().map((t) => t.title), ["banto", "自宅サーバ"]);
    // 既定の宛先は開いている先頭
    assert.equal(threads.defaultThreadId, a.id);
    assert.equal(b.isDefault, false);
  });

  it("[task-0088/a1] 枝は「いま居る会話の幹」に付く（隣の幹へ混ざらない）", async () => {
    const a = await threads.open({ kind: "trunk", title: "banto" });
    const b = await threads.open({ kind: "trunk", title: "自宅サーバ" });
    const onB = await threads.open(branchSpec("証明書が切れる"), b.id);

    assert.equal(onB.parentId, b.id);
    // 札が立つのは**その幹**だけ
    assert.deepEqual(
      b.transcript.filter((e) => e.role === "branch"),
      [{ role: "branch", branchId: onB.id }]
    );
    assert.deepEqual(a.transcript, []);
  });

  it("[task-0088/a1] 幹は畳めない。宛先は常に幹（会話のタブが要らない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝1"));
    trunk.record({ role: "po", text: "中身のある会話" });

    assert.equal(trunk.isDefault, true);
    assert.equal(branch.isDefault, false);
    assert.equal(threads.defaultThreadId, trunk.id);

    assert.throws(() => threads.merge(trunk.id, "畳む"), /幹は畳めません/u);
    // 枝を全部畳んでも宛先は幹のまま（＝空状態にならない）
    threads.merge(branch.id, "結論");
    assert.equal(threads.defaultThreadId, trunk.id);
    assert.equal(threads.resolve().id, trunk.id);

    // 畳んでも消えない（決定30c と同じ扱い）
    assert.deepEqual(threads.list({ state: "open" }).map((t) => t.id), [trunk.id]);
    assert.deepEqual(threads.list().map((t) => t.id), [trunk.id, branch.id]);
  });

  it("[task-0088/a1] 幹より先に枝は開けない（I2）", async () => {
    await assert.rejects(() => threads.open(branchSpec("枝")), /幹がありません/u);
  });

  it("[task-0088/a1] 開いた分だけ独立した対話ループができる", async () => {
    await threads.open(TRUNK);
    await threads.open(branchSpec("枝1"));
    await threads.open(branchSpec("枝2"));

    assert.equal(threads.list().length, 3);
    const ids = new Set(made.map((m) => m.session.sessionId));
    assert.equal(ids.size, 3, "枝ごとに別の対話ループが要る");
  });

  it("[task-0088/a1] 知らないIDを幹へ黙って落とさない（I2）", async () => {
    await threads.open(TRUNK);
    assert.throws(() => threads.resolve("thread-999"), /unknown thread/u);
    assert.throws(() => threads.merge("thread-999", "結論"), /unknown thread/u);
    // 省略は幹へ
    assert.equal(threads.resolve().kind, "trunk");
  });
});

describe("[PO報告 2026-08-10] 番頭は「いまどの会話に居るか」を渡される", () => {
  /**
   * **帳場を「banto 開発の幹」と取り違えていた。** 会話ごとに立場が違うのに、番頭へ渡る
   * ものが全会話で同じだったのが原因。器を作るときに素性を渡す。
   */
  it("帳場・幹・枝で、渡される素性が違う", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const registry = new ThreadRegistry(async (threadId, _resume, _model, identity) => {
      seen.push(identity as Record<string, unknown> | undefined);
      return { session: new FakeSession(`s-${threadId}`), tools: [] };
    });

    await registry.open({ kind: "trunk", main: true, title: "帳場" });
    const proj = await registry.open({ kind: "trunk", title: "loamium" });
    await registry.open(
      {
        kind: "branch",
        title: "エディタUI調査",
        returnCondition: "描画方式が決まったら",
        openedBy: "banto",
        reason: "往復が続く",
      },
      proj.id
    );

    assert.deepEqual(seen[0], {
      kind: "trunk",
      isMain: true,
      title: "帳場",
      trunkId: "thread-1",
    });
    assert.deepEqual(seen[1], {
      kind: "trunk",
      isMain: false,
      title: "loamium",
      trunkId: proj.id,
    });
    assert.deepEqual(seen[2], {
      kind: "branch",
      isMain: false,
      title: "エディタUI調査",
      returnCondition: "描画方式が決まったら",
      // **どの幹の枝か**まで渡す（親を知らないと、何の話の一部かが分からない）
      parentTitle: "loamium",
      // **記憶の区画は親の幹**（PO裁定 2026-08-10）。枝で調べたことは仕事に溜まる
      trunkId: proj.id,
    });
  });

  it("記憶の区画（trunkId）は、幹なら自分・枝なら親", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const registry = new ThreadRegistry(async (threadId, _resume, _model, identity) => {
      seen.push(identity as Record<string, unknown> | undefined);
      return { session: new FakeSession(`s-${threadId}`), tools: [] };
    });

    const trunk = await registry.open({ kind: "trunk", title: "banto 開発" });
    const a = await registry.open(
      { kind: "branch", title: "枝A", returnCondition: "x", openedBy: "banto", reason: "y" },
      trunk.id
    );
    const b = await registry.open(
      { kind: "branch", title: "枝B", returnCondition: "x", openedBy: "banto", reason: "y" },
      trunk.id
    );

    assert.equal(seen[0]?.["trunkId"], trunk.id);
    assert.equal(seen[1]?.["trunkId"], trunk.id, "枝は親の幹と同じ区画");
    assert.equal(seen[2]?.["trunkId"], trunk.id, "同じ幹の枝はどれも同じ区画");
    assert.equal(a.parentId, trunk.id);
    assert.equal(b.parentId, trunk.id);
  });

});

describe("[PO裁定 2026-08-10] 帳場（メインの幹）", () => {
  it("帳場は店にただ1つ。2つ目は作れない", async () => {
    await threads.open({ kind: "trunk", main: true, title: "帳場" });
    await assert.rejects(
      () => threads.open({ kind: "trunk", main: true }),
      /帳場は既にあります/u
    );
    // ふつうの幹は何本でも起こせる
    await threads.open({ kind: "trunk", title: "banto" });
    assert.equal(threads.trunks().length, 2);
  });

  it("宛先の決まらない知らせは帳場へ来る（たまたま先頭の幹へ流れ込まない）", async () => {
    // **先に別の幹**を起こしてから帳場を作る——順序に頼っていないことを見る
    const other = await threads.open({ kind: "trunk", title: "ひらがな学習アプリ構想" });
    const main = await threads.open({ kind: "trunk", main: true, title: "帳場" });

    assert.equal(threads.main()?.id, main.id);
    assert.equal(threads.resolve().id, main.id, "threadId 省略の宛先は帳場");
    assert.equal(threads.defaultThreadId, main.id);
    assert.equal(main.isMain, true);
    assert.equal(other.isMain, false);
  });

  it("帳場は終えない（宛先の行き先が消える）", async () => {
    const main = await threads.open({ kind: "trunk", main: true, title: "帳場" });
    assert.throws(() => threads.closeTrunk(main.id), /帳場は終えません/u);
    assert.equal(main.state, "open");
  });

  it("ふつうの幹は終えられる。開いている枝があれば止まる", async () => {
    await threads.open({ kind: "trunk", main: true, title: "帳場" });
    const proj = await threads.open({ kind: "trunk", title: "loamium" });
    const branch = await threads.open(branchSpec("エディタUI調査"), proj.id);

    assert.throws(() => threads.closeTrunk(proj.id), /開いている枝が 1 本/u);
    threads.merge(branch.id, "結論");
    threads.closeTrunk(proj.id);
    assert.equal(proj.state, "closed");
    // 帳場は残る（宛先は消えない）
    assert.equal(threads.defaultThreadId, threads.main()!.id);
  });
});

describe("[task-0088/a2] 枝は還す条件を持って生まれる（決定77）", () => {
  it("[task-0088/a2] 還す条件・理由・開いた人が枝に残る", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open({
      kind: "branch",
      title: "間欠的に落ちる試験",
      returnCondition: "再現条件が特定できたら",
      openedBy: "po",
      reason: "往復が続くので枝にする",
    });
    assert.equal(branch.kind, "branch");
    assert.equal(branch.returnCondition, "再現条件が特定できたら");
    assert.equal(branch.openedBy, "po");
    assert.equal(branch.openReason, "往復が続くので枝にする");
    assert.equal(branch.parentId, threads.trunk()!.id, "親は常に幹");
  });

  it("[task-0088/a2] 番頭の判断でも PO の指示でも開ける", async () => {
    await threads.open(TRUNK);
    const byBanto = await threads.open(branchSpec("番頭が開いた", "banto"));
    const byPo = await threads.open(branchSpec("POが指示した", "po"));
    assert.equal(byBanto.openedBy, "banto");
    assert.equal(byPo.openedBy, "po");
  });

  it("[task-0088/a2] 還す条件の無い枝は帳簿が拒む（型でも書けない・実行時も拒む）", async () => {
    await threads.open(TRUNK);
    // 型としては書けない形を、帳簿の側でも拒むことを見る（I4：any の理由はここ）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 型で塞いだ形が
    // 実行時にも塞がっていることを確かめるため、意図的に型を外す
    const bad = { kind: "branch", title: "条件なし", openedBy: "po", reason: "なんとなく" } as any;
    await assert.rejects(() => threads.open(bad), /還す条件/u);
  });
});

describe("[task-0088/a3] 枝を畳むと結論が幹へ還る（決定77）", () => {
  it("[task-0088/a3] 幹の末尾に結論が1行積まれ、既存の行は書き換わらない", async () => {
    const trunk = await threads.open(TRUNK);
    trunk.record({ role: "po", text: "最初の発話" });
    const branch = await threads.open(branchSpec("枝1"));
    const before = trunk.transcript.map((e) => JSON.stringify(e));

    threads.merge(branch.id, "inc-0048 を起票し task-0091 を積んだ");

    const after = trunk.transcript;
    assert.deepEqual(
      after.slice(0, before.length).map((e) => JSON.stringify(e)),
      before,
      "幹は追記のみ（D3）——既存の行は書き換わらない"
    );
    const last = after[after.length - 1];
    assert.equal(last?.role, "branch_result");
    if (last?.role === "branch_result") {
      assert.equal(last.branchId, branch.id);
      assert.equal(last.conclusion, "inc-0048 を起票し task-0091 を積んだ");
    }
  });

  it("[task-0088/a3] 保留も結論の一種。畳んで開き直せる", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝1"));
    threads.merge(branch.id, "保留：計測が足りない");
    assert.equal(branch.state, "closed");

    threads.reopen(branch.id);
    assert.equal(branch.state, "open");
    assert.equal(branch.conclusion, "保留：計測が足りない", "何を保留したかは残る");
    // 幹へ還した1行は消えない（追記のみ）
    const results = threads
      .trunk()!
      .transcript.filter((e) => e.role === "branch_result");
    assert.equal(results.length, 1);
  });

  it("[task-0088/a3] 空の結論では畳めない（I2）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝1"));
    assert.throws(() => threads.merge(branch.id, "   "), /結論は空にできません/u);
    assert.equal(branch.state, "open");
  });
});

describe("[task-0088/a4] 深さは1段（決定77）", () => {
  it("[task-0088/a4] 枝の中から枝は開けない", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝1"));
    await assert.rejects(
      () => threads.open(branchSpec("枝の中の枝"), branch.id),
      /枝の中に枝は開けません/u
    );
  });

  it("[task-0088/a4] 幹から開いた枝の親は必ず幹", async () => {
    const trunk = await threads.open(TRUNK);
    const a = await threads.open(branchSpec("枝1"), trunk.id);
    const b = await threads.open(branchSpec("枝2"));
    assert.equal(a.parentId, trunk.id);
    assert.equal(b.parentId, trunk.id);
  });
});

describe("[task-0088/a5] 埋没しない不変条件（決定77）", () => {
  it("[task-0088/a5] 開いている枝は全部、幹の札・横断の通知・レールの点のどれかに出ている", async () => {
    await threads.open(TRUNK);
    await threads.open(branchSpec("枝1"));
    await threads.open(branchSpec("枝2"));
    await threads.open(branchSpec("枝3"));

    // **全枝を走査する**——1本でも「どこにも出ていない」ものがあれば埋没している
    const seen = threads.branchVisibility();
    assert.equal(seen.length, 3);
    for (const b of seen) {
      assert.ok(b.visible, `枝 ${b.title} がどこにも出ていない`);
      assert.ok(b.trunkCard, `枝 ${b.title} の札が幹に無い（開いた1行が流れていない）`);
      assert.ok(b.rail, `枝 ${b.title} がレールの点に出ていない`);
    }
  });

  it("[task-0088/a5] 畳んだ枝は走査の対象から外れる（一覧が信用できなくなるため）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝1"));
    threads.merge(branch.id, "結論");
    assert.equal(threads.branchVisibility().length, 0);
  });

  it("[task-0088/a5] 黙って止まった枝は滞留として拾える（P6・ADR-0016）", async () => {
    await threads.open(TRUNK);
    const fresh = await threads.open(branchSpec("動いている"));
    const stale = await threads.open(branchSpec("止まっている"));
    stale.lastActivityAt = new Date(Date.now() - 6 * 86_400_000).toISOString();

    const found = threads.staleBranches();
    assert.deepEqual(found.map((s) => s.thread.id), [stale.id]);
    assert.ok(found[0]!.days >= 3, "何日止まっているかを数える（率ではなく実測・P6）");
    assert.ok(!found.some((s) => s.thread.id === fresh.id));
  });
});

describe("[task-0035/a2] キャンバスはスレッドごと（決定2）", () => {
  it("[task-0035/a2] 片方でGUIを開いても、もう片方のタブ構成は変わらない", async () => {
    await threads.open(TRUNK);
    await threads.open(branchSpec("枝1"));
    const [a, b] = made;

    a!.canvas.open("demo.hello");
    a!.canvas.open("demo.notes");

    assert.equal(a!.canvas.snapshot().tabs.length, 2);
    assert.equal(
      b!.canvas.snapshot().tabs.length,
      0,
      "既存の会話のキャンバスを上書きしない（「目の前の話は壊れない」）"
    );
  });

  it("[task-0035/a2] canvas_state はどのスレッドのものか判別できる", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      made[1]!.canvas.open("demo.hello");
      const event = await waitFor(
        events,
        (e) => e.type === "canvas_state" && e.threadId === second.id && e.tabs.length === 1
      );
      assert.equal(event.type === "canvas_state" && event.tabs[0]?.kind, "demo.hello");

      // 既定スレッドのキャンバスは空のまま
      const defaultStates = events.filter(
        (e) => e.type === "canvas_state" && e.threadId === threads.defaultThreadId
      );
      for (const e of defaultStates) {
        assert.equal(e.type === "canvas_state" && e.tabs.length, 0);
      }
    } finally {
      client.close();
    }
  });
});

describe("[task-0035/a3] イベントとメッセージがスレッドで分かれる", () => {
  it("[task-0035/a3] welcome にスレッド一覧と既定スレッドが載る", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("別の話"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      const welcome = await waitFor(events, (e) => e.type === "welcome");
      assert.equal(welcome.type, "welcome");
      if (welcome.type !== "welcome") return;

      assert.equal(welcome.defaultThreadId, threads.defaultThreadId);
      assert.deepEqual(
        welcome.threads.map((t) => t.threadId).sort(),
        [threads.defaultThreadId, second.id].sort()
      );
      assert.ok(welcome.threads.some((t) => t.title === "別の話"));
      // スレッドを知らないクライアントとの互換
      assert.equal(welcome.sessionId, `session-of-${threads.defaultThreadId}`);
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 接続時の履歴は見ている会話の分だけ（残りは頼んで取る）", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));
    threads.resolve().record({ role: "po", text: "こっちの話" });
    second.record({ role: "po", text: "あっちの話" });

    const events: ServerEvent[] = [];
    // 見ているのは second。全部まとめて配ると、会話が増えるほど接続が重くなる
    const client = await BantoHostClient.connect(url, (e) => events.push(e), second.id);
    try {
      await waitFor(events, (e) => e.type === "history" && e.threadId === second.id);
      const forSecond = events.find((e) => e.type === "history" && e.threadId === second.id);
      assert.deepEqual(forSecond?.type === "history" && forSecond.entries, [
        { role: "po", text: "あっちの話" },
      ]);
      assert.equal(
        events.filter((e) => e.type === "history").length,
        1,
        "見ていない会話の履歴は接続時に流さない"
      );

      // 移ったら頼んで取れる（1接続で複数タブを描けることは変わらない）
      client.send({ type: "history_request", threadId: threads.resolve().id });
      await waitFor(events, (e) => e.type === "history" && e.threadId === threads.resolve().id);
      const forFirst = events.find(
        (e) => e.type === "history" && e.threadId === threads.resolve().id
      );
      // 幹には枝の札も立っている（決定77）
      assert.deepEqual(forFirst?.type === "history" && forFirst.entries, [
        { role: "branch", branchId: second.id },
        { role: "po", text: "こっちの話" },
      ]);
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 一覧の要約はホストが載せる（履歴を配らずに履歴一覧が描ける）", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));
    second.record({ role: "po", text: "あっちの話\n2行目は出さない" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      await waitFor(events, (e) => e.type === "welcome");
      const welcome = events.find((e) => e.type === "welcome");
      const view =
        welcome?.type === "welcome"
          ? welcome.threads.find((t) => t.threadId === second.id)
          : undefined;
      assert.equal(view?.preview, "あっちの話");
      // 要約が載っているのだから、この会話の全文は接続時に要らない
      assert.equal(
        events.some((e) => e.type === "history" && e.threadId === second.id),
        false
      );
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 知らない会話の履歴を頼まれたら空で埋めずエラーを返す", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "history_request", threadId: "thread-none" });
      await waitFor(events, (e) => e.type === "error");
      // I2: 「発言なし」と誤って描かせない
      assert.equal(
        events.some((e) => e.type === "history" && e.threadId === "thread-none"),
        false
      );
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 発話は宛先スレッドにだけ入る", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "prompt", threadId: second.id, text: "あっちへ" });
      await waitFor(events, (e) => e.type === "turn_end" && e.threadId === second.id);

      assert.deepEqual(made[1]!.session.prompts, ["あっちへ"]);
      assert.deepEqual(made[0]!.session.prompts, [], "別のスレッドには入らない");
      // 幹に立つのは枝の札だけ。**枝の中身は幹に流さない**（決定77）
      assert.deepEqual(
        threads.resolve().transcript,
        [{ role: "branch", branchId: second.id }],
        "幹の履歴に枝の発話は流れない"
      );
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] threadId 省略は既定スレッド（スレッドを知らないクライアント）", async () => {
    const url = await start();
    await threads.open(branchSpec("枝1"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "prompt", text: "既定へ" });
      await waitFor(events, (e) => e.type === "turn_end");
      assert.deepEqual(made[0]!.session.prompts, ["既定へ"]);
      assert.deepEqual(made[1]!.session.prompts, []);
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 知らない threadId は黙って既定へ流さずエラーで返す（I2）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "prompt", threadId: "thread-999", text: "迷子" });
      const error = await waitFor(events, (e) => e.type === "error");
      assert.match(error.type === "error" ? error.message : "", /unknown thread/);
      assert.deepEqual(made[0]!.session.prompts, [], "別の会話に発話が紛れ込まない");
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 番頭の発話（text_delta）もスレッドが付く", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      made[1]!.session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "はい" },
      });
      const delta = await waitFor(events, (e) => e.type === "text_delta");
      assert.equal(delta.type === "text_delta" && delta.threadId, second.id);
      // 履歴も宛先スレッドにだけ積まれる
      assert.deepEqual(second.transcript, [{ role: "banto", text: "はい" }]);
      // 幹には枝の札しか立たない（枝の中身は幹に流さない・決定77）
    assert.deepEqual(threads.resolve().transcript, [{ role: "branch", branchId: second.id }]);
    } finally {
      client.close();
    }
  });
});

describe("[task-0035] スレッドの開閉（プロトコル）", () => {
  it("[task-0035] thread_open で増え、既存スレッドは何も変わらない", async () => {
    const url = await start();
    threads.resolve().record({ role: "po", text: "元の話" });
    made[0]!.canvas.open("demo.hello");

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({
        type: "thread_open",
        title: "新しい関心事",
        returnCondition: "方針が決まったら",
        reason: "往復が続く",
      });
      const state = await waitFor(events, (e) => e.type === "thread_state");
      assert.equal(state.type === "thread_state" && state.threads.length, 2);

      // 「目の前の話は壊れない」（決定2）
      // 幹には枝の札が1行増えるだけ。前の発話はそのまま（追記のみ・D3）
      assert.deepEqual(threads.resolve().transcript[0], { role: "po", text: "元の話" });
      assert.equal(threads.resolve().transcript.length, 2);
      assert.equal(made[0]!.canvas.snapshot().tabs.length, 1);
    } finally {
      client.close();
    }
  });

  it("[task-0058] thread_rename でPOも名前を付け直せる（決定25 の人側）", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("会話 2"));
    second.record({ role: "po", text: "元の話" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      // **見ている会話とは限らない**（POはタブを右クリックして選ぶ）
      client.send({ type: "thread_rename", threadId: second.id, title: "認証の設計" });
      const state = await waitFor(
        events,
        (e) =>
          e.type === "thread_state" &&
          e.threads.some((t) => t.threadId === second.id && t.title === "認証の設計")
      );
      assert.equal(state.type, "thread_state");
      assert.deepEqual(second.transcript, [{ role: "po", text: "元の話" }], "会話は変わらない");
    } finally {
      client.close();
    }
  });

  it("[task-0058] 空の題・未知のIDは黙って成功にしない（I2）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "thread_rename", threadId: "thread-999", title: "迷子" });
      await waitFor(events, (e) => e.type === "error" && /unknown thread/.test(e.message));

      client.send({ type: "thread_rename", threadId: threads.resolve().id, title: "  " });
      await waitFor(events, (e) => e.type === "error" && /empty/.test(e.message));
      assert.equal(threads.resolve().title, "幹");
    } finally {
      client.close();
    }
  });

  it("[task-0088/a2] 還す条件の無い thread_open は黙って通さない（I2）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 型で塞いだ形が
      // 配線の側でも塞がっていることを確かめるため、意図的に型を外す
      client.send({ type: "thread_open", title: "条件なし", reason: "なんとなく" } as any);
      await waitFor(events, (e) => e.type === "error" && /還す条件/.test(e.message));
      assert.equal(threads.list({ kind: "branch" }).length, 0, "条件の無い枝は生まれない");
    } finally {
      client.close();
    }
  });

  it("[task-0088/a3] thread_merge は枝を畳んで幹へ結論を還す。他の枝は触らない", async () => {
    const url = await start();
    const trunk = threads.resolve();
    trunk.record({ role: "po", text: "幹の話" });
    const branch = await threads.open(branchSpec("枝1"));
    const other = await threads.open(branchSpec("枝2"));
    other.record({ role: "po", text: "別件は残る" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "thread_merge", threadId: branch.id, conclusion: "決まった" });
      await waitFor(
        events,
        (e) => e.type === "branch_result" && e.branchId === branch.id
      );
      assert.equal(branch.state, "closed");
      assert.equal(other.state, "open");
      assert.deepEqual(other.transcript, [{ role: "po", text: "別件は残る" }]);
      // 幹は追記のみ。最初の発話は残っている
      assert.deepEqual(trunk.transcript[0], { role: "po", text: "幹の話" });
    } finally {
      client.close();
    }
  });
});

/**
 * **人が章を区切る口**（提案§3.2 の人側・決定25）。
 *
 * 自動で畳むのは文脈の量が閾値に達したときだけ。「この話は終わったので、ここから先は
 * 別の前提で進めたい」は量では拾えないので、人にも同じことができる口を持たせる。
 */
describe("[提案§3.2] chapter_close（人が章を区切る）", () => {
  it("章立てが働いている会話では、押すと畳まれる", async () => {
    const folded: string[] = [];
    threads = new ThreadRegistry(async (threadId) => {
      const session = new FakeSession(`session-of-${threadId}`);
      return {
        session,
        tools: [],
        closeChapter: async () => void folded.push(threadId),
      };
    });
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      const trunk = threads.resolve();
      client.send({ type: "chapter_close", threadId: trunk.id });
      await waitForValue(() => folded.length > 0);
      assert.deepEqual(folded, [trunk.id]);
      assert.equal(
        events.find((e) => e.type === "error"),
        undefined,
        "畳めたのにエラーを出してはいけない"
      );
    } finally {
      client.close();
    }
  });

  it("章立てが働いていない会話では、理由を言って断る（I2）", async () => {
    // 既定の器（beforeEach）は closeChapter を渡していない＝要約に使えるモデルが無い構成
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "chapter_close", threadId: threads.resolve().id });
      const err = await waitFor(events, (e) => e.type === "error");
      assert.match(
        err.type === "error" ? err.message : "",
        /章立てが働いていません/,
        "押したのに何も起きない、が一番困る"
      );
    } finally {
      client.close();
    }
  });

  it("喋っている最中は断る（道具の途中で文脈を消さない）", async () => {
    const folded: string[] = [];
    let made: FakeSession | undefined;
    threads = new ThreadRegistry(async (threadId) => {
      const session = new FakeSession(`session-of-${threadId}`);
      made = session;
      return { session, tools: [], closeChapter: async () => void folded.push(threadId) };
    });
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      made!.isStreaming = true;
      client.send({ type: "chapter_close", threadId: threads.resolve().id });
      const err = await waitFor(events, (e) => e.type === "error");
      assert.match(err.type === "error" ? err.message : "", /喋っている最中/);
      assert.deepEqual(folded, [], "ターンの最中に畳んではいけない");
    } finally {
      client.close();
    }
  });

  it("畳んだ会話では断る", async () => {
    const folded: string[] = [];
    threads = new ThreadRegistry(async (threadId) => ({
      session: new FakeSession(`session-of-${threadId}`),
      tools: [],
      closeChapter: async () => void folded.push(threadId),
    }));
    const url = await start();
    const branch = await threads.open(branchSpec("枝"));
    threads.merge(branch.id, "決まった");

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "chapter_close", threadId: branch.id });
      const err = await waitFor(events, (e) => e.type === "error");
      assert.match(err.type === "error" ? err.message : "", /畳んだ会話/);
      assert.deepEqual(folded, []);
    } finally {
      client.close();
    }
  });

  it("畳めなかった理由をそのまま出す（資料が書けなければ畳まない）", async () => {
    threads = new ThreadRegistry(async (threadId) => ({
      session: new FakeSession(`session-of-${threadId}`),
      tools: [],
      closeChapter: async () => {
        throw new Error("章の引き継ぎ資料が空で返りました");
      },
    }));
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "chapter_close", threadId: threads.resolve().id });
      const err = await waitFor(events, (e) => e.type === "error");
      assert.match(err.type === "error" ? err.message : "", /資料が空で返りました/);
    } finally {
      client.close();
    }
  });
});

describe("[task-0035/a4] 番頭自身が分身する口", () => {
  it("[task-0035/a4] thread.open で新しいスレッドが増える", async () => {
    const first = await threads.open(TRUNK);
    const tools = createThreadTools({ threads, threadId: first.id });
    const open = tools.find((t) => t.name === "thread.open")!;

    const result = await open.execute({
      title: "調査",
      returnCondition: "分かったら",
      reason: "往復が続く",
    });
    assert.equal(threads.list().length, 2);
    const opened = threads.list()[1]!;
    assert.equal(opened.title, "調査");
    assert.equal(opened.kind, "branch");
    assert.equal(opened.openedBy, "banto", "番頭の判断で開いた枝");
    assert.match(
      result.content.map((c) => c.text).join(""),
      new RegExp(opened.id),
      "番頭が以後この分身を指せるよう threadId を返す"
    );
  });

  it("[task-0035/a4] message を渡すと新しい分身に最初の一言が届く", async () => {
    const first = await threads.open(TRUNK);
    const seeded: Array<{ threadId: string; message: string }> = [];
    const tools = createThreadTools({
      threads,
      threadId: first.id,
      seed: async (threadId, message) => {
        seeded.push({ threadId, message });
      },
    });
    const open = tools.find((t) => t.name === "thread.open")!;

    await open.execute({
      title: "調査",
      returnCondition: "分かったら",
      reason: "往復が続く",
      message: "この件を調べて",
    });
    const opened = threads.list()[1]!;
    assert.deepEqual(seeded, [{ threadId: opened.id, message: "この件を調べて" }]);
  });

  it("[task-0035/a4] thread.list で並行している会話が分かる", async () => {
    const first = await threads.open(TRUNK);
    await threads.open(branchSpec("別件"));
    const tools = createThreadTools({ threads, threadId: first.id });
    const list = tools.find((t) => t.name === "thread.list")!;

    const text = (await list.execute({})).content.map((c) => c.text).join("");
    assert.match(text, /別件/);
    assert.equal((text.match(/threadId:/g) ?? []).length, 2);
  });

  it("[task-0058] thread.list で「どれが自分か」が分かる（自分の名前を見て付け直せる）", async () => {
    await threads.open(TRUNK);
    const second = await threads.open(branchSpec("別件"));
    const tools = createThreadTools({ threads, threadId: second.id });
    const list = tools.find((t) => t.name === "thread.list")!;

    const lines = (await list.execute({})).content
      .map((c) => c.text)
      .join("")
      .split("\n");
    assert.match(lines.find((l) => l.includes(second.id))!, /いまのこの会話/);
    assert.doesNotMatch(lines.find((l) => l.startsWith("幹"))!, /いまのこの会話/);
  });
});

describe("[task-0058] 番頭が会話に名前を付け直す（PO要望 2026-08-05）", () => {
  it("[task-0058] thread.rename で名前が変わり、購読者へ流れる", async () => {
    const thread = await threads.open(TRUNK);
    const seen: string[][] = [];
    threads.subscribe((list) => seen.push(list.map((t) => t.title)));
    const rename = createThreadTools({ threads, threadId: thread.id }).find(
      (t) => t.name === "thread.rename"
    )!;

    const result = await rename.execute({ title: "認証の設計" });

    assert.equal(thread.title, "認証の設計");
    assert.deepEqual(seen, [["認証の設計"]], "画面へ配るために帳簿が知らせる");
    assert.match(result.content.map((c) => c.text).join(""), /認証の設計/);
  });

  it("[task-0058] 名前を変えても会話とキャンバスは何も変わらない（決定2）", async () => {
    const thread = await threads.open(TRUNK);
    thread.record({ role: "po", text: "認証の話" });
    made[0]!.canvas.open("demo.hello");

    threads.rename(thread.id, "認証の設計");

    assert.equal(thread.transcript.length, 1);
    assert.equal(made[0]!.canvas.snapshot().tabs.length, 1);
    assert.equal(made[0]!.session.prompts.length, 0, "名付けでターンは回らない");
  });

  it("[task-0058] 隣の会話の名前は変えられない（決定35a：宛先は自分に固定）", async () => {
    const mine = await threads.open(TRUNK);
    const other = await threads.open(branchSpec("別件"));
    const rename = createThreadTools({ threads, threadId: mine.id }).find(
      (t) => t.name === "thread.rename"
    )!;

    // 番頭が threadId を書こうとしても、宛先は自分の会話のまま
    await rename.execute({ title: "横取り", threadId: other.id } as { title: string });

    assert.equal(mine.title, "横取り");
    assert.equal(other.title, "別件");
  });

  it("[task-0058] 畳んだ枝も名前を付け直せる（履歴こそ名前で探す）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("調査"));
    branch.record({ role: "po", text: "終わった調査の話" });
    threads.merge(branch.id, "結論");

    threads.rename(branch.id, "終わった調査");

    assert.equal(branch.title, "終わった調査");
    assert.equal(branch.state, "closed");
  });

  it("[task-0058] 空の名前と知らないIDはエラーにする（I2）", async () => {
    const thread = await threads.open(TRUNK);
    assert.throws(() => threads.rename(thread.id, "   "), /empty/);
    assert.throws(() => threads.rename("thread-999", "迷子"), /unknown thread/);
    assert.equal(thread.title, "幹", "失敗しても名前は元のまま");
  });

  it("[task-0058] 長すぎる名前と改行は整えて受ける（タブは1行しかない）", async () => {
    const thread = await threads.open(TRUNK);
    threads.rename(thread.id, `  認証の\n設計  `);
    assert.equal(thread.title, "認証の 設計");

    threads.rename(thread.id, "あ".repeat(MAX_THREAD_TITLE_LENGTH + 10));
    assert.equal(thread.title.length, MAX_THREAD_TITLE_LENGTH);
  });

  it("[task-0058] 同じ名前を付け直しても、画面へは知らせない（無駄な再描画を起こさない）", async () => {
    await threads.open(TRUNK);
    const thread = await threads.open(branchSpec("認証の設計"));
    let emitted = 0;
    threads.subscribe(() => emitted++);

    threads.rename(thread.id, "認証の設計");

    assert.equal(emitted, 0);
  });
});

describe("[task-0035/a7] 知らせの宛先（決定35a）", () => {
  it("[task-0035/a7] notify はスレッドを指定でき、そのスレッドにだけ入る", async () => {
    await start();
    const second = await threads.open(branchSpec("枝1"));

    await server!.notify("職人からの報告", { threadId: second.id, source: "worker" });

    assert.deepEqual(made[1]!.session.prompts, ["職人からの報告"], "宛先のターンが回る");
    assert.deepEqual(made[0]!.session.prompts, [], "別のスレッドには届かない");
    assert.deepEqual(second.transcript.slice(0, 1), [
      { role: "notice", source: "worker", text: "職人からの報告" },
    ]);
    // 幹には枝の札しか立たない（枝の中身は幹に流さない・決定77）
    assert.deepEqual(threads.resolve().transcript, [{ role: "branch", branchId: second.id }]);
  });

  it("[task-0035/a7] 宛先不明の知らせを黙って捨てない（I2）", async () => {
    await start();
    await assert.rejects(
      () => server!.notify("迷子の報告", { threadId: "thread-999" }),
      /unknown thread/
    );
  });

  it("[task-0035/a7] threadId 省略時は既定スレッドへ（起動元との互換）", async () => {
    await start();
    await threads.open(branchSpec("枝1"));
    await server!.notify("宛先なしの報告");
    assert.deepEqual(made[0]!.session.prompts, ["宛先なしの報告"]);
    assert.deepEqual(made[1]!.session.prompts, []);
  });
});

/**
 * [task-0059] 「何も無いまま閉じた会話は捨てる」は**役目を終えた**（ADR-0017 決定77）。
 *
 * 枝は生まれた瞬間に幹へ札が立ち、畳むには結論が要る——**空の器が履歴に並ぶ経路が無い**。
 * 捨てる機構を残すと、幹の札だけが宙に浮いた行として残ることになる（幹は追記のみ・D3）。
 */

describe("[task-0088/a3] 畳んだ枝は履歴に残り、再開できる", () => {
  it("[task-0037] 畳んでも会話とキャンバスは消えない", async () => {
    await threads.open(TRUNK);
    const second = await threads.open(branchSpec("調査"));
    second.record({ role: "po", text: "調べて" });
    made[1]!.canvas.open("demo.hello");

    threads.merge(second.id, "結論");

    assert.equal(second.state, "closed");
    assert.ok(second.closedAt, "畳んだ時刻が残る");
    assert.deepEqual(second.transcript, [{ role: "po", text: "調べて" }], "会話は読める");
    assert.equal(made[1]!.canvas.snapshot().tabs.length, 1, "キャンバスもそのまま");
  });

  it("[task-0037] 再開すると同じ会話の続きから話せる", async () => {
    await threads.open(TRUNK);
    const second = await threads.open(branchSpec("枝1"));
    second.record({ role: "po", text: "前の話" });
    threads.merge(second.id, "結論");

    const reopened = threads.reopen(second.id);
    assert.equal(reopened.id, second.id, "新しいスレッドを作らない");
    assert.equal(reopened.state, "open");
    assert.equal(reopened.closedAt, undefined);
    assert.deepEqual(reopened.transcript, [{ role: "po", text: "前の話" }]);
  });

  it("[task-0037] 畳むのは冪等。未知のIDはエラー（I2）", async () => {
    await threads.open(TRUNK);
    const second = await threads.open(branchSpec("枝1"));
    // 中身がある会話で見る（空だと畳まずに捨てるので、閉じたままかを見られない＝task-0059）
    second.record({ role: "po", text: "中身のある会話" });
    threads.merge(second.id, "結論");
    threads.merge(second.id, "結論"); // 2度目も落ちない
    assert.equal(second.state, "closed");
    assert.throws(() => threads.reopen("thread-999"), /unknown thread/);
  });

  it("[task-0037] 畳んだスレッドにも知らせは届く（決定35b の足場）", async () => {
    await start();
    const second = await threads.open(branchSpec("枝1"));
    second.record({ role: "po", text: "中身のある会話" });
    threads.merge(second.id, "結論");

    await server!.notify("職人からの報告", { threadId: second.id, source: "worker" });
    assert.deepEqual(made[1]!.session.prompts, ["職人からの報告"]);
  });

  it("[task-0088/a3] thread_merge / thread_reopen がプロトコルから使える", async () => {
    const url = await start();
    const second = await threads.open(branchSpec("枝1"));
    second.record({ role: "po", text: "中身のある会話" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "thread_merge", threadId: second.id, conclusion: "結論" });
      await waitFor(
        events,
        (e) =>
          e.type === "thread_state" &&
          e.threads.some((t) => t.threadId === second.id && t.state === "closed")
      );

      client.send({ type: "thread_reopen", threadId: second.id });
      await waitFor(
        events,
        (e) =>
          e.type === "thread_state" &&
          e.threads.some((t) => t.threadId === second.id && t.state === "open")
      );
    } finally {
      client.close();
    }
  });
});

describe("[task-0035/a6] 職人の起動元をスレッド粒度にする（決定35a）", () => {
  it("[task-0035/a6] 起動元名からスレッドを引ける", () => {
    assert.equal(threadOrigin("thread-7"), "banto:thread-7");
    assert.equal(threadIdOfOrigin("banto:thread-7"), "thread-7");
    // スレッド以前の名乗りは既定スレッド宛（過去の職人の報告を宛先不明で消さない）
    assert.equal(threadIdOfOrigin("banto"), undefined);
  });

  it("[task-0035/a6] 番頭が起こした職人だけを拾う（Kobo の分は会話に入れない）", () => {
    assert.equal(isBantoOrigin("banto"), true);
    assert.equal(isBantoOrigin("banto:thread-1"), true);
    assert.equal(isBantoOrigin("kobo"), false);
    // 前置きが似ているだけの別名を取り違えない
    assert.equal(isBantoOrigin("bantoish"), false);
  });

  it("[task-0035/a6] 番頭に自分の threadId を書かせない（固定して渡す）", async () => {
    await threads.open(TRUNK);
    const calls: Array<Record<string, unknown>> = [];
    const delegate = defineNamespacedTool({
      name: "worker.delegate",
      label: "Worker: Delegate",
      description: "偽",
      parameters: Type.Object({ origin: Type.Optional(Type.String()) }),
      async execute(args) {
        calls.push(args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    });

    const bound = bindToolArgs(delegate, { origin: threadOrigin("thread-1") });
    // 番頭が別スレッド宛を指定してきても上書きされない——報告が知らない会話に現れる
    await bound.execute({ origin: "banto:thread-999" });
    assert.deepEqual(calls, [{ origin: "banto:thread-1" }]);
  });
});

describe("[task-0035/a5] 記憶はスレッドを越えて共有される（D11）", () => {
  it("[task-0035/a5] スレッドの器は記憶を持たない", () => {
    // D11「番頭は記憶を持つ」はスレッド単位ではなく番頭単位。スレッドごとに記憶を作ると
    // 番頭が分裂する——器（Thread）に記憶を持たせないことが、そのままこの保証になる
    const thread = threads as unknown as Record<string, unknown>;
    assert.equal("memory" in thread, false);
  });
});
