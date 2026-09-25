import { test } from "node:test";
import assert from "node:assert/strict";
import { checkContainerPrereqs, rootMayMap, versionHasNestingFix, type PrereqDeps } from "./prereqs.js";
import { IncusMissingError, type RunIncus } from "./incus.js";

const GROUP = "ubuntu:x:1000:\nincus:x:985:ubuntu\n";
const OK_SUBID = "ubuntu:100000:65536\nroot:1000000:1000000000\nroot:1000:1\n";

function deps(over: Partial<PrereqDeps> & { version?: string; incus?: RunIncus; files?: Record<string, string>; noPool?: boolean } = {}): PrereqDeps {
  const files = { "/etc/group": GROUP, "/etc/subuid": OK_SUBID, "/etc/subgid": OK_SUBID, ...over.files };
  const run: RunIncus =
    over.incus ??
    (async (args) => {
      if (args[1] === "/1.0/storage-pools/banto") return over.noPool ? { code: 1, stdout: "", stderr: "Error: Storage pool not found" } : { code: 0, stdout: "{}", stderr: "" };
      assert.deepEqual(args, ["query", "/1.0"]);
      return { code: 0, stdout: JSON.stringify({ environment: { server_version: over.version ?? "6.0.6" } }), stderr: "" };
    });
  return {
    runIncus: run,
    readText: async (p) => {
      const t = files[p as keyof typeof files];
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    uid: 1000,
    groups: [1000, 985],
    userName: "ubuntu",
    ...over,
  };
}

test("前提がそろっていれば ok、版も返す", async () => {
  const r = await checkContainerPrereqs(deps());
  assert.deepEqual(r, { ok: true, serverVersion: "6.0.6", problems: [] });
});

test("中の Docker の修正が入った版だけを通す（6.0.6 以降の LTS、6.19 以降）", () => {
  assert.equal(versionHasNestingFix("6.0.0"), false);
  assert.equal(versionHasNestingFix("6.0.5"), false);
  assert.equal(versionHasNestingFix("6.0.6"), true);
  assert.equal(versionHasNestingFix("6.0.10"), true);
  assert.equal(versionHasNestingFix("6.18"), false);
  assert.equal(versionHasNestingFix("6.19"), true);
  assert.equal(versionHasNestingFix("7.1"), true);
});

test("古い Incus は名指しして止める", async () => {
  const r = await checkContainerPrereqs(deps({ version: "6.0.0" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.map((p) => p.code), ["incus-too-old"]);
  assert.match(r.problems[0]!.message, /6\.0\.0/);
});

test("Incus が無いときは「無い」と言う（繋がらないと混ぜない）", async () => {
  const r = await checkContainerPrereqs(deps({ incus: async () => { throw new IncusMissingError("x"); } }));
  assert.deepEqual(r.problems.map((p) => p.code), ["incus-missing"]);
});

test("繋がらず、incus グループに入っていなければ、グループの直し方を言う", async () => {
  const failing: RunIncus = async () => ({ code: 1, stdout: "", stderr: "Error: permission denied" });
  const r = await checkContainerPrereqs(deps({ incus: failing, groups: [1000] }));
  assert.deepEqual(r.problems.map((p) => p.code), ["not-in-group"]);
  assert.match(r.problems[0]!.fix, /usermod -aG incus ubuntu/);
  assert.match(r.problems[0]!.fix, /起動し直/);
});

test("グループに入っているのに繋がらなければ、デーモンを疑う", async () => {
  const failing: RunIncus = async () => ({ code: 1, stdout: "", stderr: "Error: connection refused" });
  const r = await checkContainerPrereqs(deps({ incus: failing }));
  assert.deepEqual(r.problems.map((p) => p.code), ["daemon-unreachable"]);
  assert.match(r.problems[0]!.message, /connection refused/);
});

test("uid の対応の許可が無ければ、ファイルごとに言う", async () => {
  const r = await checkContainerPrereqs(deps({ files: { "/etc/subgid": "root:1000000:1000000000\n" } }));
  assert.deepEqual(r.problems.map((p) => p.code), ["idmap-not-allowed"]);
  assert.match(r.problems[0]!.message, /\/etc\/subgid/);
  assert.match(r.problems[0]!.fix, /root:1000:1/);
});

test("subuid の範囲の読み方：root の範囲が uid を含むときだけ", () => {
  assert.equal(rootMayMap("root:1000:1", 1000), true);
  assert.equal(rootMayMap("root:900:200", 1000), true);
  assert.equal(rootMayMap("root:1000000:1000000000", 1000), false);
  assert.equal(rootMayMap("ubuntu:1000:1", 1000), false);
  assert.equal(rootMayMap("", 1000), false);
});

test("banto の置き場（btrfs）が無ければ、作り方を言う", async () => {
  const r = await checkContainerPrereqs(deps({ noPool: true }));
  assert.deepEqual(r.problems.map((p) => p.code), ["pool-missing"]);
  assert.match(r.problems[0]!.fix, /incus storage create banto btrfs/);
});
