import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore, RemoteProjectError } from "../project-thread/store.js";
import { rootIsOnThisMachine, runtimeKindOf, suspendsServicesToClose, suspendsServicesToSleep, usesHostContainer } from "./runtime-kind.js";
import { RemoteRuntimeStore } from "./remote-store.js";
import { RemoteRuntimeError, RemoteRuntimes, parseHostKey, parseRuntimeInput, remoteNameOf } from "./remote-runtimes.js";
import { fingerprintOf, type RuntimeCheck } from "./ssh.js";

const KEY = { type: "ssh-ed25519", key: "AAAAC3NzaC1lZDI1NTE5AAAAIOld", fingerprint: fingerprintOf("AAAAC3NzaC1lZDI1NTE5AAAAIOld") };
const NEW_KEY = { type: "ssh-ed25519", key: "AAAAC3NzaC1lZDI1NTE5AAAAINew", fingerprint: fingerprintOf("AAAAC3NzaC1lZDI1NTE5AAAAINew") };
const INPUT = { name: "lab", host: "192.168.1.80", user: "banto", port: 22, identity: "lab-ssh", dataRoot: "~/.local/share/banto-remote", mode: "machine" as const };
const OK: RuntimeCheck[] = [{ id: "tools", label: "道具", status: "ok" }];

async function withStores(fn: (s: { dir: string; log: EventLog; store: RemoteRuntimeStore; projects: ProjectThreadStore; runtimes: RemoteRuntimes }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-rt-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new RemoteRuntimeStore(dir, log);
    await store.load();
    const projects = new ProjectThreadStore(dir, log);
    await projects.load();
    const runtimes = new RemoteRuntimes({
      dataDir: dir,
      store,
      startSshAgent: async () => {
        throw new Error("この試験では繋がない");
      },
      publicKeyOf: async () => {
        throw new Error("この試験では繋がない");
      },
      // cli.ts と同じ数え方（閉じたものは外すときだけ数える。移している途中は移す先としても）
      projectsUsing: (rt, opts) =>
        projects
          .listProjects()
          .filter((p) => (p.runtime === rt && (p.status !== "closed" || opts?.includeClosed)) || p.move?.to.runtime === rt)
          .map((p) => ({ id: p.id, name: p.name })),
    });
    await fn({ dir, log, store, projects, runtimes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("宛先の入力：名前（id を兼ねる）・ホスト・鍵を確かめ、置き場の既定を入れる", () => {
  assert.deepEqual(parseRuntimeInput({ name: "lab", host: " 192.168.1.80 ", user: "banto", port: "2222", identity: "k" }), {
    name: "lab",
    host: "192.168.1.80",
    user: "banto",
    port: 2222,
    identity: "k",
    dataRoot: "~/.local/share/banto-remote",
    mode: "machine",
  });
  assert.equal(parseRuntimeInput({ ...INPUT, mode: "containers" }).mode, "containers");
  assert.throws(() => parseRuntimeInput({ ...INPUT, mode: "vm" }), /動かし方/);
  assert.throws(() => parseRuntimeInput({ ...INPUT, name: "Lab PVE" }), /名前/);
  assert.throws(() => parseRuntimeInput({ ...INPUT, host: "-oProxyCommand=sh" }), /ホスト/);
  assert.throws(() => parseRuntimeInput({ ...INPUT, identity: "" }), /SSH 鍵/);
  assert.throws(() => parseRuntimeInput({ ...INPUT, dataRoot: "relative/x" }), /置き場/);
});

test("画面から来た host 鍵の指紋は信じず、鍵から計算し直す", () => {
  assert.deepEqual(parseHostKey({ ...KEY, fingerprint: "SHA256:嘘" }), KEY);
  assert.throws(() => parseHostKey({ type: "ssh-ed25519; rm", key: "x", fingerprint: "" }), /形/);
});

test("記録：登録・鍵の違い・覚え直し・外す、が畳み直しても同じ", async () => {
  await withStores(async ({ dir, log, store }) => {
    await store.register(INPUT, KEY, OK);
    await store.recordMismatch("lab", NEW_KEY);
    let r = store.get("lab")!;
    assert.equal(r.hostKey.fingerprint, KEY.fingerprint);
    assert.equal(r.hostKeyMismatch?.fingerprint, NEW_KEY.fingerprint);
    await store.acceptHostKey("lab", NEW_KEY);
    r = store.get("lab")!;
    assert.equal(r.hostKey.fingerprint, NEW_KEY.fingerprint);
    assert.equal(r.hostKeyMismatch, undefined);
    // 読み直しても同じ（ログから畳む）
    const again = new RemoteRuntimeStore(dir, log);
    await again.load();
    assert.deepEqual(again.get("lab"), r);
    await store.remove("lab");
    assert.equal(store.get("lab"), undefined);
  });
});

test("選べない理由：ほかの Project が使っている → 鍵が違う → 前提が足りない の順", async () => {
  await withStores(async ({ store, projects, runtimes }) => {
    await store.register(INPUT, KEY, [{ id: "tools", label: "道具", status: "fail" }]);
    assert.equal(runtimes.get("lab")!.unavailableReason, "前提が足りません");
    await store.recordMismatch("lab", NEW_KEY);
    assert.equal(runtimes.get("lab")!.unavailableReason, "host 鍵が前と違うので繋ぎません");
    await projects.createProject("pve", "/home/banto/pve", { runtime: "remote:lab" });
    const view = runtimes.get("lab")!;
    assert.equal(view.unavailableReason, "Project「pve」が使っています（1つの実行場所に Project は1つ）");
    assert.deepEqual(view.usedBy.map((p) => p.name), ["pve"]);
    assert.equal(view.runtime, "remote:lab");
  });
});

test("使っている Project があれば外せない（閉じていても）。無ければ外せる", async () => {
  await withStores(async ({ store, projects, runtimes }) => {
    await store.register(INPUT, KEY, OK);
    const p = await projects.createProject("pve", "/home/banto/pve", { runtime: "remote:lab" });
    await projects.closeProject(p.id);
    await assert.rejects(runtimes.remove("lab"), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 409 && /pve/.test(err.message));
    await store.register({ ...INPUT, name: "spare" }, KEY, OK);
    await runtimes.remove("spare");
    assert.equal(store.get("spare"), undefined);
  });
});

test("閉じた Project は数えない：閉じたら別の Project を作れる。再開は、ほかの Project が使い始めていたら理由つきで断る", async () => {
  await withStores(async ({ store, projects, runtimes }) => {
    await store.register(INPUT, KEY, OK);
    const pve = await projects.createProject("pve", "/home/banto/pve", { runtime: "remote:lab" });
    await projects.closeProject(pve.id);
    assert.equal(runtimes.get("lab")!.unavailableReason, undefined, "閉じたのに空かない");
    assert.deepEqual(runtimes.get("lab")!.usedBy, []);
    // 空いていれば今どおり再開できる
    await runtimes.reopenProjectOn("lab", pve.id, () => projects.reopenProject(pve.id));
    assert.equal(projects.getProject(pve.id)!.status, "active");
    // 閉じている間に別の Project が使い始めた
    await projects.closeProject(pve.id);
    const other = await projects.createProject("other", "/home/banto/other", { runtime: "remote:lab" });
    await assert.rejects(
      runtimes.reopenProjectOn("lab", pve.id, () => projects.reopenProject(pve.id)),
      (err: unknown) =>
        err instanceof RemoteRuntimeError &&
        err.status === 409 &&
        err.extra?.code === "runtime-taken" &&
        /Project「other」が使い始めました/.test(err.message),
    );
    assert.equal(projects.getProject(pve.id)!.status, "closed", "断ったのに開いた");
    // 相手が閉じれば再開できる
    await projects.closeProject(other.id);
    await runtimes.reopenProjectOn("lab", pve.id, () => projects.reopenProject(pve.id));
    assert.equal(projects.getProject(pve.id)!.status, "active");
  });
});

test("鍵が違う実行場所には繋がない（フォルダを引く・確かめ直すの前に断る）。覚え直しは見た指紋が同じときだけ", async () => {
  await withStores(async ({ store, runtimes }) => {
    await store.register(INPUT, KEY, OK);
    await store.recordMismatch("lab", NEW_KEY);
    await assert.rejects(runtimes.listDirectories("lab", "~"), /host 鍵が前と違う/);
    await assert.rejects(runtimes.recheck("lab"), /host 鍵が前と違う/);
    await assert.rejects(runtimes.acceptHostKey("lab", KEY.fingerprint), /指紋が違います/);
  });
});

test("同じ実行場所に2つ目の Project は作れない（繋ぐ前に断る）", async () => {
  await withStores(async ({ store, projects, runtimes }) => {
    await store.register(INPUT, KEY, OK);
    await projects.createProject("pve", "/home/banto/pve", { runtime: "remote:lab" });
    await assert.rejects(
      runtimes.createProjectOn("lab", "/home/banto/other", async () => assert.fail("作ってはいけない")),
      (err: unknown) => err instanceof RemoteRuntimeError && err.status === 409 && /使っています/.test(err.message),
    );
  });
});

test("別のサーバの Project：根はこの機械で正規化しない・あとから根を変えられない・印を読む", async () => {
  await withStores(async ({ projects }) => {
    // この機械に無いパスでも、向こうで正規化した文字列をそのまま記録する
    const p = await projects.createProject("pve", "/nonexistent/on/this/host", { runtime: "remote:lab" });
    assert.equal(p.root, "/nonexistent/on/this/host");
    assert.equal(p.runtime, "remote:lab");
    assert.equal(runtimeKindOf(p.runtime, () => "machine"), "remote-machine");
    assert.equal(rootIsOnThisMachine(p.runtime), false);
    assert.equal(projects.getProject(p.id)!.root, "/nonexistent/on/this/host");
    await assert.rejects(projects.setProjectRoot(p.id, "/tmp"), RemoteProjectError);
    assert.equal(remoteNameOf(p.runtime), "lab");
    assert.equal(remoteNameOf("host-container"), undefined);
  });
});

test("動かし方を持つ前の登録の記録は machine として畳む", async () => {
  await withStores(async ({ dir, log }) => {
    const { mode: _mode, ...old } = INPUT;
    await log.append("runtime.remote_registered", { runtime: old, hostKey: KEY, checks: OK });
    const store = new RemoteRuntimeStore(dir, log);
    await store.load();
    assert.equal(store.get("lab")!.mode, "machine");
  });
});

test("動かし方を持つ前に書いた写し（スナップショット）から読んでも machine（2026-10-19、稼働中で踏んだ不具合）", async () => {
  await withStores(async ({ dir, log }) => {
    // 動かし方を持つ前の記録と、その頃の形の写し（版 1 のファイル名・mode の無い記録）を置く
    const { mode: _mode, ...old } = INPUT;
    await log.append("runtime.remote_registered", { runtime: old, hostKey: KEY, checks: OK });
    const first = new RemoteRuntimeStore(dir, log);
    await first.load();
    await first.save();
    const v2 = join(dir, "remote-runtimes.v2.snapshot.json");
    const strip = async (path: string) => {
      const snap = JSON.parse(await readFile(path, "utf8")) as { state: { runtimes: unknown } };
      const text = JSON.stringify(snap).replace(/"mode":"machine",?/g, "");
      assert.ok(!text.includes('"mode"'));
      await writeFile(path, text);
    };
    // 版 1 の写し（前の版が書いたもの）は読まず、ログから作り直す
    await writeFile(join(dir, "remote-runtimes.snapshot.json"), await readFile(v2, "utf8"));
    await strip(join(dir, "remote-runtimes.snapshot.json"));
    await rm(v2);
    const fromLog = new RemoteRuntimeStore(dir, log);
    await fromLog.load();
    assert.equal(fromLog.get("lab")!.mode, "machine");
    // 今の版の写しに mode が欠けていても、読むときに machine を入れる
    await fromLog.save();
    await strip(v2);
    const fromSnapshot = new RemoteRuntimeStore(dir, log);
    await fromSnapshot.load();
    assert.equal(fromSnapshot.get("lab")!.mode, "machine");
  });
});

test("containers は「1つの実行場所に Project は1つ」で選べなくしない（作る・再開する）", async () => {
  await withStores(async ({ store, projects, runtimes }) => {
    await store.register({ ...INPUT, mode: "containers" }, KEY, OK);
    const a = await projects.createProject("a", "/home/banto/a", { runtime: "remote:lab" });
    await projects.createProject("b", "/home/banto/b", { runtime: "remote:lab" });
    const view = runtimes.get("lab")!;
    assert.equal(view.unavailableReason, undefined);
    assert.deepEqual(view.usedBy.map((p) => p.name).sort(), ["a", "b"]);
    await projects.closeProject(a.id);
    await runtimes.reopenProjectOn("lab", a.id, () => projects.reopenProject(a.id));
    assert.equal(projects.getProject(a.id)!.status, "active");
  });
});

test("同じ host 鍵＋ユーザーに machine と containers を並べられない（繋ぐ前に名指しして断る）。ユーザーが違えば並べられる", async () => {
  await withStores(async ({ store, runtimes }) => {
    await store.register(INPUT, KEY, OK);
    const containers = { ...INPUT, name: "lab-c", host: "lab.example", mode: "containers" as const };
    for (const attempt of [() => runtimes.check(containers, KEY), () => runtimes.register(containers, KEY)]) {
      await assert.rejects(
        attempt(),
        (err: unknown) =>
          err instanceof RemoteRuntimeError && err.status === 409 && err.extra?.code === "mixed-modes" && /実行場所「lab」/.test(err.message),
      );
    }
    assert.equal(store.get("lab-c"), undefined);
    // 別のユーザー・別の鍵（別のサーバ）は断らない——ここから先は繋ぎに行く（この試験では Vault が無いので 502）
    for (const other of [{ ...containers, user: "banto2" }]) {
      await assert.rejects(runtimes.check(other, KEY), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 502);
    }
    await assert.rejects(runtimes.check(containers, NEW_KEY), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 502);
    // 同じ動かし方なら並べるのは断らない
    await assert.rejects(runtimes.check({ ...INPUT, name: "lab2" }, KEY), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 502);
  });
});

test("実行場所の種類：containers の登録の Project は remote-containers——眠らせる・閉じるときに Service を別に止めない（コンテナを止める）", () => {
  const modeOf = (name: string) => ({ lab: "machine" as const, box: "containers" as const })[name];
  assert.equal(runtimeKindOf(undefined, modeOf), "host-container");
  assert.equal(runtimeKindOf("host-container", modeOf), "host-container");
  assert.equal(runtimeKindOf("remote:lab", modeOf), "remote-machine");
  assert.equal(runtimeKindOf("remote:box", modeOf), "remote-containers");
  // 登録が無い名前は前の2択どおり machine として扱う
  assert.equal(runtimeKindOf("remote:gone", modeOf), "remote-machine");
  assert.equal(suspendsServicesToSleep("remote:lab", modeOf), true);
  assert.equal(suspendsServicesToSleep("remote:box", modeOf), false);
  assert.equal(suspendsServicesToClose("remote:lab", modeOf), true);
  assert.equal(suspendsServicesToClose("remote:box", modeOf), false);
  // 根は向こう・この機械のコンテナではない（machine と同じ）
  assert.equal(rootIsOnThisMachine("remote:box"), false);
  assert.equal(usesHostContainer("remote:box"), false);
});
