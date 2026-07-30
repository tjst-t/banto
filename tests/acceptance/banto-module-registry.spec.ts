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

import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Canvas,
  CORE_ORIGIN,
  createCanvasCatalog,
  createModuleRegistry,
  createWorkspaceModule,
  createDemoModule,
  defineNamespacedTool,
  moduleDomains,
  resolveSkills,
  type BantoModule,
  type BantoSkill,
  type HostSession,
  type ServerEvent,
  type SkillEntry,
} from "@banto/host";

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
    const module = createWorkspaceModule(root);

    assert.equal(module.name, "workspace");
    // 個々のTool名を全部並べるとToolが増えるたび意味の無い失敗になるので、
    // 「file/git の両ドメインを持ち、すべて閲覧専用」という性質で見る
    assert.deepEqual(moduleDomains(module).sort(), ["file", "git"]);
    for (const t of module.tools) {
      assert.doesNotMatch(t.name, /write|delete|commit|stage|push|checkout|reset/);
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
    const workspace = createWorkspaceModule(root);
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
    server = await BantoHostServer.start({
      session: new FakeSession(),
      tools: [],
      port: 0,
      canvas: new Canvas(catalog),
      catalog,
      modules,
    });

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
    server = await BantoHostServer.start({
      session: new FakeSession(),
      tools: [],
      port: 0,
      canvas: new Canvas(catalog),
      catalog,
      modules: createModuleRegistry(),
    });

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
