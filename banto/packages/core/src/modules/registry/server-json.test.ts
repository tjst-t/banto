import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePastedServerJson, ServerJsonParseError } from "./server-json.js";

const SERVER_JSON = JSON.stringify({
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "com.example/thing",
  description: "a thing",
  version: "1.0.0",
  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/v1" }],
});

test("`server.json` をそのまま貼れる", () => {
  const e = parsePastedServerJson(SERVER_JSON);
  assert.equal(e.server.name, "com.example/thing");
  assert.equal(e.server.remotes?.[0]?.url, "https://mcp.example.com/v1");
});

test("registry の応答ごと貼っても、同じに読む", () => {
  // 人は自分が見ている画面からコピーする——どちらの形で来ても受ける
  const wrapped = JSON.stringify({
    server: JSON.parse(SERVER_JSON),
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  });
  const e = parsePastedServerJson(wrapped);
  assert.equal(e.server.name, "com.example/thing");
  assert.equal(e.status, "active");
});

test("`mcpServers` を貼られたら、どちらの口かを名指しで言う", () => {
  // **「読めません」で終わらせない**（規則2）——貼り直す先を教える
  assert.throws(
    () => parsePastedServerJson('{"mcpServers":{"x":{"command":"npx"}}}'),
    (err: Error) => err instanceof ServerJsonParseError && /mcpServers/.test(err.message),
  );
});

test("JSON として読めないものは、その理由を言う", () => {
  assert.throws(
    () => parsePastedServerJson("{ これは JSON ではない"),
    (err: Error) => err instanceof ServerJsonParseError && /JSON として読めません/.test(err.message),
  );
});

test("`name` も `version` も無いものは断る（形を補わない）", () => {
  assert.throws(
    () => parsePastedServerJson('{"description":"なにか"}'),
    (err: Error) => err instanceof ServerJsonParseError && /name/.test(err.message),
  );
});

test("繋ぎ方が書かれていないものは、入れる前に断る", () => {
  // **入れてから気づくのでは遅い**——`packages` も `remotes` も無ければ繋げない
  assert.throws(
    () => parsePastedServerJson('{"name":"com.example/x","version":"1.0.0","description":""}'),
    (err: Error) => err instanceof ServerJsonParseError && /繋ぎ方/.test(err.message),
  );
});
