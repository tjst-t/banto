/**
 * 設定画面とモジュールの設定（決定41・task-0047）。
 *
 * **モジュールは GUI ではなく項目の宣言を渡す。** 見たいのは3つ：
 * (a) 宣言した区画が設定画面に集まること（モジュールが増えても画面は変わらない）
 * (b) 画面で変えた値がモジュールに届き、**その場の挙動が変わる**こと
 * (c) 設定の口が番頭に渡っていないこと——設定を書き換えられると、場所の許可も上限も
 *     自分で広げられる（決定38b の自己昇格）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SettingsStore,
  createCoreSettingsSections,
  createModuleRegistry,
  createSettingsModule,
  settingsSection,
  type BantoModule,
} from "@banto/host";
import { EnvironmentPool, createEnvironmentPoolModule } from "@banto/environment-pool";
import type { ModuleSettingsSpec } from "@banto/core";

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
  store = new SettingsStore(path.join(dir, "settings.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 設定を宣言するだけの試験用モジュール。 */
function moduleWithSettings(name: string, spec: ModuleSettingsSpec): BantoModule {
  return {
    name,
    title: name,
    description: name,
    endpoint: { baseUrl: `/api/${name}` },
    tools: [],
    views: [],
    skills: [],
    settings: spec,
  };
}

function settingsToolsOf(modules: ReturnType<typeof createModuleRegistry>): {
  describe: BantoModule["internalTools"] extends undefined ? never : NonNullable<BantoModule["internalTools"]>[number];
  update: NonNullable<BantoModule["internalTools"]>[number];
  module: BantoModule;
} {
  const module = createSettingsModule({
    core: createCoreSettingsSections(store),
    modules,
    store,
  });
  const internal = module.internalTools ?? [];
  return {
    describe: internal.find((t) => t.name === "settings.describe")!,
    update: internal.find((t) => t.name === "settings.update")!,
    module,
  };
}

describe("[決定41/a] モジュールが宣言した区画が設定画面に集まる", () => {
  it("中核の区画と、モジュールが宣言した区画が並ぶ", async () => {
    const modules = createModuleRegistry([
      moduleWithSettings("よそのモジュール", {
        title: "よそ",
        fields: [{ key: "x", label: "X", type: "text" }],
        read: () => ({ x: "いまの値" }),
        write: () => ({ applied: true }),
      }),
    ]);
    const { describe: tool } = settingsToolsOf(modules);
    const details = (await tool.execute({})).details as {
      sections: Array<{ id: string; origin: string; values: Record<string, unknown> }>;
    };

    const ids = details.sections.map((s) => s.id);
    assert.deepEqual(ids, ["llm", "places", "network", "よそのモジュール"]);
    // 由来が分かること（画面が「どのモジュールの設定か」を出せる）
    assert.equal(details.sections.find((s) => s.id === "よそのモジュール")!.origin, "よそのモジュール");
    // いまの値も一緒に来る（画面は宣言と値の両方が要る）
    assert.deepEqual(details.sections.find((s) => s.id === "よそのモジュール")!.values, {
      x: "いまの値",
    });
  });

  it("宣言していないモジュールは区画を持たない（空の区画を並べない）", async () => {
    const modules = createModuleRegistry([
      {
        name: "設定のないモジュール",
        title: "x",
        description: "x",
        endpoint: { baseUrl: "/api/x" },
        tools: [],
        views: [],
        skills: [],
      },
    ]);
    const { describe: tool } = settingsToolsOf(modules);
    const details = (await tool.execute({})).details as { sections: Array<{ id: string }> };
    assert.ok(!details.sections.some((s) => s.id === "設定のないモジュール"));
  });

  it("1区画が読めなくても他は出る（I2: ただしログには出す）", async () => {
    const modules = createModuleRegistry([
      moduleWithSettings("壊れている", {
        title: "壊れている",
        fields: [],
        read: () => {
          throw new Error("読めない");
        },
        write: () => ({ applied: true }),
      }),
    ]);
    const { describe: tool } = settingsToolsOf(modules);
    const details = (await tool.execute({})).details as { sections: Array<{ id: string }> };
    assert.equal(details.sections.length, 4, "他の区画は出ること");
  });
});

describe("[決定41/b] 画面で変えた値がモジュールへ届く", () => {
  it("**モジュールの実際の挙動が変わる**（値を持つのはモジュール）", async () => {
    const pool = new EnvironmentPool({ dataDir: path.join(dir, "env") });
    const modules = createModuleRegistry([
      createEnvironmentPoolModule(pool, "/api/env", undefined, settingsSection(store, "env")),
    ]);
    const { update } = settingsToolsOf(modules);

    assert.equal(pool.currentLimits().adhocDrivers, "builtin");
    await update.execute({
      section: "environment-pool",
      values: { adhocDrivers: "none", defaultTtlMinutes: 45 },
    });

    // 画面→モジュールへ届き、その場で効いていること
    assert.equal(pool.currentLimits().adhocDrivers, "none");
    assert.equal(pool.currentLimits().defaultTtlMs, 45 * 60_000);
    await assert.rejects(
      () => pool.provision({ driver: "process", config: { cmd: "sleep 1" } }),
      /許可されていません/
    );

    // 次の起動でも同じ値になるよう保存されていること
    assert.equal(
      (store.all().modules?.["env"] as { adhocDrivers?: string } | undefined)?.adhocDrivers,
      "none"
    );
  });

  it("受け付けられない値は黙って丸めず断る", async () => {
    const pool = new EnvironmentPool({ dataDir: path.join(dir, "env2") });
    const modules = createModuleRegistry([createEnvironmentPoolModule(pool, "/api/env")]);
    const { update } = settingsToolsOf(modules);
    await assert.rejects(
      () => update.execute({ section: "environment-pool", values: { defaultTtlMinutes: "とても長く" } }),
      /正の数/
    );
  });

  it("知らない区画への変更は黙って捨てない", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));
    await assert.rejects(() => update.execute({ section: "無い区画", values: {} }), /はありません/);
  });

  it("場所はその場で効き、LLM は次の起動から（正直に返す）", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));

    const places = (await update.execute({
      section: "places",
      values: { places: ["banto:/tmp/x:docs/**"] },
    })).details as { applied: boolean };
    assert.equal(places.applied, true);
    assert.deepEqual(store.all().places, [{ id: "banto", path: "/tmp/x", writable: ["docs/**"] }]);

    const llm = (await update.execute({ section: "llm", values: { model: "新しいモデル" } }))
      .details as { applied: boolean };
    assert.equal(llm.applied, false, "効いていないのに効いたと言わないこと");
  });

  it("場所の行が壊れていたら断る（場所が黙って消えない）", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));
    await assert.rejects(
      () => update.execute({ section: "places", values: { places: ["これは壊れている"] } }),
      /場所の指定が不正/
    );
  });

  it("Caddy の設定は対でないと保存させない（起動して初めて止まる、を避ける）", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));
    await assert.rejects(
      () => update.execute({ section: "network", values: { caddyAdmin: "http://localhost:2019" } }),
      /対で設定/
    );
  });
});

describe("[決定41/c] 番頭は設定を変えられない（決定38b の自己昇格を塞ぐ）", () => {
  it("設定の口は1本も番頭へ渡らない", () => {
    const { module } = settingsToolsOf(createModuleRegistry([]));
    assert.deepEqual(module.tools, [], "番頭へ渡す Tool は無いこと");
    assert.deepEqual(
      (module.internalTools ?? []).map((t) => t.name).sort(),
      ["settings.describe", "settings.update"],
      "GUI からは呼べること"
    );
  });

  it("保存先はホストのデータ置き場（番頭が書けない場所）", () => {
    assert.ok(store.location().startsWith(dir));
    assert.match(store.location(), /settings\.json$/);
  });

  it("壊れた設定で黙って既定に落ちない", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{ これはJSONではない");
    assert.throws(() => new SettingsStore(path.join(dir, "settings.json")), /設定が壊れています/);
  });
});
