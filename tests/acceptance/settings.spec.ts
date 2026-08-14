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
  DESK_PLACE_ID,
  SettingsStore,
  createCoreSettingsSections,
  createModuleRegistry,
  createSettingsModule,
  settingsSection,
  withDefaultDesk,
  type BantoModule,
  type PlaceSetting,
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
function moduleWithSettings(
  name: string,
  spec: ModuleSettingsSpec,
  title = name
): BantoModule {
  return {
    name,
    title,
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
    assert.deepEqual(ids, ["places", "network", "roles", "chapterModel", "よそのモジュール"]);
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
    // 中核は places / network / roles（ADR-0021 決定102：役の面1枚）/ chapterModel（task-0151）
    // ＋ 読める側のモジュール1つ
    assert.equal(details.sections.length, 5, "他の区画は出ること");
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

  it("場所はその場で効く（LLM は LLM Registry モジュールが管理）", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));

    const places = (await update.execute({
      section: "places",
      values: { places: ["banto:/tmp/x:docs/**"] },
    })).details as { applied: boolean };
    assert.equal(places.applied, true);
    assert.deepEqual(store.all().places, [{ id: "banto", path: "/tmp/x", writable: ["docs/**"] }]);
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

describe("[決定41] 画面が実態を映す", () => {
  /**
   * 呼び手（`bin.ts`）と同じ形の「いま効いている場所」。設定があればそれ、無ければ
   * 起動時の指定。どちらにも既定の書斎が足される。
   *
   * **画面は自分で判断せず、これをそのまま映す**——判断を両側に置くと、片方を直した
   * ときにもう片方が古いまま残る。
   */
  const effectivePlaces = (): PlaceSetting[] => {
    const saved = store.all().places;
    const source =
      saved && saved.length > 0 ? saved : [{ id: "起動時の指定", path: "/tmp/x", writable: ["docs/**"] }];
    return withDefaultDesk(source).map((c) => ({
      id: c.id,
      path: c.path,
      ...(c.writable ? { writable: [...c.writable] } : {}),
    }));
  };

  it("保存が無いときは、いま効いている場所を出す（空に見せない）", async () => {
    const core = createCoreSettingsSections(store, { effectivePlaces });
    const places = core.find((c) => c.id === "places")!;
    const deskLine = `${DESK_PLACE_ID}:${path.join(os.homedir(), "banto-desk")}`;

    // まだ保存していない＝起動時の指定が効いている状態
    assert.deepEqual(await places.spec.read(), {
      places: ["起動時の指定:/tmp/x:docs/**", deskLine],
    });

    // 保存すると、そちらが真実になる
    await places.spec.write({ places: ["保存した場所:/tmp/y"] });
    assert.deepEqual(await places.spec.read(), { places: ["保存した場所:/tmp/y", deskLine] });
  });

  it("[desk] 既定の書斎は、保存した後も画面から消えない", async () => {
    const core = createCoreSettingsSections(store, { effectivePlaces });
    const places = core.find((c) => c.id === "places")!;

    // 書斎の行を消して保存しても、効いている実態には残る（画面と食い違わせない）
    await places.spec.write({ places: ["保存した場所:/tmp/y"] });
    const lines = (await places.spec.read())["places"] as string[];
    assert.ok(
      lines.some((l) => l.startsWith(`${DESK_PLACE_ID}:`)),
      "消しても既定に戻ることが画面に出ること"
    );
  });

  it("[desk] 書斎の行を書けば上書きできる", async () => {
    const core = createCoreSettingsSections(store, { effectivePlaces });
    const places = core.find((c) => c.id === "places")!;

    await places.spec.write({ places: [`${DESK_PLACE_ID}:/tmp/my-desk:reports/**`] });
    assert.deepEqual(await places.spec.read(), {
      places: [`${DESK_PLACE_ID}:/tmp/my-desk:reports/**`],
    });
  });
});

describe("[決定41] どのモジュールの設定か分かる", () => {
  it("区画に由来と表示名が付く（画面が「誰の設定か」を出せる）", async () => {
    const modules = createModuleRegistry([
      moduleWithSettings(
        "worker-pool",
        { title: "職人", fields: [], read: () => ({}), write: () => ({ applied: true }) },
        "職人"
      ),
    ]);
    const { describe: tool } = settingsToolsOf(modules);
    const details = (await tool.execute({})).details as {
      sections: Array<{ id: string; origin: string; originTitle: string }>;
    };

    const core = details.sections.find((s) => s.id === "places")!;
    assert.equal(core.origin, "core");
    assert.equal(core.originTitle, "Banto 本体");

    const module = details.sections.find((s) => s.id === "worker-pool")!;
    assert.equal(module.origin, "worker-pool");
    assert.equal(module.originTitle, "職人", "モジュールの表示名が出ること");
  });
});

describe("[決定41] 設定に入れたもの（VM設置に要るもの）", () => {
  it("Banto 本体：場所・接続（ポート／待ち受け／公開／Caddy）", async () => {
    const { describe: tool } = settingsToolsOf(createModuleRegistry([]));
    const details = (await tool.execute({})).details as {
      sections: Array<{ id: string; fields: Array<{ key: string }> }>;
    };
    const keys = (id: string): string[] =>
      details.sections.find((s) => s.id === id)!.fields.map((f) => f.key);

    assert.deepEqual(keys("network"), ["port", "bind", "publicUrl", "caddyAdmin", "envDomain"]);
    assert.deepEqual(keys("places"), ["places"]);
  });

  it("ポートは範囲を確かめる（起動して初めて分かる、を避ける）", async () => {
    const { update } = settingsToolsOf(createModuleRegistry([]));
    await assert.rejects(
      () => update.execute({ section: "network", values: { port: 99999 } }),
      /1〜65535/
    );
    await update.execute({ section: "network", values: { port: 4200 } });
    assert.equal(store.all().network?.port, 4200);
  });
});
