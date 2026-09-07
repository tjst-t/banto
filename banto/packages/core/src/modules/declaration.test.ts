// Module の宣言（決定・2026-09-06、Phase 1）。
// **どの Module を、どう起動するかは、コードではなく宣言で決める**——以前は
// cli.ts に「vault の dist パス」「shell|filesystem のリテラル union」
// 「node で実行」が直書きされていて、4本目を足すには本体を書き換える必要があった。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { RuntimeConfigStore } from "../config/runtime.js";
import {
  DEFAULT_MODULE_DECLARATIONS,
  MODULE_DECLARATIONS_KEY,
  ModuleDeclarationError,
  expandLaunch,
  loadModuleDeclarations,
  parseModuleDeclaration,
  setModuleDeclarations,
} from "./declaration.js";

const CONTEXT = {
  nodeExec: "/usr/bin/node",
  monorepoRoot: "/repo",
  dataDir: "/data",
  hostRelayUrl: "http://127.0.0.1:4737/relay",
  hostRelayToken: "tok",
  moduleDataDir: "/tmp/banto-module-data",
  projectRoot: "/home/me/work",
};

test("同梱の既定は3本（vault/shell/filesystem）で、そのまま読める", () => {
  const parsed = DEFAULT_MODULE_DECLARATIONS.map((d) => parseModuleDeclaration(d, "default"));
  assert.deepEqual(
    parsed.map((d) => d.name).sort(),
    ["filesystem", "shell", "vault"],
  );
  // vault は instance に1本、shell/filesystem は Project ごと
  assert.equal(parsed.find((d) => d.name === "vault")?.meta.scope, "instance");
  assert.equal(parsed.find((d) => d.name === "shell")?.meta.scope, "project");
});

test("node 以外で起動する Module も宣言できる（TypeScript でない Module の前提）", () => {
  const python = parseModuleDeclaration(
    {
      name: "python-demo",
      launch: {
        command: "${monorepoRoot}/packages/modules/python-demo/.venv/bin/python",
        args: ["${monorepoRoot}/packages/modules/python-demo/server.py"],
      },
      meta: { satisfies: ["demo"], dependsOn: [], isolation: "subprocess", scope: "instance" },
    },
    "test",
  );
  const launched = expandLaunch(python.launch, CONTEXT);
  assert.equal(launched.command, "/repo/packages/modules/python-demo/.venv/bin/python");
  assert.deepEqual(launched.args, ["/repo/packages/modules/python-demo/server.py"]);
});

test("知らない差し込み語は、起動する前に弾く（規則2）", () => {
  assert.throws(
    () =>
      parseModuleDeclaration(
        {
          name: "bad",
          launch: { command: "${whatIsThis}/bin/x", args: [] },
          meta: { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "instance" },
        },
        "test",
      ),
    ModuleDeclarationError,
  );
});

test("instance に1本の Module が Project の場所を差し込もうとしたら弾く", () => {
  assert.throws(
    () =>
      parseModuleDeclaration(
        {
          name: "confused",
          launch: { command: "/bin/x", args: ["${projectRoot}"] },
          meta: { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "instance" },
        },
        "test",
      ),
    ModuleDeclarationError,
  );
});

test("起動の中身が空なら弾く", () => {
  assert.throws(
    () =>
      parseModuleDeclaration(
        { name: "empty", launch: { command: "", args: [] }, meta: { satisfies: ["x"], dependsOn: [], isolation: "subprocess", scope: "instance" } },
        "test",
      ),
    ModuleDeclarationError,
  );
});

test("差し込み語は起動時に実際の値へ置き換わる", () => {
  const shell = parseModuleDeclaration(
    DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === "shell")!,
    "default",
  );
  const launched = expandLaunch(shell.launch, CONTEXT);
  assert.ok(launched.command.length > 0);
  assert.equal(launched.env?.BANTO_PROJECT_ROOT, "/home/me/work");
  assert.equal(launched.env?.BANTO_HOST_MCP_TOKEN, "tok");
});

test("**コードを変えずに、宣言を1本足すだけで4本目が Project の一覧に出る**", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-decl-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();

    const before = loadModuleDeclarations(config, "project-1");
    assert.equal(before.length, 3, "既定は3本");

    await setModuleDeclarations(config, [
      ...DEFAULT_MODULE_DECLARATIONS,
      {
        name: "python-demo",
        launch: {
          command: "${monorepoRoot}/packages/modules/python-demo/.venv/bin/python",
          args: ["${monorepoRoot}/packages/modules/python-demo/server.py"],
        },
        meta: { satisfies: ["demo"], dependsOn: [], isolation: "subprocess", scope: "instance" },
      },
    ]);

    const after = loadModuleDeclarations(config, "project-1");
    assert.equal(after.length, 4);
    assert.ok(after.some((d) => d.name === "python-demo"));

    // 読み直しても残る（Event Store に載っている）
    const log2 = new EventLog(dir);
    await log2.init();
    const config2 = new RuntimeConfigStore(dir, log2);
    await config2.load();
    assert.equal(loadModuleDeclarations(config2, "project-1").length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Project ごとに、繋ぐ Module を上書きできる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-decl-project-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();

    await setModuleDeclarations(
      config,
      DEFAULT_MODULE_DECLARATIONS.filter((d) => d.name === "vault"),
      "project-2",
    );

    assert.deepEqual(
      loadModuleDeclarations(config, "project-2").map((d) => d.name),
      ["vault"],
    );
    // 別の Project は既定のまま
    assert.equal(loadModuleDeclarations(config, "other").length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**既定を改良すると、差分を持つ Project にも届く**（今回の事故の回帰）", async () => {
  // 2026-09-07：Module の設定の置き場を既定に足したのに、**宣言の写しを持つ
  // Project だけ**に届かず、設定が保存できなかった。原因は「既定を丸ごと写す」
  // 形。差分で持てば、既定の改良は自然に届く。
  const dir = await mkdtemp(join(tmpdir(), "banto-decl-overlay-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();

    // この Project は filesystem の env をひとつだけ足している
    const tweaked = DEFAULT_MODULE_DECLARATIONS.map((d) =>
      d.name === "filesystem"
        ? { ...d, launch: { ...d.launch, env: { ...d.launch.env, MY_OWN: "1" } } }
        : d,
    );
    await setModuleDeclarations(config, tweaked, "project-overlay");

    const loaded = loadModuleDeclarations(config, "project-overlay").find((d) => d.name === "filesystem")!;
    // 足した分は効いている
    assert.equal(loaded.launch.env?.MY_OWN, "1");
    // **既定にあるキーは全部そのまま届いている**（丸ごと写していたら、
    // あとから既定に足したキーはここで欠ける）
    for (const key of Object.keys(DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === "filesystem")!.launch.env!)) {
      assert.ok(loaded.launch.env?.[key], `既定の ${key} が届いていない`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("**古い形（丸ごとの写し）が Config に残っていても、既定の改良が届く**", async () => {
  // 実際にいま Config に入っているのはこの形。読むときに差分へ翻訳する
  const dir = await mkdtemp(join(tmpdir(), "banto-decl-legacy-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();

    // 古い鍵に、**既定に env が1つ足りない**写しを直接書く（2026-09-06 以前の形）
    const stale = DEFAULT_MODULE_DECLARATIONS.map((d) =>
      d.name === "filesystem"
        ? {
            ...d,
            launch: {
              ...d.launch,
              env: { BANTO_PROJECT_ROOT: "${projectRoot}", MY_OWN: "1" },
            },
          }
        : d,
    );
    await config.setProjectOverride(
      "project-legacy",
      MODULE_DECLARATIONS_KEY,
      stale as unknown as Parameters<RuntimeConfigStore["setProjectOverride"]>[2],
    );

    const loaded = loadModuleDeclarations(config, "project-legacy").find((d) => d.name === "filesystem")!;
    assert.equal(loaded.launch.env?.MY_OWN, "1", "その Project の設定が失われた");
    assert.ok(
      loaded.launch.env?.BANTO_HOST_MCP_URL,
      "**古い写しのせいで、既定にあるキーが届いていない**（今回の事故そのもの）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
