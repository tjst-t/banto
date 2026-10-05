// `scripts/restart-when-idle.mjs` の試験（`node --test scripts/restart-when-idle.test.mjs`）。
//
// host は小さな http サーバ（答えを順に返し、最後のものを返し続ける）、systemctl と sudo は偽のスクリプト（PATH の先頭に置く）。
// 見るのは起こし直し方（sudo 無しで打ち、polkit に断られたときだけ sudo で打ち直す）と、何を待つか（既定は途中で切れる
// もの＝`blocking` だけ、`--all` と古い host は全部空くまで。2026-10-05）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "restart-when-idle.mjs");
const IDLE = {
  idle: true,
  onlyWaitingOnHuman: false,
  restartable: true,
  blocking: [],
  continuesAfterRestart: [],
  turns: [],
  awaitingReplies: [],
  moduleReplies: [],
  moduleCalls: [],
};
const TURN = { threadId: "t1", threadTitle: "作業中", projectName: "P", startedAt: new Date().toISOString(), hop: 0, queued: 0, waitingOnHuman: false };
const REPLY = { threadId: "t2", threadTitle: "調べもの", projectName: "P", module: "subagent", since: new Date().toISOString() };
const CALL = { threadId: "t1", threadTitle: "作業中", projectName: "P", connName: "shell-p1", origin: "turn" };
/** ターンが文を書いている・続けられる仕事が走っている——起き直したあと続く */
const CONTINUES = {
  ...IDLE,
  idle: false,
  continuesAfterRestart: [
    { kind: "turn", ...TURN },
    { kind: "reply", ...REPLY },
  ],
  turns: [TURN],
  awaitingReplies: [REPLY],
};
/** そのターンが tool を呼んでいる——切れると結果が分からない */
const BUSY = {
  ...CONTINUES,
  restartable: false,
  blocking: [{ kind: "call", waitingOnHuman: false, ...CALL }],
  moduleCalls: [CALL],
};
/** `restartable` を返さない古い host */
const OLD_IDLE = { idle: true, onlyWaitingOnHuman: false, turns: [], awaitingReplies: [], moduleCalls: [] };
const OLD_BUSY = { ...OLD_IDLE, idle: false, turns: [TURN] };

/**
 * `systemctlFails`：偽の systemctl が restart で返す言葉（無ければ通る）。`answers`：host が順に返す activity（最後のものを
 * 返し続ける）。返すのは終了コード・出力・打った systemctl・host が答えた回数
 */
async function run(systemctlFails, { answers = [IDLE], args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "restart-when-idle-test-"));
  let asked = 0;
  const server = createServer((_req, res) => {
    const answer = answers[Math.min(asked, answers.length - 1)];
    asked += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ port: server.address().port, authToken: "tok" }));
    const calls = join(dir, "calls.log");
    const fail = systemctlFails ? `echo "${systemctlFails}" >&2; exit 1` : "exit 0";
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n${fail}\n`);
    writeFileSync(join(dir, "sudo"), `#!/bin/sh\necho "sudo $*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(dir, "systemctl"), 0o755);
    chmodSync(join(dir, "sudo"), 0o755);
    const child = spawn(process.execPath, [SCRIPT, "--units", "a.service b.service", "--interval", "0.05", ...args], {
      env: { ...process.env, BANTO_CONFIG_PATH: join(dir, "config.json"), PATH: [dir, process.env.PATH].join(delimiter) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    return { code, out, asked, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
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

const RESTART = ["systemctl --no-ask-password restart a.service b.service"];

test("走っているターンと続けられる仕事だけなら（途中で切れるものが無ければ）、待たずに再起動する", T, async () => {
  const r = await run(undefined, { answers: [CONTINUES] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, RESTART);
  assert.equal(r.asked, 1, "待つものが無いのに聞き直した");
  assert.match(r.out, /途中で切れるものはありません。起き直したあと続くもの 2 件/);
});

test("実行中の呼び出し（blocking）は待ち、終われば（ターンがまだ走っていても）再起動する", T, async () => {
  const r = await run(undefined, { answers: [BUSY, BUSY, BUSY, CONTINUES] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, RESTART);
  assert.equal(r.asked, 4, "呼び出しが終わる前に再起動した");
  assert.match(r.out, /待つもの（切れると結果が分からなくなる）：\n  Module の呼び出し：shell-p1（AI のターンから・P \/ 作業中）/);
  assert.match(r.out, /起き直したあと続くもの（待たない）：\n  ターン：P \/ 作業中（走っている・\d+秒前から）\n  返事待ちの仕事：P \/ 調べもの（subagent・\d+秒前から）/);
});

test("--all：今までどおり全部（ターン・返事待ちの仕事も）空くまで待つ", T, async () => {
  const r = await run(undefined, { answers: [CONTINUES, CONTINUES, IDLE], args: ["--all"] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, RESTART);
  assert.equal(r.asked, 3, "--all なのに、走っているターンを待たずに再起動した");
  assert.match(r.out, /動いているものがなくなりました/);
});

test("restartable を返さない古い host には、全部空くまで待つ", T, async () => {
  const r = await run(undefined, { answers: [OLD_BUSY, OLD_BUSY, OLD_IDLE] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, RESTART);
  assert.equal(r.asked, 3, "古い host でターンが走っているのに再起動した");
  assert.match(r.out, /古い版です。全部が空くまで待ちます/);
});

test("--status：再起動してよければ 0、待つものがあれば 1（--all なら全部空のときだけ 0）。再起動はしない", T, async () => {
  for (const [answers, args, code] of [
    [[CONTINUES], [], 0],
    [[BUSY], [], 1],
    [[CONTINUES], ["--all"], 1],
    [[IDLE], ["--all"], 0],
  ]) {
    const r = await run(undefined, { answers, args: ["--status", ...args] });
    assert.equal(r.code, code, `${JSON.stringify(args)}：${r.out}`);
    assert.deepEqual(r.calls, []);
  }
});

test("--ignore-waiting-on-human は無くなった——黙って受けず、理由と --all を出して止まる（再起動しない）", T, async () => {
  const r = await run(undefined, { answers: [BUSY], args: ["--ignore-waiting-on-human"] });
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(r.calls, []);
  assert.equal(r.asked, 0);
  assert.match(r.out, /--ignore-waiting-on-human は無くなりました。人の返事待ちは既定で待ちません/);
  assert.match(r.out, /--all/);
});
