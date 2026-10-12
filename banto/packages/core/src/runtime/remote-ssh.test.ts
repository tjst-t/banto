// **送り込みを途中で止めたとき**（修正・2026-10-12、レビュー、Backlog #269）。止める道は3つ：進まない（120 秒の停滞で
// ssh を止める）・接続が途中で切れた・登録を外した（`closeRuntime`）。どれも tar の段（tar の出力を縮めて ssh に流している
// 最中）で起きると、前の形では ssh の失敗が誰にも受けられずに core ごと落ち（unhandledRejection）、塞がった tar を待つ側は
// 永久に返らなかった。ここでは、送り込みが**理由つきの失敗として返る**こと・tar が残らないこと・画面への知らせが
// 「送れませんでした」で終わることを見る。
//
// 相手は偽の `ssh`（PATH の先頭に置く）：版を聞く台本（`sh -s`）には「まだ何も無い」と答え、送り込み（`sh -c …`）では
// 標準入力を読まずに居座る——向こうの線が詰まったのと同じ形。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSshRuntime, type CodeTransfer } from "./remote-ssh.js";

/** 小さなワークスペース：Module 1つと、その依存（縮まない 16MB——パイプが確実に詰まる大きさ） */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "banto-remote-ssh-"));
  const w = (rel: string, body: string | Buffer) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  w("package.json", JSON.stringify({ name: "ws" }));
  w("packages/modules/a/package.json", JSON.stringify({ name: "a", dependencies: { dep: "1" } }));
  w("packages/modules/a/dist/server.js", "a\n");
  w("node_modules/dep/package.json", JSON.stringify({ name: "dep" }));
  w("node_modules/dep/big.bin", randomBytes(16 * 1024 * 1024));
  return root;
}

/**
 * 偽の ssh。`stream` は送り込みのときの振る舞い：`hang`＝読まずに居座る／`drop`＝少しして 255 で終わる（接続が切れた）／
 * `followMaster`＝親（`master.pid` のプロセス）が居なくなったら 255 で終わる（多重化した接続と同じ）
 */
function fakeSsh(dir: string, stream: "hang" | "drop" | "followMaster"): void {
  const onStream = {
    hang: "exec sleep 60",
    drop: "sleep 1; exit 255",
    followMaster: `p=$(cat "${dir}/master.pid"); while kill -0 "$p" 2>/dev/null; do sleep 0.1; done; exit 255`,
  }[stream];
  writeFileSync(
    join(dir, "ssh"),
    `#!/bin/sh\nfor a; do last=$a; done\ncase "$last" in\n  "sh -s") cat >/dev/null; printf 'cur=\\ngzip=1\\n'; exit 0;;\n  *) ${onStream};;\nesac\n`,
  );
  chmodSync(join(dir, "ssh"), 0o755);
}

async function withFixture(
  stream: "hang" | "drop" | "followMaster",
  fn: (ctx: {
    rt: RemoteSshRuntime;
    conn: Record<string, unknown>;
    master: ChildProcess;
    events: Array<CodeTransfer | undefined>;
    root: string;
    binDir: string;
  }) => Promise<void>,
): Promise<void> {
  const root = workspace();
  const dataDir = mkdtempSync(join(tmpdir(), "banto-remote-ssh-data-"));
  const binDir = mkdtempSync(join(tmpdir(), "banto-remote-ssh-bin-"));
  fakeSsh(binDir, stream);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  // 親の接続の代わり（多重化した接続は親が居なくなると一緒に閉じる——`followMaster` の偽の ssh がそれを真似る）
  const master = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(join(binDir, "master.pid"), String(master.pid));
  const exited = new Promise<void>((resolve) => master.once("close", () => resolve()));
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  const events: Array<CodeTransfer | undefined> = [];
  const rt = new RemoteSshRuntime({
    dataDir,
    monorepoRoot: root,
    runtimes: {} as never,
    remoteNameOf: () => undefined,
    createRelayListener: () => {
      throw new Error("使わない");
    },
    notify: async () => undefined,
    log: () => undefined,
    onCodeTransfer: (_name, t) => events.push(t),
    transferStallMs: 1_000,
  });
  const conn: Record<string, unknown> = {
    runtimeName: "vm",
    runtime: { host: "example.invalid", port: 22, user: "u" },
    controlPath: join(dataDir, "cm"),
    knownHostsFile: "/dev/null",
    master,
    alive: true,
    remotePort: 0,
    base: "/remote/base",
    codeDir: "",
    checks: [],
    exited,
    forwards: new Map(),
    cautioned: new Set(),
  };
  void exited.then(() => (conn.alive = false));
  try {
    await fn({ rt, conn, master, events, root, binDir });
    // 失敗が誰にも受けられずに残っていないこと（前の形では core ごと落ちた）
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(unhandled, [], "受けられていない失敗がある");
    // tar が残っていないこと（前の形では、書き出し先が止まった tar が塞がったまま残った）
    const left = spawnSync("pgrep", ["-f", `tar -C ${root}`], { encoding: "utf8" }).stdout.trim();
    assert.equal(left, "", `tar が残っている：${left}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    process.env.PATH = savedPath;
    master.kill("SIGKILL");
    spawnSync("pkill", ["-f", `${binDir}/`]);
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** 送り込みを呼んで、決着（成功・失敗）と、それまでの時間を返す。決着しなければ時間切れで落とす */
async function settle(p: Promise<unknown>, limitMs: number): Promise<{ err?: Error; ms: number }> {
  const started = performance.now();
  const r = await Promise.race([
    p.then(
      () => ({}),
      (err: Error) => ({ err }),
    ),
    new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), limitMs).unref()),
  ]);
  assert.ok(!("hung" in r), `送り込みが ${limitMs}ms たっても返らない`);
  return { ...(r as { err?: Error }), ms: performance.now() - started };
}

const syncCode = (rt: RemoteSshRuntime, conn: unknown) => (rt as unknown as { syncCode(c: unknown): Promise<string> }).syncCode(conn);

test("tar の段で進まなくなったら、ssh を止めて理由つきで失敗し、tar も止まり、画面には「送れませんでした」が残る", async () => {
  await withFixture("hang", async ({ rt, conn, events }) => {
    const { err, ms } = await settle(syncCode(rt, conn), 15_000);
    assert.ok(err, "止まったのに成功した");
    assert.match(err.message, /コードを送れませんでした/);
    assert.match((err as Error & { result?: { stderr: string } }).result?.stderr ?? "", /1 秒のあいだ1バイトも送れなかったので止めました/);
    assert.ok(ms < 10_000, `止まるまで ${Math.round(ms)}ms かかった`);
    const last = events.at(-1);
    assert.ok(last?.failed, "画面への最後の知らせが「送れませんでした」になっていない");
    assert.match(last.failed, /コードを送れませんでした/);
    assert.deepEqual(rt.codeTransfers().map((t) => [t.runtime, Boolean(t.failed)]), [["vm", true]]);
  });
});

test("tar の段で接続が切れたら、理由つきで失敗し、tar も止まる", async () => {
  await withFixture("drop", async ({ rt, conn, master }) => {
    // 偽の ssh が 255 で終わる前に、親の接続が閉じる（本物では多重化した接続ごと閉じる）
    setTimeout(() => master.kill("SIGKILL"), 300).unref();
    const { err } = await settle(syncCode(rt, conn), 15_000);
    assert.ok(err, "接続が切れたのに成功した");
    assert.match(err.message, /SSH の接続が途中で閉じました/);
  });
});

test("用意している途中で登録を外したら（closeRuntime）、送り込みが止まって失敗し、画面の行は消える", async () => {
  await withFixture("followMaster", async ({ rt, conn, events }) => {
    (rt as unknown as { settingUp: Map<string, unknown> }).settingUp.set("vm", conn);
    const sending = syncCode(rt, conn);
    // 送り始めた（画面に「送っています」が出た）あとで外す
    const started = performance.now();
    while (!events.some((e) => e && !e.failed) && performance.now() - started < 10_000) await new Promise((r) => setTimeout(r, 20));
    await rt.closeRuntime("vm");
    const { err } = await settle(sending, 15_000);
    assert.ok(err, "外したのに成功した");
    assert.equal(conn.removed, true);
    // 外した実行場所の行は残さない（「送れませんでした」も出さない）
    assert.equal(events.at(-1), undefined);
    assert.deepEqual(rt.codeTransfers(), []);
  });
});

// **繋いでいる途中で登録を外したら、その接続を残さない**（修正・2026-10-12、レビュー）。外す側（`closeRuntime`）は、
// 前提を確かめている・親の接続を待っている段の接続をまだ掴めない。そこで外されても、繋ぎ終えたときに気づいて閉じ、
// 失敗として返す。同じ名前で登録し直したら、外す前に始まった繋ぎ（前の host 向け）に相乗りせず、新しく繋ぐ。
// `withConnection` は偽物：門（`gate`）が開くまで待ち（前提の確かめ・親の接続を待つ間）、繋ぎ終えた接続を返す
function fakeConnection(host: string): { conn: Record<string, unknown>; master: ChildProcess } {
  const master = spawn("sleep", ["60"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => master.once("close", () => resolve()));
  const conn: Record<string, unknown> = {
    runtimeName: "vm",
    runtime: { host, port: 22, user: "u" },
    master,
    alive: true,
    exited,
    remotePort: 1,
    base: "/remote/base",
    codeDir: "/remote/base/code/v-1",
    checks: [],
    forwards: new Map(),
    cautioned: new Set(),
  };
  void exited.then(() => (conn.alive = false));
  return { conn, master };
}

test("繋いでいる途中（前提の確かめ・親の接続を待つ間）に登録を外したら、繋ぎ終えても残さずに失敗する。登録し直したら新しく繋ぐ", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "banto-remote-ssh-data-"));
  const gates: Array<{ open: () => void; result: { conn: Record<string, unknown>; master: ChildProcess } }> = [];
  const runtimes = {
    withConnection: async () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      const result = fakeConnection(gates.length === 0 ? "old.example" : "new.example");
      gates.push({ open, result });
      await opened;
      return result.conn;
    },
  };
  const rt = new RemoteSshRuntime({
    dataDir,
    monorepoRoot: dataDir,
    runtimes: runtimes as never,
    remoteNameOf: () => undefined,
    createRelayListener: () => createServer(),
    notify: async () => undefined,
    log: () => undefined,
  });
  const connections = (rt as unknown as { connections: Map<string, Record<string, unknown>> }).connections;
  try {
    /** 繋ぎが n 本始まるまで待つ（始まらなければ落とす——外す前の繋ぎに相乗りすると2本目が始まらない） */
    const waitGates = async (n: number) => {
      const started = performance.now();
      while (gates.length < n) {
        assert.ok(performance.now() - started < 3_000, `繋ぎが ${n} 本目を始めない（外す前の繋ぎに相乗りしている）`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const first = rt.warmUp("vm");
    // 先の繋ぎが失敗しても、試験が見るまで受けられないままにしない
    first.catch(() => undefined);
    await waitGates(1);
    // 前提を確かめている間に外す（このときはまだどこにも掴める接続が無い）
    await rt.closeRuntime("vm");
    // 同じ名前で別の host を登録し直して、先に送る——外す前の繋ぎに相乗りせず、新しく繋ぐ
    const second = rt.warmUp("vm");
    await waitGates(2);

    gates[0]!.open();
    await assert.rejects(first, /実行場所「vm」が外されたので、繋ぐのをやめました/);
    assert.equal(gates[0]!.result.conn.alive, false, "外した実行場所への接続が閉じていない");
    assert.equal(connections.get("vm"), undefined, "外した実行場所への接続が残っている");

    gates[1]!.open();
    await second;
    assert.equal((connections.get("vm")?.runtime as { host: string }).host, "new.example", "登録し直した host に繋がっていない");
    // 繋がっていれば、もう一度頼んでも新しく繋がない
    await rt.warmUp("vm");
    assert.equal(gates.length, 2);
  } finally {
    for (const g of gates) g.result.master.kill("SIGKILL");
    await rt.closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
