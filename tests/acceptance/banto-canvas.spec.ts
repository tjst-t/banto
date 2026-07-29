/**
 * task-0012: キャンバス機構・GUIカタログ・canvas.* Tool。
 * ADR-0010 決定5・12・13・17・20。
 *
 * UIもKoboも無しで検証する（受け入れ条件 a5）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";

import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Canvas,
  createCanvasCatalog,
  createCanvasTools,
  type CanvasCatalog,
  type CanvasViewSpec,
  type HostSession,
  type ServerEvent,
} from "@banto/host";

const HELLO: CanvasViewSpec = {
  kind: "demo.hello",
  title: "デモ",
  description: "テスト用の最小GUI。渡したパラメータをそのまま表示する。",
  parameters: Type.Object({ message: Type.Optional(Type.String()) }),
  component: "DemoHello",
  category: "demo",
  icon: "🧪",
};

const NOTES: CanvasViewSpec = {
  kind: "demo.notes",
  title: "メモ",
  description: "テスト用の2つ目のGUI。",
  parameters: Type.Object({}),
  component: "DemoNotes",
};

/** ToolDefinition.execute の第5引数は本Tool群が参照しないためスタブ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由 (I4)
const TOOL_CTX = {} as any;

function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  return result.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

let catalog: CanvasCatalog;
let canvas: Canvas;

beforeEach(() => {
  catalog = createCanvasCatalog([HELLO, NOTES]);
  canvas = new Canvas(catalog);
});

describe("[task-0012/a1] GUIカタログ（決定17の形）", () => {
  it("[task-0012/a1] エントリはTool契約＋キャンバス固有フィールドを持つ", () => {
    const spec = catalog.get("demo.hello");
    assert.ok(spec);
    // Tool契約側
    assert.equal(spec!.kind, "demo.hello");
    assert.ok(spec!.description.length > 0);
    assert.ok(spec!.parameters);
    // キャンバス固有側（決定17）
    assert.equal(spec!.component, "DemoHello");
    assert.equal(spec!.category, "demo");
    assert.equal(spec!.icon, "🧪");
  });

  it("[task-0012/a1] 一覧できる", () => {
    assert.deepEqual(catalog.list().map((s) => s.kind), ["demo.hello", "demo.notes"]);
  });

  it("[task-0012/a1] kind の重複登録は例外（I2）", () => {
    assert.throws(() => catalog.register(HELLO), /already registered/);
  });

  it("[task-0012/a1] kind は Tool と同じ名前空間規則に従う", () => {
    for (const spec of catalog.list()) {
      assert.match(spec.kind, /^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$/);
    }
  });
});

describe("[task-0012] キャンバスの表示状態", () => {
  it("[task-0012] 初期状態は空", () => {
    assert.deepEqual(canvas.snapshot(), { tabs: [], activeTabId: undefined });
  });

  it("[task-0012] open するとタブが増えてアクティブになる", () => {
    const tab = canvas.open("demo.hello", { message: "やあ" });
    const snapshot = canvas.snapshot();

    assert.equal(snapshot.tabs.length, 1);
    assert.equal(snapshot.activeTabId, tab.id);
    assert.equal(snapshot.tabs[0]!.kind, "demo.hello");
    assert.deepEqual(snapshot.tabs[0]!.params, { message: "やあ" });
  });

  it("[task-0012] タイトルは省略時カタログの既定、指定すれば上書き", () => {
    canvas.open("demo.hello");
    canvas.open("demo.hello", {}, "別名");
    assert.deepEqual(canvas.snapshot().tabs.map((t) => t.title), ["デモ", "別名"]);
  });

  it("[task-0012/a3] カタログに無い kind は黙って無視せず例外（決定20・I2）", () => {
    assert.throws(() => canvas.open("demo.nonexistent"), /Unknown canvas view "demo.nonexistent"/);
    assert.throws(() => canvas.open("demo.nonexistent"), /demo\.hello/, "利用可能な種別を添える");
    assert.deepEqual(canvas.snapshot().tabs, [], "失敗時に状態を変えない");
  });

  it("[task-0012] switch で表示中タブが変わる", () => {
    const first = canvas.open("demo.hello");
    canvas.open("demo.notes");
    canvas.switchTo(first.id);
    assert.equal(canvas.snapshot().activeTabId, first.id);
  });

  it("[task-0012] close でタブが消え、アクティブは直前へ移る", () => {
    const first = canvas.open("demo.hello");
    const second = canvas.open("demo.notes");
    canvas.close(second.id);

    const snapshot = canvas.snapshot();
    assert.deepEqual(snapshot.tabs.map((t) => t.id), [first.id]);
    assert.equal(snapshot.activeTabId, first.id);
  });

  it("[task-0012] 最後の1枚を閉じると空になる", () => {
    const tab = canvas.open("demo.hello");
    canvas.close(tab.id);
    assert.deepEqual(canvas.snapshot(), { tabs: [], activeTabId: undefined });
  });

  it("[task-0012] 未知のタブIDへの close / switch は例外（I2）", () => {
    assert.throws(() => canvas.close("no-such-tab"), /Unknown canvas tab/);
    assert.throws(() => canvas.switchTo("no-such-tab"), /Unknown canvas tab/);
  });

  it("[task-0012] snapshot は内部状態のコピーを返す（外から壊せない）", () => {
    canvas.open("demo.hello");
    const snapshot = canvas.snapshot();
    snapshot.tabs[0]!.title = "書き換え";
    assert.equal(canvas.snapshot().tabs[0]!.title, "デモ");
  });

  it("[task-0012] subscribe で状態変化が通知され、解除できる", () => {
    const seen: number[] = [];
    const unsubscribe = canvas.subscribe((s) => seen.push(s.tabs.length));

    canvas.open("demo.hello");
    canvas.open("demo.notes");
    unsubscribe();
    canvas.open("demo.hello");

    assert.deepEqual(seen, [1, 2]);
  });
});

describe("[task-0012/a2] canvas.* Tool", () => {
  it("[task-0012/a2] 名前空間規則に従う5つのToolを提供する", () => {
    const names = createCanvasTools(canvas, catalog).map((t) => t.name);
    assert.deepEqual(names, [
      "canvas.list_catalog",
      "canvas.open",
      "canvas.close",
      "canvas.switch",
      "canvas.query_state",
    ]);
  });

  it("[task-0012/a2] canvas.list_catalog が開けるGUIを返す", async () => {
    const [listCatalog] = createCanvasTools(canvas, catalog);
    const out = await listCatalog!.execute("c1", {}, undefined, undefined, TOOL_CTX);

    assert.match(textOf(out), /demo\.hello/);
    assert.match(textOf(out), /demo\.notes/);
  });

  it("[task-0012/a2] canvas.open がタブを開く", async () => {
    const [, open] = createCanvasTools(canvas, catalog);
    const out = await open!.execute(
      "c1",
      { kind: "demo.hello", params: { message: "やあ" } },
      undefined,
      undefined,
      TOOL_CTX
    );

    assert.match(textOf(out), /opened demo\.hello/);
    assert.equal(canvas.snapshot().tabs.length, 1);
    assert.deepEqual(canvas.snapshot().tabs[0]!.params, { message: "やあ" });
  });

  it("[task-0012/a3] canvas.open は未知の kind でエラーになる（握りつぶさない）", async () => {
    const [, open] = createCanvasTools(canvas, catalog);
    await assert.rejects(
      () => open!.execute("c1", { kind: "demo.nope" }, undefined, undefined, TOOL_CTX),
      /Unknown canvas view/
    );
  });

  it("[task-0012/a2] canvas.query_state が現在の表示を返す（決定13）", async () => {
    const tools = createCanvasTools(canvas, catalog);
    const queryState = tools[4]!;

    const empty = await queryState.execute("c1", {}, undefined, undefined, TOOL_CTX);
    assert.match(textOf(empty), /何も開かれていない/);

    canvas.open("demo.hello");
    canvas.open("demo.notes");
    const filled = await queryState.execute("c2", {}, undefined, undefined, TOOL_CTX);
    assert.match(textOf(filled), /▶.*メモ/, "表示中のタブが分かる");
    assert.match(textOf(filled), /デモ/);
  });

  it("[task-0012/a2] canvas.close / canvas.switch が状態に反映される", async () => {
    const tools = createCanvasTools(canvas, catalog);
    const [, , close, switchTool] = tools;

    const first = canvas.open("demo.hello");
    const second = canvas.open("demo.notes");

    await switchTool!.execute("c1", { tabId: first.id }, undefined, undefined, TOOL_CTX);
    assert.equal(canvas.snapshot().activeTabId, first.id);

    await close!.execute("c2", { tabId: second.id }, undefined, undefined, TOOL_CTX);
    assert.deepEqual(canvas.snapshot().tabs.map((t) => t.id), [first.id]);
  });
});

// ── WS 配信 ─────────────────────────────────────────────────────────────────

class FakeSession implements HostSession {
  readonly sessionId = "test-session";
  isStreaming = false;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

let server: BantoHostServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function waitFor(events: ServerEvent[], predicate: (e: ServerEvent) => boolean, timeoutMs = 2000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out; got: ${events.map((e) => e.type).join(", ")}`));
      }
    }, 10);
  });
}

describe("[task-0012/a4] キャンバス状態のWS配信", () => {
  async function start(): Promise<string> {
    server = await BantoHostServer.start({
      session: new FakeSession(),
      tools: createCanvasTools(canvas, catalog),
      port: 0,
      canvas,
      catalog,
    });
    return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
  }

  it("[task-0012/a4] welcome にカタログが載る（UIがcomponentを解決できる）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    const welcome = await waitFor(events, (e) => e.type === "welcome");
    assert.ok(welcome.type === "welcome");
    assert.deepEqual(welcome.catalog.map((c) => c.kind), ["demo.hello", "demo.notes"]);
    assert.equal(welcome.catalog[0]!.component, "DemoHello");
    client.close();
  });

  it("[task-0012/a4] 接続直後に現在の表示状態が届く（後から繋いでも追いつく）", async () => {
    canvas.open("demo.hello", { message: "先に開いていた" });
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    const state = await waitFor(events, (e) => e.type === "canvas_state");
    assert.ok(state.type === "canvas_state");
    assert.equal(state.tabs.length, 1);
    assert.deepEqual(state.tabs[0]!.params, { message: "先に開いていた" });
    client.close();
  });

  it("[task-0012/a4] 表示状態の変化が全クライアントへ配信される", async () => {
    const url = await start();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, (e) => e.type === "welcome");
    await waitFor(b, (e) => e.type === "welcome");

    canvas.open("demo.notes");

    const fromA = await waitFor(a, (e) => e.type === "canvas_state" && e.tabs.length === 1);
    const fromB = await waitFor(b, (e) => e.type === "canvas_state" && e.tabs.length === 1);
    assert.ok(fromA.type === "canvas_state" && fromA.tabs[0]!.kind === "demo.notes");
    assert.ok(fromB.type === "canvas_state" && fromB.tabs[0]!.kind === "demo.notes");

    clientA.close();
    clientB.close();
  });
});

describe("[task-0014] POが直接タブを操作する経路", () => {
  async function start(): Promise<string> {
    server = await BantoHostServer.start({
      session: new FakeSession(),
      tools: createCanvasTools(canvas, catalog),
      port: 0,
      canvas,
      catalog,
    });
    return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
  }

  it("[task-0014] canvas_switch がホストのCanvasを通り、全クライアントへ反映される", async () => {
    const first = canvas.open("demo.hello");
    canvas.open("demo.notes");

    const url = await start();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, (e) => e.type === "canvas_state");
    await waitFor(b, (e) => e.type === "canvas_state");

    clientA.send({ type: "canvas_switch", tabId: first.id });

    const onB = await waitFor(b, (e) => e.type === "canvas_state" && e.activeTabId === first.id);
    assert.ok(onB.type === "canvas_state" && onB.activeTabId === first.id);
    // D3: 真実はホスト側のCanvas。UIが勝手に持つ状態ではない
    assert.equal(canvas.snapshot().activeTabId, first.id);

    clientA.close();
    clientB.close();
  });

  it("[task-0014] canvas_close がタブを閉じる", async () => {
    canvas.open("demo.hello");
    const second = canvas.open("demo.notes");

    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, (e) => e.type === "canvas_state");

    client.send({ type: "canvas_close", tabId: second.id });

    await waitFor(events, (e) => e.type === "canvas_state" && e.tabs.length === 1);
    assert.equal(canvas.snapshot().tabs.length, 1);
    client.close();
  });

  it("[task-0014] 未知のタブIDは黙って無視せずエラーを返す（I2）", async () => {
    const url = await start();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, (e) => e.type === "welcome");

    client.send({ type: "canvas_switch", tabId: "no-such-tab" });

    const err = await waitFor(events, (e) => e.type === "error");
    assert.ok(err.type === "error" && /Unknown canvas tab/.test(err.message));
    client.close();
  });
});
