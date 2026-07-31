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
        ...createThreadTools({ threads }),
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
  await threads.open();
  server = await BantoHostServer.start({ threads, port: 0, catalog });
  return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
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

describe("[task-0035/a1] 複数のスレッドが並行する", () => {
  it("[task-0035/a1] 開いた分だけ独立した対話ループができる", async () => {
    await threads.open();
    await threads.open();
    await threads.open();

    assert.equal(threads.list().length, 3);
    const ids = new Set(made.map((m) => m.session.sessionId));
    assert.equal(ids.size, 3, "スレッドごとに別の対話ループが要る");
  });

  it("[task-0035/a1] 最初の1本が既定スレッドで、閉じられない", async () => {
    const first = await threads.open();
    const second = await threads.open();

    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);
    assert.equal(threads.defaultThreadId, first.id);
    // 宛先が無くなると、スレッドを知らないクライアントが話せなくなる
    assert.throws(() => threads.close(first.id), /default thread cannot be closed/);
    threads.close(second.id);
    // 畳んでも消えない（決定30c と同じ扱い）。開いている分だけ見たいなら state で絞る
    assert.deepEqual(threads.list({ state: "open" }).map((t) => t.id), [first.id]);
    assert.deepEqual(threads.list().map((t) => t.id), [first.id, second.id]);
  });

  it("[task-0035/a1] 知らないIDを既定へ黙って落とさない（I2）", async () => {
    await threads.open();
    assert.throws(() => threads.resolve("thread-999"), /unknown thread/);
    assert.throws(() => threads.close("thread-999"), /unknown thread/);
    // 省略は既定へ
    assert.equal(threads.resolve().isDefault, true);
  });
});

describe("[task-0035/a2] キャンバスはスレッドごと（決定2）", () => {
  it("[task-0035/a2] 片方でGUIを開いても、もう片方のタブ構成は変わらない", async () => {
    await threads.open();
    await threads.open();
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
    const second = await threads.open();

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
    const second = await threads.open("別の話");

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

  it("[task-0035/a3] 接続時に全スレッドの履歴が届く（1接続で複数タブを描ける）", async () => {
    const url = await start();
    const second = await threads.open();
    threads.resolve().record({ role: "po", text: "こっちの話" });
    second.record({ role: "po", text: "あっちの話" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      await waitFor(events, (e) => e.type === "history" && e.threadId === second.id);
      const histories = events.filter((e) => e.type === "history");
      assert.equal(histories.length, 2, "スレッドごとに1通ずつ");

      const forSecond = histories.find((e) => e.type === "history" && e.threadId === second.id);
      assert.deepEqual(forSecond?.type === "history" && forSecond.entries, [
        { role: "po", text: "あっちの話" },
      ]);
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] 発話は宛先スレッドにだけ入る", async () => {
    const url = await start();
    const second = await threads.open();

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "prompt", threadId: second.id, text: "あっちへ" });
      await waitFor(events, (e) => e.type === "turn_end" && e.threadId === second.id);

      assert.deepEqual(made[1]!.session.prompts, ["あっちへ"]);
      assert.deepEqual(made[0]!.session.prompts, [], "別のスレッドには入らない");
      assert.deepEqual(threads.resolve().transcript, [], "既定スレッドの履歴も汚れない");
    } finally {
      client.close();
    }
  });

  it("[task-0035/a3] threadId 省略は既定スレッド（スレッドを知らないクライアント）", async () => {
    const url = await start();
    await threads.open();

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
    const second = await threads.open();

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
      assert.deepEqual(threads.resolve().transcript, []);
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
      client.send({ type: "thread_open", title: "新しい関心事" });
      const state = await waitFor(events, (e) => e.type === "thread_state");
      assert.equal(state.type === "thread_state" && state.threads.length, 2);

      // 「目の前の話は壊れない」（決定2）
      assert.deepEqual(threads.resolve().transcript, [{ role: "po", text: "元の話" }]);
      assert.equal(made[0]!.canvas.snapshot().tabs.length, 1);
    } finally {
      client.close();
    }
  });

  it("[task-0035] new_session はそのスレッドの会話だけを捨てる（P3：意味を変えない）", async () => {
    const url = await start();
    const second = await threads.open();
    threads.resolve().record({ role: "po", text: "残る" });
    second.record({ role: "po", text: "消える" });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "new_session", threadId: second.id });
      await waitFor(
        events,
        (e) => e.type === "history" && e.threadId === second.id && e.entries.length === 0
      );
      assert.deepEqual(second.transcript, []);
      assert.deepEqual(
        threads.resolve().transcript,
        [{ role: "po", text: "残る" }],
        "他のスレッドは触らない"
      );
    } finally {
      client.close();
    }
  });

  it("[task-0035] 既定スレッドを閉じようとしたらエラーで返す（I2）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "thread_close", threadId: threads.defaultThreadId });
      const error = await waitFor(events, (e) => e.type === "error");
      assert.match(error.type === "error" ? error.message : "", /default thread cannot be closed/);
      assert.equal(threads.list().length, 1);
    } finally {
      client.close();
    }
  });
});

describe("[task-0035/a4] 番頭自身が分身する口", () => {
  it("[task-0035/a4] thread.open で新しいスレッドが増える", async () => {
    await threads.open();
    const tools = createThreadTools({ threads });
    const open = tools.find((t) => t.name === "thread.open")!;

    const result = await open.execute({ title: "調査" });
    assert.equal(threads.list().length, 2);
    const opened = threads.list()[1]!;
    assert.equal(opened.title, "調査");
    assert.match(
      result.content.map((c) => c.text).join(""),
      new RegExp(opened.id),
      "番頭が以後この分身を指せるよう threadId を返す"
    );
  });

  it("[task-0035/a4] message を渡すと新しい分身に最初の一言が届く", async () => {
    await threads.open();
    const seeded: Array<{ threadId: string; message: string }> = [];
    const tools = createThreadTools({
      threads,
      seed: async (threadId, message) => {
        seeded.push({ threadId, message });
      },
    });
    const open = tools.find((t) => t.name === "thread.open")!;

    await open.execute({ title: "調査", message: "この件を調べて" });
    const opened = threads.list()[1]!;
    assert.deepEqual(seeded, [{ threadId: opened.id, message: "この件を調べて" }]);
  });

  it("[task-0035/a4] thread.list で並行している会話が分かる", async () => {
    await threads.open();
    await threads.open("別件");
    const tools = createThreadTools({ threads });
    const list = tools.find((t) => t.name === "thread.list")!;

    const text = (await list.execute({})).content.map((c) => c.text).join("");
    assert.match(text, /別件/);
    assert.equal((text.match(/threadId:/g) ?? []).length, 2);
  });
});

describe("[task-0035/a7] 知らせの宛先（決定35a）", () => {
  it("[task-0035/a7] notify はスレッドを指定でき、そのスレッドにだけ入る", async () => {
    await start();
    const second = await threads.open();

    await server!.notify("職人からの報告", second.id);

    assert.deepEqual(made[1]!.session.prompts, ["職人からの報告"], "宛先のターンが回る");
    assert.deepEqual(made[0]!.session.prompts, [], "別のスレッドには届かない");
    assert.deepEqual(second.transcript.slice(0, 1), [
      { role: "notice", text: "職人からの報告" },
    ]);
    assert.deepEqual(threads.resolve().transcript, []);
  });

  it("[task-0035/a7] 宛先不明の知らせを黙って捨てない（I2）", async () => {
    await start();
    await assert.rejects(() => server!.notify("迷子の報告", "thread-999"), /unknown thread/);
  });

  it("[task-0035/a7] threadId 省略時は既定スレッドへ（起動元との互換）", async () => {
    await start();
    await threads.open();
    await server!.notify("宛先なしの報告");
    assert.deepEqual(made[0]!.session.prompts, ["宛先なしの報告"]);
    assert.deepEqual(made[1]!.session.prompts, []);
  });
});

describe("[task-0037] 畳んだ分身は履歴に残り、再開できる", () => {
  it("[task-0037] 畳んでも会話とキャンバスは消えない", async () => {
    await threads.open();
    const second = await threads.open("調査");
    second.record({ role: "po", text: "調べて" });
    made[1]!.canvas.open("demo.hello");

    threads.close(second.id);

    assert.equal(second.state, "closed");
    assert.ok(second.closedAt, "畳んだ時刻が残る");
    assert.deepEqual(second.transcript, [{ role: "po", text: "調べて" }], "会話は読める");
    assert.equal(made[1]!.canvas.snapshot().tabs.length, 1, "キャンバスもそのまま");
  });

  it("[task-0037] 再開すると同じ会話の続きから話せる", async () => {
    await threads.open();
    const second = await threads.open();
    second.record({ role: "po", text: "前の話" });
    threads.close(second.id);

    const reopened = threads.reopen(second.id);
    assert.equal(reopened.id, second.id, "新しいスレッドを作らない");
    assert.equal(reopened.state, "open");
    assert.equal(reopened.closedAt, undefined);
    assert.deepEqual(reopened.transcript, [{ role: "po", text: "前の話" }]);
  });

  it("[task-0037] 畳むのは冪等。未知のIDはエラー（I2）", async () => {
    await threads.open();
    const second = await threads.open();
    threads.close(second.id);
    threads.close(second.id); // 2度目も落ちない
    assert.equal(second.state, "closed");
    assert.throws(() => threads.reopen("thread-999"), /unknown thread/);
  });

  it("[task-0037] 畳んだスレッドにも知らせは届く（決定35b の足場）", async () => {
    await start();
    const second = await threads.open();
    threads.close(second.id);

    await server!.notify("職人からの報告", second.id);
    assert.deepEqual(made[1]!.session.prompts, ["職人からの報告"]);
  });

  it("[task-0037] thread_close / thread_reopen がプロトコルから使える", async () => {
    const url = await start();
    const second = await threads.open();

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    try {
      client.send({ type: "thread_close", threadId: second.id });
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
    await threads.open();
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
