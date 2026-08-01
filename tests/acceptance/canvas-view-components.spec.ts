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
  createDemoModule,
  PlaceGrantStore,
} from "@banto/host";
import { createRepoManagerModule } from "@banto/repo-manager";
import { EnvironmentPool, createEnvironmentPoolModule } from "@banto/environment-pool";

/** 解決表のソースを読む（.tsx を Node のテストから import せずに済ませる）。 */
function registrySource(): string {
  const file = new URL("../../packages/banto-web/src/views/registry.tsx", import.meta.url).pathname;
  return fs.readFileSync(file, "utf-8");
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
        createDemoModule(),
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
