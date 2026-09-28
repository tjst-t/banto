// publish-caddy を、**偽の Caddy（HTTP）と本物の口**で試す。host の中継はアドレスを返す関数に、
// 「host から TCP で届くか」は決めた答えを返す関数に差し替える（どちらも host の外の都合で揺れない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import bcrypt from "bcryptjs";
import { HttpCaddyAdmin } from "./caddy-admin.js";
import { FakeCaddy, caddyfileLikeConfig } from "./fake-caddy.js";
import { CaddyPublisher } from "./publisher.js";
import { createPublishCaddyServer } from "./server.js";
import { PublishStore } from "./store.js";

const ADMIN = { "dev.banto/caller": { admin: true } };
const forProject = (project: string) => ({ "dev.banto/caller": { project } });
const P1 = "1a2b3c4d-0000-4000-8000-000000000001";
const P2 = "9f8e7d6c-0000-4000-8000-000000000002";
const PASSWORD = "correct-horse-battery-staple";

interface Ctx {
  client: Client;
  caddy: FakeCaddy;
  dir: string;
  /** Project → host から届くアドレス（無ければ「コンテナが止まっている」） */
  addresses: Map<string, string>;
  /** host がアドレスを確かめられない（Incus が答えない等）Project */
  flaky: Set<string>;
  /** host から TCP で届く「アドレス:ポート」 */
  listening: Set<string>;
  publisher: CaddyPublisher;
  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

async function withCaddy(fn: (ctx: Ctx) => Promise<void>, opts: { configured?: boolean; config?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "banto-publish-caddy-"));
  const caddy = new FakeCaddy(opts.config ?? caddyfileLikeConfig());
  const adminUrl = await caddy.start();
  const store = new PublishStore(dir);
  if (opts.configured !== false) await store.setSettings({ adminUrl, baseDomain: "banto.example.net", reach: "internet" });
  const addresses = new Map<string, string>([[P1, "10.61.162.23"], [P2, "10.61.162.40"]]);
  const listening = new Set<string>(["10.61.162.23:3000", "10.61.162.40:3000"]);
  const flaky = new Set<string>();
  const publisher = new CaddyPublisher({
    store,
    caddyFor: (s) => new HttpCaddyAdmin(s.adminUrl),
    resolveAddress: async (projectId) => {
      if (flaky.has(projectId)) throw new Error(`コンテナ banto-${projectId.slice(0, 8)} の状態を読めませんでした：時間切れ`);
      const a = addresses.get(projectId);
      if (!a) return { unavailable: `コンテナ banto-${projectId.slice(0, 8)} は動いていません（Stopped）` };
      return { address: a };
    },
    probe: async (address, port) => listening.has(`${address}:${port}`),
    owner: dir,
    now: () => new Date("2026-09-27T00:00:00Z"),
  });
  const server = createPublishCaddyServer(publisher, store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>, meta: Record<string, unknown> = ADMIN) => {
    const r = await client.callTool({ name, arguments: args, _meta: meta });
    return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
  };
  try {
    await fn({ client, caddy, dir, addresses, flaky, listening, publisher, call });
  } finally {
    await client.close();
    await caddy.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const publishArgs = (over: Record<string, unknown> = {}) => ({
  projectId: P1,
  service: "web",
  port: 3000,
  config: { auth: "basic", username: "me", password: PASSWORD },
  ...over,
});

/** 偽の Caddy の中で、そのホスト名に当たるルート */
function routeFor(caddy: FakeCaddy, host: string) {
  return caddy.routes().find((r) => (r.match as { host: string[] }[] | undefined)?.[0]?.host.includes(host));
}
function dialOf(route: Record<string, unknown> | undefined): string | undefined {
  return JSON.stringify(route).match(/"dial":"([^"]+)"/)?.[1];
}

test("道具は AI に見せない——窓口から呼ぶ部品の口（module）と、人の設定（admin）だけ", async () => {
  await withCaddy(async ({ client }) => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const v = (t._meta as Record<string, unknown>)["dev.banto/visibility"];
      assert.ok(v === "module" || v === "admin", `${t.name} が ${String(v)}`);
    }
    // 記録に残す引数に config（パスワード）を入れない
    const publish = tools.find((t) => t.name === "publishRoute")!;
    assert.deepEqual((publish._meta as Record<string, unknown>)["dev.banto/auditArgs"], ["projectId", "service"]);
  });
});

test("URL の決め方：既定は <サービス名>-<Project の id の先頭8文字>.<基のドメイン>、人が変えられる。見積もりは何も変えない", async () => {
  await withCaddy(async ({ call, caddy }) => {
    const plan = JSON.parse((await call("planPublish", { service: "web", port: 3000 }, forProject(P1))).text);
    assert.deepEqual(plan, { url: "https://web-1a2b3c4d.banto.example.net", hostname: "web-1a2b3c4d.banto.example.net", reach: "internet" });
    const custom = JSON.parse((await call("planPublish", { projectId: P1, service: "web", port: 3000, config: { subdomain: "demo" } })).text);
    assert.equal(custom.url, "https://demo.banto.example.net");
    const bad = await call("planPublish", { projectId: P1, service: "web", port: 3000, config: { subdomain: "Bad_Name" } });
    assert.ok(bad.isError);
    assert.match(bad.text, /サブドメイン/);
    // 別の Project の刻印では見積もれない
    assert.ok((await call("planPublish", { projectId: P2, service: "web", port: 3000 }, forProject(P1))).isError);
    assert.deepEqual(caddy.writes(), [], "見積もりで Caddy を書き換えた");
  });
});

test("公開は人の刻印があるときだけ——AI のターン（Project の刻印）からは断り、Caddy に触らない", async () => {
  await withCaddy(async ({ call, caddy, dir }) => {
    const r = await call("publishRoute", publishArgs(), forProject(P1));
    assert.ok(r.isError);
    assert.match(r.text, /人が承認の画面で押したときだけ/);
    const none = await call("publishRoute", publishArgs(), {});
    assert.ok(none.isError);
    assert.deepEqual(caddy.writes(), []);
    assert.deepEqual(await readdir(dir).then((f) => f.filter((x) => x.startsWith("routes"))), []);
  });
});

test("公開すると、まとめたルートより前に差し込み、Project のコンテナのアドレスへ中継する。Basic 認証はハッシュだけを渡す", async () => {
  await withCaddy(async ({ call, caddy, dir }) => {
    const r = await call("publishRoute", publishArgs());
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text), { url: "https://web-1a2b3c4d.banto.example.net", hostname: "web-1a2b3c4d.banto.example.net", reach: "internet" });
    const routes = caddy.routes();
    assert.deepEqual((routes[0]!.match as { host: string[] }[])[0]!.host, ["web-1a2b3c4d.banto.example.net"], "先頭に差し込んでいない");
    assert.equal(routes.length, 3);
    assert.equal(dialOf(routes[0]), "10.61.162.23:3000");
    // 認証は中継より前。パスワードは bcrypt（base64 で包む）で、元のパスワードで照合できる
    const handle = ((routes[0]!.handle as Record<string, unknown>[])[0]!.routes as { handle: Record<string, unknown>[] }[])[0]!.handle;
    assert.deepEqual(handle.map((h) => h.handler), ["authentication", "reverse_proxy"]);
    const account = (handle[0]!.providers as { http_basic: { accounts: { username: string; password: string }[] } }).http_basic.accounts[0]!;
    assert.equal(account.username, "me");
    assert.ok(await bcrypt.compare(PASSWORD, Buffer.from(account.password, "base64").toString("utf8")), "ハッシュが元のパスワードと合わない");
    // マスターは 0600
    assert.equal((await stat(join(dir, "routes.json"))).mode & 0o777, 0o600);
  });
});

test("パスワードは、返り値にも・一覧にも・覚えたものにも・Caddy に送ったものにも生で出ない", async () => {
  await withCaddy(async ({ call, caddy, dir }) => {
    const outputs: string[] = [];
    outputs.push((await call("publishRoute", publishArgs())).text);
    outputs.push((await call("listRoutes", {})).text);
    outputs.push((await call("listRoutes", {}, forProject(P1))).text);
    outputs.push((await call("unpublishRoute", { service: "web", port: 3000 }, forProject(P1))).text);
    // 同じ公開をもう一度（断られる経路の文言も見る）
    outputs.push((await call("publishRoute", publishArgs())).text);
    outputs.push((await call("publishRoute", publishArgs())).text);
    for (const o of outputs) assert.ok(!o.includes(PASSWORD), `返り値にパスワード：${o}`);
    for (const f of await readdir(dir)) {
      assert.ok(!(await readFile(join(dir, f), "utf8")).includes(PASSWORD), `${f} にパスワード`);
    }
    for (const req of caddy.requests) assert.ok(!req.body.includes(PASSWORD), `Caddy に生のパスワードを送った：${req.path}`);
    // 一覧にはハッシュも出さない
    for (const o of outputs) assert.ok(!/\$2[aby]\$|JDJ[hiy]JD/.test(o), `返り値にハッシュ：${o}`);
  });
});

test("host から届かない（止まっている・127.0.0.1 だけで待っている）なら断り、道を張らない", async () => {
  await withCaddy(async ({ call, caddy, listening, dir }) => {
    listening.clear();
    const r = await call("publishRoute", publishArgs());
    assert.ok(r.isError);
    assert.match(r.text, /10\.61\.162\.23:3000 に届きません/);
    assert.match(r.text, /0\.0\.0\.0/);
    assert.deepEqual(caddy.writes(), []);
    assert.deepEqual(await readdir(dir).then((f) => f.filter((x) => x.startsWith("routes"))), []);
  });
});

test("コンテナのアドレスが変わったら、突き合わせで行き先を直す。止まったら中継をやめて 503 にする", async () => {
  await withCaddy(async ({ call, caddy, addresses, listening, publisher }) => {
    await call("publishRoute", publishArgs());
    const host = "web-1a2b3c4d.banto.example.net";
    // DHCP で変わった
    addresses.set(P1, "10.61.162.77");
    listening.add("10.61.162.77:3000");
    const [st] = await publisher.reconcile();
    assert.equal(dialOf(routeFor(caddy, host)), "10.61.162.77:3000");
    assert.equal(st!.state, "active");
    // 止まった——前のアドレスを残すと、それを受け取った別のコンテナへ届けてしまう
    addresses.delete(P1);
    const [stopped] = await publisher.reconcile();
    assert.equal(stopped!.state, "project-stopped");
    assert.equal(dialOf(routeFor(caddy, host)), undefined, "止まったのに古い行き先へ中継している");
    assert.match(JSON.stringify(routeFor(caddy, host)), /"status_code":503/);
    // 認証は外さない（止まっている間も）
    assert.match(JSON.stringify(routeFor(caddy, host)), /"authentication"/);
    // 起き直したら戻る
    addresses.set(P1, "10.61.162.23");
    await publisher.reconcile();
    assert.equal(dialOf(routeFor(caddy, host)), "10.61.162.23:3000");
    // 変わっていないときは書かない（Caddy は書くたびに設定を読み直す）
    const before = caddy.writes().length;
    await publisher.reconcile();
    assert.equal(caddy.writes().length, before, "変わっていないのに書き換えた");
  });
});

// **アドレスを確かめられないだけなら、道に触らない**（2026-09-28、Fable のレビュー）。以前は理由を問わず 503 に
// 書き換えていたので、Incus が一瞬答えないだけで全部の公開が止まった。止まっている（確かに届かない）ときだけ 503
test("アドレスを確かめられない（一時の失敗）ときは、道を 503 にせずそのまま残し、状態は address-unknown。公開は断る", async () => {
  await withCaddy(async ({ call, caddy, flaky, publisher }) => {
    await call("publishRoute", publishArgs());
    const host = "web-1a2b3c4d.banto.example.net";
    const before = caddy.writes().length;
    flaky.add(P1);
    const [st] = await publisher.reconcile();
    assert.equal(st!.state, "address-unknown");
    assert.match(st!.problem ?? "", /時間切れ/);
    assert.equal(dialOf(routeFor(caddy, host)), "10.61.162.23:3000", "確かめられないだけで中継をやめた");
    assert.equal(caddy.writes().length, before, "確かめられないのに Caddy を書き換えた");
    // 新しい公開は、確かめられないなら張らない（理由つき）
    const r = await call("publishRoute", publishArgs({ service: "api", port: 3001, config: { auth: "none" } }));
    assert.equal(r.isError, true);
    assert.match(r.text, /確かめられません/);
    // 確かめられるようになったら元どおり
    flaky.delete(P1);
    const [back] = await publisher.reconcile();
    assert.equal(back!.state, "active");
  });
});

test("Caddyfile から読み込み直してルートが消えても、突き合わせで戻す", async () => {
  await withCaddy(async ({ call, caddy, publisher }) => {
    await call("publishRoute", publishArgs());
    caddy.reloadFromCaddyfile();
    assert.equal(routeFor(caddy, "web-1a2b3c4d.banto.example.net"), undefined);
    await publisher.reconcile();
    const routes = caddy.routes();
    assert.deepEqual((routes[0]!.match as { host: string[] }[])[0]!.host, ["web-1a2b3c4d.banto.example.net"]);
  });
});

test("公開をやめると Caddy のルートも消える。別の Project からはやめられない", async () => {
  await withCaddy(async ({ call, caddy }) => {
    await call("publishRoute", publishArgs());
    const other = await call("unpublishRoute", { projectId: P1, service: "web", port: 3000 }, forProject(P2));
    assert.ok(other.isError, "別の Project の公開をやめられた");
    assert.ok(routeFor(caddy, "web-1a2b3c4d.banto.example.net"));
    const r = JSON.parse((await call("unpublishRoute", { service: "web", port: 3000 }, forProject(P1))).text);
    assert.deepEqual(r, { removed: true, url: "https://web-1a2b3c4d.banto.example.net" });
    assert.equal(routeFor(caddy, "web-1a2b3c4d.banto.example.net"), undefined);
    assert.equal(caddy.routes().length, 2, "もとからある Caddy のルートまで消した");
    assert.deepEqual(JSON.parse((await call("listRoutes", {})).text).routes, []);
  });
});

test("やめるときに Caddy に届かなければ、記録からは消し、届いたときの突き合わせでルートを消す", async () => {
  await withCaddy(async ({ call, caddy, publisher }) => {
    await call("publishRoute", publishArgs());
    caddy.down = true;
    const r = JSON.parse((await call("unpublishRoute", { service: "web", port: 3000 }, forProject(P1))).text);
    assert.equal(r.removed, true);
    assert.match(r.note, /まだ消せていません/);
    caddy.down = false;
    assert.ok(routeFor(caddy, "web-1a2b3c4d.banto.example.net"), "前提：まだ残っている");
    await publisher.reconcile();
    assert.equal(routeFor(caddy, "web-1a2b3c4d.banto.example.net"), undefined);
  });
});

test("公開するときに Caddy に届かなければ断り、覚えない", async () => {
  await withCaddy(async ({ call, caddy }) => {
    caddy.down = true;
    const r = await call("publishRoute", publishArgs());
    assert.ok(r.isError);
    assert.match(r.text, /Caddy の admin に届きません/);
    caddy.down = false;
    assert.deepEqual(JSON.parse((await call("listRoutes", {})).text).routes, []);
  });
});

test("自分の印の付いた余りは片付け、他人の印（別の banto・人の設定）には触らない", async () => {
  await withCaddy(async ({ call, caddy, publisher }) => {
    await call("publishRoute", publishArgs());
    const mine = caddy.routes()[0]!["@id"] as string;
    const prefix = mine.slice(0, mine.lastIndexOf("-") + 1);
    caddy.routes().unshift({ "@id": `${prefix}0000000000000000`, match: [{ host: ["stale.banto.example.net"] }], terminal: true });
    caddy.routes().unshift({ "@id": "banto-publish-otherown-1111111111111111", match: [{ host: ["other.banto.example.net"] }], terminal: true });
    caddy.routes().unshift({ "@id": "hand-made", match: [{ host: ["hand.banto.example.net"] }], terminal: true });
    await publisher.reconcile();
    const ids = caddy.routes().map((r) => r["@id"]);
    assert.ok(!ids.includes(`${prefix}0000000000000000`), "自分の余りが残っている");
    assert.ok(ids.includes("banto-publish-otherown-1111111111111111"), "他の banto のルートを消した");
    assert.ok(ids.includes("hand-made"), "人が足したルートを消した");
    assert.ok(ids.includes(mine));
  });
});

test("同じホスト名を Caddy の別の設定が使っていたら断る。同じサービスとポートの二重の公開も断る", async () => {
  await withCaddy(async ({ call, caddy }) => {
    caddy.routes().unshift({ match: [{ host: ["taken.banto.example.net"] }], terminal: true });
    const taken = await call("publishRoute", publishArgs({ config: { auth: "none", subdomain: "taken" } }));
    assert.ok(taken.isError);
    assert.match(taken.text, /別の設定がもう使っています/);
    assert.equal((await call("publishRoute", publishArgs())).isError, false);
    const twice = await call("publishRoute", publishArgs({ config: { auth: "none", subdomain: "again" } }));
    assert.match(twice.text, /もう公開しています/);
  });
});

test("認証の設定項目：Basic ならパスワードが要る・知らない項目は断る・無しも選べる（認証の handler を付けない）", async () => {
  await withCaddy(async ({ call, caddy }) => {
    const describe = JSON.parse((await call("describePublishMethod", {}, forProject(P1))).text);
    assert.equal(describe.ready, true);
    assert.equal(describe.reach, "internet");
    assert.deepEqual(describe.configSchema.properties.auth.enum, ["none", "basic"]);
    // 既定は無し（決定・2026-09-28）——何も書かずに頼むと認証を付けない
    assert.equal(describe.configSchema.properties.auth.default, "none");
    assert.equal(describe.configSchema.properties.password.writeOnly, true);
    assert.match((await call("publishRoute", publishArgs({ config: { auth: "basic" } }))).text, /パスワードが要ります/);
    assert.match((await call("publishRoute", publishArgs({ config: { auth: "basic", password: "short" } }))).text, /12〜72/);
    assert.match((await call("publishRoute", publishArgs({ config: { auth: "none", passwrod: "typo" } }))).text, /知らない設定項目/);
    assert.deepEqual(caddy.writes(), []);
    assert.equal((await call("publishRoute", publishArgs({ config: {} }))).isError, false, "何も書かなければ認証なしで通る");
    const route = routeFor(caddy, "web-1a2b3c4d.banto.example.net");
    assert.ok(!JSON.stringify(route).includes("authentication"));
  });
});

test("一覧は Project の刻印ならその Project の分だけ。刻印が無ければ断る", async () => {
  await withCaddy(async ({ call }) => {
    await call("publishRoute", publishArgs());
    await call("publishRoute", publishArgs({ projectId: P2, config: { auth: "none" } }));
    const mine = JSON.parse((await call("listRoutes", {}, forProject(P2))).text).routes;
    assert.deepEqual(mine.map((r: { projectId: string }) => r.projectId), [P2]);
    assert.equal(mine[0].state, "active");
    assert.equal(mine[0].auth, "none");
    assert.equal(JSON.parse((await call("listRoutes", {})).text).routes.length, 2);
    assert.ok((await call("listRoutes", {}, {})).isError);
  });
});

test("設定がまだなら、使えないと名乗り、公開は Caddy に触らずに断る", async () => {
  await withCaddy(
    async ({ call, caddy }) => {
      const d = JSON.parse((await call("describePublishMethod", {}, forProject(P1))).text);
      assert.equal(d.ready, false);
      assert.match(d.problem, /基のドメイン/);
      assert.match((await call("publishRoute", publishArgs())).text, /基のドメイン/);
      assert.deepEqual(caddy.requests, []);
    },
    { configured: false },
  );
});

test("443 の server が複数あれば推測せず断り、設定で名前を決めればそこに足す", async () => {
  const config = caddyfileLikeConfig();
  const servers = (config.apps as { http: { servers: Record<string, unknown> } }).http.servers;
  servers.srv1 = { listen: [":443"], routes: [] };
  await withCaddy(
    async ({ call, caddy }) => {
      assert.match((await call("publishRoute", publishArgs())).text, /複数あります/);
      const settings = JSON.parse((await call("getCaddySettings", {})).text).settings;
      await call("setCaddySettings", { ...settings, serverName: "srv0" });
      assert.equal((await call("publishRoute", publishArgs())).isError, false);
      assert.ok(routeFor(caddy, "web-1a2b3c4d.banto.example.net"));
    },
    { config },
  );
});

test("設定の口は人の操作からだけ", async () => {
  await withCaddy(async ({ call }) => {
    assert.ok((await call("getCaddySettings", {}, forProject(P1))).isError);
    assert.ok((await call("setCaddySettings", { baseDomain: "evil.example" }, forProject(P1))).isError);
  });
});
