// 窓口を、**本物の Caddy の実装**（偽の Caddy を相手に）と、偽の Service に繋いで試す。
// 中継だけを差し替える——host がやること（刻印・その Project のための呼び出しの中でだけ Service が見える）を真似る。
// 刻印の決まりそのものは core の試験（host-relay-endpoint.test.ts）が見ている。

import { test } from "node:test";
import assert from "node:assert/strict";
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
import { RequestStore } from "./requests.js";
import type { RelayLike } from "./relay-client.js";

const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const ADMIN = { "dev.banto/caller": { admin: true } };
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

/** 偽の Service（listServices だけ） */
async function fakeService(rows: () => ServiceRow[]): Promise<Client> {
  const s = new Server({ name: "fake-service", version: "0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "listServices", inputSchema: { type: "object" } }] }));
  s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: JSON.stringify({ services: rows() }) }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "host", version: "0" });
  await Promise.all([s.connect(a), c.connect(b)]);
  return c;
}

interface Ctx {
  call(name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<{ text: string; isError: boolean; meta?: Record<string, unknown> }>;
  asAi(name: string, args?: Record<string, unknown>): ReturnType<Ctx["call"]>;
  asHuman(name: string, args?: Record<string, unknown>): ReturnType<Ctx["call"]>;
  caddy: FakeCaddy;
  services: ServiceRow[];
  deliveries: { replyTo: string; title: string; text: string; final: boolean }[];
  /** 窓口が実装に渡した呼び出し（名前と引数） */
  relayed: { target: string; name: string; args: Record<string, unknown> }[];
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
    resolveAddress: async () => "10.61.162.23",
    probe: async () => true,
    owner: caddyDir,
  });
  const impl = createPublishCaddyServer(publisher, store);
  const [ia, ib] = InMemoryTransport.createLinkedPair();
  const implClient = new Client({ name: "host", version: "0" });
  await Promise.all([impl.connect(ia), implClient.connect(ib)]);

  const services: ServiceRow[] = [{ name: "web", ports: [3000], state: "running", listening: [3000], notListening: [] }];
  const serviceClient = await fakeService(() => services);
  const deliveries: Ctx["deliveries"] = [];
  const relayed: Ctx["relayed"] = [];

  // host の刻印を真似る：AI のターンの中なら Project、人が画面で押したなら admin
  let stamp: Record<string, unknown> = {};
  const relay: RelayLike = {
    async listTargets() {
      const caller = (stamp["dev.banto/caller"] as object) ?? {};
      // Service は Project ごとの Module——その Project のための呼び出しの中でだけ見える。人が Project の中の画面
      // （入口）から押したときも、host はその Project の会話を台帳に置くので見える（core の ui-tool-call）
      const inProject = "project" in caller || "admin" in caller;
      return [...(inProject ? [{ name: "service-p1", roles: ["service"] }] : []), { name: "publish-caddy", roles: ["publish"] }];
    },
    async callTool(target, name, args) {
      relayed.push({ target, name, args });
      const client = target === "service-p1" ? serviceClient : target === "publish-caddy" ? implClient : undefined;
      if (!client) throw new Error(`unknown target ${target}`);
      const r = await client.callTool({ name, arguments: args, _meta: stamp });
      return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
    },
    async deliver(input) {
      deliveries.push(input);
    },
  };

  const directory = createPublishDirectoryServer({ relay, requests: new RequestStore(directoryDir) });
  const [da, db] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-or-canvas", version: "0" });
  await Promise.all([directory.connect(da), client.connect(db)]);
  const call: Ctx["call"] = async (name, args, meta) => {
    stamp = { "dev.banto/caller": (meta["dev.banto/caller"] as object) ?? undefined };
    if (!meta["dev.banto/caller"]) stamp = {};
    const r = await client.callTool({ name, arguments: args, _meta: meta });
    return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true, meta: r._meta as Record<string, unknown> | undefined };
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

const requestIdOf = (text: string) => text.match(/公開の承認の id：([0-9a-f-]{36})/)![1]!;

test("AI に見せるのは3つ。publishService は承認の画面を持ち、あとで結果を届けると名乗る。人の口は admin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-publish-directory-tools-"));
  try {
    const server = createPublishDirectoryServer({
      relay: { listTargets: async () => [], callTool: async () => ({ text: "", isError: true }), deliver: async () => {} },
      requests: new RequestStore(dir),
    });
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
    const server = createPublishDirectoryServer({
      relay: { listTargets: async () => [], callTool: async () => ({ text: "", isError: true }), deliver: async () => {} },
      requests: new RequestStore(dir),
    });
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
