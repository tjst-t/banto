// 起動役を本物のプロセスとして起こし、「どう終わったか」の記録と終了コードを確かめる
// （systemd は止まった unit の終わり方を忘れるので、状態の判定はこの記録に頼る——壊すと状態が嘘になる）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmittedEvent } from "@banto/module-contract";
import type { ExitRecord } from "./log-wrapper.js";

const wrapper = fileURLToPath(new URL("./log-wrapper.js", import.meta.url));

async function runWrapper(command: string, opts: { termAfterMs?: number; cause?: string } = {}) {
  const base = await mkdtemp(join(tmpdir(), "banto-wrapper-"));
  // 置き場の名前がサービスの名前（unit.ts の serviceDir）
  const dir = join(base, "web");
  const outbox = join(base, ".outbox");
  await mkdir(dir);
  await writeFile(join(dir, "command.sh"), `${command}\n`);
  if (opts.cause) await writeFile(join(dir, "cause.json"), opts.cause);
  const child = spawn(process.execPath, [wrapper, dir, outbox], { stdio: "ignore" });
  if (opts.termAfterMs !== undefined) setTimeout(() => child.kill("SIGTERM"), opts.termAfterMs);
  const code = await new Promise<number | null>((res) => child.on("close", (c) => res(c)));
  const exit = JSON.parse(await readFile(join(dir, "exit.json"), "utf8")) as ExitRecord;
  const log = await readFile(join(dir, "log"), "utf8");
  const files = await readdir(outbox).catch(() => [] as string[]);
  const events = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(outbox, f), "utf8")) as EmittedEvent));
  await rm(base, { recursive: true, force: true });
  return { code, exit, log, events };
}

test("自分で終わった（終了コード 0）：止められた印は立てず、0 で抜ける。落ちていないので出来事は書かない", async () => {
  const { code, exit, log, events } = await runWrapper("echo hi; echo oops >&2; exit 0");
  assert.deepEqual(events, []);
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

test("止められた（SIGTERM）：止められた印を立て、0 で抜ける（起こし直させない）。出来事は書かない", async () => {
  const { code, exit, events } = await runWrapper("sleep 30", { termAfterMs: 300 });
  assert.deepEqual(events, []);
  assert.equal(code, 0);
  assert.equal(exit.stopRequested, true);
});

test("落ちたら service.crashed を出口の箱に書く——属性・ログの末尾・始めた呼び出しの印（Backlog #347）", async () => {
  const { code, events } = await runWrapper("echo 起きた; echo こわれた >&2; exit 7", { cause: JSON.stringify({ callId: "call-1" }) });
  assert.equal(code, 7);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.name, "service.crashed");
  assert.deepEqual(e.fields, { service: "web", exitCode: 7 });
  assert.deepEqual(e.causedBy, { callId: "call-1" });
  assert.ok(e.eventId);
  assert.match(e.text!, /Service「web」が落ちました（終了コード 7）/);
  assert.match(e.text!, /Z 起きた\n/);
  assert.match(e.text!, /Z \[stderr\] こわれた\n/);
});

test("信号で死んだら signal を添える。印のファイルが無ければ causedBy を付けない", async () => {
  const { events } = await runWrapper("kill -KILL $$");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.fields, { service: "web", signal: "SIGKILL" });
  assert.equal(events[0]!.causedBy, undefined);
});
