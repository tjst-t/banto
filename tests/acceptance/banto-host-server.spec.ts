/**
 * task-0009: 番頭ホストの常駐サーバとWS API。
 *
 * Kobo にも LLM にも接続しない（受け入れ条件 a5）。server が具象の AgentSession ではなく
 * HostSession 契約に依存しているため、テスト用の FakeSession を挿してターンの進行を
 * こちらから発火でき、プロバイダを一切呼ばずに配信経路を検証できる。
 * 実プロバイダとの往復は別途デモで確認する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { JsonlMemoryStore } from "@banto/core";
import {
  ThreadRegistry,
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  createMemoryTools,
  isNoticeworthy,
  renderWorkerNotice,
  type HostSession,
  type ServerEvent,
} from "@banto/host";
import type { WorkerEvent } from "@banto/worker-pool";

/**
 * HostSession を満たすテスト用セッション。プロバイダを一切呼ばずに、ターンの進行だけを
 * こちらから発火できる。server が具象型ではなく HostSession に依存しているから可能。
 */
class FakeSession implements HostSession {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  aborted = 0;
  private listeners = new Set<(event: unknown) => void>();

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  async abort(): Promise<void> {
    this.aborted++;
  }

  /** ハーネス側から流れてくるイベントを再現する。 */
  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }
}

let dir: string;
let store: JsonlMemoryStore;
let server: BantoHostServer | undefined;
let session: FakeSession;

async function startHost(
  getLastError?: (() => string | undefined) | { webDir: string }
): Promise<{ url: string; tools: string[] }> {
  // 第2引数を取らずに済むよう、オブジェクトを渡したら設定として扱う（既存の呼び出しはそのまま）
  const extra = typeof getLastError === "object" ? getLastError : undefined;
  const lastError = typeof getLastError === "function" ? getLastError : undefined;
  const tools = createMemoryTools(store);
  // task-0035: サーバはスレッドの帳簿を受け取る。既定スレッドを1本開いてから立てる
  const threads = new ThreadRegistry(async () => {
    session = new FakeSession();
    return { session, tools, ...(lastError ? { getLastError: lastError } : {}) };
  });
  await threads.open();
  server = await BantoHostServer.start({ threads, port: 0, ...(extra ?? {}) });
  return { url: `ws://localhost:${server.port}${BANTO_WS_PATH}`, tools: tools.map((t) => t.name) };
}

/** 指定の型のイベントが来るまで待つ。 */
function waitFor(events: ServerEvent[], type: ServerEvent["type"], timeoutMs = 2000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find((e) => e.type === type);
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for "${type}"; got: ${events.map((e) => e.type).join(", ")}`));
      }
    }, 10);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-host-server-"));
  store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[task-0009/a1] WS API — 接続と会話の入口", () => {
  it("[task-0009/a1] 接続すると welcome でセッションIDとTool一覧が届く", async () => {
    const { url, tools } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    const welcome = await waitFor(events, "welcome");
    assert.equal(welcome.type, "welcome");
    // 開いている会話が1本も無ければ undefined（空状態）。ここでは1本開いている
    assert.ok(welcome.type === "welcome" && (welcome.sessionId ?? "").length > 0);
    assert.ok(welcome.type === "welcome" && tools.every((t) => welcome.tools.includes(t)));
    client.close();
  });

  it("[task-0009/a2] welcome のTool名は論理名（wire名を漏らさない）", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    const welcome = await waitFor(events, "welcome");
    assert.ok(welcome.type === "welcome");
    assert.ok(welcome.tools.includes("memory.save"), `got: ${welcome.tools.join(", ")}`);
    assert.equal(
      welcome.tools.some((t) => t.includes("__")),
      false,
      "wire名はプロバイダとの境界に閉じる（決定22）"
    );
    client.close();
  });

  it("[task-0009/a1] HTTP の /health が応答する", async () => {
    await startHost();
    const res = await fetch(`http://localhost:${server!.port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("[task-0009/a1] セッションイベントの配信", () => {
  it("[task-0009/a1] テキスト差分が text_delta として流れる", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    // プロバイダを呼ばずにターンの進行だけ再現する
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "こんにちは" },
    });

    const delta = await waitFor(events, "text_delta");
    assert.ok(delta.type === "text_delta" && delta.delta === "こんにちは");
    client.close();
  });

  it("[task-0009/a2] Tool実行イベントは論理名へ戻して通知される", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    // プロバイダ側は wire 名で呼んでくる
    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "memory__save",
      args: {},
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "memory__save",
      result: {},
      isError: false,
    });

    const start = await waitFor(events, "tool_start");
    assert.ok(start.type === "tool_start" && start.name === "memory.save", `got ${JSON.stringify(start)}`);
    const end = await waitFor(events, "tool_end");
    assert.ok(end.type === "tool_end" && end.name === "memory.save" && end.isError === false);
    client.close();
  });

  it("[task-0009/a2] 名前空間規則に従わない名前はそのまま通す", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    session.emit({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "read",
      args: {},
    });

    const start = await waitFor(events, "tool_start");
    assert.ok(start.type === "tool_start" && start.name === "read");
    client.close();
  });
});

describe("[task-0009/a3] 複数クライアント", () => {
  it("[task-0009/a3] 同時接続した全員が同じセッションのイベントを受け取る", async () => {
    const { url } = await startHost();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, "welcome");
    await waitFor(b, "welcome");

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "全員に届く" },
    });

    const fromA = await waitFor(a, "text_delta");
    const fromB = await waitFor(b, "text_delta");
    assert.ok(fromA.type === "text_delta" && fromA.delta === "全員に届く");
    assert.ok(fromB.type === "text_delta" && fromB.delta === "全員に届く");

    clientA.close();
    clientB.close();
  });

  it("[task-0009/a3] 片方が切断してももう片方は受け取り続ける", async () => {
    const { url } = await startHost();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, "welcome");
    await waitFor(b, "welcome");

    clientA.close();
    await new Promise((r) => setTimeout(r, 50));

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "残った方へ" },
    });

    const fromB = await waitFor(b, "text_delta");
    assert.ok(fromB.type === "text_delta" && fromB.delta === "残った方へ");
    clientB.close();
  });
});

describe("[task-0009] プロトコル違反の扱い（I2）", () => {
  it("[task-0009] 壊れたJSONは error として返る（黙って捨てない）", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 生のWSへ不正データを流すため (I4)
    (client as any).ws.send("{ not json");

    const err = await waitFor(events, "error");
    assert.ok(err.type === "error" && /invalid JSON/.test(err.message));
    client.close();
  });

  it("[task-0009] 未知のメッセージ種別は error として返る", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 型に無い種別を送るため (I4)
    client.send({ type: "nonsense" } as any);

    const err = await waitFor(events, "error");
    assert.ok(err.type === "error" && /unknown message type: nonsense/.test(err.message));
    client.close();
  });

  it("[task-0009] 空文字のpromptは error として返る", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "prompt", text: "" });

    const err = await waitFor(events, "error");
    assert.ok(err.type === "error" && /non-empty/.test(err.message));
    client.close();
  });
});

describe("[task-0009/a1] prompt と abort の中継", () => {
  it("[task-0009/a1] prompt がセッションへ渡り、turn_end で完了が通知される", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "prompt", text: "在庫を確認して" });

    const end = await waitFor(events, "turn_end");
    assert.ok(end.type === "turn_end" && end.errorMessage === undefined);
    assert.deepEqual(session.prompts, ["在庫を確認して"]);
    client.close();
  });

  it("[task-0009/a1] プロバイダ側エラーは turn_end に載って伝わる（I2）", async () => {
    const { url } = await startHost(() => "400 Upstream request failed");
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "prompt", text: "何か" });

    const end = await waitFor(events, "turn_end");
    assert.ok(end.type === "turn_end" && end.errorMessage === "400 Upstream request failed");
    client.close();
  });

  it("[task-0009/a1] abort がセッションへ中継される", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "abort" });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(session.aborted, 1);
    client.close();
  });

  it("[task-0009/a3] 一方が送った prompt の turn_end を全クライアントが受け取る", async () => {
    const { url } = await startHost();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, "welcome");
    await waitFor(b, "welcome");

    clientA.send({ type: "prompt", text: "共有される発話" });

    await waitFor(a, "turn_end");
    await waitFor(b, "turn_end");
    clientA.close();
    clientB.close();
  });
});

describe("[task-0014] 会話履歴のホスト保持（リロードで消えない）", () => {
  it("[task-0014] 接続直後に history が届く（初回は空）", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    const history = await waitFor(events, "history");
    assert.ok(history.type === "history" && history.entries.length === 0);
    client.close();
  });

  it("[task-0014] POの発話は本人以外にも配られ、履歴にも残る", async () => {
    const { url } = await startHost();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, "history");
    await waitFor(b, "history");

    clientA.send({ type: "prompt", text: "在庫を確認して" });
    const poOnB = await waitFor(b, "po_message");
    assert.ok(poOnB.type === "po_message" && poOnB.text === "在庫を確認して");
    await waitFor(a, "turn_end");
    clientA.close();
    clientB.close();

    // 再接続＝リロード相当。履歴が復元される
    const c: ServerEvent[] = [];
    const clientC = await BantoHostClient.connect(url, (e) => c.push(e));
    const history = await waitFor(c, "history");
    assert.ok(history.type === "history");
    assert.deepEqual(history.entries, [{ role: "po", text: "在庫を確認して" }]);
    clientC.close();
  });

  it("[task-0014] 番頭の発話とTool実行も履歴に残り、再接続で再現される", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "history");

    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "はい" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "、確認します" } });
    session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "memory__save", args: {} });
    session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "memory__save", result: {}, isError: false });
    await waitFor(events, "tool_end");
    client.close();

    const c: ServerEvent[] = [];
    const clientC = await BantoHostClient.connect(url, (e) => c.push(e));
    const history = await waitFor(c, "history");
    assert.ok(history.type === "history");
    assert.deepEqual(history.entries, [
      { role: "banto", text: "はい、確認します" },
      { role: "tool", name: "memory.save", state: "ok" },
    ]);
    clientC.close();
  });

  it("[task-0037] new_session は畳んで新しく始め、全クライアントへ通知される", async () => {
    // 以前は会話を捨てていた。畳むだけで消さないので、あとから履歴で読める
    // （PO要望 2026-07-31）。詳細は banto-threads.spec.ts
    const { url } = await startHost();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    const clientA = await BantoHostClient.connect(url, (e) => a.push(e));
    const clientB = await BantoHostClient.connect(url, (e) => b.push(e));
    await waitFor(a, "history");
    await waitFor(b, "history");

    clientA.send({ type: "prompt", text: "何か" });
    await waitFor(a, "turn_end");

    b.length = 0;
    clientA.send({ type: "new_session" });
    // 開くのと畳むので2通来る。**最後の状態**を見る（先に開いてから畳むため）
    await waitFor(b, "thread_state");
    const deadline = Date.now() + 2000;
    let last = b.filter((e) => e.type === "thread_state").pop();
    while (
      Date.now() < deadline &&
      !(last?.type === "thread_state" && last.threads.some((t) => t.state === "closed"))
    ) {
      await new Promise<void>((r) => setTimeout(r, 20));
      last = b.filter((e) => e.type === "thread_state").pop();
    }
    assert.ok(last?.type === "thread_state", "thread_state が全クライアントへ届く");
    if (last?.type === "thread_state") {
      assert.ok(
        last.threads.some((t) => t.state === "closed"),
        "前の会話は畳まれて履歴に残る"
      );
      assert.ok(last.threads.some((t) => t.state === "open"), "新しい会話が始まっている");
    }

    clientA.close();
    clientB.close();
  });
});

// ── task-0026: 職人からの報告・質問が番頭へ届く（決定29） ───────────────────────

/** テスト用のイベント。Worker Pool を起こさずに翻訳と配信だけを見る。 */
function workerEvent(partial: Partial<WorkerEvent> & Pick<WorkerEvent, "type">): WorkerEvent {
  return {
    id: 1,
    at: "2026-07-30T00:00:00.000Z",
    kind: "fact",
    origin: "banto",
    projectTag: "banto",
    taskId: "task-0042",
    sessionId: "sess-1",
    data: {},
    ...partial,
  };
}

describe("[task-0026/a6] 番頭が職人の報告・質問に気づく", () => {
  it("[task-0026/a6] notify で知らせが配信され、番頭のターンが回る", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    await server!.notify("職人から報告が届きました");

    const notice = await waitFor(events, "notice");
    assert.ok(notice.type === "notice" && notice.text === "職人から報告が届きました");
    // 会話に積むだけでは気づかない。番頭のターンが実際に回ること
    assert.deepEqual(session.prompts, ["職人から報告が届きました"]);
    client.close();
  });

  it("[task-0026/a6] 知らせは履歴に残る（リロードしても消えない）", async () => {
    const { url } = await startHost();
    const first: ServerEvent[] = [];
    const a = await BantoHostClient.connect(url, (e) => first.push(e));
    await waitFor(first, "welcome");
    await server!.notify("職人から質問です", { source: "worker" });
    a.close();

    const second: ServerEvent[] = [];
    const b = await BantoHostClient.connect(url, (e) => second.push(e));
    const history = await waitFor(second, "history");
    assert.ok(history.type === "history");
    // 出所が載る（外からの知らせを全部「職人」で出さないため。PO報告 2026-07-31）
    assert.deepEqual(history.entries, [
      { role: "notice", source: "worker", text: "職人から質問です" },
    ]);
    b.close();
  });

  it("[task-0026/a6] 知らせが重なってもターンは1本ずつ進む", async () => {
    await startHost();
    await Promise.all([server!.notify("1人目"), server!.notify("2人目"), server!.notify("3人目")]);
    assert.deepEqual(session.prompts, ["1人目", "2人目", "3人目"]);
  });
});

describe("[task-0026/a6] 職人イベントの言い換え（決定29d）", () => {
  it("[task-0026/a6] 番頭自身がやったことは知らせない（ターンが回り続けるため）", () => {
    for (const type of ["worker_started", "worker_answered"] as const) {
      assert.equal(isNoticeworthy(workerEvent({ type })), false, type);
      assert.equal(renderWorkerNotice(workerEvent({ type })), undefined);
    }
    // 自分で畳んだ職人（done）も知らせない
    const own = workerEvent({ type: "worker_closed", data: { reason: "done" } });
    assert.equal(isNoticeworthy(own), false);
  });

  it("[task-0028/a2] 安全弁が働いたことは番頭に知らせる（畳み忘れの兆候）", () => {
    const swept = workerEvent({ type: "worker_closed", data: { reason: "idle" } });
    assert.equal(isNoticeworthy(swept), true);
    const text = renderWorkerNotice(swept);
    assert.ok(text?.includes("安全弁"));
    assert.ok(text?.includes("worker.wake"), "起こし直せることを伝える");
  });

  it("[task-0026/a2] 報告は主張として伝える（完了と言い換えない。I1）", () => {
    const text = renderWorkerNotice(
      workerEvent({ type: "worker_reported", kind: "claim", data: { summary: "直しました", done: true } })
    );
    assert.ok(text?.includes("直しました"));
    assert.ok(text?.includes("主張"), `完了扱いに言い換えていないこと: ${String(text)}`);
  });

  it("[task-0026/a3] 質問には、答え方（worker.steer）と sessionId を添える", () => {
    const text = renderWorkerNotice(
      workerEvent({ type: "worker_asked", kind: "claim", data: { question: "A案とB案どちら？" } })
    );
    assert.ok(text?.includes("A案とB案どちら？"));
    assert.ok(text?.includes("worker.steer"));
    assert.ok(text?.includes("sess-1"), "どの職人に答えるか分かること");
  });

  it("[task-0026/a2] 異常終了と正常終了を混同しない", () => {
    const ok = renderWorkerNotice(workerEvent({ type: "worker_exited", data: { exitCode: 0, signal: null } }));
    const killed = renderWorkerNotice(
      workerEvent({ type: "worker_exited", data: { exitCode: null, signal: "SIGKILL" } })
    );
    assert.ok(ok?.includes("正常"));
    assert.ok(killed?.includes("SIGKILL"));
    assert.equal(killed?.includes("正常"), false);
  });
});

describe("[task-0044] 中断できること（忙しさの真実はホストが持つ）", () => {
  it("**職人の報告で始まったターンでも turn_start が出る**", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    await server!.notify("職人から報告が届きました");

    // ここが本題。UI は turn_start を見て中断ボタンを出すので、これが無いと
    // 「番頭が喋っているのに止める手段が画面に無い」状態になる（実際に踏んだ）
    const started = await waitFor(events, "turn_start");
    assert.ok(started.type === "turn_start");
    const notice = events.findIndex((e) => e.type === "notice");
    const start = events.findIndex((e) => e.type === "turn_start");
    assert.ok(start > notice, "知らせを配ってからターンが始まること");
    client.close();
  });

  it("POの発話で始まったターンでも turn_start が出る", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "prompt", text: "こんにちは" });
    const started = await waitFor(events, "turn_start");
    assert.ok(started.type === "turn_start");
    client.close();
  });

  it("abort がハーネスまで届く", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "abort" });
    // 届いたことはハーネス側の数で見る（ここが増えなければ「中断が効かない」そのもの）
    const deadline = Date.now() + 2000;
    while (session.aborted === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(session.aborted, 1);
    client.close();
  });

  it("再接続しても進行中のターンが分かる（turn_start は接続前に流れている）", async () => {
    const { url } = await startHost();
    const first: ServerEvent[] = [];
    const a = await BantoHostClient.connect(url, (e) => first.push(e));
    const welcome = await waitFor(first, "welcome");
    assert.ok(welcome.type === "welcome");
    // 接続直後は誰も喋っていない
    assert.deepEqual(welcome.threads.map((t) => t.streaming), [false]);
    a.close();

    // ハーネスが喋っている最中に、別のクライアントが繋いでくる
    session.isStreaming = true;
    const second: ServerEvent[] = [];
    const b = await BantoHostClient.connect(url, (e) => second.push(e));
    const later = await waitFor(second, "welcome");
    assert.ok(later.type === "welcome");
    assert.deepEqual(
      later.threads.map((t) => t.streaming),
      [true],
      "進行中だと分かること（分からないと中断ボタンが出ない）"
    );
    b.close();
  });
});

describe("[task-0048] 常駐のためにビルド済み UI を配る", () => {
  it("資産があれば同じポートで UI が出る。API は覆い隠されない", async () => {
    const webDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-web-"));
    fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>banto</title>");
    fs.writeFileSync(path.join(webDir, "assets", "app.js"), "console.log(1)");
    try {
      const { url } = await startHost({ webDir });
      const base = url.replace(/^ws/, "http").replace(/\/ws$/, "");

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /banto/);

      const asset = await fetch(`${base}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

      // 画面の中の遷移は index.html を返す（1ページのアプリ）
      const deep = await fetch(`${base}/どこか/深い/道`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /banto/);

      // API は資産より先に見る（覆い隠さない）
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      // 資産の外は読ませない（.. で外へ出ない）
      const escape = await fetch(`${base}/../../etc/passwd`);
      assert.equal(escape.status, 200);
      assert.match(await escape.text(), /banto/, "外のファイルではなく index.html を返すこと");
    } finally {
      fs.rmSync(webDir, { recursive: true, force: true });
    }
  });

  it("資産が無ければ何も配らない（開発中は vite が出す）", async () => {
    const { url } = await startHost();
    const base = url.replace(/^ws/, "http").replace(/\/ws$/, "");
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 404, "配るものが無いことを黙って隠さない");
  });
});
