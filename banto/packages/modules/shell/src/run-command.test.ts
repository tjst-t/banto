import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.js";

function unusedRelayClient() {
  return {
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

test("envSecrets values reach the child process env, never the command string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-shell-test-"));
  try {
    const relayClient = {
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
