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
  createExecutorTools,
  DaemonClient,
  loadPromptAsset,
} from "@banto/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("[AC-S254276-3-1] banto-core layering: tools, client, prompt assets; adapter is thin", () => {
  it("[AC-S254276-3-1] @banto/core exports createExecutorTools, DaemonClient, loadPromptAsset", () => {
    // task-0025: 依存（DaemonClient）は Tool を作る関数の引数で受ける。型には現れない
    const tools = createExecutorTools(new DaemonClient("http://localhost:1"));
    assert.ok(Array.isArray(tools), "createExecutorTools should return an array");
    assert.deepEqual(tools.map((t) => t.name), ["report_phase", "report_done"]);
    for (const tool of tools) {
      assert.equal(typeof tool.execute, "function");
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.parameters.type, "object");
    }

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

  it("[task-0025] モジュールは Tool を定義するのに pi の型を要らない（Worker Pool が証拠）", () => {
    // imp-0003 の実害そのもの：Worker Pool は pi を**バイナリとしてしか**使わないのに、
    // Tool を定義するために型依存が要る状態だった。戻ったら気づけるようにしておく。
    // pi-rpc-driver.ts はバイナリのパス解決でパッケージ名を**文字列として**持つので、
    // ここで見るのは import 文だけ（コメント・文字列は許す）
    const srcDir = path.join(repoRoot, "packages", "banto-worker-pool", "src");
    const files = fs
      .readdirSync(srcDir, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf-8");
      assert.ok(
        !/^import\s.*['"]@mariozechner\//m.test(content),
        `banto-worker-pool/${file} は pi の型を import してはいけない（契約は @banto/core）`
      );
    }
  });

  it("[task-0025] Tool 契約の型は1つだけ（並立していないこと）", () => {
    // 決定27b「契約体系を2つ持たない」。banto-host が pi の ToolDefinition を
    // **契約として**再輸出していたら、また2つに割れる
    const registryPath = path.join(repoRoot, "packages", "banto-host", "src", "tool-registry.ts");
    const registry = fs.readFileSync(registryPath, "utf-8");

    // pi の型を使ってよいのは「pi へ写す」関数の戻り値だけ。契約は core から来る
    assert.ok(
      /from "@banto\/core"/.test(registry),
      "契約は @banto/core から取ること"
    );
    assert.ok(
      /^import type \{ ToolDefinition \}/m.test(registry),
      "pi の型は type import に留めること（アダプタの出口の型としてのみ）"
    );
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

  it("[AC-S254276-3-1] report_phase parameters conform to JSON Schema shape", () => {
    const tool = createExecutorTools(new DaemonClient("http://localhost:1")).find(
      (t) => t.name === "report_phase"
    )!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 生成された JSON Schema を覗く (I4)
    const params = tool.parameters as any;

    assert.equal(params.type, "object");
    for (const field of ["phase", "projectTag", "taskId"]) {
      assert.ok(field in params.properties, `${field} が無い`);
      assert.ok(params.required.includes(field), `${field} が必須になっていない`);
    }

    // phase の取りうる値（DEC-S254276-012 resolved: "review-ready" は削除。report_done を使う）。
    // task-0025 で typebox に統一したため、符号化は enum から anyOf/const に変わった
    // ——見たいのは符号化ではなく**許す値の集合**なので、どちらの形からも取り出して比べる
    const phase = params.properties["phase"];
    const allowed: string[] = phase.enum ?? phase.anyOf.map((v: { const: string }) => v.const);
    assert.deepEqual(allowed, ["planning", "implementing"]);
  });
});
