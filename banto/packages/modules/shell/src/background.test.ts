// **待たずに流したコマンド**（決定・2026-10-07、docs/specs/v4-modules.md §2.3「待たない形」）。
//
// 本物の起動役（`background-wrapper.js`）を、systemd の代わりに Shell から切り離した子として起こす（`DetachedLauncher`）。
// 見るもの：
//   - 待たずに流すとすぐ返り（あとで届けると約束）、終わったら札で終了コード・出力の末尾が届く
//   - 秘密は置き場（host のディスク）に残らず、環境のファイルは起動役が消す。札そのものは置き場に書かない
//   - 一覧・止める口は流した Thread の分だけ
//   - 起こし直しをまたぐ：Shell を捨てて立て直し、host の問いに「続ける」と答えて届ける
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CALLER_META_KEY,
  CALLER_MODULE_META_KEY,
  CARD_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  REPLY_TO_META_KEY,
  RESUME_AFTER_RESTART_TOOL,
  THREAD_META_KEY,
  fillCardText,
  replyToFingerprint,
} from "@banto/module-contract";
import { createShellServer } from "./server.js";
import { BackgroundCommands, type DeliverInput } from "./background.js";
import { DetachedLauncher } from "./background-launcher.js";
import { tailLines, type JobRecord, type StartedRecord } from "./background-files.js";
import type { HostRelayClient } from "./host-relay-client.js";

const WRAPPER = fileURLToPath(new URL("./background-wrapper.js", import.meta.url));
const THREAD = { projectId: "p1", threadId: "t1" };
const OTHER_THREAD = { projectId: "p1", threadId: "t2" };
const SECRET = "BG-SECRET-VALUE-7f3a";

type ToolResult = { content: { text: string }[]; isError?: boolean; _meta?: Record<string, unknown> };

interface Dirs {
  root: string;
  project: string;
  commands: string;
  secrets: string;
}

function fakeRelay(): HostRelayClient {
  return {
    lookupAlias: async (_d: string, name: string) => ({ implementation: "vault", name, group: "instance" }),
    resolveAlias: async () => SECRET,
    startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
    close: async () => undefined,
  } as unknown as HostRelayClient;
}

/** 同じ置き場で Shell を立てる（起き直しは、同じ置き場で立て直すこと） */
async function startShell(
  dirs: Dirs,
  opts: { deliver?: (input: DeliverInput) => Promise<unknown>; background?: false; pollMs?: number } = {},
) {
  const delivered: DeliverInput[] = [];
  const background =
    opts.background === false
      ? undefined
      : new BackgroundCommands({
          dir: dirs.commands,
          secretsDir: dirs.secrets,
          projectRoot: dirs.project,
          launcher: new DetachedLauncher(process.execPath, WRAPPER),
          deliver:
            opts.deliver ??
            (async (input) => {
              delivered.push(input);
              return { deliveryId: `d${delivered.length}`, wake: "now" };
            }),
          pollMs: opts.pollMs ?? 50,
        });
  const server = createShellServer({
    projectRoot: dirs.project,
    relayClient: fakeRelay(),
    ...(background ? { background } : { backgroundUnavailable: "試験：待たない形を持たない Shell" }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as ToolResult;
  const waitDelivered = async (n: number, ms = 15_000) => {
    for (let waited = 0; waited < ms && delivered.length < n; waited += 50) await new Promise((r) => setTimeout(r, 50));
    assert.equal(delivered.length, n, `届いた数が違う：${JSON.stringify(delivered.map((d) => d.title))}`);
  };
  return {
    client,
    call,
    delivered,
    waitDelivered,
    background,
    /** Shell が落ちたのと同じ：見張りを止めて接続を切る（コマンドは止めない） */
    close: async () => {
      background?.close();
      await client.close();
    },
  };
}

async function withDirs(fn: (dirs: Dirs) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "shell-bg-"));
  const dirs = { root, project: join(root, "project"), commands: join(root, "data", "commands"), secrets: join(root, "run") };
  mkdirSync(dirs.project, { recursive: true });
  try {
    await fn(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stamp = (thread = THREAD, replyTo = "reply_THIS-IS-THE-HANDLE-ITSELF") => ({ [REPLY_TO_META_KEY]: replyTo, [THREAD_META_KEY]: thread });

async function runInBackground(
  shell: Awaited<ReturnType<typeof startShell>>,
  args: Record<string, unknown>,
  meta: Record<string, unknown> = stamp(),
): Promise<{ commandId: string; outputFile: string; result: ToolResult }> {
  const result = await shell.call("runCommand", { runInBackground: true, ...args }, meta);
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const body = JSON.parse(result.content[0]!.text) as { commandId: string; outputFile: string; status: string };
  assert.equal(body.status, "running");
  return { commandId: body.commandId, outputFile: body.outputFile, result };
}

const deliveredBody = (d: DeliverInput) => JSON.parse(d.text) as Record<string, unknown> & { tail: string; exitCode: number | null; status: string };

/** 置き場の全ファイルの中身（秘密・札が書かれていないかを見る） */
function allFileText(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out += readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return out;
}

const readJob = (dirs: Dirs, id: string) => JSON.parse(readFileSync(join(dirs.commands, id, "job.json"), "utf8")) as JobRecord;
const readStarted = (dirs: Dirs, id: string) => JSON.parse(readFileSync(join(dirs.commands, id, "started.json"), "utf8")) as StartedRecord;

// ---- 名乗り ----------------------------------------------------------------------------------------------

test("名乗り：runCommand は終わったら届ける・カードの題はコマンド、Module は起こし直しても続けられる、道具が2本増える", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const { tools } = await shell.client.listTools();
      const run = tools.find((t) => t.name === "runCommand")!;
      assert.equal(run._meta?.[DELIVERS_LATER_META_KEY], true);
      const card = run._meta?.[CARD_META_KEY] as { title: string };
      assert.equal(fillCardText(card.title, { command: "npm run e2e" }), "npm run e2e");
      assert.ok((run.inputSchema.properties as Record<string, unknown>).runInBackground, "runInBackground の引数が無い");
      for (const name of ["listCommands", "cancelCommand"]) {
        assert.equal(tools.find((t) => t.name === name)?._meta?.["dev.banto/visibility"], "agent", name);
      }
      assert.equal(tools.find((t) => t.name === RESUME_AFTER_RESTART_TOOL)?._meta?.["dev.banto/visibility"], "admin");
      const { resources } = await shell.client.listResources();
      const declared = resources.find((r) => r._meta?.[MODULE_META_KEY])!._meta![MODULE_META_KEY] as { resumesAfterRestart?: boolean };
      assert.equal(declared.resumesAfterRestart, true);
    } finally {
      await shell.close();
    }
  });
});

// ---- 待たずに流して、届く ----------------------------------------------------------------------------------

test("待たずに流すとすぐ返り、終わったら札で終了コードと出力の末尾 50 行が届く。出力は stdout と stderr を1つのファイルに", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const started = Date.now();
      const command = "for i in $(seq 1 80); do echo line-$i; done; sleep 0.2; echo to-stderr 1>&2; sleep 0.5; echo last-line; exit 3";
      const { commandId, outputFile, result } = await runInBackground(shell, { command });
      assert.ok(Date.now() - started < 5_000, "待たない形なのに待った");
      assert.equal(result._meta?.[PENDING_REPLY_META_KEY], true, "あとで届けると約束していない");
      assert.equal(shell.delivered.length, 0, "返す前に届いた");
      assert.equal(outputFile, join(dirs.commands, commandId, "output.log"));

      await shell.waitDelivered(1);
      const d = shell.delivered[0]!;
      assert.equal(d.replyTo, "reply_THIS-IS-THE-HANDLE-ITSELF");
      assert.equal(d.final, true);
      assert.match(d.title, /^コマンドが失敗しました（終了コード 3）：for i in/);
      assert.ok(d.text.startsWith('{"exitCode":3,'), `終了コードが先頭に無い：${d.text.slice(0, 40)}`);
      const body = deliveredBody(d);
      assert.equal(body.status, "exited");
      assert.equal(body.commandId, commandId);
      assert.equal(body.outputFile, outputFile);
      const tail = body.tail.split("\n");
      assert.equal(tail.length, 50, "末尾が 50 行ではない");
      assert.equal(tail.at(-1), "last-line");
      assert.equal(tail.at(-2), "to-stderr");
      assert.equal(tail[0], "line-33");
      const whole = readFileSync(outputFile, "utf8");
      assert.ok(whole.startsWith("line-1\nline-2\n"), "全体がファイルに無い");
      assert.ok(whole.includes("to-stderr\n"), "stderr がファイルに無い");

      // 一覧：終わった（終了コード）
      const list = JSON.parse((await shell.call("listCommands", {}, { [THREAD_META_KEY]: THREAD })).content[0]!.text) as {
        commands: Array<{ commandId: string; status: string; exitCode: number; command: string; cwd: string }>;
      };
      assert.deepEqual(
        list.commands.map((c) => [c.commandId, c.status, c.exitCode, c.cwd]),
        [[commandId, "exited", 3, "."]],
      );
    } finally {
      await shell.close();
    }
  });
});

test("秘密：envSecrets の値はコマンドに届き、置き場（host のディスク）にも環境のファイルにも残らない。札そのものも書かない。secretFiles は終わったら消える", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const { commandId } = await runInBackground(shell, {
        // コマンドに秘密そのものを書かない（書けば job.json に残るのは当たり前）——指紋で比べる
        command: `[ "$(printf %s "$TOKEN" | sha256sum | cut -c1-16)" = "${createHash("sha256").update(SECRET).digest("hex").slice(0, 16)}" ] && echo token-ok; cat .npmrc | wc -c; sleep 0.3`,
        envSecrets: { TOKEN: "some-alias" },
        secretFiles: { ".npmrc": "npm-alias" },
      });
      // 起動役が起きたら、環境のファイルはもう無い
      assert.deepEqual(readdirSync(dirs.secrets), [], "環境のファイルが残っている");
      await shell.waitDelivered(1);
      const body = deliveredBody(shell.delivered[0]!);
      assert.equal(body.exitCode, 0, body.tail);
      assert.match(body.tail, /token-ok/);
      assert.match(body.tail, new RegExp(`^${SECRET.length}$`, "m"));
      assert.equal(existsSync(join(dirs.project, ".npmrc")), false, "secretFiles が消えていない");
      const onDisk = allFileText(dirs.commands);
      assert.ok(onDisk.includes("token-ok"), "置き場の中身を読めていない（試験の前提）");
      assert.ok(!onDisk.includes(SECRET), "秘密が置き場に書かれた");
      assert.ok(!onDisk.includes("reply_THIS-IS-THE-HANDLE-ITSELF"), "札そのものが置き場に書かれた");
      assert.equal(readJob(dirs, commandId).replyToFingerprint, replyToFingerprint("reply_THIS-IS-THE-HANDLE-ITSELF"));
    } finally {
      await shell.close();
    }
  });
});

test("1行が極端に長い出力は、届ける末尾で切る（1通を膨らませない）", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      await runInBackground(shell, { command: "head -c 300000 /dev/zero | tr '\\0' x; echo; echo end" });
      await shell.waitDelivered(1);
      const d = shell.delivered[0]!;
      assert.ok(d.text.length < 20_000, `届ける本文が大きい：${d.text.length}`);
      const tail = deliveredBody(d).tail;
      assert.match(tail, /^…?x{999,1000}…（この行の残り \d+ 文字を省きました）\nend$/);
      assert.ok(tail.endsWith("\nend"));
    } finally {
      await shell.close();
    }
  });
});

test("時間切れ：timeout を書けば起動役が止め、時間切れとして届く", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      await runInBackground(shell, { command: "echo begin; sleep 30", timeout: 1 });
      await shell.waitDelivered(1, 20_000);
      const d = shell.delivered[0]!;
      assert.match(d.title, /^コマンドが時間切れで止まりました/);
      assert.equal(deliveredBody(d).status, "timedOut");
      assert.match(deliveredBody(d).tail, /begin/);
    } finally {
      await shell.close();
    }
  });
});

// ---- 断るもの --------------------------------------------------------------------------------------------

test("断る：札が無い（Thread の無い呼び出し）・待たない形を持たない Shell。どちらも何も流さない", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const noHandle = await shell.call("runCommand", { command: "touch should-not-exist", runInBackground: true }, { [THREAD_META_KEY]: THREAD });
      assert.equal(noHandle.isError, true);
      assert.match(noHandle.content[0]!.text, /届ける先がありません/);
      assert.equal(existsSync(dirs.commands) ? readdirSync(dirs.commands).length : 0, 0);
    } finally {
      await shell.close();
    }
    const without = await startShell(dirs, { background: false });
    try {
      const refused = await without.call("runCommand", { command: "touch should-not-exist", runInBackground: true }, stamp());
      assert.equal(refused.isError, true);
      assert.match(refused.content[0]!.text, /待たない形が使えません（試験：待たない形を持たない Shell）/);
      assert.equal(existsSync(join(dirs.project, "should-not-exist")), false);
      // 待つ形はそのまま使える（札があっても、あとで届けるとは言わない）
      const waited = await without.call("runCommand", { command: "echo waited" }, stamp());
      assert.equal(JSON.parse(waited.content[0]!.text).stdout, "waited\n");
      assert.equal(waited._meta?.[PENDING_REPLY_META_KEY], undefined);
    } finally {
      await without.close();
    }
  });
});

// ---- 一覧・止める ----------------------------------------------------------------------------------------

test("一覧と止める口は、流した Thread の分だけ。止めると「止めました」が届き、一覧は cancelled", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const mine = await runInBackground(shell, { command: "echo mine-started; sleep 60" }, stamp(THREAD, "reply_A"));
      const theirs = await runInBackground(shell, { command: "sleep 60" }, stamp(OTHER_THREAD, "reply_B"));
      const listOf = async (meta?: Record<string, unknown>) =>
        (JSON.parse((await shell.call("listCommands", {}, meta)).content[0]!.text) as { commands: Array<{ commandId: string; status: string }> })
          .commands;
      assert.deepEqual((await listOf({ [THREAD_META_KEY]: THREAD })).map((c) => [c.commandId, c.status]), [[mine.commandId, "running"]]);
      assert.deepEqual((await listOf({ [THREAD_META_KEY]: OTHER_THREAD })).map((c) => c.commandId), [theirs.commandId]);
      // Thread の印が無い呼び出し（人の画面など）は全部
      assert.equal((await listOf()).length, 2);

      // 別の Thread からは止められない・印の無い呼び出しも断る
      const fromOther = await shell.call("cancelCommand", { commandId: mine.commandId }, { [THREAD_META_KEY]: OTHER_THREAD });
      assert.equal(fromOther.isError, true);
      assert.match(fromOther.content[0]!.text, /別の会話（Thread）が流したもの/);
      const noStamp = await shell.call("cancelCommand", { commandId: mine.commandId }, { [CALLER_META_KEY]: { admin: true } });
      assert.equal(noStamp.isError, true);
      assert.match(noStamp.content[0]!.text, /どの会話からの呼び出しか分からない/);
      const fromModule = await shell.call(
        "cancelCommand",
        { commandId: mine.commandId },
        { [CALLER_MODULE_META_KEY]: { name: "factory", conn: "factory-p1" } },
      );
      assert.equal(fromModule.isError, true);
      assert.equal((await listOf({ [THREAD_META_KEY]: THREAD }))[0]!.status, "running", "断ったのに止まった");

      const cancelled = await shell.call("cancelCommand", { commandId: mine.commandId }, { [THREAD_META_KEY]: THREAD });
      assert.equal(cancelled.isError, undefined, cancelled.content[0]?.text);
      assert.equal(JSON.parse(cancelled.content[0]!.text).status, "cancelled");
      await shell.waitDelivered(1);
      const d = shell.delivered[0]!;
      assert.equal(d.replyTo, "reply_A");
      assert.match(d.title, /^コマンドを止めました：echo mine-started/);
      assert.equal(deliveredBody(d).status, "cancelled");
      assert.match(deliveredBody(d).tail, /mine-started/);
      assert.equal((await listOf({ [THREAD_META_KEY]: THREAD }))[0]!.status, "cancelled");
      // 子（sleep）まで止まっている
      const pid = readStarted(dirs, mine.commandId).pid;
      assert.throws(() => process.kill(pid, 0), "起動役が残っている");

      // もう動いていないものは止められない
      const again = await shell.call("cancelCommand", { commandId: mine.commandId }, { [THREAD_META_KEY]: THREAD });
      assert.equal(again.isError, true);
      assert.match(again.content[0]!.text, /もう動いていません/);

      await shell.call("cancelCommand", { commandId: theirs.commandId }, { [THREAD_META_KEY]: OTHER_THREAD });
      await shell.waitDelivered(2);
    } finally {
      await shell.close();
    }
  });
});

test("外から止められたもの（cancelCommand ではない SIGTERM）は「外から止められました」、起動役ごと消えたものは「途中で終わりました」", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      const stopped = await runInBackground(shell, { command: "echo s; sleep 60" }, stamp(THREAD, "reply_S"));
      process.kill(readStarted(dirs, stopped.commandId).pid, "SIGTERM");
      await shell.waitDelivered(1);
      assert.match(shell.delivered[0]!.title, /^コマンドが外から止められました/);
      assert.equal(deliveredBody(shell.delivered[0]!).status, "stopped");

      const lost = await runInBackground(shell, { command: "echo partial-output; sleep 60" }, stamp(THREAD, "reply_L"));
      for (let i = 0; i < 100 && !readFileSync(lost.outputFile, "utf8").includes("partial-output"); i++) await new Promise((r) => setTimeout(r, 50));
      const pid = readStarted(dirs, lost.commandId).pid;
      // 起動役もコマンドも SIGKILL（コンテナが落ちたのと同じ——終わり方を書く間が無い）。コマンドは自分のグループ
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      assert.ok(children.length > 0, "起動役の子が見えない（試験の前提）");
      process.kill(pid, "SIGKILL");
      for (const child of children) process.kill(-Number(child), "SIGKILL");
      await shell.waitDelivered(2);
      const d = shell.delivered[1]!;
      assert.match(d.title, /^コマンドが途中で終わりました/);
      const body = deliveredBody(d);
      assert.equal(body.status, "lost");
      assert.equal(body.exitCode, null);
      assert.match(body.tail, /partial-output/, "ファイルの終わりから末尾を作っていない");
      assert.match(String(body.note), /終わり方の記録がありません/);
    } finally {
      await shell.close();
    }
  });
});

test("起動役：started.json を書いた直後に止められても、終わり方を書き、子を残さない（信号の受け口を先に置く）", async () => {
  await withDirs(async (dirs) => {
    // 以前は started.json を書いて子を起こしてから受け口を置いていて、見た直後の SIGTERM で 30 回中 30 回書けなかった
    for (let i = 0; i < 10; i++) {
      const dir = join(dirs.root, `race-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "job.json"),
        JSON.stringify({ id: "x", command: "sleep 31", cwd: dirs.project, startedAt: "", replyToFingerprint: "f", unit: "u" }),
      );
      writeFileSync(join(dir, "env.json"), JSON.stringify({ PATH: process.env.PATH }));
      const wrapper = spawn(process.execPath, [WRAPPER, dir, join(dir, "env.json")], { stdio: "ignore", detached: true });
      const exited = new Promise((r) => wrapper.on("exit", r));
      while (!existsSync(join(dir, "started.json"))) await new Promise((r) => setImmediate(r));
      process.kill(JSON.parse(readFileSync(join(dir, "started.json"), "utf8")).pid as number, "SIGTERM");
      await exited;
      assert.ok(existsSync(join(dir, "exit.json")), `${i} 回目：終わり方を書けなかった`);
      assert.equal(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).stopRequested, true);
    }
    // 子（自分のグループで起こした sleep）まで止まっている
    for (let waited = 0; waited < 3_000 && spawnSync("pgrep", ["-f", "^sleep 31$"]).status === 0; waited += 50) await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(spawnSync("pgrep", ["-f", "^sleep 31$"]).status, 0, "子が残った");
  });
});

// ---- 起こし直しをまたぐ ----------------------------------------------------------------------------------

test("起こし直しをまたぐ：Shell を捨てても動き続け、立て直した Shell が host の問いに「続ける」と答えて届ける", async () => {
  await withDirs(async (dirs) => {
    // 落ちる前の Shell は見張らない（届ける前に落ちたことにする）
    const before = await startShell(dirs, { pollMs: 600_000 });
    const running = await runInBackground(before, { command: "sleep 1.5; echo done-after-restart" }, stamp(THREAD, "reply_RUNNING"));
    const finished = await runInBackground(before, { command: "echo finished-while-down" }, stamp(THREAD, "reply_FINISHED"));
    const other = await runInBackground(before, { command: "echo other-thread" }, stamp(OTHER_THREAD, "reply_OTHER"));
    const unasked = await runInBackground(before, { command: "sleep 3; echo unasked" }, stamp(THREAD, "reply_UNASKED"));
    // 届ける前に Shell が落ちる（見張りを止めて接続を切る——banto の起こし直しで Module が止まるのと同じ）
    await before.close();
    assert.equal(before.delivered.length, 0, "落ちる前に届いた（試験の前提が崩れた）");
    for (let i = 0; i < 100 && !existsSync(join(dirs.commands, finished.commandId, "exit.json")); i++) await new Promise((r) => setTimeout(r, 50));
    const runningPid = readStarted(dirs, running.commandId).pid;
    process.kill(runningPid, 0); // まだ動いている

    const after = await startShell(dirs);
    try {
      // 問いは host だけ——呼び元の印が付いていたら断る
      const notHost = await after.call(RESUME_AFTER_RESTART_TOOL, { items: [{ replyTo: "reply_RUNNING", thread: THREAD }] }, { [THREAD_META_KEY]: THREAD });
      assert.equal(notHost.isError, true);

      const res = await after.call(RESUME_AFTER_RESTART_TOOL, {
        items: [
          { replyTo: "reply_RUNNING", toolName: "runCommand", thread: THREAD },
          { replyTo: "reply_FINISHED", toolName: "runCommand", thread: THREAD },
          { replyTo: "reply_OTHER", toolName: "runCommand", thread: THREAD },
          { replyTo: "reply_NO_RECORD", toolName: "runCommand", thread: THREAD },
        ],
      });
      const answers = JSON.parse(res.content[0]!.text).answers as Array<{ replyTo: string; resume: boolean; reason?: string }>;
      assert.deepEqual(
        answers.map((a) => [a.replyTo, a.resume]),
        [
          ["reply_RUNNING", true],
          ["reply_FINISHED", true],
          ["reply_OTHER", false],
          ["reply_NO_RECORD", false],
        ],
      );
      assert.match(answers[2]!.reason!, /Thread が違います/);
      assert.match(answers[3]!.reason!, /記録がありません/);

      // 終わっていたものはすぐ、動いていたものは終わったら届く（同じ札で）
      await after.waitDelivered(2);
      const byHandle = new Map(after.delivered.map((d) => [d.replyTo, d]));
      assert.match(deliveredBody(byHandle.get("reply_FINISHED")!).tail, /finished-while-down/);
      const resumed = deliveredBody(byHandle.get("reply_RUNNING")!);
      assert.equal(resumed.exitCode, 0);
      assert.match(resumed.tail, /done-after-restart/);
      assert.equal(byHandle.get("reply_RUNNING")!.final, true);

      // 問われなかったものは止めない（一覧に出る）。届けもしない
      const listed = JSON.parse((await after.call("listCommands", {}, { [THREAD_META_KEY]: THREAD })).content[0]!.text).commands as Array<{
        commandId: string;
        status: string;
      }>;
      assert.equal(listed.find((c) => c.commandId === unasked.commandId)?.status, "running");
      await new Promise((r) => setTimeout(r, 3_500));
      assert.equal(after.delivered.length, 2, "問われなかったものまで届けた");
      assert.ok(!after.delivered.some((d) => d.replyTo === "reply_OTHER"));
      assert.equal(other.commandId.length > 0, true);
    } finally {
      await after.close();
    }
  });
});

test("届けられなかったもの（host が落ちていた）は記録に残り、起き直した host に問われたら届ける", async () => {
  await withDirs(async (dirs) => {
    let fail = true;
    const delivered: DeliverInput[] = [];
    const before = await startShell(dirs, {
      deliver: async (input) => {
        if (fail) throw new Error("host に繋がりません");
        delivered.push(input);
        return {};
      },
    });
    await runInBackground(before, { command: "echo will-be-redelivered" }, stamp(THREAD, "reply_RETRY"));
    await new Promise((r) => setTimeout(r, 1_500));
    await before.close();
    fail = false;
    const after = await startShell(dirs);
    try {
      const res = await after.call(RESUME_AFTER_RESTART_TOOL, { items: [{ replyTo: "reply_RETRY", thread: THREAD }] });
      assert.equal(JSON.parse(res.content[0]!.text).answers[0].resume, true);
      await after.waitDelivered(1);
      assert.match(deliveredBody(after.delivered[0]!).tail, /will-be-redelivered/);
      assert.equal(delivered.length, 0);
    } finally {
      await after.close();
    }
  });
});

// ---- 末尾の整え方 ----------------------------------------------------------------------------------------

test("tailLines：50 行・1行と全体の上限・進捗の \\r・途中から始まる文字列", () => {
  const many = Array.from({ length: 120 }, (_, i) => `l${i}`).join("\n") + "\n";
  const t = tailLines(many).split("\n");
  assert.equal(t.length, 50);
  assert.equal(t[0], "l70");
  assert.equal(t.at(-1), "l119");
  assert.equal(tailLines("10%\r50%\r100%\ndone\n"), "100%\ndone");
  assert.equal(tailLines("half-line\nwhole\n", true), "…half-line\nwhole");
  const wide = Array.from({ length: 50 }, () => "y".repeat(900)).join("\n");
  const capped = tailLines(wide);
  assert.ok(capped.length <= 16_000, `全体の上限が効いていない：${capped.length}`);
  assert.equal(capped.split("\n").length, 17);
});

test("終わったものは新しい 20 件だけ残す（動いているもの・届ける前のものは消さない）", async () => {
  await withDirs(async (dirs) => {
    const shell = await startShell(dirs);
    try {
      // 古い記録を 25 件置く（終わったもの）
      for (let i = 0; i < 25; i++) {
        const id = `20200101-0000${String(i).padStart(2, "0")}-aaaaaa`;
        mkdirSync(join(dirs.commands, id), { recursive: true });
        writeFileSync(
          join(dirs.commands, id, "job.json"),
          JSON.stringify({ id, command: "old", cwd: dirs.project, startedAt: `2020-01-01T00:00:${String(i).padStart(2, "0")}Z`, replyToFingerprint: "x", unit: "u" }),
        );
        writeFileSync(
          join(dirs.commands, id, "exit.json"),
          JSON.stringify({ at: "2020", code: 0, signal: null, stopRequested: false, timedOut: false, outputBytes: 0, capped: false, tail: "" }),
        );
      }
      const fresh = await runInBackground(shell, { command: "sleep 2" });
      const left = readdirSync(dirs.commands);
      assert.ok(left.includes(fresh.commandId));
      assert.equal(left.length, 21, `残した数：${left.length}`);
      assert.ok(!left.includes("20200101-000000-aaaaaa"), "一番古いものが残っている");
      assert.ok(left.includes("20200101-000024-aaaaaa"), "新しいものが消えた");
      await shell.waitDelivered(1);
    } finally {
      await shell.close();
    }
  });
});
