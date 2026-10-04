// 画面から banto を更新する——host の口（`/api/admin/update`、アーキ仕様 §2.5・`docs/specs/v4-security.md` §2「画面からの更新」）。
// git は本物（一時フォルダの repo.git と、GitHub 役のリポジトリ）、systemctl は偽物で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { createApp } from "../http/app.js";
import { AuthStore } from "../auth/store.js";
import { AuthService, SESSION_COOKIE } from "../auth/service.js";
import { writeLoginLink } from "../auth/login-links.js";
import { SoftAuthenticator } from "../auth/soft-authenticator.js";
import { runCommand, SelfUpdate, UPDATE_UNIT, type CommandRunner } from "./self-update.js";

const UI = "http://localhost:4175";
const TOKEN = "machine-token";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

interface FakeSystemd {
  loadState: string;
  activeState: string;
  startFails: boolean;
  calls: string[][];
}

interface Ctx {
  base: string;
  dataDir: string;
  releaseDir: string;
  systemd: FakeSystemd;
  /** GitHub 役。`commit()` で release を進める */
  commit(subject: string): string;
  first: string;
  ui(path: string, init?: { method?: string; body?: unknown; cookie?: string }): Promise<Response>;
  machine(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** リンクで入る（入った直後の 10 分は本人確認済み） */
  login(): Promise<string>;
  /** パスキーを登録して、11 分進める（以後は本人確認が要る）。返すのは本人確認に使う鍵 */
  requireStepUpFrom(cookie: string): Promise<SoftAuthenticator>;
  stepUp(cookie: string, key: SoftAuthenticator): Promise<void>;
  clock: { now: number };
}

/**
 * 置き場の形：`<release>/repo.git`（bare、origin は GitHub 役）・`versions/<頭12>`（worktree）。
 * `codeInVersions` が false なら、動いているコードを置き場の外（開発用のリポジトリ役）に置く
 */
async function withUpdate(fn: (ctx: Ctx) => Promise<void>, opts: { codeInVersions?: boolean } = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-self-update-test-"));
  const dataDir = join(dir, "data");
  const releaseDir = join(dir, "release");
  const github = join(dir, "github");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(github, "banto"), { recursive: true });
  git(dir, "init", "-q", "-b", "release", github);
  await writeFile(join(github, "banto", "README"), "v1\n");
  git(github, "add", ".");
  git(github, "commit", "-q", "-m", "最初の版");
  const first = git(github, "rev-parse", "HEAD");
  let n = 0;
  const commit = (subject: string): string => {
    execFileSync("sh", ["-c", `echo ${++n} >> banto/README`], { cwd: github });
    git(github, "commit", "-q", "-am", subject);
    return git(github, "rev-parse", "HEAD");
  };

  const repo = join(releaseDir, "repo.git");
  git(dir, "init", "-q", "--bare", repo);
  git(repo, "remote", "add", "origin", github);
  git(repo, "fetch", "-q", "origin", "+refs/heads/release:refs/remotes/origin/release");
  const versionDir = join(releaseDir, "versions", first.slice(0, 12));
  git(repo, "worktree", "add", "-q", "--detach", versionDir, first);
  const codeDir = opts.codeInVersions === false ? join(github, "banto") : join(versionDir, "banto");

  const systemd: FakeSystemd = { loadState: "loaded", activeState: "inactive", startFails: false, calls: [] };
  const run: CommandRunner = async (file, args, o) => {
    if (file !== "systemctl") return runCommand(file, args, o);
    systemd.calls.push(args);
    if (args[0] === "show") {
      const prop = args[2];
      return { code: 0, stdout: `${prop === "LoadState" ? systemd.loadState : systemd.activeState}\n`, stderr: "" };
    }
    if (args[0] === "start") {
      return systemd.startFails ? { code: 1, stdout: "", stderr: "Interactive authentication required." } : { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `偽の systemctl は ${args[0]} を知りません` };
  };

  const clock = { now: Date.parse("2026-10-04T00:00:00Z") };
  const log = new EventLog(dataDir);
  await log.init();
  const projectThread = new ProjectThreadStore(dataDir, log);
  await projectThread.load();
  const globalMemory = new GlobalMemoryStore(dataDir, log);
  await globalMemory.load();
  const inbox = new InboxStore(dataDir, log);
  await inbox.load();
  const store = new AuthStore(dataDir, log, () => clock.now);
  await store.load();
  const server = createApp({
    projectThread,
    globalMemory,
    inbox,
    pendingApprovals: new PendingApprovalRegistry(),
    relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
    agentRelayEndpoint: new AgentRelayEndpoint(TOKEN),
    authToken: TOKEN,
    auth: new AuthService({ store, dataDir, authToken: TOKEN, uiOrigin: UI, apiBaseUrl: "http://localhost:4737", now: () => clock.now }),
    selfUpdate: new SelfUpdate({ releaseDir, dataDir, codeDir, run }),
    resolveModulesForThread: async () => [],
    dataDir,
    configDir: dir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const ui: Ctx["ui"] = (path, init = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-banto-client": "1",
        origin: UI,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const ctx: Ctx = {
    base,
    dataDir,
    releaseDir,
    systemd,
    commit,
    first,
    clock,
    ui,
    machine: (path, init = {}) =>
      fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    async login() {
      const { code } = await writeLoginLink(dataDir, clock.now);
      const res = await ui("/api/auth/redeem", { method: "POST", body: { code } });
      assert.equal(res.status, 200, await res.clone().text());
      const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      assert.ok(set);
      return set.split(";")[0]!;
    },
    async requireStepUpFrom(cookie) {
      const key = new SoftAuthenticator();
      const options = (await (await ui("/api/auth/passkey/register/options", { method: "POST", cookie })).json()) as {
        challenge: string;
        rp: { id: string };
      };
      const reg = await ui("/api/auth/passkey/register/verify", { method: "POST", cookie, body: { response: key.register(options, UI) } });
      assert.equal(reg.status, 200, await reg.clone().text());
      clock.now += 11 * 60 * 1000;
      return key;
    },
    async stepUp(cookie, key) {
      const options = (await (await ui("/api/auth/stepup/options", { method: "POST", cookie })).json()) as {
        challenge: string;
        rpId: string;
      };
      const res = await ui("/api/auth/stepup/verify", { method: "POST", cookie, body: { response: key.assert(options, UI) } });
      assert.equal(res.status, 200, await res.clone().text());
    },
  };
  try {
    await fn(ctx);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface StatusBody {
  ready: boolean;
  reasons: string[];
  current: { commit: string; subject: string } | null;
  latest: { commit: string; fastForward: boolean; checkedAt: string | null; commits: Array<{ commit: string; subject: string }> } | null;
  running: boolean;
  state: unknown;
}

const starts = (s: FakeSystemd) => s.calls.filter((c) => c[0] === "start");

test("GET は今の版・最後に確かめた最新とその間のコミットを返す。人も機械の合言葉も読める", async () => {
  await withUpdate(async (ctx) => {
    const b = ctx.commit("二つ目");
    const c = ctx.commit("三つ目");
    const before = (await (await ctx.machine("/api/admin/update")).json()) as StatusBody;
    assert.equal(before.ready, true, before.reasons.join("／"));
    assert.equal(before.current?.commit, ctx.first);
    assert.equal(before.current?.subject, "最初の版");
    // まだ確かめていない（GitHub 役は進んだが、repo.git は前に取ってきたまま）
    assert.equal(before.latest?.commit, ctx.first);
    assert.deepEqual(before.latest?.commits, []);
    assert.equal(before.running, false);
    assert.equal(before.state, null);

    const cookie = await ctx.login();
    const checked = await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
    assert.equal(checked.status, 200, await checked.clone().text());
    const after = (await checked.json()) as StatusBody;
    assert.equal(after.latest?.commit, c);
    assert.equal(after.latest?.fastForward, true);
    assert.ok(after.latest?.checkedAt);
    assert.deepEqual(
      after.latest?.commits.map((x) => [x.commit, x.subject]),
      [
        [c, "三つ目"],
        [b, "二つ目"],
      ],
    );
    // 人の画面からも読める
    assert.equal((await ctx.ui("/api/admin/update", { cookie })).status, 200);
  });
});

test("頼めるのはログイン中の人だけ、その場の本人確認（step-up）を済ませてから。機械の合言葉は断る", async () => {
  await withUpdate(async (ctx) => {
    const latest = ctx.commit("二つ目");
    const cookie = await ctx.login();
    await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
    const key = await ctx.requireStepUpFrom(cookie);

    // 機械の合言葉：読むのはよいが、確かめ直し・頼む・止めるはできない
    for (const path of ["/api/admin/update", "/api/admin/update/check", "/api/admin/update/cancel", "/api/admin/update/force-now"]) {
      const res = await ctx.machine(path, { method: "POST", body: { commit: latest, mode: "now" } });
      assert.equal(res.status, 403, path);
    }
    // 本人確認がまだ
    const denied = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "wait" } });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code?: string }).code, "step-up-required");
    assert.equal(starts(ctx.systemd).length, 0, "断ったのに unit を起こした");
    assert.equal(existsSync(join(ctx.dataDir, "update", "request.json")), false, "断ったのに頼みを書いた");

    await ctx.stepUp(cookie, key);
    const ok = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "wait" } });
    assert.equal(ok.status, 202, await ok.clone().text());
    const { id } = (await ok.json()) as { id: string };
    const request = JSON.parse(await readFile(join(ctx.dataDir, "update", "request.json"), "utf8")) as Record<string, unknown>;
    assert.equal(request.id, id);
    assert.equal(request.commit, latest);
    assert.equal(request.mode, "wait");
    assert.equal((request.requestedBy as { sessionId?: string }).sessionId !== undefined, true);
    assert.deepEqual(starts(ctx.systemd), [["start", "--no-block", UPDATE_UNIT]]);
  });
});

test("見せた最新と違う commit は断る（release が後から進んでも、それは入らない）", async () => {
  await withUpdate(async (ctx) => {
    const shown = ctx.commit("二つ目");
    const cookie = await ctx.login();
    await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
    // 人が一覧を見ている間に、誰かが確かめ直して release が進んだ
    ctx.commit("後から入ったもの");
    await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
    const res = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: shown, mode: "now" } });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "stale-commit");
    // 今の版そのもの・形の違う値も断る
    const same = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: ctx.first, mode: "now" } });
    assert.equal(same.status, 409);
    assert.equal((await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: "HEAD", mode: "now" } })).status, 400);
    const bad = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: shown, mode: "later" } });
    assert.equal(bad.status, 400);
    assert.equal(starts(ctx.systemd).length, 0);
  });
});

test("走っている更新があれば断る（unit が動いている・起こしたばかりでまだ受け取られていない）", async () => {
  await withUpdate(async (ctx) => {
    const latest = ctx.commit("二つ目");
    const cookie = await ctx.login();
    await ctx.ui("/api/admin/update/check", { method: "POST", cookie });

    ctx.systemd.activeState = "activating";
    const busy = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { code?: string }).code, "running");
    assert.equal(((await (await ctx.machine("/api/admin/update")).json()) as StatusBody).running, true);

    // 頼んだ直後（unit はまだ inactive）に2回目
    ctx.systemd.activeState = "inactive";
    assert.equal((await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } })).status, 202);
    const again = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } });
    assert.equal(again.status, 409);
    assert.equal(starts(ctx.systemd).length, 1);

    // 受け取られないまま古くなった頼みは数えない（unit が落ちていた等）
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(join(ctx.dataDir, "update", "request.json"), old, old);
    assert.equal((await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } })).status, 202);
  });
});

test("unit を起こせなければ、頼みを残さずに理由を返す", async () => {
  await withUpdate(async (ctx) => {
    const latest = ctx.commit("二つ目");
    const cookie = await ctx.login();
    await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
    ctx.systemd.startFails = true;
    const res = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /Interactive authentication required/);
    assert.equal(existsSync(join(ctx.dataDir, "update", "request.json")), false);
  });
});

test("準備が済んでいなければ（開発用のリポジトリから動いている）理由を返し、頼みは断る", async () => {
  await withUpdate(
    async (ctx) => {
      const latest = ctx.commit("二つ目");
      const status = (await (await ctx.machine("/api/admin/update")).json()) as StatusBody;
      assert.equal(status.ready, false);
      assert.equal(status.current, null);
      assert.ok(status.reasons.some((r) => r.includes("versions/ の外")), status.reasons.join("／"));
      const cookie = await ctx.login();
      await ctx.ui("/api/admin/update/check", { method: "POST", cookie });
      const res = await ctx.ui("/api/admin/update", { method: "POST", cookie, body: { commit: latest, mode: "now" } });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { code?: string }).code, "not-ready");
      assert.equal(starts(ctx.systemd).length, 0);
    },
    { codeInVersions: false },
  );
});

test("準備が済んでいなければ（banto-update.service が無い）理由を返す", async () => {
  await withUpdate(async (ctx) => {
    ctx.systemd.loadState = "not-found";
    const status = (await (await ctx.machine("/api/admin/update")).json()) as StatusBody;
    assert.equal(status.ready, false);
    assert.deepEqual(status.reasons, [`${UPDATE_UNIT} がありません（LoadState=not-found）`]);
    // 今の版は出せる
    assert.equal(status.current?.commit, ctx.first);
  });
});

test("待ちをやめるのはログイン中の人だけ。すぐ起こし直すは本人確認も要る。走っていなければ断る", async () => {
  await withUpdate(async (ctx) => {
    const cookie = await ctx.login();
    const key = await ctx.requireStepUpFrom(cookie);
    const updateDir = join(ctx.dataDir, "update");

    assert.equal((await ctx.ui("/api/admin/update/cancel", { method: "POST", cookie })).status, 409, "走っていないのに受けた");

    ctx.systemd.activeState = "activating";
    await mkdir(updateDir, { recursive: true });
    await writeFile(join(updateDir, "state.json"), JSON.stringify({ id: "x", phase: "wait" }));
    assert.equal((await ctx.machine("/api/admin/update/cancel", { method: "POST" })).status, 403);
    assert.equal((await ctx.ui("/api/admin/update/force-now", { method: "POST", cookie })).status, 403);
    assert.equal(existsSync(join(updateDir, "force-now")), false);

    assert.equal((await ctx.ui("/api/admin/update/cancel", { method: "POST", cookie })).status, 200);
    assert.equal(existsSync(join(updateDir, "cancel")), true);
    await ctx.stepUp(cookie, key);
    assert.equal((await ctx.ui("/api/admin/update/force-now", { method: "POST", cookie })).status, 200);
    assert.equal(existsSync(join(updateDir, "force-now")), true);

    // 起こし直しに入ったら、もう止められない
    await writeFile(join(updateDir, "state.json"), JSON.stringify({ id: "x", phase: "verify" }));
    assert.equal((await ctx.ui("/api/admin/update/cancel", { method: "POST", cookie })).status, 409);
  });
});
