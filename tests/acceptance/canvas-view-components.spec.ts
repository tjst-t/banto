/**
 * キャンバスGUIの解決表が、登録されているGUIを全部持っていること（ADR-0010 決定12・17）。
 *
 * ホスト側は React に依存しないので、GUI は `component`（エクスポート名）を**文字列で**持ち、
 * 実体への解決は UI 側の表が行う。**この2つがずれても型では落ちない**——画面に
 * 「コンポーネントが解決表にありません」と出るまで気づけない。
 *
 * P4: 同じ抜けを繰り返さないよう、覚えておくのではなく機械で見る。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PlaceRegistry,
  createStaticPlaceProvider,
  createWorkspaceModule,
  PlaceGrantStore,
} from "@banto/host";
import { createRepoManagerModule } from "@banto/repo-manager";
import { EnvironmentPool, createEnvironmentPoolModule } from "@banto/environment-pool";

/** 解決表のソースを読む（.tsx を Node のテストから import せずに済ませる）。 */
function registrySource(): string {
  const file = new URL("../../packages/banto-web/src/views/registry.tsx", import.meta.url).pathname;
  return fs.readFileSync(file, "utf-8");
}

/** 各パッケージの src 配下の .ts を全部たどる（banto-web は解決表そのものなので除く）。 */
function hostSources(): string[] {
  const root = new URL("../../packages", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  for (const pkg of fs.readdirSync(root)) {
    if (pkg === "banto-web") continue;
    const src = path.join(root, pkg, "src");
    if (fs.existsSync(src)) walk(src);
  }
  return files;
}

describe("[task-0043] 登録されたGUIは全部 UI 側で解決できる", () => {
  it("各モジュールの component が解決表にある", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views-"));
    try {
      const places = new PlaceRegistry([createStaticPlaceProvider([{ id: "x", path: dir }])]);
      const grants = new PlaceGrantStore(path.join(dir, "grants.json"));
      const modules = [
        createWorkspaceModule(places, {}, grants),
        createRepoManagerModule(),
        createEnvironmentPoolModule(new EnvironmentPool({ dataDir: dir })),
      ];

      const source = registrySource();
      const missing: string[] = [];
      for (const module of modules) {
        for (const view of module.views) {
          // 表は `const REGISTRY = { FileBrowser, ... }` の形。名前が現れていれば解決できる
          if (!new RegExp(`\\b${view.component}\\b`).test(source)) {
            missing.push(`${module.name}: ${view.kind} → ${view.component}`);
          }
        }
      }
      assert.deepEqual(missing, [], `UI の解決表に無いコンポーネントがある:\n${missing.join("\n")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 上のテストは「このテストが組み立てたモジュール」しか見ない——**モジュールを増やした人が
   * ここに足し忘れると、抜けたまま通る**。ソース中の `component:` 宣言を機械で拾えば、
   * どのモジュールに足しても漏れない（P4：覚えておくのではなく機械で見る）。
   *
   * 抜けたときに起きること：カタログには出るのに、開くと「この面を描けません」になる。
   * 画面側は開ける一覧からそれを外すが（決定12・17）、**外して済ませる話ではない**——
   * 出所が分かるうちに直せるよう、ここで落とす。
   */
  it("ソースにある component 宣言が全部 UI 側で解決できる", () => {
    const source = registrySource();
    const missing: string[] = [];
    for (const file of hostSources()) {
      const text = fs.readFileSync(file, "utf-8");
      for (const match of text.matchAll(/component:\s*"([A-Za-z0-9_$]+)"/g)) {
        const component = match[1]!;
        if (!new RegExp(`\\b${component}\\b`).test(source)) {
          missing.push(`${path.relative(process.cwd(), file)}: ${component}`);
        }
      }
    }
    assert.deepEqual(missing, [], `UI の解決表に無いコンポーネントがある:\n${missing.join("\n")}`);
  });

  it("リポジトリと検証環境のGUIが登録されている（POが自分で開ける）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views2-"));
    try {
      const repo = createRepoManagerModule();
      const env = createEnvironmentPoolModule(new EnvironmentPool({ dataDir: dir }));
      assert.deepEqual(repo.views.map((v) => v.kind), ["repo.manager"]);
      assert.deepEqual(env.views.map((v) => v.kind), ["env.manager"]);
      // GUI は提供元モジュールの到達先からデータを取る（決定25）
      assert.match(repo.endpoint.baseUrl, /^\//);
      assert.match(env.endpoint.baseUrl, /^\//);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("場所を引数に取るGUIは place を受け取れる（POが画面で選べる前提）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "views3-"));
    try {
      const places = new PlaceRegistry([createStaticPlaceProvider([{ id: "x", path: dir }])]);
      const workspace = createWorkspaceModule(places);
      for (const kind of ["file.browser", "git.viewer"]) {
        const view = workspace.views.find((v) => v.kind === kind)!;
        const properties = (view.parameters as { properties?: Record<string, unknown> }).properties ?? {};
        assert.ok(
          Object.keys(properties).includes("place"),
          `${kind} が place を受け取れない（番頭が場所を指定して開けない）`
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
