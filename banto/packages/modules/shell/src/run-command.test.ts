import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.js";

function unusedRelayClient() {
  return {
    lookupAlias: async () => ({ implementation: "vault" }),
    resolveAlias: async () => {
      throw new Error("relay should not be called for this test");
    },
    startSshAgent: async () => {
      throw new Error("relay should not be called for this test");
    },
    close: async () => undefined,
  } as unknown as import("./host-relay-client.js").HostRelayClient;
}

test("runs a command and captures stdout/stderr/exitCode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: "echo hello && echo world 1>&2 && exit 3" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "hello");
    assert.equal(result.stderr.trim(), "world");
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs relative to the project root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    await writeFile(join(dir, "marker.txt"), "here");
    const result = await runCommand(
      { command: "cat marker.txt" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "here");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("times out long-running commands and reports timedOut", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: "sleep 5", timeout: 0.5 },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.timedOut, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secretFiles are written before exec and always deleted after, even on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async () => ({ implementation: "vault" }),
      resolveAlias: async () => "TOP-SECRET-VALUE",
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    const result = await runCommand(
      { command: "cat .npmrc; exit 1", secretFiles: { ".npmrc": "npm-registry-token" } },
      { projectRoot: dir, relayClient },
    );
    assert.equal(result.stdout.trim(), "TOP-SECRET-VALUE");
    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(join(dir, ".npmrc")), false, "secretFile was not cleaned up after failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 中継トークンは「どのModuleからの呼び出しか」の識別そのもの。AIの書いた
// コマンドに継承されると、AIがShellの身元でresolveAliasを呼べてしまう
// （決定・2026-09-10、docs/specs/v4-security.md「中継が縛らないもの」）。
test("no BANTO_* variable is visible to the child process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const before = { ...process.env };
  process.env.BANTO_HOST_MCP_TOKEN = "RELAY-TOKEN-MUST-NOT-LEAK";
  process.env.BANTO_HOST_MCP_URL = "http://127.0.0.1:1/relay";
  process.env.BANTO_PROJECT_ROOT = dir;
  process.env.BANTO_MODULE_DATA_DIR = dir;
  try {
    const result = await runCommand(
      { command: "env | grep '^BANTO_'; echo exit=$?" },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "exit=1", `BANTO_* leaked to the child: ${result.stdout}`);
    assert.ok(!result.stdout.includes("RELAY-TOKEN-MUST-NOT-LEAK"));

    // 親（Moduleプロセス）自身のenvは壊さない——hostから受け取った値で
    // 中継クライアントが動いているため。
    assert.equal(process.env.BANTO_HOST_MCP_TOKEN, "RELAY-TOKEN-MUST-NOT-LEAK");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in before)) delete process.env[name];
    }
    Object.assign(process.env, before);
    await rm(dir, { recursive: true, force: true });
  }
});

test("BANTO_* が envSecrets で復活させられない（黙って無視せず止める）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async () => ({ implementation: "vault" }),
      resolveAlias: async () => "whatever",
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    await assert.rejects(
      runCommand(
        { command: "true", envSecrets: { BANTO_HOST_MCP_TOKEN: "some-alias" } },
        { projectRoot: dir, relayClient },
      ),
      /BANTO_/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PATH などの通常の環境変数は子に届く", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const result = await runCommand(
      { command: 'echo "path=${PATH:+set}"' },
      { projectRoot: dir, relayClient: unusedRelayClient() },
    );
    assert.equal(result.stdout.trim(), "path=set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **MCP の呼び出しは既定60秒で切れる**（既知の罠）。`npm install` のような
// 長いコマンドを通すため、実行中は進捗を送り続けて呼び出し元のタイムアウトを
// 更新させる（docs/specs/v4-modules.md §2.3）。
test("長いコマンドの実行中は、進捗を送り続ける（呼び出し元のタイムアウトを更新させる）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const notes: string[] = [];
  try {
    const result = await runCommand(
      { command: "sleep 0.4" },
      {
        projectRoot: dir,
        relayClient: unusedRelayClient(),
        onProgress: (note) => notes.push(note),
        progressIntervalMs: 50,
      },
    );
    assert.equal(result.exitCode, 0);
    const heartbeats = notes.filter((n) => n.startsWith("実行中"));
    assert.ok(heartbeats.length >= 3, `進捗が足りない: ${JSON.stringify(notes)}`);
    assert.match(heartbeats[0]!, /秒経過/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("コマンドが終わったら進捗も止まる（タイマーを残さない）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  const notes: string[] = [];
  try {
    await runCommand(
      { command: "true" },
      {
        projectRoot: dir,
        relayClient: unusedRelayClient(),
        onProgress: (note) => notes.push(note),
        progressIntervalMs: 20,
      },
    );
    const afterExit = notes.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(notes.length, afterExit, "終わった後も進捗が送られている");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("envSecrets values reach the child process env, never the command string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
      lookupAlias: async () => ({ implementation: "vault" }),
      resolveAlias: async (_target: string, alias: string) => `resolved-${alias}`,
      startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
      close: async () => undefined,
    } as unknown as import("./host-relay-client.js").HostRelayClient;

    const result = await runCommand(
      { command: 'echo "token=$NPM_TOKEN"', envSecrets: { NPM_TOKEN: "npm-registry-token" } },
      { projectRoot: dir, relayClient },
    );
    assert.equal(result.stdout.trim(), "token=resolved-npm-registry-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **引数の説明は、AI がこの Module を使えるかどうかそのもの**
// （追加・2026-09-12、ユーザー指摘「AI が Vault の使い方を分かっていない」）。
// 以前は `envSecrets: { type: "object" }` としか書いておらず、
// 「何を鍵にして何を値にするのか」も「値を書いてはいけない」ことも伝わらなかった。
test("runCommand の説明が、秘密の渡し方を AI に伝えている", async () => {
  const { createShellServer } = await import("./server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  // 中継は使わない試験（tool の説明だけを見る）——繋がる先は要らない
  const relayClient = {
    lookupAlias: async () => ({ implementation: "vault" }),
    resolveAlias: async () => "",
    startSshAgent: async () => ({ socketPath: "" }),
  };
  const server = createShellServer({
    projectRoot: process.cwd(),
    relayClient: relayClient as never,
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    const { tools } = await client.listTools();
    const run = tools.find((t) => t.name === "runCommand")!;
    assert.match(run.description ?? "", /alias/, "秘密を alias 名で渡すことが書かれていない");
    assert.match(run.description ?? "", /vault:\/\/aliases/, "一覧の在りかが書かれていない");

    const props = (run.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    assert.match(props.envSecrets?.description ?? "", /alias 名/, "envSecrets の説明が無い");
    assert.match(props.secretFiles?.description ?? "", /alias 名/, "secretFiles の説明が無い");
    assert.match(props.sshIdentity?.description ?? "", /ssh-identity/, "sshIdentity の説明が無い");
    assert.match(props.timeout?.description ?? "", /120/, "既定のタイムアウトが書かれていない");
  } finally {
    await client.close();
  }
});

// **決め打ちをやめた**（追加・2026-09-12）。以前は `"vault"` を直に呼んでいたので、
// 2本目の backend に預けた秘密には構造的に届かなかった。ここで見るのは2つ：
//   1. **在りかを窓口に聞いてから**、その金庫を呼ぶ（`vault` 以外にも届く）
//   2. **値は窓口を通らない**——窓口に渡すのは名前だけ
test("秘密の在りかは窓口に聞く——決め打ちした金庫を呼ばない", async () => {
  const calls: Array<[string, string]> = [];
  const relayClient = {
    lookupAlias: async (target: string, name: string) => {
      calls.push([`lookup:${target}`, name]);
      return { implementation: "vault-infisical" }; // 既定ではない金庫
    },
    resolveAlias: async (target: string, name: string) => {
      calls.push([`resolve:${target}`, name]);
      return "VALUE-FROM-SECOND-VAULT";
    },
    startSshAgent: async () => ({ socketPath: "/tmp/unused.sock" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-"));
  const result = await runCommand(
    { command: "printf %s \"$TOKEN\"", envSecrets: { TOKEN: "far-away" } },
    { projectRoot: dir, relayClient },
  );

  assert.equal(result.stdout, "VALUE-FROM-SECOND-VAULT");
  assert.deepEqual(calls, [
    ["lookup:vault-directory", "far-away"],
    ["resolve:vault-infisical", "far-away"], // **窓口ではなく、引いた金庫を直接**
  ]);
});

test("在りかが分からない alias は、既定の金庫へ落とさず止まる", async () => {
  const relayClient = {
    lookupAlias: async () => {
      throw new Error('alias "unknown" はどの Vault にもありません');
    },
    resolveAlias: async () => assert.fail("在りかが分からないのに金庫を呼んだ"),
    startSshAgent: async () => ({ socketPath: "" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-miss-"));
  await assert.rejects(
    () => runCommand({ command: "true", envSecrets: { TOKEN: "unknown" } }, { projectRoot: dir, relayClient }),
    /どの Vault にもありません/,
  );
});

test("同じ alias を2箇所で使っても、在りかは1度しか引かない", async () => {
  let lookups = 0;
  const relayClient = {
    lookupAlias: async () => {
      lookups += 1;
      return { implementation: "vault" };
    },
    resolveAlias: async () => "same",
    startSshAgent: async () => ({ socketPath: "" }),
  } as unknown as import("./host-relay-client.js").HostRelayClient;

  const dir = await mkdtemp(join(tmpdir(), "shell-lookup-once-"));
  await runCommand(
    { command: "true", envSecrets: { A: "dup" }, secretFiles: { "f.txt": "dup" } },
    { projectRoot: dir, relayClient },
  );
  assert.equal(lookups, 1);
});
