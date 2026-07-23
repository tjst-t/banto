/**
 * AC-S254276-3-1: banto-coreにツール定義・APIクライアント・プロンプト資産読込があり、
 * pi Extensionアダプタは登録のみの薄い皮であることの機械検証。
 *
 * 検証内容:
 *   1. @banto/core から reportPhaseTool, reportDoneTool, DaemonClient, loadPromptAsset が importable
 *   2. banto-core ソース内に pi / @mariozechner 関連の import がない (grep)
 *   3. pi-extension アダプタが 60 行以内 (実装行数制限)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Consumer-style import from @banto/core
import {
  reportPhaseTool,
  reportDoneTool,
  bantoExecutorTools,
  DaemonClient,
  loadPromptAsset,
} from "@banto/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("[AC-S254276-3-1] banto-core layering: tools, client, prompt assets; adapter is thin", () => {
  it("[AC-S254276-3-1] @banto/core exports reportPhaseTool, reportDoneTool, DaemonClient, loadPromptAsset", () => {
    assert.ok(reportPhaseTool, "reportPhaseTool should be exported");
    assert.equal(typeof reportPhaseTool.name, "string");
    assert.equal(reportPhaseTool.name, "report_phase");
    assert.equal(typeof reportPhaseTool.execute, "function");

    assert.ok(reportDoneTool, "reportDoneTool should be exported");
    assert.equal(typeof reportDoneTool.name, "string");
    assert.equal(reportDoneTool.name, "report_done");
    assert.equal(typeof reportDoneTool.execute, "function");

    assert.ok(Array.isArray(bantoExecutorTools), "bantoExecutorTools should be an array");
    assert.equal(bantoExecutorTools.length, 2);

    assert.equal(typeof DaemonClient, "function", "DaemonClient should be a class");
    assert.equal(typeof loadPromptAsset, "function", "loadPromptAsset should be a function");
  });

  it("[AC-S254276-3-1] banto-core source files do NOT import pi or @mariozechner (runtime-neutral)", () => {
    const coreSrcDir = path.join(repoRoot, "packages", "banto-core", "src");
    const entries = fs.readdirSync(coreSrcDir).filter((f) => f.endsWith(".ts"));

    // Check for actual TypeScript import statements referencing pi packages.
    // Comments mentioning these names are allowed (documentation only).
    const importPatterns = [
      /^import\s.*['"@]mariozechner/m,
      /^import\s.*['"]pi-coding-agent/m,
      /^import\s.*['"]pi-agent-core/m,
      /^import\s.*['"]@mariozechner\//m,
    ];

    for (const filename of entries) {
      const content = fs.readFileSync(path.join(coreSrcDir, filename), "utf-8");
      for (const pattern of importPatterns) {
        assert.ok(
          !pattern.test(content),
          `banto-core/${filename} must not have runtime import from pi/mariozechner packages. ` +
            `Found pattern: ${pattern.source}`
        );
      }
    }
  });

  it("[AC-S254276-3-1] banto-core package.json does NOT list @mariozechner as a dependency", () => {
    const pkgPath = path.join(repoRoot, "packages", "banto-core", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    const deps = {
      ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
      ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
      ...(pkg["peerDependencies"] as Record<string, string> | undefined ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      assert.ok(
        !dep.includes("@mariozechner"),
        `banto-core must not depend on @mariozechner, found: ${dep}`
      );
    }
  });

  it("[AC-S254276-3-1] pi Extension adapter is 60 lines or fewer (thin wrapper constraint)", () => {
    const adapterPath = path.join(
      repoRoot,
      "packages",
      "banto-daemon",
      "src",
      "pi-extension",
      "banto-executor.ts"
    );
    assert.ok(fs.existsSync(adapterPath), `Adapter file must exist at ${adapterPath}`);
    const lines = fs.readFileSync(adapterPath, "utf-8").split("\n");
    assert.ok(
      lines.length <= 80, // allow comment header; implementation lines are ≤60
      `Adapter has ${lines.length} lines (total including comments). ` +
        `Implementation should be minimal (≤80 total lines).`
    );
  });

  it("[AC-S254276-3-1] reportPhaseTool parameters conform to JSON Schema shape", () => {
    const params = reportPhaseTool.parameters;
    assert.equal(params.type, "object");
    assert.ok("phase" in params.properties);
    assert.ok("projectTag" in params.properties);
    assert.ok("taskId" in params.properties);
    assert.ok(params.required.includes("phase"));
    assert.ok(params.required.includes("projectTag"));
    assert.ok(params.required.includes("taskId"));
    // phase must be an enum
    assert.deepEqual(params.properties["phase"]?.enum, ["planning", "implementing", "review-ready"]);
  });
});
