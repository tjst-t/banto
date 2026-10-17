// エージェントの本体を取ってくる（アーキ仕様 §4.1「試験」）：取る・確かめが合わない・中身が不正・進まない・二度目は取らない・
// 同時に1本・目録に無い版を消す。偽の登録簿（`fake-registry.ts`）から小さな tarball を出す

import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_BINARIES, agentBinaryDirName, catalogFromEnv, hostHasAvx2, selectAgentBinary, type AgentBinary } from "./agent-binaries.js";
import { integrityOfBytes, startFakeRegistry, tgzOf, type TarEntry } from "./fake-registry.js";
import { AgentBinaryError, AgentBinaryStore } from "./store.js";

const SCRIPT = "#!/bin/sh\necho fake-agent\n";
const GOOD: TarEntry[] = [
  { name: "package/package.json", body: '{"name":"fake"}' },
  { name: "package/bin", type: "dir" },
  { name: "package/bin/fake", body: SCRIPT, mode: 0o755 },
];

function entryFor(url: string, tgz: Buffer, over: Partial<AgentBinary> = {}): AgentBinary {
  return {
    agent: "fake",
    title: "Fake",
    version: "1.0.0",
    cpu: "x64",
    url,
    integrity: integrityOfBytes(tgz),
    path: "package/bin/fake",
    maxBytes: 1_000_000,
    approxBytes: 100,
    ...over,
  };
}

/** 版のフォルダは 0555 なので、書けるようにしてから消す */
function cleanup(dir: string): void {
  spawnSync("chmod", ["-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "banto-agent-binaries-"));
}

test("取ってきて置く：中身・0755・版のフォルダは 0555。二度目は取らない", async () => {
  const tgz = tgzOf(GOOD);
  const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz } });
  const dataDir = tempData();
  try {
    const entry = entryFor(reg.url("/fake.tgz"), tgz);
    const store = new AgentBinaryStore({ dataDir, catalog: [entry], hostAvx2: true, log: () => undefined });
    store.init();
    assert.equal(statSync(store.root).mode & 0o777, 0o755, "親は 0755");
    assert.equal(store.status("fake").present, false);
    const messages: string[] = [];
    const placed = await store.ensure("fake", { onProgress: (m) => messages.push(m) });
    assert.equal(placed.file, join(store.root, agentBinaryDirName(entry), "fake"));
    assert.equal(readFileSync(placed.file, "utf8"), SCRIPT);
    assert.equal(statSync(placed.file).mode & 0o777, 0o755);
    assert.equal(statSync(placed.dir).mode & 0o777, 0o555);
    // 置いたのは実行ファイル1本だけ（package.json は取り出さない）。作業フォルダは残さない
    assert.deepEqual(readdirSync(placed.dir), ["fake"]);
    assert.deepEqual(readdirSync(store.root), [agentBinaryDirName(entry)]);
    assert.ok(messages.some((m) => m.startsWith("Fake を取ってきています")), JSON.stringify(messages));
    assert.deepEqual(store.status("fake"), {
      agent: "fake",
      title: "Fake",
      version: "1.0.0",
      cpu: "x64",
      present: true,
      sizeBytes: SCRIPT.length,
      approxBytes: 100,
    });
    await store.ensure("fake");
    assert.equal(reg.hits("/fake.tgz"), 1, "二度目は取らない");
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

test("同時に頼まれても1本だけ取り、待っている呼び元にも進み具合が流れる", async () => {
  const tgz = tgzOf(GOOD);
  const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz, delayMs: 300 } });
  const dataDir = tempData();
  try {
    const store = new AgentBinaryStore({
      dataDir,
      catalog: [entryFor(reg.url("/fake.tgz"), tgz)],
      hostAvx2: true,
      log: () => undefined,
    });
    store.init();
    const a: string[] = [];
    const b: string[] = [];
    const [pa, pb] = await Promise.all([store.ensure("fake", { onProgress: (m) => a.push(m) }), store.ensure("fake", { onProgress: (m) => b.push(m) })]);
    assert.equal(pa.file, pb.file);
    assert.equal(reg.hits("/fake.tgz"), 1);
    assert.ok(a.length > 0 && b.length > 0, `どちらにも流れる：${JSON.stringify({ a, b })}`);
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

test("確かめ（sha512）が合わなければ置かずに断り、次にまた試す", async () => {
  const tgz = tgzOf(GOOD);
  const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz } });
  const dataDir = tempData();
  try {
    const store = new AgentBinaryStore({
      dataDir,
      catalog: [entryFor(reg.url("/fake.tgz"), tgz, { integrity: integrityOfBytes(Buffer.from("別のもの")) })],
      hostAvx2: true,
      log: () => undefined,
    });
    store.init();
    await assert.rejects(store.ensure("fake"), (err: unknown) => err instanceof AgentBinaryError && /確かめが合いませんでした/.test(err.message));
    assert.deepEqual(readdirSync(store.root), [], "何も残さない");
    await assert.rejects(store.ensure("fake"), AgentBinaryError);
    assert.equal(reg.hits("/fake.tgz"), 2, "次に使うときにまた試す");
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

for (const [label, entries, pattern] of [
  ["symlink（目録のパス）", [{ name: "package/bin/fake", type: "symlink", linkname: "/etc/passwd" }], /symlink/],
  ["symlink（ほかの名前）", [...GOOD, { name: "package/evil", type: "symlink", linkname: "/etc" }], /symlink/],
  ["hardlink", [{ name: "package/bin/fake", type: "hardlink", linkname: "/etc/passwd" }], /hardlink/],
  ["`..` を含む名前", [{ name: "package/../../evil", body: "x" }, ...GOOD], /外を指しうる名前/],
  ["`/` で始まる名前", [{ name: "/tmp/evil", body: "x" }, ...GOOD], /外を指しうる名前/],
  ["同じパスが2つ（余計なファイル）", [...GOOD, { name: "package/bin/fake", body: "second" }], /2つあります/],
  ["目録のパスが無い", [{ name: "package/package.json", body: "{}" }], /ありません/],
  ["フォルダが目録のパス", [{ name: "package/bin/fake", type: "dir" }], /ありません/],
] as Array<[string, TarEntry[], RegExp]>) {
  test(`中身が不正なら置かない：${label}`, async () => {
    const tgz = tgzOf(entries);
    const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz } });
    const dataDir = tempData();
    try {
      const store = new AgentBinaryStore({ dataDir, catalog: [entryFor(reg.url("/fake.tgz"), tgz)], hostAvx2: true, log: () => undefined });
      store.init();
      await assert.rejects(store.ensure("fake"), (err: unknown) => err instanceof AgentBinaryError && pattern.test(err.message));
      assert.deepEqual(readdirSync(store.root), [], "何も残さない");
      assert.equal(existsSync(join(dataDir, "evil")), false);
    } finally {
      await reg.close();
      cleanup(dataDir);
    }
  });
}

test("大きさの上限を越える実行ファイルは断る", async () => {
  const tgz = tgzOf([{ name: "package/bin/fake", body: Buffer.alloc(5000, 1) }]);
  const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz } });
  const dataDir = tempData();
  try {
    const store = new AgentBinaryStore({
      dataDir,
      catalog: [entryFor(reg.url("/fake.tgz"), tgz, { maxBytes: 4000 })],
      hostAvx2: true,
      log: () => undefined,
    });
    store.init();
    await assert.rejects(store.ensure("fake"), (err: unknown) => err instanceof AgentBinaryError && /上限/.test(err.message));
    assert.deepEqual(readdirSync(store.root), []);
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

test("進まなければやめる（止まっている間も知らせる）", async () => {
  const tgz = tgzOf([...GOOD, { name: "package/pad", body: Buffer.alloc(200_000, 7) }]);
  const reg = await startFakeRegistry({ "/fake.tgz": { body: tgz, stallAfter: 100 } });
  const dataDir = tempData();
  try {
    const store = new AgentBinaryStore({
      dataDir,
      catalog: [entryFor(reg.url("/fake.tgz"), tgz)],
      hostAvx2: true,
      timing: { tickMs: 20, movingMs: 50, stalledMs: 100, giveUpMs: 400 },
      log: () => undefined,
    });
    store.init();
    const messages: string[] = [];
    await assert.rejects(
      store.ensure("fake", { onProgress: (m) => messages.push(m) }),
      (err: unknown) => err instanceof AgentBinaryError && /1バイトも進みませんでした/.test(err.message),
    );
    assert.ok(messages.some((m) => /進んでいません（\d+秒）/.test(m)), JSON.stringify(messages));
    assert.deepEqual(readdirSync(store.root), []);
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

test("登録簿が断ったら理由を添えて断る", async () => {
  const reg = await startFakeRegistry({});
  const dataDir = tempData();
  try {
    const store = new AgentBinaryStore({ dataDir, catalog: [entryFor(reg.url("/none.tgz"), Buffer.from(""))], hostAvx2: true, log: () => undefined });
    store.init();
    await assert.rejects(store.ensure("fake"), /404/);
  } finally {
    await reg.close();
    cleanup(dataDir);
  }
});

test("目録に無いエージェントは断る。起きたときに目録に無い版と作業フォルダを消す", () => {
  const dataDir = tempData();
  try {
    const entry = entryFor("http://127.0.0.1:9/x.tgz", Buffer.from("x"));
    const root = join(dataDir, "agent-binaries");
    mkdirSync(join(root, "fake-0.9.0-x64-000000000000"), { recursive: true });
    writeFileSync(join(root, "fake-0.9.0-x64-000000000000", "fake"), "old");
    mkdirSync(join(root, ".incoming-abc"));
    mkdirSync(join(root, agentBinaryDirName(entry)));
    // 前の版は 0555 で置いてある
    chmodSync(join(root, "fake-0.9.0-x64-000000000000"), 0o555);
    const store = new AgentBinaryStore({ dataDir, catalog: [entry], hostAvx2: true, log: () => undefined });
    store.init();
    assert.deepEqual(readdirSync(root), [agentBinaryDirName(entry)]);
    assert.throws(() => store.entryFor("nope", true), /目録にありません/);
  } finally {
    cleanup(dataDir);
  }
});

test("目録：CPU で選ぶ・名前・差し替えは偽のエージェントのときだけ・AVX2 の読み方", () => {
  assert.equal(selectAgentBinary(AGENT_BINARIES, "opencode", true)?.url, "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.18.32.tgz");
  assert.equal(
    selectAgentBinary(AGENT_BINARIES, "opencode", false)?.url,
    "https://registry.npmjs.org/opencode-linux-x64-baseline/-/opencode-linux-x64-baseline-1.18.32.tgz",
  );
  const name = agentBinaryDirName(selectAgentBinary(AGENT_BINARIES, "opencode", true)!);
  assert.match(name, /^opencode-1\.18\.32-x64-[0-9a-f]{12}$/);
  const fake = JSON.stringify([entryFor("http://x/y.tgz", Buffer.from("y"))]);
  assert.equal(catalogFromEnv({ BANTO_AGENT_BINARY_CATALOG: fake }), AGENT_BINARIES, "偽のエージェントでなければ効かない");
  assert.equal(catalogFromEnv({ BANTO_AGENT_BINARY_CATALOG: fake, BANTO_SUBAGENT_FAKE_AGENT: "1" })[0]!.agent, "fake");
  assert.throws(() => catalogFromEnv({ BANTO_AGENT_BINARY_CATALOG: "{}", BANTO_SUBAGENT_FAKE_AGENT: "1" }), /配列/);
  assert.equal(hostHasAvx2(() => "flags : fpu sse avx avx2 bmi2"), true);
  assert.equal(hostHasAvx2(() => "flags : fpu sse avx"), false);
  assert.equal(
    hostHasAvx2(() => {
      throw new Error("no");
    }),
    false,
  );
});

