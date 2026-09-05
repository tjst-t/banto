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
