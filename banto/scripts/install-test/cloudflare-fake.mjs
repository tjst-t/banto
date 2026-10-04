#!/usr/bin/env node
// Cloudflare の API の偽物（install.sh が使う口だけ：ゾーンの一覧・A レコードの一覧・作る・直す・消す）。
// cloudflare.test.mjs が読み込んで使い、試験の場（run.sh）では中で単独で立てる。本物のトークンは使わない。
//
//   node cloudflare-fake.mjs --port 8787 --token <偽のトークン> --zones a.test,b.test [--seed '<レコードの JSON の配列>']
//
// 認証の要らない GET /__state で、今のレコードと書き換えの記録（mutations）を返す（試験が見るため）。
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** zones は名前の配列か {id, name} の配列 */
export function startFakeCloudflare({ token, zones, records = [], port = 0, host = "127.0.0.1" }) {
  const zoneList = zones.map((z, i) => (typeof z === "string" ? { id: `z-${i}-${z}`, name: z } : z));
  const state = { records: records.map((r, i) => ({ id: `seed${i}`, ...r })), mutations: [] };
  let nextId = 1;
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/__state") return send(200, state);
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null });
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "GET" && url.pathname === "/zones") {
        const per = Number(url.searchParams.get("per_page")), page = Number(url.searchParams.get("page"));
        return send(200, {
          success: true,
          result: zoneList.slice((page - 1) * per, page * per),
          result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(zoneList.length / per)) },
        });
      }
      const m = url.pathname.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
      if (!m) return send(404, { success: false, errors: [{ code: 7003, message: "no route" }] });
      const [, zone, recId] = m;
      if (req.method === "GET") {
        const type = url.searchParams.get("type"), name = url.searchParams.get("name");
        return send(200, { success: true, result: state.records.filter((r) => r.zone === zone && r.type === type && r.name === name) });
      }
      if (req.method === "DELETE") {
        const i = state.records.findIndex((x) => x.id === recId && x.zone === zone);
        if (i < 0) return send(404, { success: false, errors: [{ code: 81044, message: "Record does not exist." }] });
        const [r] = state.records.splice(i, 1);
        state.mutations.push(["DELETE", zone, r.name, r.content]);
        return send(200, { success: true, result: { id: recId } });
      }
      const data = JSON.parse(body);
      if (req.method === "POST") {
        const r = { id: `r${nextId++}`, zone, ...data };
        state.records.push(r);
        state.mutations.push(["POST", zone, data.name, data.content, data.proxied, data.comment ?? null]);
        return send(200, { success: true, result: r });
      }
      if (req.method === "PATCH") {
        const r = state.records.find((x) => x.id === recId && x.zone === zone);
        if (!r) return send(404, { success: false, errors: [{ code: 81044, message: "Record does not exist." }] });
        Object.assign(r, data);
        state.mutations.push(["PATCH", zone, r.name, r.content, r.proxied]);
        return send(200, { success: true, result: r });
      }
      send(405, { success: false, errors: [{ code: 0, message: "method" }] });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, host, () =>
      resolve({ state, zones: zoneList, base: `http://${host}:${server.address().port}`, close: () => server.close() }),
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const zones = arg("--zones", "").split(",").filter(Boolean);
  const records = JSON.parse(arg("--seed", "[]")).map((r) => ({ ...r, zone: `z-${zones.indexOf(r.zoneName)}-${r.zoneName}` }));
  const fake = await startFakeCloudflare({ token: arg("--token"), zones, records, port: Number(arg("--port", "8787")) });
  console.log(`偽の Cloudflare：${fake.base}（ゾーン ${zones.join(", ")}）`);
}
