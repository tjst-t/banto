// `scripts/restart-when-idle.mjs` の試験（`node --test scripts/restart-when-idle.test.mjs`）。
//
// host は小さな http サーバ（いつも空いている）、systemctl と sudo は偽のスクリプト（PATH の先頭に置く）。
// 見るのは起こし直し方だけ：sudo 無しで打ち、polkit に断られたときだけ sudo で打ち直す。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "restart-when-idle.mjs");
const IDLE = { idle: true, onlyWaitingOnHuman: false, turns: [], awaitingReplies: [], moduleCalls: [] };

/** `systemctlFails`：偽の systemctl が restart で返す言葉（無ければ通る） */
async function run(systemctlFails) {
  const dir = mkdtempSync(join(tmpdir(), "restart-when-idle-test-"));
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(IDLE)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ port: server.address().port, authToken: "tok" }));
    const calls = join(dir, "calls.log");
    const fail = systemctlFails ? `echo "${systemctlFails}" >&2; exit 1` : "exit 0";
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n${fail}\n`);
    writeFileSync(join(dir, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(dir, "systemctl"), 0o755);
    chmodSync(join(dir, "sudo"), 0o755);
    const child = spawn(process.execPath, [SCRIPT, "--units", "a.service b.service", "--interval", "0.05"], {
      env: { ...process.env, BANTO_CONFIG_PATH: join(dir, "config.json"), PATH: [dir, process.env.PATH].join(delimiter) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    return { code, out, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = { timeout: 20_000 };

test("polkit の規則がある host：sudo 無しの systemctl restart で済ませる（sudo は打たない）", T, async () => {
  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, ["systemctl --no-ask-password restart a.service b.service"]);
});

test("polkit に断られたら（Interactive authentication required・Access denied）、sudo で打ち直す", T, async () => {
  for (const message of [
    "Failed to restart a.service: Interactive authentication required.",
    "Failed to restart a.service: Access denied",
  ]) {
    const r = await run(message);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["systemctl --no-ask-password restart a.service b.service", "sudo systemctl restart a.service b.service"], message);
  }
});

test("断られた以外の失敗（unit が起きない等）は sudo で打ち直さず、失敗で終わる", T, async () => {
  const r = await run("Job for a.service failed because the control process exited with error code.");
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.calls, ["systemctl --no-ask-password restart a.service b.service"]);
  assert.match(r.out, /Job for a\.service failed/);
});
