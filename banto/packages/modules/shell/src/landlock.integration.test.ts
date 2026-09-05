// Shell Moduleプロセス全体をbanto-landlock-exec経由で起動し（hostが実際に行う
// spawnと同じ形）、その中で呼ばれるrunCommandがProject根の外に出られないことを
// 実機で検証する。banto-landlock-exec(Rust) → node server.js → /bin/sh -c "..."
// という2段のプロセス階層をLandlockの制限がまたいで生き続けるかの確認。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveProjectRuleset,
  writeRulesetFile,
  wrapCommand,
  assertLauncherAvailable,
} from "@banto/landlock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "dist", "server.js");

test("runCommand cannot escape the Project root when the whole Shell process runs under Landlock", async () => {
  assertLauncherAvailable();

  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "banto-shell-landlock-project-")));
  const outsideDir = await mkdtemp(join(tmpdir(), "banto-shell-landlock-outside-"));
  const runDir = await mkdtemp(join(tmpdir(), "banto-shell-landlock-run-"));
  try {
    await writeFile(join(projectRoot, "inside.txt"), "inside-content");
    await writeFile(join(outsideDir, "secret.txt"), "OUTSIDE-SECRET");

    // devのnpm workspacesはnode_modulesがルートにhoistされ、ワークスペース間
    // 参照はsymlink（realpath解決するとpackages/*を指す）になるため、
    // モノレポルート全体を読み取り許可にする。実際にパッケージ化された
    // 配布（本番）では、Moduleパッケージ自身のディレクトリ1つで足りる
    // ——これは開発時のモノレポ特有の簡略化として記録しておく。
    const monorepoRoot = join(__dirname, "..", "..", "..", "..");
    const { ruleset } = deriveProjectRuleset({
      projectRoot,
      pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
      profile: "exec",
      nodeExecPath: process.execPath,
      moduleInstallDirs: [monorepoRoot],
    });
    const rulesetFile = writeRulesetFile(runDir, "shell-landlock-test", ruleset);
    const wrapped = wrapCommand(rulesetFile, { command: process.execPath, args: [serverEntry] });

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: {
        ...process.env,
        BANTO_PROJECT_ROOT: projectRoot,
        BANTO_HOST_MCP_URL: "http://127.0.0.1:0/relay",
        BANTO_HOST_MCP_TOKEN: "unused-in-this-test",
      },
    });
    const client = new Client({ name: "test-host", version: "0.0.0" });
    await client.connect(transport);

    const insideResult = await client.callTool({
      name: "runCommand",
      arguments: { command: "cat inside.txt" },
    });
    const insideParsed = JSON.parse((insideResult.content as { text: string }[])[0]!.text);
    assert.equal(insideParsed.stdout.trim(), "inside-content");

    const outsideResult = await client.callTool({
      name: "runCommand",
      arguments: { command: `cat ${outsideDir}/secret.txt` },
    });
    const outsideParsed = JSON.parse((outsideResult.content as { text: string }[])[0]!.text);
    assert.ok(
      !outsideParsed.stdout.includes("OUTSIDE-SECRET"),
      `Landlock did not confine the process — read outside root succeeded: ${JSON.stringify(outsideParsed)}`,
    );
    assert.notEqual(outsideParsed.exitCode, 0);

    await client.close();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
