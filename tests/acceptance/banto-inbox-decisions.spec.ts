/**
 * task-0086: POの判断を求めるものは、出所を問わず取次1つに集まる（決定73・74・75）。
 *
 * ここで一番見たいのは a4——**押したらその場で効いて、番頭が先へ進むこと**。
 * 以前は取次が「答えを記録して画面に流す」だけで、
 *   - 承認のように番頭が自分では呼べない口（決定29e・38c）は誰も呼ばず
 *   - 番頭には知らせが届かず（`broadcast` は画面にしか行かない）
 * POから見ると「押したのに何も起きない」状態だった。
 *
 * a3 は逆向きの確認：押されたときに何を呼ぶかは**画面へ配らない**。配ると、画面から
 * 任意の口を叩けることになり、承認を番頭から機構で分けた意味が無くなる（I1）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Inbox,
  PlaceGrantStore,
  PlaceRegistry,
  ThreadRegistry,
  createFileWriteTools,
  createPlaceGrantAdminTools,
  createPlaceRequestTools,
  createStaticPlaceProvider,
  createWorkspaceModule,
  type HostSession,
  type InboxEffect,
  type NamespacedToolDefinition,
  type ServerEvent,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

let dir: string;
let repo: string;
let other: string;
let grantsFile: string;
let server: BantoHostServer | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-inbox-"));
  repo = path.join(dir, "repo");
  other = path.join(dir, "other");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(other, "docs"), { recursive: true });
  grantsFile = path.join(dir, "host-data", "place-grants.json");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  inbox: Inbox;
  grants: PlaceGrantStore;
  places: PlaceRegistry;
  request: NamespacedToolDefinition;
  admin: Record<string, NamespacedToolDefinition>;
  write: NamespacedToolDefinition;
}

/** 場所2つ＋許可の帳簿＋取次。どちらの場所も既定は読み取り専用（決定38a）。 */
function setup(): Fixture {
  const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
  const grants = new PlaceGrantStore(grantsFile);
  const places = new PlaceRegistry(
    [
      createStaticPlaceProvider([
        { id: "repo", label: "リポジトリ", path: repo },
        { id: "other", label: "別のリポジトリ", path: other },
      ]),
    ],
    grants
  );
  return {
    inbox,
    grants,
    places,
    request: createPlaceRequestTools(places, grants, { inbox })[0]!,
    admin: Object.fromEntries(createPlaceGrantAdminTools(grants, places).map((t) => [t.name, t])),
    write: createFileWriteTools(places, { protectedPaths: [path.dirname(grantsFile)] })[0]!,
  };
}

describe("[task-0086/a1] 書き込み許可も取次に積まれる", () => {
  it("番頭が頼むと、判断待ちが取次に積まれる（面を開かせない）", async () => {
    const { request, inbox } = setup();

    await request.execute({
      place: "repo",
      patterns: ["docs/**"],
      reason: "決定を記録したい",
      threadId: "t-1",
    });

    const items = inbox.list().filter((i) => !i.resolvedAt);
    assert.equal(items.length, 1, "判断待ちが1件積まれる");
    const item = items[0]!;
    assert.equal(item.source.id, "place");
    // 三部構成（spec-ui §3）が揃っていないと札として成立しない
    assert.ok(item.why && item.what && item.ask, "経緯・起きたこと・求める判断が揃う");
    assert.deepEqual(
      item.actions.map((a) => a.id),
      ["approve", "deny"]
    );
    // 頼んだ会話へ戻れること・設定へ逃げられること（決定75）
    assert.equal(item.opens?.threadId, "t-1");
    assert.equal(item.opens?.settings?.section, "places");
  });

  it("同じ頼みを繰り返しても札は1枚のまま", async () => {
    const { request, inbox } = setup();
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "1回目" });
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "2回目" });
    assert.equal(inbox.list().filter((i) => !i.resolvedAt).length, 1);
  });

  it("一度断られた件は、頼み直せば新しい札になる", async () => {
    const { request, inbox, admin } = setup();
    const first = await request.execute({ place: "repo", patterns: ["docs/**"], reason: "1回目" });
    const firstId = (first.details as { request: { id: string } }).request.id;
    // 画面から断る → 札も畳む（サーバ経由の流れを、ここでは手で再現する）
    await admin["place.deny_write"]!.execute({ requestId: firstId });
    inbox.resolve(inbox.list()[0]!.id, "deny");

    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "やはり要る" });
    assert.equal(inbox.list().filter((i) => !i.resolvedAt).length, 1, "新しい札が積まれる");
  });
});

describe("[task-0086/a3] 押されたら何を呼ぶかは画面へ配らない", () => {
  it("配る形に effect は載らない（画面から任意の口を叩けない）", async () => {
    const { request, inbox } = setup();
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });

    const view = inbox.list()[0]!;
    for (const action of view.actions) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(action, "effect"),
        `選択肢 ${action.id} に呼び出し先が載っている`
      );
    }
    // ホスト自身は持っている（呼ぶのはホスト）
    const internal = inbox.get(view.id)!;
    assert.equal(internal.actions[0]!.effect?.tool, "place.approve_write");
  });
});

// ── 取次の答えがその場で効き、番頭が先へ進む ────────────────────────────────

/** ターンの進行だけをこちらから発火できるセッション（プロバイダを呼ばない）。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }

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

/** 取次つきのホストを立てる。効果の実行は bin.ts と同じくモジュールの帳簿から引く。 */
async function startHost(fixture: Fixture): Promise<{ url: string; session: FakeSession }> {
  const module = createWorkspaceModule(fixture.places, {}, fixture.grants, fixture.inbox);
  let session!: FakeSession;
  const threads = new ThreadRegistry(async () => {
    session = new FakeSession();
    return { harness: session, tools: [] };
  });
  await threads.open(TRUNK);
  server = await BantoHostServer.start({
    threads,
    inbox: fixture.inbox,
    port: 0,
    runInboxEffect: async (effect: InboxEffect) => {
      assert.equal(effect.module, "workspace");
      const tool = [...module.tools, ...(module.internalTools ?? [])].find(
        (t) => t.name === effect.tool
      );
      if (!tool) throw new Error(`no tool ${effect.tool}`);
      const result = await tool.execute((effect.args ?? {}) as never, { toolCallId: "test" });
      return result.content.map((c) => c.text ?? "").join("");
    },
  });
  return { url: `ws://localhost:${server.port}${BANTO_WS_PATH}`, session };
}

/** 条件が満たされるまで待つ（イベントの到着とターンの発火を待ち合わせる）。 */
async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("[task-0086/a4] 押したらその場で効いて、番頭が先へ進む", () => {
  it("「許す」で書けるようになり、番頭に知らせが入る", async () => {
    const fixture = setup();
    await fixture.request.execute({ place: "repo", patterns: ["docs/**"], reason: "決定を記録したい" });
    const itemId = fixture.inbox.list()[0]!.id;

    const { url, session } = await startHost(fixture);
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "inbox_answer", itemId, actionId: "approve" });

    // 効いたこと：承認が実際に走り、書けるようになる
    await until(
      () => (fixture.grants.writableFor("repo") as string[]).includes("docs/**"),
      "承認が効くこと"
    );
    await fixture.write.execute({ place: "repo", path: "docs/a.md", content: "ok\n" });
    assert.equal(fs.readFileSync(path.join(repo, "docs", "a.md"), "utf-8"), "ok\n");

    // 番頭に届いたこと：知らせが入り、ターンが回る（＝自動で先に行く）
    await until(() => session.prompts.length > 0, "番頭のターンが回ること");
    assert.match(session.prompts[0]!, /この範囲で許す/);
    assert.match(session.prompts[0]!, /続けてください/);

    // 画面にも配られ、札は畳まれる
    await until(
      () =>
        events.some(
          (e) => e.type === "inbox_state" && e.items.some((i) => i.id === itemId && i.resolvedAt)
        ),
      "札が畳まれること"
    );
    client.close();
  });

  it("効かせられなかったら畳まない（許したことにして書けないままにしない）", async () => {
    const fixture = setup();
    await fixture.request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    const itemId = fixture.inbox.list()[0]!.id;
    // 帳簿の側で先に決着させておく＝承認の口が「既に許可されています」で失敗する状況
    const requestId = fixture.grants.requests()[0]!.id;
    fixture.grants.approve(requestId);
    fixture.grants.revoke("repo", "docs/**");

    const { url } = await startHost(fixture);
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "inbox_answer", itemId, actionId: "approve" });

    await until(() => events.some((e) => e.type === "error"), "断りが返ること");
    assert.equal(fixture.inbox.get(itemId)!.resolvedAt, undefined, "札は判断待ちのまま残る");
    client.close();
  });
});

describe("[task-0086/a5] 全ての場所で許す範囲（決定74）", () => {
  it("共通で許すと、登録された全ての場所で書ける", async () => {
    const { admin, write, places } = setup();

    await admin["place.set_global_write"]!.execute({ patterns: ["docs/**"] });

    await write.execute({ place: "repo", path: "docs/a.md", content: "ok\n" });
    await write.execute({ place: "other", path: "docs/b.md", content: "ok\n" });
    assert.ok(fs.existsSync(path.join(other, "docs", "b.md")));

    // 範囲の外は共通でも書けない
    await assert.rejects(
      () => write.execute({ place: "repo", path: "src/x.ts", content: "x" }),
      /範囲の外/
    );
    // 実効値として見える（画面が「いま何が書けるか」を出せる）
    const repoPlace = (await places.list()).find((p) => p.id === "repo")!;
    assert.deepEqual(repoPlace.writable, ["docs/**"]);
  });

  it("共通の許可を空にすると、どの場所からも消える", async () => {
    const { admin, write } = setup();
    await admin["place.set_global_write"]!.execute({ patterns: ["docs/**"] });
    await admin["place.set_global_write"]!.execute({ patterns: [] });
    await assert.rejects(
      () => write.execute({ place: "repo", path: "docs/a.md", content: "x" }),
      /読み取り専用/
    );
  });

  it("場所ごとの許可は、共通を消しても残る（別々に持つ）", async () => {
    const { admin, request, write } = setup();
    const requested = await request.execute({ place: "repo", patterns: ["work/**"], reason: "A" });
    await admin["place.approve_write"]!.execute({
      requestId: (requested.details as { request: { id: string } }).request.id,
    });
    await admin["place.set_global_write"]!.execute({ patterns: ["docs/**"] });
    await admin["place.set_global_write"]!.execute({ patterns: [] });

    await write.execute({ place: "repo", path: "work/a.md", content: "ok\n" });
    assert.ok(fs.existsSync(path.join(repo, "work", "a.md")));
  });

  it("共通の許可は番頭のTool一覧に出ない（自分で広げられない）", () => {
    const { places, grants, inbox } = setup();
    const module = createWorkspaceModule(places, {}, grants, inbox);
    assert.ok(!module.tools.some((t) => t.name === "place.set_global_write"));
    assert.ok((module.internalTools ?? []).some((t) => t.name === "place.set_global_write"));
  });

  it("再起動しても共通の許可は残る", async () => {
    const { admin } = setup();
    await admin["place.set_global_write"]!.execute({ patterns: ["docs/**"] });
    const reloaded = new PlaceGrantStore(grantsFile);
    assert.deepEqual([...reloaded.globalWritable()], ["docs/**"]);
  });
});

describe("[task-0086/a6] 設定の画面が1つの口から描ける", () => {
  it("保留・許可・共通・場所の一覧がまとめて取れる", async () => {
    const { admin, request } = setup();
    await request.execute({ place: "repo", patterns: ["docs/**"], reason: "A" });
    await admin["place.set_global_write"]!.execute({ patterns: ["work/**"] });

    const details = (await admin["place.list_requests"]!.execute({})).details as {
      pending: Array<{ patterns: string[] }>;
      grants: Record<string, string[]>;
      global: string[];
      places: Array<{ id: string; label: string; path: string; writable: string[] }>;
    };
    assert.deepEqual(details.pending.map((p) => p.patterns), [["docs/**"]]);
    assert.deepEqual(details.global, ["work/**"]);
    assert.deepEqual(details.places.map((p) => p.id).sort(), ["other", "repo"]);
    // 実効値には共通の分が乗っている（画面が突き合わせずに描ける）
    assert.deepEqual(details.places.find((p) => p.id === "repo")!.writable, ["work/**"]);
  });
});
