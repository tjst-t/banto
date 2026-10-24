// **待つ形の runCommand のあとに、仕事の組に残ったプロセス**（Backlog #527）。
// 見るもの：
//   - 引き取ったものは一覧に `leftover` として出て（outputFile は無い）、cancelCommand で組ごと止まる。届けるものは無い
//   - 起き直した host の問いとは合わない（札が無い）
//   - 本物のユーザーの systemd があれば：`(setsid sleep … &)` が残り、一覧に出て、止めると消える。時間切れなら組ごと止める
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { inWorkScope, workScopeEnv, workScopeOwner } from "@banto/module-contract";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundCommands } from "./background.js";
import type { BackgroundLauncher } from "./background-launcher.js";
import { SystemdScopes, type ScopeControl } from "./leftover-scope.js";
import { commandScopeOwner, runCommand, sweepLeftoverCommandScopes } from "./run-command.js";
import { fakeRelayClient } from "./testing/fake-relay-client.js";

const OWNER = { projectId: "p1", threadId: "t1" };

const unusedLauncher: BackgroundLauncher = {
  prepare: async () => {},
  start: async () => {
    throw new Error("呼ばれないはず");
  },
  stop: async () => {
    throw new Error("呼ばれないはず");
  },
};

function withRegistry(scopes: ScopeControl | undefined, fn: (bg: BackgroundCommands, root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-leftover-"));
    mkdirSync(join(root, "project"));
    const bg = new BackgroundCommands({
      dir: join(root, "commands"),
      secretsDir: join(root, "run"),
      projectRoot: join(root, "project"),
      launcher: unusedLauncher,
      deliver: async () => {
        throw new Error("残ったプロセスは届けない");
      },
      ...(scopes ? { scopes } : {}),
    });
    try {
      await fn(bg, join(root, "project"));
    } finally {
      bg.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "引き取った残りは一覧に leftover で出て、cancelCommand で組ごと止まる",
  (() => {
    const alive = new Set<string>();
    const stops: string[] = [];
    const scopes: ScopeControl = {
      leftover: async () => undefined,
      populated: (cgroup) => alive.has(cgroup),
      stop: async (unit, cgroup) => {
        stops.push(unit);
        alive.delete(cgroup);
      },
    };
    return withRegistry(scopes, async (bg, project) => {
      alive.add("/u/banto-shell-1.scope");
      const view = bg.adoptLeftover({
        command: "(setsid sleep 100000 &)",
        cwd: project,
        startedAt: new Date().toISOString(),
        unit: "banto-shell-1.scope",
        cgroup: "/u/banto-shell-1.scope",
        requestedBy: OWNER,
      });
      assert.equal(view.status, "running");
      assert.equal(view.leftover, true);
      assert.equal(view.outputFile, undefined);
      assert.deepEqual(
        bg.list(OWNER).map((c) => [c.commandId, c.status]),
        [[view.commandId, "running"]],
      );
      assert.deepEqual(bg.list({ projectId: "p1", threadId: "other" }), []);
      // 札の無い記録は、起き直した host の問いと合わない
      assert.deepEqual(
        bg.answerResume([{ replyTo: "reply_x", thread: OWNER }], () => true).map((a) => a.resume),
        [false],
      );
      const after = await bg.cancel(view.commandId);
      assert.deepEqual(stops, ["banto-shell-1.scope"]);
      assert.equal(after.status, "cancelled");
      assert.equal(bg.willDeliver(view.commandId), false);
    });
  })(),
);

test(
  "残りが自分で終わったら exited（終了コードは持たない）",
  (() => {
    let populated = true;
    const scopes: ScopeControl = { leftover: async () => undefined, populated: () => populated, stop: async () => {} };
    return withRegistry(scopes, async (bg, project) => {
      const view = bg.adoptLeftover({ command: "x &", cwd: project, startedAt: new Date().toISOString(), unit: "u.scope", cgroup: "/u" });
      populated = false;
      const [now] = bg.list();
      assert.equal(now?.commandId, view.commandId);
      assert.equal(now?.status, "exited");
      assert.equal(now?.exitCode, undefined);
      await assert.rejects(bg.cancel(view.commandId), /もう動いていません/);
    });
  })(),
);

/** 本物のユーザーの systemd で scope を作れるか（コンテナの中の Shell と同じ形）。作れなければ本物の試験は飛ばす */
function userScopeWorks(): boolean {
  const runtime = `/run/user/${process.getuid?.() ?? 0}`;
  const r = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "/bin/true"], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
    timeout: 10_000,
  });
  return r.status === 0;
}

const realSystemd = userScopeWorks();

test(
  "本物の systemd：(setsid sleep &) は残って一覧に出て、cancelCommand で消える",
  { skip: realSystemd ? false : "ユーザーの systemd で scope を作れない" },
  withRegistry(undefined, async (bg, project) => {
    const scopes = new SystemdScopes();
    const r = await runCommand(
      { command: "(setsid sleep 100527 > /dev/null 2>&1 &); echo started" },
      { projectRoot: project, relayClient: fakeRelayClient(), leftovers: bg, requestedBy: OWNER, workScopeAvailable: () => true },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "started\n");
    const id = r.leftover?.commandId;
    assert.ok(id, JSON.stringify(r));
    assert.match(r.leftover!.note, /cancelCommand/);
    const listed = bg.list(OWNER);
    assert.deepEqual(listed.map((c) => [c.commandId, c.status, c.leftover]), [[id, "running", true]]);
    const record = bg.get(id)!.record;
    assert.ok(scopes.populated(record.leftover!.cgroup));
    const after = await bg.cancel(id);
    assert.equal(after.status, "cancelled");
    assert.equal(scopes.populated(record.leftover!.cgroup), false);
  }),
);

test(
  "本物の systemd：時間切れなら、後ろに回したものも組ごと止める（一覧には残さない）",
  { skip: realSystemd ? false : "ユーザーの systemd で scope を作れない" },
  withRegistry(undefined, async (bg, project) => {
    const r = await runCommand(
      { command: "(setsid sleep 100528 > /dev/null 2>&1 &); sleep 30", timeout: 1 },
      { projectRoot: project, relayClient: fakeRelayClient(), leftovers: bg, requestedBy: OWNER, workScopeAvailable: () => true },
    );
    assert.equal(r.timedOut, true);
    assert.equal(r.leftover?.stopped, true, JSON.stringify(r));
    assert.deepEqual(bg.list(OWNER), []);
    assert.equal(spawnSync("pgrep", ["-f", "sleep 100528"]).status, 1, "sleep が残っている");
  }),
);

test(
  "本物の systemd：何も残らなければ leftover を持たない",
  { skip: realSystemd ? false : "ユーザーの systemd で scope を作れない" },
  withRegistry(undefined, async (bg, project) => {
    const r = await runCommand(
      { command: "echo hi" },
      { projectRoot: project, relayClient: fakeRelayClient(), leftovers: bg, requestedBy: OWNER, workScopeAvailable: () => true },
    );
    assert.equal(r.stdout, "hi\n");
    assert.equal(r.leftover, undefined);
    assert.deepEqual(bg.list(), []);
  }),
);

test(
  "本物の systemd：起きたときの片づけ——前の走行が待っていたコマンドの組は止め、引き取った残り・別の1本の組は残す（Backlog #294）",
  { skip: realSystemd ? false : "ユーザーの systemd で scope を作れない" },
  withRegistry(undefined, async (bg, project) => {
    // 本物の banto-shell-*.scope（この機械で走っているコマンド）に触らないよう、試験だけの頭を使う
    const kind = `shell-sweeptest-${randomBytes(3).toString("hex")}`;
    const env = workScopeEnv();
    const start = (marker: string, owner: string | null = commandScopeOwner()) => {
      // 待つ形の E2E の `grep | tail` が、答えを返す相手（止まった Shell）を失って待ち続けている形
      const launch = inWorkScope("/bin/sh", ["-c", `sleep 300 | tail -n 1 # ${marker}`], {
        kind,
        env,
        available: () => true,
        ...(owner ? { owner } : {}),
      });
      assert.ok(launch.unit);
      spawn(launch.command, launch.args, { env: launch.env, stdio: "ignore", detached: true }).unref();
      return launch.unit;
    };
    const stray = start("stray");
    const adopted = start("adopted");
    // 同じ Project に立てた2本目の Shell が待っているコマンド・印の無い組（この1本のものか分からない）
    const others = [start("other", workScopeOwner("shell", { BANTO_MODULE_NAME: "shell-second" })), start("unmarked", null)];
    const scopes = new SystemdScopes();
    try {
      let cgroup: string | undefined;
      for (let i = 0; i < 100; i++) {
        cgroup = await scopes.leftover(adopted, env);
        if (cgroup && (await scopes.leftover(stray, env)) && (await Promise.all(others.map((u) => scopes.leftover(u, env)))).every(Boolean)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(cgroup, "組が起きない（試験の前提）");
      for (const u of others) assert.ok(await scopes.leftover(u, env), "組が起きない（試験の前提）");
      bg.adoptLeftover({ command: "sleep 300 | tail -n 1", cwd: project, startedAt: new Date().toISOString(), unit: adopted, cgroup, requestedBy: OWNER });

      const r = await sweepLeftoverCommandScopes(bg, { kind, available: () => true });
      assert.deepEqual(r, { stopped: [stray], failed: [] });
      assert.equal(await scopes.leftover(stray, env), undefined, `${stray} が残っている`);
      assert.ok(await scopes.leftover(adopted, env), "引き取った残りまで止めた（cancelCommand で止めるもの）");
      for (const u of others) assert.ok(await scopes.leftover(u, env), `この1本のものでない組 ${u} まで止めた`);
    } finally {
      spawnSync("systemctl", ["--user", "stop", stray, adopted, ...others], { env });
    }
  }),
);
