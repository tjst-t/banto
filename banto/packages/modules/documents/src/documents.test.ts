import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CALLER_META_KEY, STATELESS_TRANSFORM_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import {
  MAX_BYTES,
  PROFILE_XCU,
  TOO_LARGE_MESSAGE,
  checkSandbox,
  convertCommand,
  convertOne,
  dropPrivilegesArgs,
  sandboxArgs,
  type SandboxRunner,
} from "./converter.js";
import { FairQueue, QueueFullError } from "./queue.js";
import { createDocumentsServer, queueKeyOf } from "./server.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 偽の囲い：作業フォルダを見て、頼まれた出力を書く */
function fakeRunner(opts: { write?: boolean; code?: number; delayMs?: number; seen?: string[][] } = {}): SandboxRunner {
  return {
    async run(workDir, command, timeoutMs) {
      opts.seen?.push(command);
      if (opts.delayMs && opts.delayMs > timeoutMs) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        return { code: null, stderr: "", timedOut: true };
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (command[0] === "/usr/bin/id") return { code: opts.code ?? 0, stderr: "", timedOut: false };
      if (opts.write !== false) {
        const out = command.includes("pdf") ? "input.pdf" : command[0] === "/usr/bin/pdftoppm" ? "page.png" : "input.xlsx";
        const input = command[command.length - 1]!.startsWith("/work/out") ? command[command.length - 2]! : command[command.length - 1]!;
        // 入力が作業フォルダの中にあることも確かめる（囲いの中のパス → 外のパス）
        const src = readFileSync(join(workDir, input.replace(/^\/work\//, "")));
        writeFileSync(join(workDir, "out", out), Buffer.concat([Buffer.from("OUT:"), src]));
      }
      return { code: opts.code ?? 0, stderr: "warn", timedOut: false };
    },
  };
}

// ---- 囲いの作り ----

test("囲いはネットワーク・PID 等を分け、環境を消し、親と一緒に死ぬ。user namespace は作らず setpriv で nobody に落とす", () => {
  const args = sandboxArgs("/tmp/w");
  for (const flag of ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--clearenv"]) {
    assert.ok(args.includes(flag), `${flag} が無い`);
  }
  // 測ったこと：--unshare-user（--unshare-all）だと中が外から見て root のままになり、/proc も付けられない
  assert.ok(!args.includes("--unshare-all") && !args.includes("--unshare-user") && !args.includes("--uid"));
  // 書けるのは作業フォルダだけ。根は /usr の読み取り専用
  const binds = args.flatMap((a, i) => (a === "--bind" ? [`${args[i + 1]}→${args[i + 2]}`] : []));
  assert.deepEqual(binds, ["/tmp/w→/work"]);
  assert.ok(args.join(" ").includes("--ro-bind /usr /usr"));
  // ホーム・Module の置き場は見せない
  assert.ok(!args.some((a) => a.startsWith("/home") || a.startsWith("/root")));
  // 日本語の字形で描く：既定の言語は日本語、fontconfig は作業フォルダの設定（JP を先に）
  assert.equal(args[args.indexOf("LANG") + 1], "ja_JP.UTF-8");
  assert.equal(args[args.indexOf("FONTCONFIG_FILE") + 1], "/work/fonts.conf");
  assert.deepEqual(dropPrivilegesArgs().slice(0, 3), ["/usr/bin/setpriv", "--reuid=65534", "--regid=65534"]);
  assert.ok(dropPrivilegesArgs().includes("--bounding-set=-all") && dropPrivilegesArgs().includes("--no-new-privs"));
});

test("LibreOffice のプロファイルはマクロを止め、外のリンクを更新せず、表を読むたびに計算し直す", () => {
  assert.match(PROFILE_XCU, /MacroSecurityLevel" oor:op="fuse"><value>3</);
  assert.match(PROFILE_XCU, /DisableMacrosExecution" oor:op="fuse"><value>true</);
  assert.match(PROFILE_XCU, /Writer\/Content\/Update"><prop oor:name="Link" oor:op="fuse"><value>2</);
  assert.match(PROFILE_XCU, /Calc\/Content\/Update"><prop oor:name="Link" oor:op="fuse"><value>1</);
  assert.match(PROFILE_XCU, /OOXMLRecalcMode" oor:op="fuse"><value>0</);
  const cmd = convertCommand("pdf", "docx");
  assert.ok(cmd.includes("-env:UserInstallation=file:///work/profile"));
  assert.equal(cmd[cmd.length - 1], "/work/in/input.docx");
  assert.ok(convertCommand("recalculate", "xlsx").includes("xlsx:Calc Office Open XML"));
  assert.deepEqual(convertCommand("pageImage", "pdf", { page: 3, dpi: 150 }).slice(0, 8), ["/usr/bin/pdftoppm", "-png", "-r", "150", "-f", "3", "-l", "3"]);
});

test("root でない・囲いが起きないなら変換しない", async () => {
  assert.match((await checkSandbox(fakeRunner(), 1000))!, /root で動いていません/);
  assert.match((await checkSandbox(fakeRunner({ code: 1 }), 0))!, /囲い（bubblewrap）を起こせないので変換しません/);
  assert.equal(await checkSandbox(fakeRunner(), 0), undefined);
});

// ---- 1件の変換 ----

test("1件ごとに作業フォルダで変換し、出力を返して、フォルダを消す", async () => {
  const seen: string[][] = [];
  let workDir = "";
  const runner: SandboxRunner = {
    async run(dir, command, t) {
      workDir = dir;
      assert.ok(readFileSync(join(dir, "profile", "user", "registrymodifications.xcu"), "utf8").includes("DisableMacrosExecution"));
      return fakeRunner({ seen }).run(dir, command, t);
    },
  };
  const r = await convertOne(runner, "pdf", "docx", Buffer.from("DOC"), { chownTo: null });
  assert.equal(r.data.toString(), "OUT:DOC");
  assert.equal(r.mimeType, "application/pdf");
  assert.equal(existsSync(workDir), false, "作業フォルダが残っている");
});

test("7MB を超える入力は理由を出して断る。種類の違うものも断る", async () => {
  await assert.rejects(convertOne(fakeRunner(), "pdf", "docx", Buffer.alloc(MAX_BYTES + 1), { chownTo: null }), { message: TOO_LARGE_MESSAGE });
  await assert.rejects(convertOne(fakeRunner(), "recalculate", "docx", Buffer.from("x"), { chownTo: null }), /計算し直せません/);
  await assert.rejects(convertOne(fakeRunner(), "pdf", "exe", Buffer.from("x"), { chownTo: null }), /PDF にできません/);
});

test("LibreOffice が何も書き出さなければ失敗にする。打ち切りは理由を出す", async () => {
  await assert.rejects(convertOne(fakeRunner({ write: false }), "pdf", "docx", Buffer.from("x"), { chownTo: null }), /何も書き出されませんでした/);
  await assert.rejects(
    convertOne(fakeRunner({ delayMs: 50 }), "pdf", "docx", Buffer.from("x"), { chownTo: null, timeoutMs: 10 }),
    /終わらなかったので止めました/,
  );
});

// ---- 順番と公平 ----

test("同時に1件。Project の間は順番に回し、1つの Project の連投で他を止めない", async () => {
  const q = new FairQueue(3);
  const order: string[] = [];
  let release!: () => void;
  const first = q.run("A", () => new Promise<void>((r) => (release = r)).then(() => void order.push("A0")));
  const later = [
    q.run("A", async () => void order.push("A1")),
    q.run("A", async () => void order.push("A2")),
    q.run("B", async () => void order.push("B1")),
    q.run("A", async () => void order.push("A3")),
    q.run("C", async () => void order.push("C1")),
  ];
  await tick();
  assert.deepEqual(order, [], "1件目が終わる前に次が走った");
  release();
  await Promise.all([first, ...later]);
  assert.deepEqual(order, ["A0", "A1", "B1", "C1", "A2", "A3"]);
});

test("待ちは Project ごとに3件まで（走っているものは数えない）", async () => {
  const q = new FairQueue(3);
  let release!: () => void;
  const running = q.run("A", () => new Promise<void>((r) => (release = r)));
  const waits = [1, 2, 3].map(() => q.run("A", async () => undefined));
  await assert.rejects(q.run("A", async () => undefined), QueueFullError);
  await assert.rejects(q.run("A", async () => undefined), /変換が混んでいます/);
  // 別の Project は待てる
  const other = q.run("B", async () => "b");
  release();
  await Promise.all([running, ...waits]);
  assert.equal(await other, "b");
});

// ---- 口 ----

async function withServer(deps: Parameters<typeof createDocumentsServer>[0], fn: (c: Client) => Promise<void>) {
  const server = createDocumentsServer(deps);
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

const describe = () => ({ version: "libreoffice 24.2; poppler 24.02; recipe 1", fonts: "abc" });

test("tool はどれも AI に見せず、受けた中身を残さず変換して返すだけと名乗る", async () => {
  await withServer({ runner: fakeRunner(), uid: 0, describe, chownTo: null }, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["convertToPdf", "describe", "recalculate", "renderPage"]);
    for (const t of tools) {
      assert.equal(t._meta?.[VISIBILITY_META_KEY], "module", t.name);
      assert.equal(t._meta?.[STATELESS_TRANSFORM_META_KEY], true, t.name);
    }
  });
});

test("変換は base64 で受けて返し、版・フォントの印と、かかった時間を添えて記録する", async () => {
  const logs: string[] = [];
  await withServer({ runner: fakeRunner(), uid: 0, describe, chownTo: null, log: (l) => logs.push(l) }, async (client) => {
    const r = await client.callTool({
      name: "convertToPdf",
      arguments: { data: Buffer.from("DOCX").toString("base64"), extension: "DOCX" },
      _meta: { [CALLER_META_KEY]: { project: "p1" } },
    });
    assert.ok(!r.isError, JSON.stringify(r.content));
    const out = JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    assert.equal(Buffer.from(out.data as string, "base64").toString(), "OUT:DOCX");
    assert.equal(out.mimeType, "application/pdf");
    assert.deepEqual(out.converter, describe());
    assert.equal(typeof out.ms, "number");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^\[documents\] pdf docx 4B → 8B 変換 \d+ms 待ち 0ms（project:p1）$/);
  });
});

test("root でなければ変換せず理由を返す。7MB を超える base64 は読む前に断る", async () => {
  await withServer({ runner: fakeRunner(), uid: 1000, describe, chownTo: null }, async (client) => {
    const r = await client.callTool({ name: "convertToPdf", arguments: { data: "AAAA", extension: "docx" } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0]!.text, /root で動いていません/);
    const big = await client.callTool({ name: "recalculate", arguments: { data: "A".repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4), extension: "xlsx" } });
    assert.equal((big.content as { text: string }[])[0]!.text, TOO_LARGE_MESSAGE);
  });
});

test("待ちの鍵は host が刻んだ Project（人の画面からなら、どの Project のためか）", () => {
  assert.equal(queueKeyOf({ [CALLER_META_KEY]: { project: "p" } }), "project:p");
  assert.equal(queueKeyOf({ [CALLER_META_KEY]: { admin: true, forProject: "q" } }), "project:q");
  assert.equal(queueKeyOf({ [CALLER_META_KEY]: { admin: true } }), "admin");
  assert.equal(queueKeyOf(undefined), "unknown");
});
