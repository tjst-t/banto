#!/usr/bin/env node
// install.sh の Cloudflare の部分（ゾーンを探す・A レコードを作る／直す・名前を替えたときに前のものを片づける）を、
// Cloudflare の API の偽物（cloudflare-fake.mjs）で確かめる。本物のトークンは使わない。install.sh を関数だけ読み込み
// （BANTO_INSTALL_LIB=1）、step_https と同じ形（環境変数でトークンを渡す）で cloudflare_upsert_records を呼ぶ。
//
//   node banto/scripts/install-test/cloudflare.test.mjs
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFakeCloudflare } from "./cloudflare-fake.mjs";

const installSh = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "install.sh");
const TOKEN = "fake-token-0123456789abcdefABCDEF";
const MARK = "banto install.sh";

const zones = [];
for (let i = 0; i < 55; i++) zones.push({ id: `z${i}`, name: `filler${i}.net` }); // 2ページ目まで読むか
zones.push({ id: "zex", name: "example.com" }, { id: "zlab", name: "lab.example.com" });
const fake = await startFakeCloudflare({ token: TOKEN, zones });
const { state } = fake;

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
async function upsert(domain, ip, { token = TOKEN, api = fake.base, old = "" } = {}) {
  const r = await run('source "$1"; CLOUDFLARE_API_TOKEN=$TOK cloudflare_upsert_records "$2" "$3" "$4"', [domain, ip, old], { BANTO_CLOUDFLARE_API: api, TOK: token });
  // トークンは出力に出ない
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "トークンが出力に出た");
  return r;
}

let passed = 0;
async function t(name, fn) {
  state.mutations.length = 0;
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

try {
  await t("無ければ2つとも作る（長く一致するゾーン・2ページ目まで読む・印を付ける）", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.10");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ゾーン：lab\.example\.com/);
    assert.deepEqual(state.mutations, [
      ["POST", "zlab", "banto.lab.example.com", "192.168.1.10", false, MARK],
      ["POST", "zlab", "*.banto.lab.example.com", "192.168.1.10", false, MARK],
    ]);
  });
  await t("同じなら触らない", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.10");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/そのまま/g) ?? []).length, 2);
    assert.deepEqual(state.mutations, []);
  });
  await t("IP が変われば直す", async () => {
    const r = await upsert("banto.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(state.mutations.map((m) => [m[0], m[3]]), [["PATCH", "192.168.1.20"], ["PATCH", "192.168.1.20"]]);
  });
  await t("proxied になっていれば外す", async () => {
    state.records.find((x) => x.name === "banto.lab.example.com").proxied = true;
    const r = await upsert("banto.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(state.mutations, [["PATCH", "zlab", "banto.lab.example.com", "192.168.1.20", false]]);
  });
  await t("名前を替えると、前の名前の印つき・このホスト向きだけを消し、ほかは「残っている」と出す", async () => {
    // 前の名前の *. は人が作ったもの（印なし）にしておく
    const wild = state.records.find((x) => x.name === "*.banto.lab.example.com");
    delete wild.comment;
    // 別のホストを向いた印つきのものも1つ（このホストのものではないので消さない）
    state.records.push({ id: "other", zone: "zlab", type: "A", name: "banto.lab.example.com", content: "10.9.9.9", proxied: false, comment: MARK });
    const r = await upsert("new.lab.example.com", "192.168.1.20", { old: "banto.lab.example.com" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(state.mutations.filter((m) => m[0] === "DELETE"), [["DELETE", "zlab", "banto.lab.example.com", "192.168.1.20"]]);
    assert.match(r.stdout, /残っている：banto\.lab\.example\.com → 10\.9\.9\.9（このホスト（192\.168\.1\.20）を向いていない/);
    assert.match(r.stdout, /残っている：\*\.banto\.lab\.example\.com → 192\.168\.1\.20（install\.sh が作った印が無い/);
    assert.equal(state.records.filter((x) => x.name === "new.lab.example.com" || x.name === "*.new.lab.example.com").length, 2);
  });
  await t("ゾーンの名前そのものも使える", async () => {
    const r = await upsert("example.com", "10.0.0.1");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(state.mutations.map((m) => [m[1], m[2]]), [["zex", "example.com"], ["zex", "*.example.com"]]);
  });
  await t("見えるゾーンに無ければ止まる", async () => {
    const r = await upsert("banto.other.org", "10.0.0.1");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /含むものがありません/);
    assert.deepEqual(state.mutations, []);
  });
  await t("トークンが違えば理由を出して止まる", async () => {
    const r = await upsert("banto.lab.example.com", "10.0.0.1", { token: "wrong-token-0123456789abcdef" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /9109 Invalid access token/);
  });
  await t("同じ名前の A が2つあれば決めずに止まる", async () => {
    state.records.push({ id: "dup", zone: "zlab", type: "A", name: "new.lab.example.com", content: "1.2.3.4", proxied: false });
    const r = await upsert("new.lab.example.com", "192.168.1.20");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 個あります/);
    assert.deepEqual(state.mutations, []);
  });
  await t("Cloudflare に届かなければ止まる", async () => {
    const r = await upsert("a.example.com", "1.1.1.1", { api: "http://127.0.0.1:1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /届きません/);
  });
  console.log(`\n${passed} 件とおった`);
} finally {
  fake.close();
}
