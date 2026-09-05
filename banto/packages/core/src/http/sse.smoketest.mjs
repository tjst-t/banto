// 実API使用、手動確認用（自動テストには含めない）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../dist/event-store/log.js";
import { ProjectThreadStore } from "../../dist/project-thread/store.js";
import { InboxStore } from "../../dist/inbox/store.js";
import { HostRelayEndpoint, RelayRegistry } from "../../dist/relay/host-relay-endpoint.js";
import { createApp } from "../../dist/http/app.js";

const dir = await mkdtemp(join(tmpdir(), "banto-sse-smoke-"));
const log = new EventLog(dir);
await log.init();
const projectThread = new ProjectThreadStore(dir, log);
await projectThread.load();
const inbox = new InboxStore(dir, log);
await inbox.load();
const token = "smoke-token";

const server = createApp({
  projectThread,
  inbox,
  relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
  authToken: token,
  resolveModulesForThread: () => [],
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const project = await (
  await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "smoke", root: dir }) })
).json();
const thread = await (
  await fetch(`${base}/api/projects/${project.id}/threads`, { method: "POST", headers })
).json();

console.log("[test] starting turn via SSE...");
const res = await fetch(`${base}/api/threads/${thread.id}/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt: "Reply with exactly: pong" }),
});

const text = await res.text();
const events = text
  .split("\n\n")
  .filter((l) => l.startsWith("data: "))
  .map((l) => JSON.parse(l.slice(6)));

console.log("[test] received", events.length, "SSE events");
const done = events.find((e) => e.type === "done");
console.log("[test] done event:", done);

let failed = false;
if (!done?.sessionId) {
  console.error("FAIL: no sessionId in done event");
  failed = true;
}
const updatedThread = await (await fetch(`${base}/api/threads/${thread.id}`, { headers })).json();
if (updatedThread.resumePoint !== done?.sessionId) {
  console.error("FAIL: thread resumePoint was not updated to the session id");
  failed = true;
}

server.close();
await rm(dir, { recursive: true, force: true });
console.log(failed ? "RESULT: FAIL" : "RESULT: OK");
process.exit(failed ? 1 : 0);
