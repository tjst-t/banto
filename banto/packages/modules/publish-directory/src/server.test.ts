// 窓口を、**本物の Caddy の実装**（偽の Caddy を相手に）と、偽の Service に繋いで試す。
// 中継だけを差し替える——**host の規則をそのまま真似る**（改訂・2026-09-28、Fable のレビュー）：
//
// - host が窓口を呼ぶたびに呼び出しの印（`dev.banto/callId`）を振り、出所（AI のターン／人の画面）と Project を台帳に置く
// - 窓口が中継に印を添えればその1件、添えなければ走っている全部を合わせる（ターンが混ざればターン・Project が混ざれば決められない）
// - Service（Project ごと）は、Project が決まっているときだけ見える。人の画面でも Project が無ければ見えない
// - 刻印：人の画面なら `{admin, forProject}`、ターンなら `{project}`
//
// 以前の偽物は「人の刻印なら Service が見える」と仮定し、刻印を窓口全体で1つ持っていたので、人の画面から Service が
// 呼べない穴と、AI のターンと人の画面が混ざると人の承認が断られる穴の、どちらも隠していた。
// 刻印の決まりそのものは core の試験（host-relay-endpoint.test.ts）が見ている。

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CaddyPublisher, HttpCaddyAdmin, PublishStore, createPublishCaddyServer } from "@banto/module-publish-caddy";
import { FakeCaddy, caddyfileLikeConfig } from "@banto/module-publish-caddy/dist/fake-caddy.js";
import { createPublishDirectoryServer } from "./server.js";
import { RequestStore, WithdrawalLog } from "./requests.js";
import type { RelayLike } from "./relay-client.js";

const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const P2 = "5e6f7a8b-0000-4000-8000-000000000002";
/** 人が Project の画面（会話の中の承認・入口）から押したとき host が刻むもの */
const ADMIN = { "dev.banto/caller": { admin: true, forProject: P1 } };
/** banto 全体の設定画面から（Project が無い） */
const INSTANCE_ADMIN = { "dev.banto/caller": { admin: true } };
const REPLY = "reply-handle-abc";
const PASSWORD = "correct-horse-battery-staple";
const HOST = "web-1a2b3c4d.banto.example.net";

interface ServiceRow {
  name: string;
  ports: number[];
  state: string;
  listening: number[];
  notListening: number[];
  note?: string;
}

/** 偽の Service（listServices だけ）。`hold` を渡すと、答える前にそれを待つ（呼び出しを重ねる試験のため） */
async function fakeService(rows: () => ServiceRow[], hold: () => Promise<void> | undefined): Promise<Client> {
  const s = new Server({ name: "fake-service", version: "0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "listServices", inputSchema: { type: "object" } }] }));
  s.setRequestHandler(CallToolRequestSchema, async () => {
    await hold();
    return { content: [{ type: "text", text: JSON.stringify({ services: rows() }) }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "host", version: "0" });
  await Promise.all([s.connect(a), c.connect(b)]);
  return c;
}

/** host の台帳の1件（窓口への呼び出し1つ） */
interface Entry {
  origin: "turn" | "canvas";
  project?: string;
}

interface Ctx {
  /** `ledger: false` は host が台帳に置かなかった呼び出し（中継が Project を決められない状態を作る） */
  call(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown>,
    opts?: { ledger?: boolean },
  ): Promise<{ text: string; isError: boolean; meta?: Record<string, unknown> }>;
  asAi(name: string, args?: Record<string, unknown>): ReturnType<Ctx["call"]>;
  asHuman(name: string, args?: Record<string, unknown>): ReturnType<Ctx["call"]>;
  caddy: FakeCaddy;
  services: ServiceRow[];
  deliveries: { replyTo: string; title: string; text: string; final: boolean }[];
  /** 窓口が実装・Service に渡した呼び出し（名前・引数・host が刻んだもの） */
  relayed: { target: string; name: string; args: Record<string, unknown>; stamp: unknown }[];
  /** 次に Service が答えるまで止める（止めた呼び出しの間に、別の呼び出しを重ねる） */
  holdService(): () => void;
  /** 次のその口の呼び出しは、相手に届いて処理されたうえで返事だけ落ちる */
  dropNextReply(name: string): void;
  /** 会話に届けた時点で、その頼みが記録の上でどうなっていたか（届けた順） */
  statesAtDelivery: string[];
  dirs: { directory: string; caddy: string };
}

async function withDirectory(fn: (ctx: Ctx) => Promise<void>) {
  const directoryDir = await mkdtemp(join(tmpdir(), "banto-publish-directory-"));
  const caddyDir = await mkdtemp(join(tmpdir(), "banto-publish-directory-caddy-"));
  const caddy = new FakeCaddy(caddyfileLikeConfig());
  const adminUrl = await caddy.start();
  const store = new PublishStore(caddyDir);
  await store.setSettings({ adminUrl, baseDomain: "banto.example.net", reach: "internet" });
  const publisher = new CaddyPublisher({
    store,
    caddyFor: (s) => new HttpCaddyAdmin(s.adminUrl),
    resolveAddress: async () => ({ address: "10.61.162.23" }),
    probe: async () => true,
    owner: caddyDir,
  });
  const impl = createPublishCaddyServer(publisher, store);
  const [ia, ib] = InMemoryTransport.createLinkedPair();
  const implClient = new Client({ name: "host", version: "0" });
  await Promise.all([impl.connect(ia), implClient.connect(ib)]);

  const services: ServiceRow[] = [{ name: "web", ports: [3000], state: "running", listening: [3000], notListening: [] }];
  let gate: Promise<void> | undefined;
  const serviceClient = await fakeService(() => services, () => gate);
  const deliveries: Ctx["deliveries"] = [];
  const relayed: Ctx["relayed"] = [];
  const statesAtDelivery: string[] = [];
  const drop = new Set<string>();

  // ---- host の台帳（窓口への呼び出しごと）----
  const inFlight = new Map<string, Entry>();
  /** 印があればその1件、無ければ全部を合わせる（ターンが混ざればターン、Project が混ざれば決められない） */
  const contextOf = (callId?: string): Entry | undefined => {
    const one = callId ? inFlight.get(callId) : undefined;
    if (one) return one;
    const all = [...inFlight.values()];
    if (all.length === 0) return undefined;
    const projects = [...new Set(all.map((e) => e.project).filter((p): p is string => !!p))];
    return { origin: all.some((e) => e.origin === "turn") ? "turn" : "canvas", ...(projects.length === 1 ? { project: projects[0] } : {}) };
  };
  const stampOf = (e: Entry | undefined) =>
    !e ? {} : e.origin === "canvas" ? { admin: true, ...(e.project ? { forProject: e.project } : {}) } : e.project ? { project: e.project } : {};
  const relay: RelayLike = {
    async listTargets(callId) {
      const ctx = contextOf(callId);
      return {
        targets: [...(ctx?.project === P1 ? [{ name: "service-p1", roles: ["service"] }] : []), { name: "publish-caddy", roles: ["publish"] }],
        ...(ctx?.project ? { onBehalfOf: ctx.project } : {}),
      };
    },
    async callTool(target, name, args, callId) {
      const ctx = contextOf(callId);
      if (target === "service-p1" && ctx?.project !== P1) throw new Error("publish-directory は service-p1 を呼ぶ権限がありません");
      const stamp = stampOf(ctx);
      relayed.push({ target, name, args, stamp });
      const client = target === "service-p1" ? serviceClient : target === "publish-caddy" ? implClient : undefined;
      if (!client) throw new Error(`unknown target ${target}`);
      const r = await client.callTool({ name, arguments: args, _meta: { "dev.banto/caller": stamp } });
      if (drop.delete(name)) throw new Error("中継の返事が途中で切れました");
      return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
    },
    async deliver(input) {
      const saved = JSON.parse(await readFile(join(directoryDir, "requests.json"), "utf8")) as { requests: { replyTo?: string; state: string }[] };
      statesAtDelivery.push(saved.requests.filter((q) => q.replyTo === input.replyTo).map((q) => q.state).join(","));
      deliveries.push(input);
    },
  };

  const directory = createPublishDirectoryServer({ relay, requests: new RequestStore(directoryDir), withdrawals: new WithdrawalLog(directoryDir) });
  const [da, db] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-or-canvas", version: "0" });
  await Promise.all([directory.connect(da), client.connect(db)]);
  // host が窓口を呼ぶ：刻印から台帳の1件を作り、呼び出しの印を添える
  const call: Ctx["call"] = async (name, args, meta, opts = {}) => {
    const caller = meta["dev.banto/caller"] as Record<string, unknown> | undefined;
    const callId = randomUUID();
    if (caller && opts.ledger !== false) {
      const project = (caller.project ?? caller.forProject) as string | undefined;
      inFlight.set(callId, { origin: caller.admin === true ? "canvas" : "turn", ...(project ? { project } : {}) });
    }
    try {
      const r = await client.callTool({ name, arguments: args, _meta: { ...meta, "dev.banto/callId": callId } });
      return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true, meta: r._meta as Record<string, unknown> | undefined };
    } finally {
      inFlight.delete(callId);
    }
  };
  try {
    await fn({
      call,
      asAi: (name, args = {}) => call(name, args, { "dev.banto/caller": { project: P1 }, "dev.banto/replyTo": REPLY }),
      asHuman: (name, args = {}) => call(name, args, ADMIN),
      caddy,
      services,
      deliveries,
      relayed,
      dropNextReply: (name) => drop.add(name),
      statesAtDelivery,
      holdService: () => {
        let release!: () => void;
        gate = new Promise<void>((r) => (release = r));
        return () => {
          gate = undefined;
          release();
        };
      },
      dirs: { directory: directoryDir, caddy: caddyDir },
    });
  } finally {
    await client.close();
    await implClient.close();
    await serviceClient.close();
    await caddy.stop();
    await rm(directoryDir, { recursive: true, force: true });
    await rm(caddyDir, { recursive: true, force: true });
  }
}

/** 中継が何もしない窓口（名乗りと画面だけを見る試験） */
function bareDirectory(dir: string) {
  return createPublishDirectoryServer({
    relay: { listTargets: async () => ({ targets: [] }), callTool: async () => ({ text: "", isError: true }), deliver: async () => {} },
    requests: new RequestStore(dir),
    withdrawals: new WithdrawalLog(dir),
  });
}

const requestIdOf = (text: string) => text.match(/公開の承認の id：([0-9a-f-]{36})/)![1]!;

test("AI に見せるのは3つ。publishService は承認の画面を持ち、あとで結果を届けると名乗る。人の口は admin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-publish-directory-tools-"));
  try {
    const server = bareDirectory(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const { tools } = await c.listTools();
    const vis = Object.fromEntries(tools.map((t) => [t.name, (t._meta as Record<string, unknown>)["dev.banto/visibility"]]));
    assert.deepEqual(vis, {
      publishService: "agent",
      unpublishService: "agent",
      listPublished: "agent",
      get_publish_request: "admin",
      approve_publish: "admin",
      decline_publish: "admin",
      get_publish_overview: "admin",
      unpublish_route: "admin",
      // Service が removeService の中で呼ぶ部品の口（AI には見せない）
      serviceRemoved: "module",
    });
    const publish = tools.find((t) => t.name === "publishService")!;
    const meta = publish._meta as Record<string, unknown>;
    assert.equal(meta["dev.banto/deliversLater"], true);
    assert.equal((meta.ui as { resourceUri: string }).resourceUri, "ui://banto-publish-directory/approve");
    await c.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publishService は公開しない——Service の登録と待ち受けを確かめ、承認の頼みを置くだけ", async () => {
  await withDirectory(async ({ asAi, caddy }) => {
    const r = await asAi("publishService", { service: "web" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /まだ公開していません/);
    assert.match(r.text, /https:\/\/web-1a2b3c4d\.banto\.example\.net/);
    assert.match(r.text, /届く範囲：インターネット/);
    requestIdOf(r.text);
    // 結果はあとで札で届ける（host に「返事待ち」と伝える）
    assert.equal(r.meta?.["dev.banto/pendingReply"], true);
    assert.deepEqual(caddy.writes(), [], "頼まれただけで Caddy を書き換えた");
  });
});

test("待ち受けていない・登録に無い・ポートが決まらない・待ち受けを調べられない、は断り、頼みを置かない", async () => {
  await withDirectory(async ({ asAi, services, dirs }) => {
    services[0] = { name: "web", ports: [3000], state: "crashed", listening: [], notListening: [3000] };
    const notListening = await asAi("publishService", { service: "web" });
    assert.ok(notListening.isError);
    assert.match(notListening.text, /3000 で待ち受けていません（状態：crashed）/);

    const unknown = await asAi("publishService", { service: "api" });
    assert.match(unknown.text, /「api」は登録されていません（登録済み：web）/);

    services[0] = { name: "web", ports: [3000, 5173], state: "running", listening: [3000, 5173], notListening: [] };
    assert.match((await asAi("publishService", { service: "web" })).text, /port を選んでください/);
    assert.match((await asAi("publishService", { service: "web", port: 8080 })).text, /登録に無いポート/);

    services[0] = { name: "web", ports: [3000], state: "running", listening: [], notListening: [3000], note: "待ち受けを調べられませんでした（ss が使えない）" };
    assert.match((await asAi("publishService", { service: "web" })).text, /確かめられません：待ち受けを調べられませんでした/);

    assert.deepEqual((await readdir(dirs.directory)).filter((f) => f.startsWith("requests")), [], "断ったのに頼みを置いた");
  });
});

test("Project の会話からでなければ断る（どの Project の公開か決められない）", async () => {
  await withDirectory(async ({ call }) => {
    const r = await call("publishService", { service: "web" }, {});
    assert.ok(r.isError);
    assert.match(r.text, /Project の会話からだけ/);
    assert.ok((await call("publishService", { service: "web" }, ADMIN)).isError);
    assert.ok((await call("publishService", { service: "web" }, INSTANCE_ADMIN)).isError);
  });
});

test("人が承認の画面で押すと公開する。画面には実装の設定項目がそのまま出て、設定はそのまま実装に渡る。結果は会話に届く", async () => {
  await withDirectory(async ({ asAi, asHuman, caddy, deliveries, relayed }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    const view = JSON.parse((await asHuman("get_publish_request", { requestId: id })).text);
    assert.equal(view.request.service, "web");
    assert.equal(view.request.replyTo, undefined, "札を画面に出した");
    assert.equal(view.plan.url, `https://${HOST}`);
    assert.equal(view.plan.reachLabel, "インターネット（URL を知っている誰でも）");
    // 窓口は設定項目を解釈しない——実装が名乗ったものがそのまま
    assert.deepEqual(Object.keys(view.method.configSchema.properties), ["auth", "username", "password", "subdomain"]);
    assert.equal(view.method.configSchema.properties.password.writeOnly, true);

    const config = { auth: "basic", username: "me", password: PASSWORD };
    const r = await asHuman("approve_publish", { requestId: id, config });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text), { state: "published", url: `https://${HOST}`, reach: "internet", reachLabel: "インターネット（URL を知っている誰でも）" });
    const passed = relayed.find((c) => c.name === "publishRoute")!;
    assert.deepEqual(passed.args, { projectId: P1, service: "web", port: 3000, config }, "設定を手直しして渡した");
    assert.ok(caddy.routes().some((x) => JSON.stringify(x).includes(HOST)), "Caddy にルートが無い");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.replyTo, REPLY);
    assert.equal(deliveries[0]!.final, true);
    assert.match(deliveries[0]!.text, new RegExp(`https://${HOST.replace(/\./g, "\\.")}`));
    // 二度は公開しない
    assert.match((await asHuman("approve_publish", { requestId: id, config })).text, /もう答えが出ています/);
  });
});

test("承認の口は人の刻印があるときだけ——AI のターンからは押せない", async () => {
  await withDirectory(async ({ asAi, caddy }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    for (const name of ["approve_publish", "decline_publish", "get_publish_request"]) {
      const r = await asAi(name, { requestId: id, config: { auth: "none" } });
      assert.ok(r.isError, name);
      assert.match(r.text, /人の操作からだけ/);
    }
    assert.deepEqual(caddy.writes(), []);
  });
});

test("実装が設定を断ったら頼みは待ったまま——直して押し直せる", async () => {
  await withDirectory(async ({ asAi, asHuman, deliveries }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    const short = await asHuman("approve_publish", { requestId: id, config: { auth: "basic", password: "short" } });
    assert.ok(short.isError);
    assert.match(short.text, /12〜72/);
    assert.deepEqual(deliveries, [], "失敗したのに会話へ届けた");
    const ok = await asHuman("approve_publish", { requestId: id, config: { auth: "none" } });
    assert.equal(ok.isError, false, ok.text);
  });
});

test("公開しないを押すと、Caddy に触らず、断ったことが会話に届く", async () => {
  await withDirectory(async ({ asAi, asHuman, caddy, deliveries }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    assert.equal((await asHuman("decline_publish", { requestId: id })).isError, false);
    assert.deepEqual(caddy.writes(), []);
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0]!.text, /断りました/);
    const again = JSON.parse((await asHuman("get_publish_request", { requestId: id })).text);
    assert.equal(again.request.state, "declined");
  });
});

test("承認の画面でサブドメインを変えると、URL の見積もりも変わる", async () => {
  await withDirectory(async ({ asAi, asHuman }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    const view = JSON.parse((await asHuman("get_publish_request", { requestId: id, config: { subdomain: "demo" } })).text);
    assert.equal(view.plan.url, "https://demo.banto.example.net");
    const r = JSON.parse((await asHuman("approve_publish", { requestId: id, config: { auth: "none", subdomain: "demo" } })).text);
    assert.equal(r.url, "https://demo.banto.example.net");
  });
});

test("一覧は実装から組む（公開・承認待ち・出し方）。やめると一覧から消え、Caddy のルートも消える", async () => {
  await withDirectory(async ({ asAi, asHuman, caddy }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    let list = JSON.parse((await asAi("listPublished")).text);
    assert.deepEqual(list.pending.map((p: { requestId: string }) => p.requestId), [id]);
    assert.deepEqual(list.published, []);
    assert.deepEqual(list.methods, [{ name: "publish-caddy", title: "Caddy のサブドメイン", reach: "internet", ready: true }]);

    await asHuman("approve_publish", { requestId: id, config: { auth: "basic", password: PASSWORD } });
    list = JSON.parse((await asAi("listPublished")).text);
    assert.deepEqual(list.pending, []);
    assert.equal(list.published.length, 1);
    assert.equal(list.published[0].url, `https://${HOST}`);
    assert.equal(list.published[0].method, "publish-caddy");
    assert.equal(list.published[0].auth, "basic");
    assert.equal(list.published[0].state, "active");
    // 同じものをもう一度頼むと断る（承認の画面を出す前に）
    assert.match((await asAi("publishService", { service: "web" })).text, /もう公開しています/);

    const off = JSON.parse((await asAi("unpublishService", { service: "web" })).text);
    assert.deepEqual(off.removed.map((x: { url: string }) => x.url), [`https://${HOST}`]);
    assert.ok(!caddy.routes().some((x) => JSON.stringify(x).includes(HOST)), "やめたのに Caddy にルートが残った");
    assert.deepEqual(JSON.parse((await asAi("listPublished")).text).published, []);
    assert.match((await asAi("unpublishService", { service: "web" })).text, /公開していません/);
  });
});

test("パスワードは、窓口の返事・会話に届けるもの・覚えたものに出ない", async () => {
  await withDirectory(async ({ asAi, asHuman, deliveries, dirs }) => {
    const outputs: string[] = [];
    const first = await asAi("publishService", { service: "web" });
    outputs.push(first.text);
    const id = requestIdOf(first.text);
    outputs.push((await asHuman("approve_publish", { requestId: id, config: { auth: "basic", password: "short-pass" } })).text);
    outputs.push((await asHuman("approve_publish", { requestId: id, config: { auth: "basic", password: PASSWORD } })).text);
    outputs.push((await asHuman("get_publish_request", { requestId: id })).text);
    outputs.push((await asAi("listPublished")).text);
    outputs.push((await asAi("unpublishService", { service: "web" })).text);
    for (const o of [...outputs, ...deliveries.map((d) => JSON.stringify(d))]) {
      assert.ok(!o.includes(PASSWORD) && !o.includes("short-pass"), `パスワードが出た：${o}`);
    }
    for (const f of await readdir(dirs.directory)) {
      const text = await readFile(join(dirs.directory, f), "utf8");
      assert.ok(!text.includes(PASSWORD) && !text.includes("short-pass"), `${f} にパスワード`);
    }
  });
});

test("入口の画面：公開・承認待ち・まだ公開していないサーバを返し、やめると消える。人の刻印が無ければ断る", async () => {
  await withDirectory(async ({ asAi, asHuman, caddy, services }) => {
    services.push({ name: "api", ports: [4000], state: "running", listening: [], notListening: [4000] });
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    let ov = JSON.parse((await asHuman("get_publish_overview", { projectId: P1 })).text);
    assert.deepEqual(ov.pending.map((p: { requestId: string }) => p.requestId), [id]);
    assert.deepEqual(ov.published, []);
    // まだ公開していないサーバ：待ち受けているかも添える
    assert.deepEqual(
      ov.unpublished.map((s: { name: string; port: number; listening: boolean }) => [s.name, s.port, s.listening]),
      [["web", 3000, true], ["api", 4000, false]],
    );

    await asHuman("approve_publish", { requestId: id, config: { auth: "none" } });
    ov = JSON.parse((await asHuman("get_publish_overview", { projectId: P1 })).text);
    assert.equal(ov.published.length, 1);
    assert.equal(ov.published[0].url, `https://${HOST}`);
    assert.equal(ov.published[0].reachLabel.length > 0, true);
    assert.equal(ov.published[0].methodTitle, "Caddy のサブドメイン");
    assert.deepEqual(ov.unpublished.map((s: { name: string }) => s.name), ["api"], "公開したものは「まだ」に出さない");

    // AI（Project の刻印）からは呼べない
    assert.ok((await asAi("get_publish_overview", { projectId: P1 })).isError);
    assert.ok((await asAi("unpublish_route", { projectId: P1, method: "publish-caddy", service: "web", port: 3000 })).isError);

    const off = await asHuman("unpublish_route", { projectId: P1, method: "publish-caddy", service: "web", port: 3000 });
    assert.equal(off.isError, false, off.text);
    assert.ok(!caddy.routes().some((x) => JSON.stringify(x).includes(HOST)), "やめたのに Caddy にルートが残った");
    assert.deepEqual(JSON.parse((await asHuman("get_publish_overview", { projectId: P1 })).text).published, []);
    // 無い出し方は断る
    assert.match((await asHuman("unpublish_route", { projectId: P1, method: "nope", service: "web", port: 3000 })).text, /ありません/);
  });
});

test("入口の画面の HTML は launcher として名乗り、どの Project かを banto の文脈から読む", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-publish-directory-launcher-"));
  try {
    const server = bareDirectory(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const { resources } = await c.listResources();
    const launcher = resources.find((r) => (r._meta as Record<string, unknown>)?.["dev.banto/canvas"] === "launcher")!;
    assert.equal(launcher.uri, "ui://banto-publish-directory/published");
    assert.equal((launcher._meta as Record<string, unknown>)["dev.banto/visibility"], "admin");
    const html = ((await c.readResource({ uri: launcher.uri })).contents[0] as { text: string }).text;
    assert.match(html, /dev\.banto\/project/);
    assert.match(html, /get_publish_overview/);
    assert.match(html, /ui\/open-link/);
    await c.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("承認の画面は banto が渡す色の名前だけを使い、明暗の渡し直しに追随し、公開した URL は ui/open-link で開く", async () => {
  const { APPROVAL_APP_HTML } = await import("./approval-app.js");
  // 以前は渡されない名前（--mcp-ui-color-*）を使っていて、banto の色が当たっていなかった
  assert.doesNotMatch(APPROVAL_APP_HTML, /--mcp-ui-/);
  assert.match(APPROVAL_APP_HTML, /var\(--color-text-primary/);
  assert.match(APPROVAL_APP_HTML, /ui\/notifications\/host-context-changed/);
  assert.match(APPROVAL_APP_HTML, /ui\/open-link/);
  // 届く範囲の輪の名前（この画面の芯）
  for (const name of ["この機械", "LAN", "インターネット"]) assert.ok(APPROVAL_APP_HTML.includes(`"${name}"`), name);
});

test("承認の画面は、最初の選択を既定に戻したら自分で開いた「詳しい設定」を畳み直す（人が開けたものは畳まない）", async () => {
  const { APPROVAL_APP_HTML } = await import("./approval-app.js");
  // 2026-09-29、ユーザー指摘「いちど Basic 認証にすると、無しにしてもフォームが戻らない」。動きそのものは実ブラウザで確かめた
  assert.match(APPROVAL_APP_HTML, /target\.dataset\.key !== firstEnumKey/);
  assert.match(APPROVAL_APP_HTML, /else if \(autoOpenedMore\) \{\s*more\.open = false;/);
  assert.match(APPROVAL_APP_HTML, /sum\.addEventListener\("click", \(\) => \{ manualMore = true;/);
  // 実装が設定を断ったときに開く動きは残す
  assert.match(APPROVAL_APP_HTML, /if \(\$\("more"\)\) \$\("more"\)\.open = true;/);
});

// ---- Fable のレビュー（2026-09-28）で直したもの ----

// **人が Project の画面から押した呼び出しの中で、窓口はその Project の Service を読める**。読めないときは黙って空にせず、
// 「読めなかった（理由）」を返す。理由は「その Project に Service が無い」と「どの Project か中継が決められない」を分ける
test("入口の画面：Service の宛先が無いときは黙って空にせず理由を言う——Service が無いのか、どの Project か決められないのかを分ける", async () => {
  await withDirectory(async ({ call, asHuman }) => {
    // Project の画面から（host が forProject を刻む）なら読める
    const ok = JSON.parse((await asHuman("get_publish_overview", { projectId: P1 })).text);
    assert.equal(ok.servicesProblem, undefined);
    assert.deepEqual(ok.unpublished.map((s: { name: string }) => s.name), ["web"]);

    // その Project に Service の Module が無い
    const none = JSON.parse((await call("get_publish_overview", { projectId: P2 }, { "dev.banto/caller": { admin: true, forProject: P2 } })).text);
    assert.match(none.servicesProblem, /この Project に Service の Module がありません/);
    assert.deepEqual(none.unpublished, []);

    // banto 全体の画面から（Project が無い）——Service を入れろとは言わない
    const unknown = JSON.parse((await call("get_publish_overview", { projectId: P1 }, INSTANCE_ADMIN)).text);
    assert.match(unknown.servicesProblem, /どの Project のためのものか決められませんでした/);
    assert.doesNotMatch(unknown.servicesProblem, /Module を追加/, "決められないのに「Service を入れて」と嘘の案内を出した");

    // 画面が言う Project と banto が刻んだ Project が違えば断る（別々の Project の中身を1枚に混ぜない）
    const mixed = await asHuman("get_publish_overview", { projectId: P2 });
    assert.ok(mixed.isError);
    assert.match(mixed.text, /banto が渡した Project/);
  });
});

test("publishService：Service が無いのと、どの Project か中継が決められないのを取り違えない", async () => {
  await withDirectory(async ({ call }) => {
    const none = await call("publishService", { service: "web" }, { "dev.banto/caller": { project: P2 } });
    assert.match(none.text, /この Project に Service の Module がありません/);
    const unknown = await call("publishService", { service: "web" }, { "dev.banto/caller": { project: P1 } }, { ledger: false });
    assert.match(unknown.text, /決められませんでした/);
    assert.doesNotMatch(unknown.text, /Module を追加/);
  });
});

// **AI のターンと人の画面が同時に窓口を通っても、人の承認は断られない**。窓口は banto 全体で1接続なので、
// 呼び出しの印を中継に添えないと host は両方を混ぜ、ターン扱い（`{project}`）で publishRoute を刻んでいた
test("AI のターンが窓口で止まっている最中に人が「公開する」を押しても、人の刻印で公開できる", async () => {
  await withDirectory(async ({ asAi, asHuman, relayed, holdService, caddy }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    const release = holdService();
    // 同じ Project の AI が、別の公開を頼んでいる最中（Service の答えを待っている）
    const aiTurn = asAi("publishService", { service: "web" });
    await new Promise((r) => setTimeout(r, 20));
    try {
      const r = await asHuman("approve_publish", { requestId: id, config: { auth: "none" } });
      assert.equal(r.isError, false, r.text);
      const passed = relayed.find((c) => c.name === "publishRoute")!;
      assert.deepEqual(passed.stamp, { admin: true, forProject: P1 }, "人の承認が AI のターンの刻印で中継された");
      assert.ok(caddy.routes().some((x) => JSON.stringify(x).includes(HOST)));
    } finally {
      release();
    }
    // 止まっていた AI の頼みは、公開済みなので断られる（混ざっても AI の側が人の印を借りない）
    assert.match((await aiTurn).text, /もう公開しています/);
    const aiCalls = relayed.filter((c) => c.name === "listRoutes" && c.target === "publish-caddy");
    assert.deepEqual(aiCalls.at(-1)!.stamp, { project: P1 });
  });
});

// **会話に届けるのは、決めたことを書いてから**（届けてから書くと、書けなかったとき会話と頼みが食い違う）
test("承認・断りは、頼みの記録を書いてから会話に届ける", async () => {
  await withDirectory(async ({ asAi, asHuman, statesAtDelivery }) => {
    const a = requestIdOf((await asAi("publishService", { service: "web" })).text);
    await asHuman("approve_publish", { requestId: a, config: { auth: "none" } });
    await asAi("unpublishService", { service: "web" });
    const b = requestIdOf((await asAi("publishService", { service: "web" })).text);
    await asHuman("decline_publish", { requestId: b });
    // 同じ札を2つの頼みが持っているので、届けた時点での状態を順に見る
    assert.deepEqual(statesAtDelivery, ["published", "published,declined"]);
  });
});

// **道は張れたのに返事だけ落ちたら、公開したと確定させる**——押し直すと「もう公開しています」で断られ続けていた
test("publishRoute は通ったのに返事が落ちたら、実装の一覧にある公開を見て「公開した」と確定させる", async () => {
  await withDirectory(async ({ asAi, asHuman, deliveries, dropNextReply }) => {
    const id = requestIdOf((await asAi("publishService", { service: "web" })).text);
    dropNextReply("publishRoute");
    const r = await asHuman("approve_publish", { requestId: id, config: { auth: "none" } });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text), { state: "published", url: `https://${HOST}`, reach: "internet", reachLabel: "インターネット（URL を知っている誰でも）" });
    assert.equal(deliveries.length, 1);
    assert.match((await asHuman("approve_publish", { requestId: id, config: { auth: "none" } })).text, /もう答えが出ています（公開済み）/);
  });
});

// **公開中の Service が removeService されたら、その公開もやめる**（ユーザー決定の案A）。やめたことは一覧と入口の画面に出す。
// 承認待ちの頼みも取り下げる——人が承認するのは前の中身で、同じ名前で登録し直した別の中身をその承認で出さない
test("Service の登録が消されたら公開をやめ、一覧と入口の画面に出す。承認待ちの頼みも取り下げる", async () => {
  await withDirectory(async ({ asAi, asHuman, call, caddy, services }) => {
    const first = requestIdOf((await asAi("publishService", { service: "web" })).text);
    await asHuman("approve_publish", { requestId: first, config: { auth: "none" } });
    services.push({ name: "api", ports: [4000], state: "running", listening: [4000], notListening: [] });
    const pending = requestIdOf((await asAi("publishService", { service: "api" })).text);

    // 人の刻印・別の Project からは呼べない／触れない
    assert.match((await asHuman("serviceRemoved", { service: "web" })).text, /Project の Module（Service）からだけ/);
    const other = JSON.parse((await call("serviceRemoved", { service: "web" }, { "dev.banto/caller": { project: P2 } })).text);
    assert.deepEqual(other.unpublished, []);
    assert.ok(caddy.routes().some((x) => JSON.stringify(x).includes(HOST)), "別の Project から公開をやめられた");

    // Service（P1）が知らせる
    const web = await call("serviceRemoved", { service: "web" }, { "dev.banto/caller": { project: P1 } });
    assert.equal(web.isError, false, web.text);
    assert.deepEqual(JSON.parse(web.text).unpublished.map((u: { url: string; port: number }) => [u.url, u.port]), [[`https://${HOST}`, 3000]]);
    assert.ok(!caddy.routes().some((x) => JSON.stringify(x).includes(HOST)), "登録が消えたのに道が残った");
    const list = JSON.parse((await asAi("listPublished")).text);
    assert.deepEqual(list.published, []);
    assert.deepEqual(list.withdrawn.map((w: { url: string; service: string; reason: string }) => [w.url, w.service]), [[`https://${HOST}`, "web"]]);
    assert.match(list.withdrawn[0].reason, /登録「web」が消された/);
    const ov = JSON.parse((await asHuman("get_publish_overview", { projectId: P1 })).text);
    assert.equal(ov.withdrawn.length, 1);

    // 承認待ちの頼みを取り下げる——登録し直した中身をその承認で出さない
    const api = JSON.parse((await call("serviceRemoved", { service: "api" }, { "dev.banto/caller": { project: P1 } })).text);
    assert.deepEqual(api.withdrawnRequests.map((w: { requestId: string }) => w.requestId), [pending]);
    assert.deepEqual(JSON.parse((await asAi("listPublished")).text).pending, []);
    const late = await asHuman("approve_publish", { requestId: pending, config: { auth: "none" } });
    assert.ok(late.isError);
    assert.match(late.text, /取り下げた——Service の登録が消された/);
  });
});

test("Service の登録が消されたのに、公開をやめられない出し方があれば断る（Service は消すのをやめる）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-publish-directory-removed-"));
  try {
    const server = createPublishDirectoryServer({
      relay: {
        listTargets: async () => ({ targets: [{ name: "publish-x", roles: ["publish"] }], onBehalfOf: P1 }),
        callTool: async () => ({ text: "Caddy に繋がりません", isError: true }),
        deliver: async () => {},
      },
      requests: new RequestStore(dir),
      withdrawals: new WithdrawalLog(dir),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const r = await c.callTool({ name: "serviceRemoved", arguments: { service: "web" }, _meta: { "dev.banto/caller": { project: P1 } } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0]!.text, /やめられなかった出し方があります：publish-x：Caddy に繋がりません/);
    await c.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
