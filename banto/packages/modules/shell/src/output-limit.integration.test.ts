// **大きな出力で Shell が切れない**（追加・2026-09-29、banto.tjstkm.net で Shell が使えなくなり続けた件）。
//
// host と同じく **stdio で Shell を起こして**確かめる。MCP SDK の stdio は1通 10 MiB までしか受け取らず、
// 越えた返事が来ると host 側が接続を閉じて Shell は exit 0 で黙って消えた（`cp -al` のエラーが 12.1MB 出た）。
// runCommand を直接呼ぶ試験ではこの上限を通らないので、ここだけは本物の口を通す。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("10 MiB を越える出力でも Shell は切れず、全体はファイルに残り、返事は小さい", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "banto-shell-big-project-"));
  const homeDir = await mkdtemp(join(tmpdir(), "banto-shell-big-home-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.js", import.meta.url))],
    env: {
      ...(process.env as Record<string, string>),
      BANTO_PROJECT_ROOT: projectDir,
      BANTO_HOST_MCP_URL: "http://127.0.0.1:1/relay",
      BANTO_HOST_MCP_TOKEN: "unused",
      BANTO_SHELL_HOME: homeDir,
    },
  });
  const client = new Client({ name: "host", version: "0.0.0" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(transport);
    // 1行 100 文字 × 120,000 行 = 12,000,000 文字を stderr へ。最後に stdout へ終わりの印
    const line = "x".repeat(99);
    const r = await client.callTool(
      {
        name: "runCommand",
        arguments: { command: `yes '${line}' | head -n 120000 1>&2; echo rc=done`, timeout: 60 },
      },
      undefined,
      { timeout: 60_000 },
    );
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.ok(text.length < 20_000, `返事は小さい（${text.length} 文字）`);
    const result = JSON.parse(text) as {
      exitCode: number;
      stdout: string;
      stderr: string;
      stderrFile?: string;
      stdoutFile?: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "rc=done\n", "小さいほうのストリームはそのまま");
    assert.equal(result.stdoutFile, undefined);
    assert.ok(result.stderrFile, "あふれたストリームは保存先を返す");
    const saved = await readFile(result.stderrFile!, "utf8");
    assert.equal(saved.length, 12_000_000, "全体がファイルに残っている");

    // 切られていれば、ここで Not connected になる
    const again = await client.callTool({ name: "runCommand", arguments: { command: "echo still-here" } });
    const againResult = JSON.parse((again.content as Array<{ text: string }>)[0]!.text) as { stdout: string };
    assert.equal(againResult.stdout, "still-here\n");
    assert.equal(closed, false, "接続は閉じていない");
  } finally {
    await client.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
