/**
 * task-0034: `env.*` Tool と Environment Pool の設定面。ADR-0010 決定34。
 *
 * **Kobo も Banto も起こさない**（a7）。同梱の `process` ドライバを本物の子プロセスとして
 * 回すので、契約（stdin/stdout の7動詞）が実際に噛み合っているところまで見る。
 *
 * 一番見たいのは a1——**途中で失敗しても畳むこと**。外部リソースの消し忘れは金銭的実害で、
 * 本仕様で最も優先度の高い機構（I3）。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  EnvironmentPool,
  createEnvTools,
  DEFAULT_ENV_LIMITS,
  checkAdhocDriver,
  checkProfileLimits,
  loadProfile,
  resolveLimits,
  resolveRunTimeout,
  type EnvLimits,
} from "@banto/environment-pool";
import type { NamespacedToolDefinition } from "@banto/core";

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-pool-tools.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `process` ドライバで動く最小のプロファイル定義を書く。 */
function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function pool(limits?: Partial<EnvLimits>): EnvironmentPool {
  return new EnvironmentPool({ dataDir, ...(limits ? { limits } : {}), driverTimeoutMs: 20_000 });
}

function tool(p: EnvironmentPool, name: string): NamespacedToolDefinition {
  return createEnvTools(p).find((t) => t.name === name)!;
}

describe("[task-0034/a1] env.verify は一息で回して必ず畳む", () => {
  it("provision → healthcheck → run → teardown が通り、環境が残らない", async () => {
    const p = pool();
    const verify = tool(p, "env.verify");

    const result = await verify.execute({
      driver: "process",
      // 起動しっぱなしになるコマンド。healthcheck は生存を見る
      config: { cmd: "sleep 30" },
      cmd: "echo hello-from-env",
      taskId: "t-verify",
    });
    const details = result.details as {
      exit: number;
      logTail: string;
      tornDown: boolean;
      healthy: boolean;
      failure?: string;
    };

    assert.equal(details.healthy, true, "環境が使える状態になること");
    assert.equal(details.exit, 0, "コマンドが通ること");
    assert.match(details.logTail, /hello-from-env/, "ログの中身が返ること");
    assert.equal(details.failure, undefined);
    assert.equal(details.tornDown, true, "畳まれること");

    // 台帳にも生き残りがいない
    assert.deepEqual(p.list(), []);
  });

  it("**途中で失敗しても畳む**（I3: 消し忘れが一番困る）", async () => {
    const p = pool();
    const verify = tool(p, "env.verify");

    // 落ちるコマンドを走らせる。verify は失敗として返すが、環境は畳んでいること
    const result = await verify.execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      cmd: "exit 3",
      taskId: "t-fail",
    });
    const details = result.details as { exit: number; tornDown: boolean; failure?: string };

    assert.equal(details.exit, 3, "落ちた終了コードをそのまま返すこと");
    assert.equal(details.failure, undefined, "コマンドまでは到達していること");
    assert.equal(details.tornDown, true, "失敗しても畳むこと");
    assert.deepEqual(p.list(), [], "環境が残らないこと");
  });

  it("環境が立ち上がらなくても畳みまで到達する", async () => {
    const p = pool();
    const verify = tool(p, "env.verify");
    // 即座に終わるコマンド＝環境として生きていない
    await assert.rejects(
      () => verify.execute({ driver: "process", config: { cmd: "true" }, cmd: "echo x", taskId: "t-dead" }),
      /環境を用意できませんでした/
    );
    // provision 自体が失敗したので台帳には載らない（載せてから失敗すると幽霊が残る）
    assert.deepEqual(p.list({ includeTornDown: true }), []);
  });

  it("畳めなかったら成功に見せない（tornDown:false と理由が返る）", async () => {
    // **畳めない環境**を本当に作る。provision も healthcheck も run も通るが teardown だけ
    // 失敗するドライバ——ここが verify の一番きわどい経路で、
    // 「失敗したのに成功に見える」が起きると外部リソースが黙って残り続ける（I3）
    const driver = path.join(dir, "stubborn-driver");
    fs.writeFileSync(
      driver,
      [
        "#!/usr/bin/env node",
        'const verb = process.argv[2];',
        'if (verb === "teardown") { process.stderr.write("cannot destroy\\n"); process.exit(1); }',
        'const out = { provision: { handle: { id: "x" } }, healthcheck: { ok: true },',
        '  run: { exit: 0, log_path: "" } }[verb] ?? {};',
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"),
      { mode: 0o755 }
    );

    // 外部ドライバなので adhocDrivers を開ける（決定34e の設定面がここでも効く）
    const p = new EnvironmentPool({ dataDir, limits: { adhocDrivers: "all" }, driverTimeoutMs: 10_000 });
    const result = await tool(p, "env.verify").execute({
      driver,
      config: {},
      cmd: "echo x",
      taskId: "t-stubborn",
    });
    const details = result.details as {
      envId: string;
      ok: boolean;
      tornDown: boolean;
      teardownError?: string;
    };

    assert.equal(details.tornDown, false, "畳めなかったことを返すこと");
    assert.match(details.teardownError ?? "", /cannot destroy/, "理由が分かること");
    assert.match(result.content[0]!.text!, /環境が畳めていません/, "本文にも出ること（詳細だけだと気づかない）");

    // 台帳には生きたまま残る——残骸を追えるようにするため（黙って消さない）
    const remaining = p.list();
    assert.deepEqual(
      remaining.map((e) => e.envId),
      [details.envId],
      "畳めなかった環境は生きたまま台帳に残ること（残骸を追えるようにする）"
    );
  });
});

describe("[task-0034/a2] 低位動詞は envId を鍵に動く", () => {
  it("provision で得た envId で run / teardown できる。teardown は冪等", async () => {
    const p = pool();
    const provision = tool(p, "env.provision");
    const run = tool(p, "env.run");
    const teardown = tool(p, "env.teardown");
    const list = tool(p, "env.list");

    const created = await provision.execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      taskId: "t-low",
    });
    const envId = (created.details as { envId: string }).envId;
    assert.match(envId, /^env-/);

    // 立てたものは残る（居座らせたい環境のための経路）
    const listed = await list.execute({});
    assert.equal((listed.details as { environments: unknown[] }).environments.length, 1);

    const ran = await run.execute({ envId, cmd: "echo low-level" });
    assert.equal((ran.details as { exit: number }).exit, 0);

    const first = await teardown.execute({ envId });
    assert.equal((first.details as { alreadyDone: boolean }).alreadyDone, false);
    // 冪等: 2回目は何もせず成功する
    const second = await teardown.execute({ envId });
    assert.equal((second.details as { alreadyDone: boolean }).alreadyDone, true);

    assert.deepEqual(p.list(), []);
  });

  it("畳んだ環境への操作は黙って通さない", async () => {
    const p = pool();
    const created = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
    });
    const envId = (created.details as { envId: string }).envId;
    await tool(p, "env.teardown").execute({ envId });

    await assert.rejects(() => tool(p, "env.run").execute({ envId, cmd: "echo x" }), /既に畳まれています/);
    await assert.rejects(() => tool(p, "env.run").execute({ envId: "env-nope", cmd: "x" }), /台帳にありません/);
  });
});

describe("[task-0034/a3] プロファイルの在り処は呼び出し側が渡す", () => {
  it("repoPath の meta/environments.yaml が解決される", async () => {
    writeProfiles("profiles:\n  dev:\n    driver: process\n    config:\n      cmd: sleep 30\n    ttl: 1h\n");
    const p = pool();

    const created = await tool(p, "env.provision").execute({ repoPath: repo, profile: "dev" });
    const details = created.details as { profile: string; driver: string };
    assert.equal(details.profile, "dev");
    assert.equal(details.driver, "process");
    await tool(p, "env.teardown").execute({ envId: (created.details as { envId: string }).envId });
  });

  it("独自のプロジェクト登録簿を持たない（repoPath 無しでは profile を使えない）", async () => {
    const p = pool();
    await assert.rejects(
      () => tool(p, "env.provision").execute({ profile: "dev" }),
      /repoPath/
    );
  });

  it("毎回読み直す（D3: ファイルは意図。キャッシュしない）", () => {
    writeProfiles("profiles:\n  dev:\n    driver: process\n    ttl: 1h\n");
    const limits = resolveLimits();
    assert.equal(loadProfile(repo, "dev", limits).ok, true);

    writeProfiles("profiles:\n  other:\n    driver: process\n    ttl: 1h\n");
    const after = loadProfile(repo, "dev", limits);
    assert.equal(after.ok, false, "書き換えたらすぐ反映されること");
  });

  it("定義が無い・壊れているを区別して返す", () => {
    const limits = resolveLimits();
    const noFile = loadProfile(repo, "dev", limits);
    assert.equal(noFile.ok, false);
    assert.match((noFile as { reason: string }).reason, /がありません/);

    writeProfiles("profiles:\n  dev:\n    driver: process\n    ttl: 1h\n");
    const missing = loadProfile(repo, "prod", limits);
    assert.match((missing as { reason: string }).reason, /定義済み: dev/);
  });
});

describe("[task-0034/a4] workdir がドライバへ渡る", () => {
  it("provision / run がその場所で動く", async () => {
    const workdir = path.join(dir, "worktree");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "marker.txt"), "ここが作業場所\n");

    const p = pool();
    const result = await tool(p, "env.verify").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      // cwd が workdir でなければ marker.txt は見えない
      cmd: "cat marker.txt",
      workdir,
    });
    const details = result.details as { exit: number; logTail: string; tornDown: boolean };
    assert.equal(details.exit, 0, "workdir で動いていること");
    assert.match(details.logTail, /ここが作業場所/);
    assert.equal(details.tornDown, true);
  });

  it("省略時は現状どおりに落ちる（既存プロファイルを壊さない）", async () => {
    const p = pool();
    const result = await tool(p, "env.verify").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      cmd: "pwd",
    });
    const details = result.details as { exit: number };
    assert.equal(details.exit, 0, "workdir 無しでも動くこと");
  });

  it("workdir は台帳に残る（後続の run に同じ場所を渡せる）", async () => {
    const workdir = path.join(dir, "wt2");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "here.txt"), "ok\n");

    const p = pool();
    const created = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      workdir,
    });
    const envId = (created.details as { envId: string }).envId;
    assert.equal((created.details as { workdir?: string }).workdir, workdir);

    // run では workdir を渡していないのに、provision と同じ場所で走る
    const ran = await tool(p, "env.run").execute({ envId, cmd: "cat here.txt" });
    assert.equal((ran.details as { exit: number }).exit, 0);
    await tool(p, "env.teardown").execute({ envId });
  });
});

describe("[task-0034/a5] アドホック環境は既定でビルトインのみ", () => {
  it("既定では外部ドライバを拒む。ビルトインは通る", () => {
    const limits = resolveLimits();
    assert.equal(checkAdhocDriver("process", limits).ok, true);
    assert.equal(checkAdhocDriver("docker", limits).ok, true);
    const external = checkAdhocDriver("/opt/drivers/proxmox", limits);
    assert.equal(external.ok, false);
    assert.match((external as { reason: string }).reason, /費用/);
  });

  it("設定で all / none に切り替わる", () => {
    assert.equal(checkAdhocDriver("/opt/x", resolveLimits({ adhocDrivers: "all" })).ok, true);
    const none = checkAdhocDriver("process", resolveLimits({ adhocDrivers: "none" }));
    assert.equal(none.ok, false);
    assert.match((none as { reason: string }).reason, /プロファイルを使って/);
  });

  it("アドホックにも既定TTLが付いて台帳に載る（掃除の扱いを経路で変えない）", async () => {
    const p = pool();
    const created = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
    });
    const details = created.details as { ttlDeadline: string; profile: string; envId: string };
    assert.match(details.profile, /^adhoc:process$/);
    const remaining = new Date(details.ttlDeadline).getTime() - Date.now();
    assert.ok(remaining > 0 && remaining <= DEFAULT_ENV_LIMITS.defaultTtlMs + 1000);
    await tool(p, "env.teardown").execute({ envId: details.envId });
  });

  it("許していない外部ドライバは黙ってビルトインに差し替えない", async () => {
    const p = pool();
    await assert.rejects(
      () => tool(p, "env.provision").execute({ driver: "/opt/drivers/proxmox", config: {} }),
      /アドホックで使えるのは/
    );
  });
});

describe("[task-0034/a6] 上限は能力側が持ち、超えたら丸めず拒否する", () => {
  it("TTL が上限を超えるプロファイルは理由つきで拒否される", () => {
    const limits = resolveLimits();
    const check = checkProfileLimits(
      { name: "long", driver: "process", ttlMs: 720 * 3600 * 1000 },
      limits
    );
    assert.equal(check.ok, false);
    assert.match((check as { reason: string }).reason, /丸めずに拒否/);
  });

  it("quota が上限を超えるプロファイルも拒否される", () => {
    const check = checkProfileLimits(
      { name: "many", driver: "process", ttlMs: 1000, quota: { max_instances: 99 } },
      resolveLimits()
    );
    assert.equal(check.ok, false);
    assert.match((check as { reason: string }).reason, /max_instances/);
  });

  it("拒否されたプロファイルは env.list_profiles に理由つきで出る（黙って隠さない）", async () => {
    writeProfiles(
      "profiles:\n" +
        "  ok:\n    driver: process\n    ttl: 1h\n" +
        "  toolong:\n    driver: process\n    ttl: 720h\n"
    );
    const listed = await tool(pool(), "env.list_profiles").execute({ repoPath: repo });
    const details = listed.details as {
      usable: Array<{ name: string }>;
      rejected: Array<{ name: string; reason: string }>;
    };
    assert.deepEqual(details.usable.map((p) => p.name), ["ok"]);
    assert.deepEqual(details.rejected.map((r) => r.name), ["toolong"]);
    assert.match(listed.content[0]!.text!, /toolong — 使えません/);
  });

  it("同時実行の上限を超えると立てられない（台帳から数える・D3）", async () => {
    const p = pool({ maxInstancesTotal: 1, maxInstancesPerProfile: 1 });
    const first = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
    });
    await assert.rejects(
      () => tool(p, "env.provision").execute({ driver: "process", config: { cmd: "sleep 30" } }),
      /同時に動かせる環境は 1 個までです/
    );

    // 畳めばまた立てられる（生きているものだけを数えている）
    await tool(p, "env.teardown").execute({ envId: (first.details as { envId: string }).envId });
    const second = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
    });
    await tool(p, "env.teardown").execute({ envId: (second.details as { envId: string }).envId });
  });
});

describe("[task-0034] 職人には渡さない（決定32c）", () => {
  it("env.* は Worker Pool の職人向け Tool に混ざっていない", async () => {
    const { createWorkerTools, createWorkerReportTools } = await import("@banto/worker-pool");
    void createWorkerTools;
    // 職人が持つのは報告経路だけ。ここに env.* が混ざると、職人が自分の作業を
    // 自分で検証して「通りました」と言えてしまい、決定29a が崩れる
    const workerSide = createWorkerReportTools({} as never).map((t) => t.name);
    for (const name of workerSide) {
      assert.doesNotMatch(name, /^env\./);
    }
  });
});

describe("[task-0034] spec-environment §3.1 の契約と一致していること（P3）", () => {
  it("env.provision は立てた直後の疎通も返す（立つ≠使える）", async () => {
    const p = pool();
    const created = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
    });
    const details = created.details as {
      envId: string;
      profile: string;
      driver: string;
      ttlDeadline: string;
      healthcheck: { ok: boolean; detail?: string };
    };
    assert.equal(details.healthcheck.ok, true);
    // spec の表にある列がそろっていること
    for (const key of ["envId", "profile", "driver", "ttlDeadline"] as const) {
      assert.ok(details[key], `${key} が返ること`);
    }
    assert.match(created.content[0]!.text!, /いま使えるか: 使えます/);
    await tool(p, "env.teardown").execute({ envId: details.envId });
  });

  it("env.list は state を返し、畳み損ねを畳み済みと同じに見せない", async () => {
    const p = pool();
    const created = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      taskId: "t-state",
    });
    const envId = (created.details as { envId: string }).envId;

    const live = (await tool(p, "env.list").execute({})).details as {
      environments: Array<{ state: string }>;
    };
    assert.deepEqual(live.environments.map((e) => e.state), ["live"]);

    await tool(p, "env.teardown").execute({ envId });
    const all = (await tool(p, "env.list").execute({ includeTornDown: true })).details as {
      environments: Array<{ state: string }>;
    };
    assert.deepEqual(all.environments.map((e) => e.state), ["torn-down"]);
  });

  it("env.list は projectTag で絞れる", async () => {
    const p = pool();
    const a = await tool(p, "env.provision").execute({
      driver: "process",
      config: { cmd: "sleep 30" },
      taskId: "t-a",
    });
    const listed = (await tool(p, "env.list").execute({ projectTag: "よそ" })).details as {
      environments: unknown[];
    };
    assert.deepEqual(listed.environments, [], "別のプロジェクトのものは出ないこと");
    await tool(p, "env.teardown").execute({ envId: (a.details as { envId: string }).envId });
  });

  it("**確かめていないことを通ったと読ませない**（走らなかったら exit は 0 にしない）", async () => {
    // healthcheck が通らないドライバ。run まで到達しない
    const driver = path.join(dir, "sick-driver");
    fs.writeFileSync(
      driver,
      [
        "#!/usr/bin/env node",
        "const verb = process.argv[2];",
        'const out = { provision: { handle: { id: "x" } }, healthcheck: { ok: false, detail: "起動していません" } }[verb] ?? {};',
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"),
      { mode: 0o755 }
    );
    const p = new EnvironmentPool({ dataDir, limits: { adhocDrivers: "all" }, driverTimeoutMs: 10_000 });
    const result = await tool(p, "env.verify").execute({ driver, config: {}, cmd: "echo x" });
    const details = result.details as { exit: number; healthy: boolean; failure?: string; tornDown: boolean };

    assert.equal(details.healthy, false);
    assert.notEqual(details.exit, 0, "走らせていないのに 0 を返さないこと");
    assert.match(details.failure ?? "", /healthcheck/);
    assert.match(result.content[0]!.text!, /検証まで到達しませんでした/);
    assert.equal(details.tornDown, true, "それでも畳むこと");
  });
});

describe("[spec-environment §5] TTL 執行と照合は Environment Pool 側にある", () => {
  it("**期限を過ぎた環境は畳まれる**（ここに無いと誰も片付けない）", async () => {
    // 期限をごく短くして立てる。番頭が Kobo 無しで立てた環境が対象になることを見る
    const p = pool();
    const created = await p.provision({
      driver: "process",
      config: { cmd: "sleep 60" },
      ttlMs: 1,
      taskId: "t-ttl",
    });
    assert.deepEqual(p.list().map((e) => e.envId), [created.envId]);

    await new Promise((r) => setTimeout(r, 30));
    const result = await p.runMaintenance();

    assert.deepEqual(result.tornDown, [created.envId], "期限切れが畳まれること");
    assert.deepEqual(p.list(), [], "生きた環境が残らないこと");
  });

  it("期限内の環境は畳まれない", async () => {
    const p = pool();
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const result = await p.runMaintenance();
    assert.deepEqual(result.tornDown, []);
    assert.deepEqual(p.list().map((e) => e.envId), [created.envId]);
    await p.teardown(created.envId);
  });

  it("執行を回していないことを number で誤魔化さない（回っていなければそう返る）", async () => {
    const p = pool();
    assert.equal(p.isMaintaining(), false);
    p.startMaintenance();
    assert.equal(p.isMaintaining(), true);
    p.stopMaintenance();
    assert.equal(p.isMaintaining(), false);
  });

  it("台帳に無い実リソースを照合で見つける（消しはしない）", async () => {
    const p = pool();
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" }, taskId: "t-orphan" });
    // 台帳から消して「実物だけある」状態を作る＝クラッシュ中に生じた孤児と同じ形
    const ledgerFile = path.join(dataDir, "env-ledger.json");
    const raw = JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) as { entries: unknown[] };
    raw.entries = [];
    fs.writeFileSync(ledgerFile, JSON.stringify(raw));

    const fresh = pool();
    // 台帳が空だと照合するドライバも分からないので、1本立て直してから見る
    const other = await fresh.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const found = await fresh.reconcile();

    assert.ok(
      found.some((o) => o.name.includes("t-orphan")),
      `孤児が見つかること。見つかったもの: ${JSON.stringify(found)}`
    );
    // 消さない——Banto 以外が作ったものを巻き込まないため
    assert.ok(fresh.orphans().length > 0);
    await fresh.teardown(other.envId);
    await p.teardown(created.envId).catch(() => undefined);
  });

  it("既定TTLは spec §5.1 の 30分（実装が勝手に別の数字を選ばない）", () => {
    assert.equal(DEFAULT_ENV_LIMITS.defaultTtlMs, 30 * 60 * 1000);
    assert.equal(DEFAULT_ENV_LIMITS.maxTtlMs, 24 * 3600 * 1000);
    assert.equal(DEFAULT_ENV_LIMITS.maxInstancesPerProfile, 4);
    assert.equal(DEFAULT_ENV_LIMITS.maxInstancesTotal, 8);
    assert.equal(DEFAULT_ENV_LIMITS.adhocDrivers, "builtin");
  });
});

describe("[I3] 片付けが他人のプロセスを壊さない（pid の使い回し）", () => {
  it("記録の pid が別のプロセスになっていたら、殺さず記録だけ片付ける", async () => {
    // ドライバの記録に、いま生きている**無関係な**プロセスの pid を仕込む。
    // pid は使い回されるので、古い記録がこの状態になることが実際にある（7月の記録2件がそうだった）
    const victim = childProcess.spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    victim.unref();
    const stateFile = TEST_DRIVER_STATE;
    const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf-8") : undefined;
    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify([
          {
            pid: victim.pid,
            name: "古い記録-env",
            taskId: "古い記録",
            // 記録上のコマンドは実物（sleep）と違う＝もう自分のものではない
            cmd: "python3 -m http.server 9999",
            created: "2026-07-24T00:00:00.000Z",
          },
        ])
      );

      const p = pool();
      // ドライバは alive:false を添えるので、照合はこれを実リソースと数えない
      const found = await p.reconcile().catch(() => []);
      assert.ok(
        !found.some((o) => o.name === "古い記録-env"),
        "別のプロセスになった記録を実リソースとして数えないこと"
      );

      // そして無関係なプロセスは生きたまま
      assert.doesNotThrow(() => process.kill(victim.pid!, 0), "他人のプロセスを殺していないこと");
    } finally {
      try {
        process.kill(victim.pid!, "SIGKILL");
      } catch { /* already gone */ }
      if (before !== undefined) fs.writeFileSync(stateFile, before);
      else fs.rmSync(stateFile, { force: true });
    }
  });
});

describe("[spec-environment §8 裁定] run の制限時間", () => {
  it("**検証コマンドは30秒で切れない**（既定は分単位）", () => {
    assert.ok(
      DEFAULT_ENV_LIMITS.defaultRunTimeoutMs >= 5 * 60 * 1000,
      `既定が短すぎる: ${DEFAULT_ENV_LIMITS.defaultRunTimeoutMs}ms。npm test が途中で切れる`
    );
    assert.ok(DEFAULT_ENV_LIMITS.maxRunTimeoutMs >= DEFAULT_ENV_LIMITS.defaultRunTimeoutMs);
  });

  it("呼び出し側は厳しくのみできる（上限を超える指定は丸める）", () => {
    const limits = resolveLimits();
    assert.equal(resolveRunTimeout(undefined, limits), limits.defaultRunTimeoutMs);
    assert.equal(resolveRunTimeout(5_000, limits), 5_000, "短くはできる");
    assert.equal(
      resolveRunTimeout(999 * 3600 * 1000, limits),
      limits.maxRunTimeoutMs,
      "上限より長くはできない"
    );
  });

  it("既定より長くかかるコマンドが、既定の制限時間の中なら通る", async () => {
    const p = pool();
    // ドライバの他の動詞は短い制限（20秒）のまま。run だけ別枠であることを見る
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const result = await p.run(created.envId, "sleep 25 && echo 長くかかった");
    assert.equal(result.exit, 0, "25秒のコマンドが切られないこと");
    assert.match(result.logTail, /長くかかった/);
    await p.teardown(created.envId);
  });
});

describe("[PO指摘] 溜まったものが捨てられる（際限なく増えない）", () => {
  it("保存期間を過ぎた成果物は捨てられ、新しいものは残る", async () => {
    const p = pool({ collectedRetentionMs: 1000 });
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const { dest } = await p.collect(created.envId);
    fs.writeFileSync(path.join(dest, "old.txt"), "古い");

    // 古く見せる（保存期間より前に触られたことにする）
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(dest, past, past);

    // 新しい方も1つ作る
    const fresh = path.join(p.collectedRoot(), "env-新しい");
    fs.mkdirSync(fresh, { recursive: true });

    await p.runMaintenance();

    assert.equal(fs.existsSync(dest), false, "期間を過ぎた成果物は捨てられること");
    assert.equal(fs.existsSync(fresh), true, "新しいものは残ること");
    await p.teardown(created.envId).catch(() => undefined);
  });

  it("台帳の古い記録は捨てられるが、**生きている環境は期間に関係なく残る**", async () => {
    const p = pool({ ledgerRetentionMs: 1000 });
    const live = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const gone = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    await p.teardown(gone.envId);

    // 畳んだ記録を古く見せる
    const file = path.join(dataDir, "env-ledger.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      entries: Array<{ envId: string; tornDownAt?: string }>;
    };
    for (const e of raw.entries) {
      if (e.envId === gone.envId) e.tornDownAt = new Date(Date.now() - 60_000).toISOString();
    }
    fs.writeFileSync(file, JSON.stringify(raw));

    const fresh = pool({ ledgerRetentionMs: 1000 });
    await fresh.runMaintenance();

    const remaining = fresh.list({ includeTornDown: true }).map((e) => e.envId);
    assert.ok(!remaining.includes(gone.envId), "古い畳んだ記録は捨てられること");
    assert.ok(remaining.includes(live.envId), "生きている環境は残ること");
    await fresh.teardown(live.envId).catch(() => undefined);
  });

  it("ドライバは自分の古いログを捨てる", async () => {
    const logDir = path.join(os.tmpdir(), "banto-process-driver-logs");
    fs.mkdirSync(logDir, { recursive: true });
    const old = path.join(logDir, "run-とても古い.log");
    fs.writeFileSync(old, "古いログ");
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);

    const p = pool();
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    await p.run(created.envId, "echo ログを1つ書く");

    assert.equal(fs.existsSync(old), false, "保存期間を過ぎたログが捨てられること");
    await p.teardown(created.envId);
  });
});

describe("[PO提案] env.cleanup（番頭が判断して捨てる）", () => {
  it("環境を名指しで捨てられる。他は残る", async () => {
    const p = pool();
    const a = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const b = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const destA = (await p.collect(a.envId)).dest;
    const destB = (await p.collect(b.envId)).dest;
    fs.writeFileSync(path.join(destA, "x"), "中身");

    const result = p.cleanupArtifacts({ envId: a.envId });
    assert.deepEqual(result.removed.map((r) => r.envId), [a.envId]);
    assert.ok(result.bytesFreed > 0, "捨てた分の大きさが返ること");
    assert.equal(fs.existsSync(destA), false);
    assert.equal(fs.existsSync(destB), true, "名指ししていないものは残ること");

    await p.teardown(a.envId);
    await p.teardown(b.envId);
  });

  it("**台帳は消えない**（番頭に自分の記録を編集させない・I1）", async () => {
    const p = pool();
    const created = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    await p.collect(created.envId);
    p.cleanupArtifacts({ envId: created.envId });

    const remaining = p.list({ includeTornDown: true }).map((e) => e.envId);
    assert.ok(remaining.includes(created.envId), "何を立てたかの記録は残ること");
    await p.teardown(created.envId);
  });

  it("何を捨てるか指定しなければ何もしない（全部消すを既定にしない）", () => {
    assert.throws(() => pool().cleanupArtifacts({}), /どれを捨てるか指定/);
  });

  it("olderThanDays: 0 なら全部捨てられる", async () => {
    const p = pool();
    const a = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    const b = await p.provision({ driver: "process", config: { cmd: "sleep 60" } });
    await p.collect(a.envId);
    await p.collect(b.envId);
    assert.equal(p.artifactUsage().count, 2);

    const result = p.cleanupArtifacts({ olderThanDays: 0 });
    assert.equal(result.removed.length, 2);
    assert.equal(p.artifactUsage().count, 0);

    await p.teardown(a.envId);
    await p.teardown(b.envId);
  });

  it("名指ししたものが無ければ、消えたことにしない", () => {
    assert.throws(() => pool().cleanupArtifacts({ envId: "env-無い" }), /成果物はありません/);
  });

  it("パスは受け取らない（塞いだ穴をまた開けない）", () => {
    const cleanup = createEnvTools(pool()).find((t) => t.name === "env.cleanup")!;
    const properties = Object.keys(
      (cleanup.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    );
    for (const name of properties) {
      assert.doesNotMatch(name, /path|dir|dest/i, `${name} がパスを受けている`);
    }
  });
});
