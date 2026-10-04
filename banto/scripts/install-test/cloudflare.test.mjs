#!/usr/bin/env node
// install.sh の Cloudflare の部分（ゾーンを探す・A レコードを作る／直す）を、Cloudflare の API の偽物で確かめる。
// 本物のトークンは使わない。install.sh を関数だけ読み込み（BANTO_INSTALL_LIB=1）、step_https と同じ形
// （環境変数でトークンを渡す）で cloudflare_upsert_records を呼ぶ。
//
//   node banto/scripts/install-test/cloudflare.test.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const installSh = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "install.sh");
const TOKEN = "fake-token-0123456789abcdefABCDEF";

// ---- 偽物の Cloudflare（使う口だけ） ----
const zones = [];
for (let i = 0; i < 55; i++) zones.push({ id: `z${i}`, name: `filler${i}.net` }); // 2ページ目まで読むか
zones.push({ id: "zex", name: "example.com" }, { id: "zlab", name: "lab.example.com" });
let records = [];
let mutations = [];
let nextId = 1;
const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });
  }
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/zones") {
      const per = Number(url.searchParams.get("per_page")), page = Number(url.searchParams.get("page"));
      return send(200, {
        success: true,
        result: zones.slice((page - 1) * per, page * per),
        result_info: { page, per_page: per, total_pages: Math.ceil(zones.length / per) },
      });
    }
    const m = url.pathname.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (!m) return send(404, { success: false, errors: [{ code: 7003, message: "no route" }] });
    const [, zoneId, recId] = m;
    if (req.method === "GET") {
      const type = url.searchParams.get("type"), name = url.searchParams.get("name");
      return send(200, { success: true, result: records.filter((r) => r.zone === zoneId && r.type === type && r.name === name) });
    }
    const data = JSON.parse(body);
    if (req.method === "POST") {
      const r = { id: `r${nextId++}`, zone: zoneId, ...data };
      records.push(r);
      mutations.push(["POST", zoneId, data.name, data.content, data.proxied]);
      return send(200, { success: true, result: r });
    }
    if (req.method === "PATCH") {
      const r = records.find((x) => x.id === recId && x.zone === zoneId);
      if (!r) return send(404, { success: false, errors: [{ code: 81044, message: "Record does not exist." }] });
      Object.assign(r, data);
      mutations.push(["PATCH", zoneId, r.name, r.content, r.proxied]);
      return send(200, { success: true, result: r });
    }
    send(405, { success: false, errors: [{ code: 0, message: "method" }] });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// 偽物は同じプロセスで動くので、spawnSync だと応えられない——非同期で流す
function run(script, args, env) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", script, "_", installSh, ...args], { env: { ...process.env, BANTO_INSTALL_LIB: "1", CLOUDFLARE_API_TOKEN: "", ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// step_https と同じ形（環境変数でトークンを渡す）で呼ぶ
async function upsert(domain, ip, token = TOKEN, api = base) {
  const r = await run('source "$1"; CLOUDFLARE_API_TOKEN=$TOK cloudflare_upsert_records "$2" "$3"', [domain, ip], { BANTO_CLOUDFLARE_API: api, TOK: token });
  // トークンは出力に出ない
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "トークンが出力に出た");
  return r;
}

let passed = 0;
async function t(name, fn) {
  mutations = [];
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

try {
  await t("無ければ2つとも作る（長く一致するゾーン・2ページ目まで読む）", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.10");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ゾーン：lab\.example\.com/);
    assert.deepEqual(mutations, [
      ["POST", "zlab", "banto.lab.example.com", "192.168.1.10", false],
      ["POST", "zlab", "*.banto.lab.example.com", "192.168.1.10", false],
    ]);
  });
  await t("同じなら触らない", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.10");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/そのまま/g) ?? []).length, 2);
    assert.deepEqual(mutations, []);
  });
  await t("IP が変われば直す", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutations.map((m) => [m[0], m[3]]), [["PATCH", "192.168.1.20"], ["PATCH", "192.168.1.20"]]);
  });
  await t("proxied になっていれば外す", async () => {
    records.find((x) => x.name === "banto.lab.example.com").proxied = true;
    const r = await upsert("banto.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutations, [["PATCH", "zlab", "banto.lab.example.com", "192.168.1.20", false]]);
  });
  await t("ゾーンの名前そのものも使える", async () => {
    const r = await upsert("example.com", "10.0.0.1");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(mutations.map((m) => [m[1], m[2]]), [["zex", "example.com"], ["zex", "*.example.com"]]);
  });
  await t("見えるゾーンに無ければ止まる", async () => {
    const r = await upsert("banto.other.org", "10.0.0.1");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /含むものがありません/);
    assert.deepEqual(mutations, []);
  });
  await t("トークンが違えば理由を出して止まる", async () => {
    const r = await upsert("banto.lab.example.com", "10.0.0.1", "wrong-token-0123456789abcdef");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /9109 Invalid access token/);
  });
  await t("同じ名前の A が2つあれば決めずに止まる", async () => {
    records.push({ id: "dup", zone: "zlab", type: "A", name: "banto.lab.example.com", content: "1.2.3.4", proxied: false });
    const r = await upsert("banto.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 個あります/);
    assert.deepEqual(mutations, []);
  });
  await t("Cloudflare に届かなければ止まる", async () => {
    const r = await upsert("a.example.com", "1.1.1.1", TOKEN, "http://127.0.0.1:1");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /届きません/);
  });
  console.log(`\n${passed} 件とおった`);
} finally {
  server.close();
}
