/**
 * task-0015: モジュール登録機構。ADR-0010 決定25・26・27。
 *
 * Kobo にも LLM にも接続せず、登録の帳簿としての振る舞いだけを検証する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { JsonlMemoryStore } from "@banto/core";

import {
  PlaceRegistry,
  createStaticPlaceProvider,
  ThreadRegistry,
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Canvas,
  CORE_ORIGIN,
  createCanvasCatalog,
  createModuleRegistry,
  createWorkspaceModule,
  createDemoModule,
  createStudioModule,
  defineNamespacedTool,
  moduleDomains,
  resolveSkills,
  type BantoModule,
  type BantoSkill,
  type HostSession,
  type ServerEvent,
  type SkillEntry,
} from "@banto/host";

/** 場所1つの帳簿。task-0038 で workspace モジュールは場所を受け取るようになった。 */
function placesOf(root: string): PlaceRegistry {
  return new PlaceRegistry([createStaticPlaceProvider([{ id: "workspace", path: root }])]);
}

function stubTool(name: `${string}.${string}`) {
  return defineNamespacedTool({
    name,
    label: name,
    description: `stub ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  });
}

function stubSkill(name: string): BantoSkill {
  return { name, description: `stub skill ${name}`, filePath: `/tmp/${name}/SKILL.md` };
}

function stubModule(name: string, overrides: Partial<BantoModule> = {}): BantoModule {
  return {
    name,
    title: name,
    description: `stub module ${name}`,
    endpoint: { baseUrl: `/api/${name}` },
    tools: [],
    views: [],
    skills: [],
    ...overrides,
  };
}

describe("[task-0015/a1] 登録単位（接続情報・Tool・GUI・SKILL）", () => {
  it("[task-0015/a1] 4点を1つにまとめて登録できる", () => {
    const module = stubModule("shop", {
      endpoint: { baseUrl: "http://localhost:9999" },
      tools: [stubTool("shop.query.items")],
      views: [
        {
          kind: "shop.board",
          title: "ボード",
          description: "ボード表示",
          parameters: Type.Object({}),
          component: "ShopBoard",
        },
      ],
      skills: [stubSkill("shop-workflow")],
    });
    const registry = createModuleRegistry([module]);

    const registered = registry.get("shop");
    assert.ok(registered);
    assert.equal(registered!.endpoint.baseUrl, "http://localhost:9999");
    assert.deepEqual(registered!.tools.map((t) => t.name), ["shop.query.items"]);
    assert.deepEqual(registered!.views.map((v) => v.kind), ["shop.board"]);
    assert.deepEqual(registered!.skills.map((s) => s.name), ["shop-workflow"]);
  });

  it("[task-0015/a2] Tool・GUI・SKILL が束ねて取り出せる（配る口が1つ）", () => {
    const registry = createModuleRegistry([
      stubModule("a", { tools: [stubTool("a.one")], skills: [stubSkill("a-skill")] }),
      stubModule("b", { tools: [stubTool("b.two")] }),
    ]);

    assert.deepEqual(registry.tools().map((t) => t.name), ["a.one", "b.two"]);
    assert.deepEqual(registry.skills().map((e) => e.skill.name), ["a-skill"]);
  });

  it("[task-0015/a5] SKILL は由来つきで返る（どのモジュール由来か判別できる）", () => {
    const registry = createModuleRegistry([
      stubModule("kobo", { skills: [stubSkill("kobo-attention-queue")] }),
    ]);

    assert.deepEqual(registry.skills(), [
      { skill: stubSkill("kobo-attention-queue"), origin: "kobo" },
    ]);
  });

  it("[task-0015] モジュール名から提供元を逆引きできる", () => {
    const registry = createModuleRegistry([
      stubModule("a", {
        tools: [stubTool("a.one")],
        views: [
          {
            kind: "a.view",
            title: "v",
            description: "d",
            parameters: Type.Object({}),
            component: "AView",
          },
        ],
      }),
    ]);

    assert.equal(registry.moduleForTool("a.one")?.name, "a");
    assert.equal(registry.moduleForView("a.view")?.name, "a");
    assert.equal(registry.moduleForTool("nope.x"), undefined);
    assert.equal(registry.moduleForView("nope.view"), undefined);
  });

  it("[task-0015] moduleDomains が持つ名前空間ドメインを返す（決定27a）", () => {
    const module = stubModule("workspace", {
      tools: [stubTool("file.list"), stubTool("file.read"), stubTool("git.log")],
    });
    assert.deepEqual(moduleDomains(module).sort(), ["file", "git"]);
  });
});

describe("[task-0015/a4] 衝突の検出（I2）", () => {
  it("[task-0015/a4] 同名モジュールの二重登録は例外", () => {
    const registry = createModuleRegistry([stubModule("a")]);
    assert.throws(() => registry.register(stubModule("a")), /Module "a" is already registered/);
  });

  it("[task-0015/a4] 同一Tool名を別モジュールが出すと例外（衝突相手を添える）", () => {
    const registry = createModuleRegistry([stubModule("a", { tools: [stubTool("x.one")] })]);
    assert.throws(
      () => registry.register(stubModule("b", { tools: [stubTool("x.one")] })),
      /Tool "x.one" is already provided by module "a"/
    );
  });

  it("[task-0015/a4] 同一kindを別モジュールが出すと例外", () => {
    const view = {
      kind: "dup.view",
      title: "v",
      description: "d",
      parameters: Type.Object({}),
      component: "V",
    };
    const registry = createModuleRegistry([stubModule("a", { views: [view] })]);
    assert.throws(
      () => registry.register(stubModule("b", { views: [view] })),
      /Canvas view "dup.view" is already provided by module "a"/
    );
  });

  it("[task-0015/a4] 同一SKILL名を別モジュールが出すと例外", () => {
    const registry = createModuleRegistry([stubModule("a", { skills: [stubSkill("dup")] })]);
    assert.throws(
      () => registry.register(stubModule("b", { skills: [stubSkill("dup")] })),
      /SKILL "dup" is already provided by module "a"/
    );
  });

  it("[task-0015/a4] 衝突で失敗したモジュールは帳簿に残らない（半端に登録しない）", () => {
    const registry = createModuleRegistry([stubModule("a", { tools: [stubTool("x.one")] })]);
    assert.throws(() =>
      registry.register(
        stubModule("b", { tools: [stubTool("b.fresh"), stubTool("x.one")], skills: [stubSkill("b-skill")] })
      )
    );

    assert.equal(registry.get("b"), undefined);
    assert.deepEqual(registry.tools().map((t) => t.name), ["x.one"], "先に検査してから登録する");
    assert.deepEqual(registry.skills(), []);
  });

  it("[task-0015] 予約名 core はモジュール名に使えない", () => {
    assert.throws(() => createModuleRegistry([stubModule(CORE_ORIGIN)]), /reserved for Banto core/);
  });
});

describe("[task-0015/a5] SKILL の優先順位解決（決定26）", () => {
  it("[task-0015/a5] 先に渡した層が勝つ（学習層を先頭に差し込める形）", () => {
    const learned: SkillEntry[] = [{ skill: stubSkill("work-handoff"), origin: "learned" }];
    const core: SkillEntry[] = [{ skill: stubSkill("work-handoff"), origin: CORE_ORIGIN }];
    const fromModule: SkillEntry[] = [{ skill: stubSkill("kobo-queue"), origin: "kobo" }];

    const resolved = resolveSkills([learned, core, fromModule]);

    assert.deepEqual(
      resolved.map((e) => [e.skill.name, e.origin]),
      [
        ["work-handoff", "learned"],
        ["kobo-queue", "kobo"],
      ],
      "同名は学習層が勝ち、他はそのまま残る"
    );
  });

  it("[task-0015/a5] 学習層が無ければ既定がそのまま効く", () => {
    const core: SkillEntry[] = [{ skill: stubSkill("work-handoff"), origin: CORE_ORIGIN }];
    assert.deepEqual(resolveSkills([[], core]).map((e) => e.origin), [CORE_ORIGIN]);
  });

  it("[task-0015/a5] 空の層だけなら空", () => {
    assert.deepEqual(resolveSkills([[], []]), []);
  });
});

describe("[task-0015] 組み込みモジュール", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "banto-mod-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("[task-0015] workspace モジュールが file.* / git.* を提供する", () => {
    const module = createWorkspaceModule(placesOf(root));

    assert.equal(module.name, "workspace");
    // 個々のTool名を全部並べるとToolが増えるたび意味の無い失敗になるので、性質で見る
    // task-0039: place.* も持つ——場所の id を知る手段が無いと file.* の place 引数を埋められない
    assert.deepEqual(moduleDomains(module).sort(), ["file", "git", "place"]);
    // 探索系も揃っていること（番頭がどこに何があるか探せる）
    for (const expected of ["file.find", "file.grep"]) {
      assert.ok(module.tools.some((t) => t.name === expected), `${expected} を提供する`);
    }
    // 決定38（task-0041）: file.write はある。ただし**書けるかどうかは実行時の許可**で決まり、
    // 既定はどの場所も読み取り専用（banto-write-scope.spec.ts で見る）
    assert.ok(module.tools.some((t) => t.name === "file.write"), "file.write を提供する");
    // 決定37: git は閲覧のみ。番頭は履歴を変える手段を持たない
    for (const t of module.tools.filter((t) => t.name.startsWith("git."))) {
      assert.doesNotMatch(t.name, /commit|stage|push|checkout|reset|write|delete/);
    }
    // file 側も、書き込みは file.write ただ1つ（削除・移動は持たせていない）
    for (const t of module.tools.filter((t) => t.name.startsWith("file."))) {
      assert.doesNotMatch(t.name, /delete|remove|move|rename|chmod/);
    }
    // 組み込みは Banto ホスト自身が提供元なので、相対パスで指す（決定25）
    assert.match(module.endpoint.baseUrl, /^\//);
  });

  it("[task-0015] demo モジュールがテスト用GUIを提供する", () => {
    const module = createDemoModule();
    assert.equal(module.name, "demo");
    assert.deepEqual(module.views.map((v) => v.kind), ["demo.hello", "demo.clock"]);
  });

  it("[task-0015] 組み込み2つを同時に登録しても衝突しない", () => {
    const workspace = createWorkspaceModule(placesOf(root));
    const demo = createDemoModule();
    const registry = createModuleRegistry([workspace, demo]);

    assert.deepEqual(registry.list().map((m) => m.name), ["workspace", "demo"]);
    // 件数を直書きすると片方が増えたときに意味の無い失敗になるので、内訳から導く
    assert.equal(registry.views().length, workspace.views.length + demo.views.length);
    assert.equal(registry.tools().length, workspace.tools.length + demo.tools.length);
    // kind が重複していないこと（衝突しないことの実体）
    const kinds = registry.views().map((v) => v.kind);
    assert.equal(new Set(kinds).size, kinds.length);
  });
});

// ── UI へ接続情報が渡ること（a3）─────────────────────────────────────────────

class FakeSession implements HostSession {
  readonly sessionId = "test-session";
  isStreaming = false;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

describe("[task-0015/a3] UI へモジュールの接続情報が渡る", () => {
  let server: BantoHostServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("[task-0015/a3] welcome のカタログエントリに提供元モジュールと到達先が載る", async () => {
    const modules = createModuleRegistry([createDemoModule()]);
    const catalog = createCanvasCatalog(modules.views());
    const threads = new ThreadRegistry(async () => ({
      session: new FakeSession(),
      tools: [],
      canvas: new Canvas(catalog),
    }));
    await threads.open();
    server = await BantoHostServer.start({ threads, port: 0, catalog, modules });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(
      `ws://localhost:${server.port}${BANTO_WS_PATH}`,
      (e) => events.push(e)
    );

    const welcome = await new Promise<ServerEvent>((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const found = events.find((e) => e.type === "welcome");
        if (found) {
          clearInterval(tick);
          resolve(found);
        } else if (Date.now() - started > 2000) {
          clearInterval(tick);
          reject(new Error("timed out"));
        }
      }, 10);
    });

    assert.ok(welcome.type === "welcome");
    const hello = welcome.catalog.find((c) => c.kind === "demo.hello");
    assert.ok(hello, `demo.hello must be in the catalog: ${JSON.stringify(welcome.catalog)}`);
    assert.equal(hello!.module, "demo");
    assert.equal(hello!.endpoint, "/api/demo");
    client.close();
  });

  it("[task-0015/a3] モジュール未登録のGUIは中核由来として扱われる", async () => {
    const catalog = createCanvasCatalog([
      {
        kind: "core.only",
        title: "中核",
        description: "モジュール外のGUI",
        parameters: Type.Object({}),
        component: "CoreOnly",
      },
    ]);
    const threads = new ThreadRegistry(async () => ({
      session: new FakeSession(),
      tools: [],
      canvas: new Canvas(catalog),
    }));
    await threads.open();
    server = await BantoHostServer.start({ threads, port: 0, catalog, modules: createModuleRegistry() });

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(
      `ws://localhost:${server.port}${BANTO_WS_PATH}`,
      (e) => events.push(e)
    );
    await new Promise((r) => setTimeout(r, 200));

    const welcome = events.find((e) => e.type === "welcome");
    assert.ok(welcome?.type === "welcome");
    assert.equal(welcome.catalog[0]!.module, CORE_ORIGIN);
    client.close();
  });
});

// ── task-0031: studio モジュール（番頭の中身を見せる。提案 banto-studio-module より） ──

describe("[task-0031] studio モジュール", () => {
  let dir: string;
  let memory: JsonlMemoryStore;

  const studio = (): ReturnType<typeof createStudioModule> =>
    createStudioModule({
      memory,
      skills: [
        {
          skill: {
            name: "work-handoff",
            description: "引き継ぎの手順",
            filePath: path.join(dir, "handoff.md"),
          },
          origin: "core",
        },
        {
          skill: {
            name: "worker-delegation",
            description: "委譲の手順",
            filePath: path.join(dir, "missing.md"),
          },
          origin: "worker-pool",
        },
      ],
    });

  const run = async (
    module: ReturnType<typeof createStudioModule>,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const tool = module.internalTools!.find((t) => t.name === name)!;
    const out = await tool.execute(args as never);
    return (out as { details: Record<string, unknown> }).details;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-studio-"));
    memory = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
    fs.writeFileSync(path.join(dir, "handoff.md"), "# 引き継ぎ\n\n手順はここ\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("[task-0031] 記憶とSKILLのGUIを提供する", () => {
    assert.deepEqual(studio().views.map((v) => v.kind).sort(), ["memory.viewer", "skill.viewer"]);
  });

  it("[task-0031] 番頭には Tool を渡さない（memory.*/skill.* は中核の持ち物）", () => {
    // 決定27a: ドメインの所有と、GUIのための閲覧口を混ぜない
    assert.deepEqual(studio().tools, []);
    assert.deepEqual(
      studio().internalTools!.map((t) => t.name).sort(),
      ["studio.memory", "studio.skills"]
    );
  });

  it("[task-0031] 記憶を一覧で返す", async () => {
    memory.save({ kind: "preference", text: "結論から話す" });
    memory.save({ kind: "habit", text: "毎朝ログを見る" });

    const all = (await run(studio(), "studio.memory"))["records"] as Array<{ text: string }>;
    assert.equal(all.length, 2);

    const prefs = (await run(studio(), "studio.memory", { kind: "preference" }))["records"] as Array<{
      text: string;
    }>;
    assert.deepEqual(prefs.map((r) => r.text), ["結論から話す"], "種別で絞れる");
  });

  it("[task-0031] 訂正済みの記憶は既定で隠れ、求めれば履歴として見える", async () => {
    const first = memory.save({ kind: "preference", text: "簡潔に" });
    memory.supersede(first.id, { kind: "preference", text: "簡潔に、ただし根拠は添える" });

    const active = (await run(studio(), "studio.memory"))["records"] as Array<{ text: string }>;
    assert.deepEqual(active.map((r) => r.text), ["簡潔に、ただし根拠は添える"]);

    const withHistory = (await run(studio(), "studio.memory", { includeSuperseded: true }))[
      "records"
    ] as Array<{ text: string }>;
    assert.equal(withHistory.length, 2);
  });

  it("[task-0031] SKILLの中身と出所を返す", async () => {
    const skills = (await run(studio(), "studio.skills"))["skills"] as Array<Record<string, string>>;

    const handoff = skills.find((s) => s["name"] === "work-handoff")!;
    assert.equal(handoff["origin"], "core", "どの層から来たか分かる（決定26）");
    assert.match(handoff["body"]!, /手順はここ/);
  });

  it("[task-0031] 読めないSKILLは黙って空にせず理由を返す（I2）", async () => {
    const skills = (await run(studio(), "studio.skills"))["skills"] as Array<Record<string, string>>;
    const broken = skills.find((s) => s["name"] === "worker-delegation")!;

    assert.equal(broken["body"], undefined);
    assert.match(broken["error"]!, /読めません/);
  });
});
