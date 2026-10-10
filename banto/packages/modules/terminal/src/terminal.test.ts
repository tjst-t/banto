// Terminal の Module（v4-modules.md §4.6）。本物の tmux を、試験ごとの専用のソケットで動かす（人の tmux・本番の
// `banto-terminal` には触らない）。流れは共通の待ち受け（`@banto/stream-server`）に、host と同じく刻印つきで繋ぐ。
// 見るもの：
//   - `%output` の8進の戻し方・写しの組み立て
//   - セッションを足す・名前を変える・閉じる。消えた（tmux に無い）ものは lost に出て、同じ作業ディレクトリで作り直せる
//   - 流れ：繋ぐと今の中身が先に来る・打った文字が届いて出力が返る（日本語のまま）・繋ぎ直すと前の出力が写しで戻る・
//     2本で同じセッションを開ける・大きさは最後に打った方・無いセッションは 4404・閉じたら 4404
//   - シェルの環境：専用のホーム・作業ディレクトリ・host の `BANTO_*` は渡らない
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WebSocket } from "ws";
import { encodeStreamStamp, STREAM_STAMP_HEADER } from "@banto/module-contract";
import { listenStreams, streamSocketPathOf } from "@banto/stream-server";
import { unescapeOutput } from "./control.js";
import { buildEnvironments } from "./server.js";
import { SessionStore } from "./store.js";
import { buildSnapshot, terminalStreamHandler } from "./stream.js";
import { Terminal } from "./terminal.js";
import { Tmux } from "./tmux.js";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsTmux = hasTmux ? {} : { skip: "tmux が入っていない（apt-get install tmux）" };

test("%output の中身：8進の \\ooo を戻し、UTF-8 はそのまま", () => {
  const escaped = Buffer.concat([Buffer.from("a\\015\\012\\134b", "latin1"), Buffer.from("あ", "utf8"), Buffer.from("\\033[K", "latin1")]);
  assert.deepEqual(unescapeOutput(escaped), Buffer.from("a\r\n\\bあ\x1b[K", "utf8"));
  // 8進でない \ はそのまま
  assert.deepEqual(unescapeOutput(Buffer.from("\\9x\\01", "latin1")), Buffer.from("\\9x\\01", "latin1"));
});

test("写し：端末を初期化してから行を書き、カーソルと入力の形を戻す", () => {
  const flags = {
    alternate_on: true,
    cursor_flag: false,
    keypad_cursor_flag: true,
    keypad_flag: false,
    mouse_standard_flag: false,
    mouse_button_flag: false,
    mouse_any_flag: false,
    mouse_sgr_flag: true,
  };
  const out = buildSnapshot(["$ ls", "a b"], { paneId: "%1", sessionId: "$1", cursorX: 3, cursorY: 1, flags }).toString("utf8");
  assert.equal(out, "\x1bc\x1b[?1049h$ ls\x1b[0m\r\na b\x1b[0m\x1b[2;4H\x1b[?25l\x1b[?1h\x1b[?1006h");
});

test("シェルの環境：host の BANTO_* を落とし、専用のホームと locale と Claude の中継を渡す", () => {
  const { processEnv, sessionEnv } = buildEnvironments(
    { PATH: "/usr/bin", BANTO_HOST_MCP_TOKEN: "secret", BANTO_MODULE_DATA_DIR: "/d", ANTHROPIC_BASE_URL: "http://relay", TMUX: "/tmp/x" },
    "/d/home",
  );
  assert.equal(processEnv.BANTO_HOST_MCP_TOKEN, undefined);
  assert.equal(processEnv.TMUX, undefined);
  assert.equal(processEnv.HOME, "/d/home");
  assert.deepEqual(sessionEnv, {
    HOME: "/d/home",
    XDG_CONFIG_HOME: "/d/home/.config",
    XDG_CACHE_HOME: "/d/home/.cache",
    XDG_DATA_HOME: "/d/home/.local/share",
    XDG_STATE_HOME: "/d/home/.local/state",
    LANG: "C.UTF-8",
    ANTHROPIC_BASE_URL: "http://relay",
  });
});

interface Fixture {
  root: string;
  projectRoot: string;
  dataDir: string;
  tmux: Tmux;
  terminal: Terminal;
}

async function withTerminal(fn: (f: Fixture) => Promise<void>): Promise<void> {
  // ソケットのパスが長くならないように /tmp の下（TMPDIR が長い環境がある）
  const root = mkdtempSync(join("/tmp", "banto-term-"));
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");
  mkdirSync(projectRoot);
  mkdirSync(dataDir);
  const home = join(dataDir, "home");
  const { processEnv, sessionEnv } = buildEnvironments({ ...process.env, BANTO_HOST_MCP_TOKEN: "do-not-pass" }, home);
  // 試験の tmux の置き場（人の tmux と混ざらない）
  processEnv.TMUX_TMPDIR = root;
  const tmux = new Tmux({ env: processEnv, socket: `t${process.pid}` });
  const terminal = new Terminal({
    tmux,
    store: new SessionStore(dataDir),
    projectRoot,
    sessionEnv,
    prepare: async () => {
      mkdirSync(home, { recursive: true });
    },
    log: () => undefined,
  });
  try {
    await fn({ root, projectRoot, dataDir, tmux, terminal });
  } finally {
    try {
      await tmux.exec(["kill-server"]);
    } catch {
      // もう居ない
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("セッション：足す・名前を変える・閉じる。tmux から消えたものは lost に出て、同じ作業ディレクトリで作り直せる", needsTmux, async () => {
  await withTerminal(async ({ terminal, tmux, projectRoot }) => {
    assert.deepEqual(await terminal.listSessions(), { sessions: [], lost: [] });
    let list = await terminal.createSession({ name: "main" });
    assert.deepEqual(list.sessions.map((s) => [s.name, s.cwd]), [["main", projectRoot]]);
    await assert.rejects(terminal.createSession({ name: "main" }), /もうあります/);
    await assert.rejects(terminal.createSession({ name: "a:b" }), /使えません/);
    await assert.rejects(terminal.createSession({ name: "x", cwd: "/no/such/dir" }), /ありません/);

    list = await terminal.createSession({ name: "作業", cwd: "/tmp" });
    list = await terminal.renameSession({ name: "作業", newName: "work" });
    assert.deepEqual(list.sessions.map((s) => s.name).sort(), ["main", "work"]);
    await assert.rejects(terminal.renameSession({ name: "work", newName: "main" }), /もうあります/);

    // コンテナを起こし直したのと同じ：tmux のサーバごと消える
    await tmux.exec(["kill-server"]);
    list = await terminal.listSessions();
    assert.deepEqual(list.sessions, []);
    assert.deepEqual(list.lost.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "main", cwd: projectRoot },
      { name: "work", cwd: "/tmp" },
    ]);
    // 同じ名前で作り直すと、控えの作業ディレクトリで起きる
    list = await terminal.createSession({ name: "work" });
    assert.deepEqual(list.sessions.map((s) => [s.name, s.cwd]), [["work", "/tmp"]]);
    assert.deepEqual(list.lost, [{ name: "main", cwd: projectRoot }]);
    // 消えたものを閉じると控えから消える
    list = await terminal.closeSession({ name: "main" });
    assert.deepEqual(list.lost, []);
    list = await terminal.closeSession({ name: "work" });
    assert.deepEqual(list, { sessions: [], lost: [] });
    await assert.rejects(terminal.closeSession({ name: "work" }), /ありません/);
  });
});

/** host の代わりに、刻印つきで流れに繋ぐ（フォルダの番号を通す——host と同じ） */
function dial(path: string, params: Record<string, unknown>) {
  let fd: number | undefined = openSync(dirname(path), "r");
  const release = () => {
    if (fd === undefined) return;
    closeSync(fd);
    fd = undefined;
  };
  const stamp = encodeStreamStamp({ name: "terminal", params, projectId: "p1", resourceUri: "ui://banto-terminal/terminal", human: true });
  const ws = new WebSocket(`ws+unix:///proc/self/fd/${fd}/${basename(path)}:/`, { headers: { [STREAM_STAMP_HEADER]: stamp } });
  ws.once("upgrade", release);
  ws.once("close", release);
  let screen = "";
  const waiters: Array<() => void> = [];
  ws.on("message", (data: Buffer, isBinary) => {
    if (isBinary) screen += data.toString("utf8");
    for (const w of waiters.splice(0)) w();
  });
  ws.on("error", () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    ws,
    closed,
    opened,
    get screen() {
      return screen;
    },
    /** 端末に出たものに `pattern` が現れるまで待つ（10 秒） */
    async until(pattern: RegExp): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!pattern.test(screen)) {
        if (Date.now() > deadline) throw new Error(`端末に ${pattern} が出ない。出たもの：${JSON.stringify(screen.slice(-500))}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 200);
        });
      }
    },
    type(data: string) {
      ws.send(JSON.stringify({ type: "input", data }));
    },
  };
}

const windowSize = async (tmux: Tmux) => (await tmux.exec(["display-message", "-p", "-t", "=main:", "#{window_width}x#{window_height}"])).trim();

test("流れ：今の中身が先に来て、打った文字が届き、繋ぎ直すと前の出力が写しで戻る。2本で同じセッション・大きさは最後に打った方", needsTmux, async () => {
  await withTerminal(async ({ terminal, tmux, dataDir, projectRoot }) => {
    const server = await listenStreams({ terminal: terminalStreamHandler({ tmux, log: () => undefined }) }, { dataDir });
    const path = streamSocketPathOf(dataDir);
    try {
      await terminal.createSession({ name: "main" });

      const a = dial(path, { session: "main", cols: 100, rows: 30 });
      // 最初に来るのは写し（端末の初期化から始まる）
      await a.until(/^\x1bc/);
      a.type("echo \"こん\"\"にちは-$((40+2))\"; pwd; echo \"home=$HOME token=${BANTO_HOST_MCP_TOKEN:-none}\"\r");
      await a.until(/こんにちは-42/);
      await a.until(new RegExp(`\\n${projectRoot}\\r`));
      await a.until(new RegExp(`home=${dataDir}/home token=none`));
      assert.equal(await windowSize(tmux), "100x30");

      // 2本目：同じセッション。写しに1本目の出力が入っている
      const b = dial(path, { session: "main", cols: 60, rows: 20 });
      await b.until(/こんにちは-42/);
      // 1本目で打ったものが2本目にも出る
      a.type("echo shared-$((1+1))\r");
      await b.until(/shared-2/);
      // 大きさは最後に打った方：1本目が打ったので 100x30 に戻る
      assert.equal(await windowSize(tmux), "100x30");
      b.type("echo from-b\r");
      await a.until(/from-b/);
      assert.equal(await windowSize(tmux), "60x20");

      // 閉じて開き直すと、前の出力が写しで戻る（セッションは残る）
      b.ws.close();
      a.ws.close();
      await a.closed;
      const c = dial(path, { session: "main", cols: 100, rows: 30 });
      await c.until(/from-b/);
      assert.match(c.screen, /shared-2/);

      // 無いセッションは 4404（画面は繋ぎ直しをやめる）
      const none = dial(path, { session: "nothing", cols: 80, rows: 24 });
      assert.equal((await none.closed).code, 4404);

      // 開いている間に閉じられたら 4404
      await terminal.closeSession({ name: "main" });
      assert.equal((await c.closed).code, 4404);
    } finally {
      await server.close();
    }
  });
});

test("流れ：大きさが範囲の外・知らないメッセージは断る", needsTmux, async () => {
  await withTerminal(async ({ terminal, tmux, dataDir }) => {
    const server = await listenStreams({ terminal: terminalStreamHandler({ tmux, log: () => undefined }) }, { dataDir });
    const path = streamSocketPathOf(dataDir);
    try {
      await terminal.createSession({ name: "main" });
      assert.equal((await dial(path, { session: "main", cols: 0, rows: 24 }).closed).code, 1008);
      const a = dial(path, { session: "main", cols: 80, rows: 24 });
      await a.until(/^\x1bc/);
      a.ws.send(JSON.stringify({ type: "resize", cols: 5000, rows: 10 }));
      assert.equal((await a.closed).code, 1008);
      const b = dial(path, { session: "main", cols: 80, rows: 24 });
      await b.until(/^\x1bc/);
      b.ws.send(JSON.stringify({ type: "shell", data: "x" }));
      assert.equal((await b.closed).code, 1008);
    } finally {
      await server.close();
    }
  });
});

/** 端末に出た `n<数>` を、出た順に拾う（色などの逃がしを外し、最後の書きかけの行は捨てる） */
function countersOf(screen: string): number[] {
  // eslint-disable-next-line no-control-regex
  const plain = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[=>c]/g, "");
  const lines = plain.split(/\r?\n/);
  lines.pop();
  return lines.flatMap((line) => {
    const m = /^n(\d+)\s*$/.exec(line.trim());
    return m ? [Number(m[1])] : [];
  });
}

/**
 * **写しと続きの継ぎ目で出力を落とさない・二重にしない**（レビューの指摘・2026-10-10）。tmux の stdout の1チャンクに写しの
 * 返事の最後の `%end` と続く `%output` が一緒に入ると、Promise の解決を待って境目を決めていた作りでは、その `%output` を
 * 捨てていた（30 回中 17〜20 回、写しの最後の行の直後に抜け）。連番を速く流すペインに何度も繋いで、数が1つずつ続くことを見る
 */
test("流れ：連番を速く流しているペインに繋いでも、写しと続きの継ぎ目で抜けも二重も無い", needsTmux, async () => {
  await withTerminal(async ({ terminal, tmux, dataDir }) => {
    const server = await listenStreams({ terminal: terminalStreamHandler({ tmux, log: () => undefined }) }, { dataDir });
    const path = streamSocketPathOf(dataDir);
    try {
      await terminal.createSession({ name: "main", cols: 80, rows: 24 });
      await tmux.exec(["send-keys", "-t", "=main:", "clear; i=0; while :; do i=$((i+1)); echo n$i; done", "Enter"]);
      const rounds = Number(process.env.BANTO_TERMINAL_SEAM_ROUNDS ?? 8);
      const broken: string[] = [];
      for (let round = 0; round < rounds; round++) {
        const c = dial(path, { session: "main", cols: 80, rows: 24 });
        await c.until(/n\d+\r?\n[\s\S]*n\d+\r?\n[\s\S]*n\d+\r?\n/);
        await new Promise((r) => setTimeout(r, 150));
        c.ws.close();
        await c.closed;
        const seen = countersOf(c.screen);
        for (let i = 1; i < seen.length; i++) {
          if (seen[i] !== seen[i - 1]! + 1) {
            broken.push(`${round + 1} 回目：n${seen[i - 1]} の次が n${seen[i]}`);
            break;
          }
        }
      }
      assert.deepEqual(broken, [], `継ぎ目で数が続かない（${broken.length}/${rounds}）`);
    } finally {
      await server.close();
    }
  });
});

/**
 * **閉じる理由は 123 バイトに切る**（レビューの指摘・2026-10-10）。日本語 31 字の名前だと理由が越え、`ws.close` が投げて
 * 流れが宙に浮いていた（開いている間に閉じたときは受け口の無い reject で Module ごと落ちた）
 */
test("流れ：長い日本語の名前でも、無い・使えない・閉じられたを理由つきで閉じる", { ...needsTmux, timeout: 30_000 }, async () => {
  await withTerminal(async ({ terminal, tmux, dataDir }) => {
    const server = await listenStreams({ terminal: terminalStreamHandler({ tmux, log: () => undefined }) }, { dataDir });
    const path = streamSocketPathOf(dataDir);
    const long = "あ".repeat(31);
    try {
      const missing = await dial(path, { session: long, cols: 80, rows: 24 }).closed;
      assert.equal(missing.code, 4404);
      assert.match(missing.reason, /^セッション「あ+」はあり$/);
      assert.ok(Buffer.byteLength(missing.reason) <= 123);
      assert.equal((await dial(path, { session: "い".repeat(41), cols: 80, rows: 24 }).closed).code, 1008);

      await terminal.createSession({ name: long });
      const c = dial(path, { session: long, cols: 80, rows: 24 });
      await c.until(/^\x1bc/);
      await terminal.closeSession({ name: long });
      const gone = await c.closed;
      assert.equal(gone.code, 4404);
      assert.ok(Buffer.byteLength(gone.reason) <= 123);
    } finally {
      await server.close();
    }
  });
});

// 別のサーバ（実行場所）では sudo にパスワードが要る・sudo が無いことがある。そのときは理由と入れ方を添えて断る
// （v4-security.md §1「前提の確かめ」——特定の Module だけが使う道具は、使うときに断る）
test("tmux が無く入れられないときは、理由と入れ方を添えて断る", async () => {
  const { Tmux, TerminalError } = await import("./tmux.js");
  const { writeFileSync, chmodSync } = await import("node:fs");
  const withSudo = mkdtempSync(join("/tmp", "term-nosudo-"));
  const empty = mkdtempSync(join("/tmp", "term-empty-"));
  try {
    writeFileSync(join(withSudo, "sudo"), "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n");
    chmodSync(join(withSudo, "sudo"), 0o755);
    for (const [dir, detail] of [
      [withSudo, "a password is required"],
      [empty, "sudo がありません"],
    ] as const) {
      const tmux = new Tmux({ env: { PATH: dir }, socket: `t-nosudo-${process.pid}` });
      await assert.rejects(tmux.ensureInstalled(() => {}), (err: Error) => {
        assert.ok(err instanceof TerminalError);
        assert.match(err.message, /この実行場所には tmux がありません/);
        assert.ok(err.message.includes(detail), err.message);
        assert.ok(err.message.includes("sudo apt install tmux"), err.message);
        return true;
      });
    }
  } finally {
    rmSync(withSudo, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
