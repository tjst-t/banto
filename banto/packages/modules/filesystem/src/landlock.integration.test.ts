// FileSystem Moduleプロセス全体をbanto-landlock-exec経由で起動し、
// readFile/writeFileがProject根の外に出られないことを実機で検証する
// （files-onlyプロファイル：Shellと違い実行権もdev書込も持たない、より狭い）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectRuleset, writeRulesetFile, wrapCommand, assertLauncherAvailable } from "@banto/landlock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "dist", "server.js");
const monorepoRoot = join(__dirname, "..", "..", "..", "..");

test("FileSystem cannot read or write outside the Project root under Landlock (files-only profile)", async () => {
  assertLauncherAvailable();

  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "banto-fs-landlock-project-")));
  const outsideDir = await mkdtemp(join(tmpdir(), "banto-fs-landlock-outside-"));
  const runDir = await mkdtemp(join(tmpdir(), "banto-fs-landlock-run-"));
  try {
    await writeFile(join(outsideDir, "secret.txt"), "OUTSIDE-SECRET");

    const { ruleset } = deriveProjectRuleset({
      projectRoot,
      pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
      profile: "files-only",
      nodeExecPath: process.execPath,
      moduleInstallDirs: [monorepoRoot],
    });
    const rulesetFile = writeRulesetFile(runDir, "fs-landlock-test", ruleset);
    const wrapped = wrapCommand(rulesetFile, { command: process.execPath, args: [serverEntry] });

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: { ...process.env, BANTO_PROJECT_ROOT: projectRoot },
    });
    const client = new Client({ name: "test-host", version: "0.0.0" });
    await client.connect(transport);

    await client.callTool({ name: "writeFile", arguments: { path: "inside.txt", content: "ok" } });
    const insideRead = await client.callTool({ name: "readFile", arguments: { path: "inside.txt" } });
    assert.equal((insideRead.content as { text: string }[])[0]?.text, "ok");

    await assert.rejects(() =>
      client.callTool({ name: "readFile", arguments: { path: `${outsideDir}/secret.txt` } }),
    );

    await client.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
