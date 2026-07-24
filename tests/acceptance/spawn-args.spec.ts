/**
 * [AC-S254276-5-1] pi spawn args: --extension, --provider, --model are passed.
 *
 * Verifies that PiRpcDriver.spawn() invokes node with the expected CLI flags:
 *   - --extension <absolutePath>   (banto-executor extension)
 *   - --provider <provider>        (configurable; default "opencode-go")
 *   - --model <model>              (configurable; default "deepseek-v4-flash")
 *
 * Does NOT require a real LLM or any network call. We pass a fake piCliPath pointing
 * to a tiny helper script. The script writes process.argv to a file (path in
 * CAPTURE_FILE env var) and exits quickly. The parent process polls for the file
 * and then asserts on the captured args.
 *
 * D6: uses only node:test, node:child_process, node:fs (no extra test libs).
 * P1: does not exercise LLM or network.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { PiRpcDriver } from "../../packages/banto-daemon/src/pi-rpc-driver.js";

// ── Helper: tiny ESM script that writes process.argv to CAPTURE_FILE ─────────
// argv[0]="node", argv[1]=this script, argv[2..]= args passed by PiRpcDriver

const CAPTURE_SCRIPT = `
import * as fs from "node:fs";
const dest = process.env["CAPTURE_FILE"];
if (dest) {
  fs.writeFileSync(dest, JSON.stringify(process.argv.slice(2)));
}
// Exit after 50ms (before driver's 200ms startup delay) to trigger early-exit path.
setTimeout(() => process.exit(0), 50);
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return fs.existsSync(filePath);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("[AC-S254276-5-1] PiRpcDriver spawn passes --extension, --provider, --model", () => {
  let tmpDir: string;
  let captureScriptPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-spawn-args-"));
    captureScriptPath = path.join(tmpDir, "capture.mjs");
    fs.writeFileSync(captureScriptPath, CAPTURE_SCRIPT, "utf8");
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S254276-5-1] spawn includes --provider, --model, --extension from driver config", async () => {
    const sessionDir = path.join(tmpDir, "sessions1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const captureFile = path.join(tmpDir, "args1.json");
    const worktreePath = path.join(tmpDir, "wt1");
    fs.mkdirSync(worktreePath, { recursive: true });

    const fakeExtensionPath = "/fake/banto-executor.ts";

    const driver = new PiRpcDriver({
      piCliPath: captureScriptPath,
      sessionBaseDir: sessionDir,
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
      extensionPath: fakeExtensionPath,
    });

    // Inject CAPTURE_FILE into the environment BEFORE spawn so the child inherits it.
    const prevCapture = process.env["CAPTURE_FILE"];
    process.env["CAPTURE_FILE"] = captureFile;

    // Spawn — will fail (early exit from helper script) but args are captured first.
    const spawnPromise = driver.spawn({
      taskId: "T-args-test-1",
      worktreePath,
      sessionPath: path.join(sessionDir, "T-args-test-1.jsonl"),
      systemPrompt: "",
      tools: [],
      driverOptions: {},
    }).catch(() => undefined);

    const appeared = await waitForFile(captureFile, 3000);

    // Restore env before assertions to avoid polluting other tests
    if (prevCapture === undefined) {
      delete process.env["CAPTURE_FILE"];
    } else {
      process.env["CAPTURE_FILE"] = prevCapture;
    }

    await spawnPromise;

    assert.ok(
      appeared,
      `capture file must appear at ${captureFile} — the helper script must have run`
    );

    const rawArgs: string[] = JSON.parse(fs.readFileSync(captureFile, "utf8")) as string[];
    const joined = rawArgs.join(" ");

    assert.ok(rawArgs.includes("--provider"), `args must include --provider; got: ${joined}`);
    assert.ok(rawArgs.includes("opencode-go"), `args must include "opencode-go"; got: ${joined}`);
    assert.ok(rawArgs.includes("--model"), `args must include --model; got: ${joined}`);
    assert.ok(rawArgs.includes("deepseek-v4-flash"), `args must include "deepseek-v4-flash"; got: ${joined}`);
    assert.ok(rawArgs.includes("--extension"), `args must include --extension; got: ${joined}`);
    assert.ok(rawArgs.includes(fakeExtensionPath), `args must include the extension path; got: ${joined}`);
  });

  it("[AC-S254276-5-1] driverOptions.provider/model override driver defaults", async () => {
    const sessionDir = path.join(tmpDir, "sessions2");
    fs.mkdirSync(sessionDir, { recursive: true });
    const captureFile = path.join(tmpDir, "args2.json");
    const worktreePath = path.join(tmpDir, "wt2");
    fs.mkdirSync(worktreePath, { recursive: true });

    const driver = new PiRpcDriver({
      piCliPath: captureScriptPath,
      sessionBaseDir: sessionDir,
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
    });

    const prevCapture = process.env["CAPTURE_FILE"];
    process.env["CAPTURE_FILE"] = captureFile;

    const spawnPromise = driver.spawn({
      taskId: "T-args-test-2",
      worktreePath,
      sessionPath: path.join(sessionDir, "T-args-test-2.jsonl"),
      systemPrompt: "",
      tools: [],
      driverOptions: {
        provider: "my-custom-provider",
        model: "my-custom-model",
      },
    }).catch(() => undefined);

    const appeared = await waitForFile(captureFile, 3000);

    if (prevCapture === undefined) {
      delete process.env["CAPTURE_FILE"];
    } else {
      process.env["CAPTURE_FILE"] = prevCapture;
    }

    await spawnPromise;

    assert.ok(appeared, `capture file must appear at ${captureFile}`);

    const rawArgs: string[] = JSON.parse(fs.readFileSync(captureFile, "utf8")) as string[];
    const joined = rawArgs.join(" ");

    assert.ok(
      rawArgs.includes("my-custom-provider"),
      `overridden provider must be in args; got: ${joined}`
    );
    assert.ok(
      rawArgs.includes("my-custom-model"),
      `overridden model must be in args; got: ${joined}`
    );
    // Default "opencode-go" must NOT appear when overridden
    assert.ok(
      !rawArgs.includes("opencode-go"),
      `default provider must NOT appear when overridden; got: ${joined}`
    );
  });
});
