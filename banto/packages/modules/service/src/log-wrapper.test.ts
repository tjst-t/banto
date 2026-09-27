// 起動役を本物のプロセスとして起こし、「どう終わったか」の記録と終了コードを確かめる
// （systemd は止まった unit の終わり方を忘れるので、状態の判定はこの記録に頼る——壊すと状態が嘘になる）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExitRecord } from "./log-wrapper.js";

const wrapper = fileURLToPath(new URL("./log-wrapper.js", import.meta.url));

async function runWrapper(command: string, opts: { termAfterMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "banto-wrapper-"));
  await writeFile(join(dir, "command.sh"), `${command}\n`);
  const child = spawn(process.execPath, [wrapper, dir], { stdio: "ignore" });
  if (opts.termAfterMs !== undefined) setTimeout(() => child.kill("SIGTERM"), opts.termAfterMs);
  const code = await new Promise<number | null>((res) => child.on("close", (c) => res(c)));
  const exit = JSON.parse(await readFile(join(dir, "exit.json"), "utf8")) as ExitRecord;
  const log = await readFile(join(dir, "log"), "utf8");
  await rm(dir, { recursive: true, force: true });
  return { code, exit, log };
}

test("自分で終わった（終了コード 0）：止められた印は立てず、0 で抜ける", async () => {
  const { code, exit, log } = await runWrapper("echo hi; echo oops >&2; exit 0");
  assert.equal(code, 0);
  assert.equal(exit.code, 0);
  assert.equal(exit.stopRequested, false);
  assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z hi$/m);
  assert.match(log, /Z \[stderr\] oops$/m);
});

test("落ちた（終了コード 3）：そのコードで抜ける（systemd に起こし直させる）", async () => {
  const { code, exit } = await runWrapper("exit 3");
  assert.equal(code, 3);
  assert.equal(exit.code, 3);
  assert.equal(exit.stopRequested, false);
});

test("止められた（SIGTERM）：止められた印を立て、0 で抜ける（起こし直させない）", async () => {
  const { code, exit } = await runWrapper("sleep 30", { termAfterMs: 300 });
  assert.equal(code, 0);
  assert.equal(exit.stopRequested, true);
});
