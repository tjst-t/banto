/**
 * task-0026: 職人への指示が本当に届いたかを確かめる（PiRpcDriver.inject）。
 *
 * 実際に踏んだ不具合の再発防止：職人がターン中に指示を送ると pi は受け付けず、
 * こちらは stdin に書けたことだけで成功と見なしていたため、**質問への回答が黙って消えた**。
 * 職人は「答えを待っています」と言ったまま止まり、誰も原因に気づけなかった。
 *
 * LLM もネットワークも使わない。pi の代わりに RPC を喋る小さなスタブを起こす。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PiRpcDriver } from "@banto/worker-pool";

/**
 * pi の RPC モードの最小スタブ。
 *
 * - `get_state` には常に答える（ドライバの起動待ちがここを見ている）
 * - `prompt` は、STUB_REJECT=1 のとき「受け付けられない」と返す
 *   （本物が、ターン中に streamingBehavior 無しの prompt を受けたときの振る舞い）
 * - 受け取ったコマンドは RPC_LOG に書き出す
 */
const STUB = `
import * as fs from "node:fs";
import * as readline from "node:readline";

const log = process.env["RPC_LOG"];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  if (log) fs.appendFileSync(log, line + "\\n");

  if (cmd.type === "get_state") {
    process.stdout.write(JSON.stringify({
      id: cmd.id, type: "response", command: "get_state", success: true,
      data: { sessionId: "stub-session", sessionFile: process.env["STUB_SESSION_FILE"] },
    }) + "\\n");
    return;
  }
  if (cmd.type === "prompt") {
    const reject = process.env["STUB_REJECT"] === "1";
    process.stdout.write(JSON.stringify(
      reject
        ? { id: cmd.id, type: "response", command: "prompt", success: false, error: "already streaming" }
        : { id: cmd.id, type: "response", command: "prompt", success: true }
    ) + "\\n");
  }
});
setTimeout(() => process.exit(0), 30_000);
`;

let tmpDir: string;
let stubPath: string;

/** スタブを pi の代わりに使うドライバで職人を1人起こす。 */
async function spawnWithStub(name: string): Promise<{
  driver: PiRpcDriver;
  sessionId: string;
  rpcLog: string;
}> {
  const sessionDir = path.join(tmpDir, name, "sessions");
  const worktree = path.join(tmpDir, name, "wt");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const rpcLog = path.join(tmpDir, `${name}.log`);
  // スタブは環境変数で出力先を受け取る。子プロセスは spawn 時点の環境を引き継ぐので先に置く
  process.env["RPC_LOG"] = rpcLog;

  const driver = new PiRpcDriver({ sessionBaseDir: sessionDir, piCliPath: stubPath });
  const handle = await driver.spawn({
    taskId: name,
    worktreePath: worktree,
    sessionPath: path.join(sessionDir, `${name}.jsonl`),
    systemPrompt: "stub",
    tools: [],
  });
  return { driver, sessionId: handle.sessionId, rpcLog };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-inject-"));
  stubPath = path.join(tmpDir, "stub-pi.mjs");
  fs.writeFileSync(stubPath, STUB, "utf8");
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[task-0026] 職人への指示が届いたことを確かめる", () => {
  it("[task-0026] inject は pi の応答を待つ（書けた＝届いた、にしない）", async () => {
    const { driver, sessionId, rpcLog } = await spawnWithStub("ok");

    await driver.inject(sessionId, "答えです");

    const sent = fs
      .readFileSync(rpcLog, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const prompt = sent.find((c) => c["type"] === "prompt");
    assert.ok(prompt, "prompt が送られている");
    assert.equal(prompt!["message"], "答えです");
    assert.ok(typeof prompt!["id"] === "string", "応答を対応づけるため id を振っている");
    await driver.kill(sessionId);
  });

  it("[task-0026] 職人がターン中でも取りこぼさない（followUp で積む）", async () => {
    const { driver, sessionId, rpcLog } = await spawnWithStub("followup");

    await driver.inject(sessionId, "答えです");

    const prompt = fs
      .readFileSync(rpcLog, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((c) => c["type"] === "prompt");
    // これが無いと、ターン中の職人へ送った指示を pi が受け付けず黙って消える
    assert.equal(prompt!["streamingBehavior"], "followUp");
    await driver.kill(sessionId);
  });

  it("[task-0026] pi が受け付けなかったら失敗する（I2：成功に見せない）", async () => {
    const rpcLog = path.join(tmpDir, "reject.log");
    const sessionDir = path.join(tmpDir, "reject", "sessions");
    const worktree = path.join(tmpDir, "reject", "wt");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    // スタブに「受け付けない」振る舞いをさせる
    const prev = process.env["STUB_REJECT"];
    process.env["STUB_REJECT"] = "1";
    process.env["RPC_LOG"] = rpcLog;
    try {
      const driver = new PiRpcDriver({ sessionBaseDir: sessionDir, piCliPath: stubPath });
      const handle = await driver.spawn({
        taskId: "reject",
        worktreePath: worktree,
        sessionPath: path.join(sessionDir, "reject.jsonl"),
        systemPrompt: "stub",
        tools: [],
      });

      await assert.rejects(
        () => driver.inject(handle.sessionId, "消えてはいけない指示"),
        /rejected by pi/
      );
      await driver.kill(handle.sessionId);
    } finally {
      if (prev === undefined) delete process.env["STUB_REJECT"];
      else process.env["STUB_REJECT"] = prev;
    }
  });
});
