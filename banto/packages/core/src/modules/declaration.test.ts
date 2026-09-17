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
  fillSecrets,
  loadModuleDeclarations,
  secretPlaceholders,
  secretsAllowedFor,
  parseModuleDeclaration,
  setModuleDeclarations,
  listProjectModules,
  setProjectModuleSelection,
} from "./declaration.js";

/** 設定だけを持つ空の置き場（この節の試験はどれも同じ形で始まる） */
async function withConfig(fn: (config: RuntimeConfigStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-module-select-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();
    await fn(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CONTEXT = {
  nodeExec: "/usr/bin/node",
  monorepoRoot: "/repo",
  dataDir: "/data",
  hostRelayUrl: "http://127.0.0.1:4737/relay",
  hostRelayToken: "tok",
  moduleDataDir: "/tmp/banto-module-data",
  projectRoot: "/home/me/work",
};

test("同梱の既定は6本（vault-local/infisical×2/vault-directory/shell/filesystem）で、そのまま読める", () => {
  const parsed = DEFAULT_MODULE_DECLARATIONS.map((d) => parseModuleDeclaration(d, "default"));
  assert.deepEqual(
    parsed.map((d) => d.name).sort(),
    ["filesystem", "shell", "vault-directory", "vault-infisical", "vault-infisical-cloud", "vault-local"],
  );
  // VaultUI は vault を横断するので、依存を名乗っている（中継の許可はここから出る）
  assert.deepEqual(parsed.find((d) => d.name === "vault-directory")?.meta.dependsOn, [
    { role: "vault", required: true },
  ]);
  // vault は instance に1本、shell/filesystem は Project ごと
  assert.equal(parsed.find((d) => d.name === "vault-local")?.meta.scope, "instance");
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

test("**コードを変えずに、宣言を1本足すだけで次の1本が Project の一覧に出る**", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-decl-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const config = new RuntimeConfigStore(dir, log);
    await config.load();

    const before = loadModuleDeclarations(config, "project-1");
    assert.equal(before.length, 6, "既定は6本");

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
    assert.equal(after.length, 7);
    assert.ok(after.some((d) => d.name === "python-demo"));

    // 読み直しても残る（Event Store に載っている）
    const log2 = new EventLog(dir);
    await log2.init();
    const config2 = new RuntimeConfigStore(dir, log2);
    await config2.load();
    assert.equal(loadModuleDeclarations(config2, "project-1").length, 7);
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
      DEFAULT_MODULE_DECLARATIONS.filter((d) => d.name === "vault-local"),
      "project-2",
    );

    assert.deepEqual(
      loadModuleDeclarations(config, "project-2").map((d) => d.name),
      ["vault-local"],
    );
    // 別の Project は既定のまま
    assert.equal(loadModuleDeclarations(config, "other").length, 6);
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

// **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、2026-09-11）。
// 宣言は banto 全体の既定なので、1本足すと全 Project に繋がる——増やす前に、
// Project ごとに選べるようにする（Phase 2 の入口）。

test("外した Module は、その Project でだけ消える（他の Project は変わらない）", async () => {
  await withConfig(async (config) => {
    const before = listProjectModules(config, "p1");
    assert.ok(before.length >= 3, "既定の Module が見えていない");
    assert.equal(before.every((m) => m.selected), true, "はじめは全部使う");

    const keep = before.filter((m) => m.name !== "shell").map((m) => m.name);
    await setProjectModuleSelection(config, "p1", keep);

    assert.equal(
      loadModuleDeclarations(config, "p1").some((d) => d.name === "shell"),
      false,
      "外したのに、その Project で使われている",
    );
    assert.equal(
      loadModuleDeclarations(config, "p2").some((d) => d.name === "shell"),
      true,
      "他の Project からも消えている（差分が漏れている）",
    );
    // 一覧には残る——**外しただけで、Module そのものは消えない**
    const after = listProjectModules(config, "p1");
    assert.equal(after.find((m) => m.name === "shell")?.selected, false);
    assert.equal(after.length, before.length);
  });
});

test("繋ぎ直すと戻る（外した印が残らない）", async () => {
  await withConfig(async (config) => {
    const all = listProjectModules(config, "p1").map((m) => m.name);
    await setProjectModuleSelection(config, "p1", all.filter((n) => n !== "filesystem"));
    assert.equal(loadModuleDeclarations(config, "p1").some((d) => d.name === "filesystem"), false);
    await setProjectModuleSelection(config, "p1", all);
    assert.equal(loadModuleDeclarations(config, "p1").some((d) => d.name === "filesystem"), true);
  });
});

test("知らない Module は選べない（順番の中に幽霊を作らない）", async () => {
  await withConfig(async (config) => {
    await assert.rejects(() => setProjectModuleSelection(config, "p1", ["shell", "いない"]));
    // 断られたのだから、選択は変わっていない
    assert.equal(listProjectModules(config, "p1").every((m) => m.selected), true);
  });
});

test("その Project 固有の直しは、選び直しても残る", async () => {
  await withConfig(async (config) => {
    // Project だけ env を足す（`setModuleDeclarations` が差分として残す）
    const declarations = loadModuleDeclarations(config, "p1").map((d) =>
      d.name === "shell"
        ? { ...d, launch: { ...d.launch, env: { ...d.launch.env, EXTRA: "1" } } }
        : d,
    );
    await setModuleDeclarations(config, declarations as never, "p1");
    assert.equal(
      loadModuleDeclarations(config, "p1").find((d) => d.name === "shell")?.launch.env?.EXTRA,
      "1",
    );

    // 別の Module を外す——**shell の直しは巻き添えにならない**
    const keep = listProjectModules(config, "p1")
      .filter((m) => m.name !== "filesystem")
      .map((m) => m.name);
    await setProjectModuleSelection(config, "p1", keep);
    assert.equal(
      loadModuleDeclarations(config, "p1").find((d) => d.name === "shell")?.launch.env?.EXTRA,
      "1",
      "選び直したら、その Project 固有の直しが消えた",
    );
  });
});

// **同じ実装を2本以上立てられるようにしておく**（追加・2026-09-15）。
// Vault を自前ホストと Infisical Cloud で並べたい、という要望から。
// 宣言をコピーすれば足りる形にしておくには、**置き場が固定パスであってはいけない**
// ——固定だと2本目が1本目の資格情報を上書きする。
test("秘密を扱う Module の置き場は、接続名ごとに分かれる場所を指す", () => {
  for (const d of DEFAULT_MODULE_DECLARATIONS) {
    for (const [key, value] of Object.entries(d.launch.env ?? {})) {
      if (!/DATA_DIR$/.test(key)) continue;
      // `${dataDir}/...` は banto 全体で1つの場所——コピーするとぶつかる。
      // **ぶつかってよいものだけ、理由つきでここに挙げる**
      const sharedOnPurpose = new Set(["vault-local", "vault-directory"]);
      if (sharedOnPurpose.has(d.name)) continue;
      assert.ok(
        value.includes("${moduleDataDir}"),
        `${d.name} の ${key} が固定パス（${value}）——この実装を2本立てると置き場がぶつかる`,
      );
    }
  }
});

// ---- 2026-09-15：第三者 Module を受け入れる前の土台 --------------------------

// **骨格の役割は、同梱だけが名乗れる**（レビューで発覚）。
// `satisfies` は自己申告で、spawn-shape の厳格さが掛かっていない——第三者が
// `vault-directory` を名乗れれば、AI と Shell が話す窓口になりうる。
test("外から繋ぐ Module は、骨格の役割を名乗れない", () => {
  const evil = {
    name: "evil",
    launch: { command: "/bin/sh", args: ["-c", "true"] },
    meta: { satisfies: ["vault-directory"], dependsOn: [], isolation: "subprocess" },
  };
  assert.throws(
    () => parseModuleDeclaration(evil, "test"),
    /同梱の実装だけが名乗れる役割/,
    "第三者が窓口を名乗れてしまう",
  );
  // 自分の役割ならよい
  assert.doesNotThrow(() =>
    parseModuleDeclaration({ ...evil, meta: { ...evil.meta, satisfies: ["weather"] } }, "test"),
  );
});

// **同梱かどうかは host が決める**（宣言に書かせない）
test("origin は宣言に書けない——同梱の印は host が立てる", () => {
  const claimed = parseModuleDeclaration(
    {
      name: "liar",
      launch: { command: "/bin/sh", args: ["-c", "true"] },
      meta: { satisfies: ["weather"], dependsOn: [], isolation: "subprocess", origin: "bundled" },
    },
    "test",
  );
  assert.equal(claimed.meta.origin, "external", "宣言が同梱を名乗れてしまう");
});

// **束ね役は instance 全体で1本**——2本目が居ると、呼ぶ側が「唯一の1本」を引けない
test("窓口を名乗る Module が2本あったら、読み込みで止まる", async () => {
  await withConfig(async (config) => {
    const current = loadModuleDeclarations(config, "");
    await assert.rejects(
      () =>
        setModuleDeclarations(config, [
          ...(current as unknown as Parameters<typeof setModuleDeclarations>[1]),
          {
            name: "another-directory",
            launch: { command: "/bin/sh", args: ["-c", "true"] },
            // 第三者は予約 role を名乗れないので、ここは同梱と同じ名前・同じコードに
            // した写し……ではなく、そもそも名乗れないことを先に確かめる
            meta: { satisfies: ["vault-directory"], dependsOn: [], isolation: "subprocess" },
          },
        ] as never),
      /同梱の実装だけが名乗れる役割|役割 "vault-directory" は1本だけ/,
    );
  });
});

// **書いていなければ、書いたものから決める**（画面の既定を決めるための導出）
test("scope を書かなければ、この Project のフォルダを使うかで決まる", () => {
  const usesRoot = parseModuleDeclaration(
    {
      name: "files",
      launch: { command: "/bin/sh", args: ["-c", "true", "${projectRoot}"] },
      meta: { satisfies: ["weather"], dependsOn: [], isolation: "subprocess" },
    },
    "test",
  );
  assert.equal(usesRoot.meta.scope, "project", "Project のフォルダを渡しているのに instance");

  const plain = parseModuleDeclaration(
    {
      name: "weather",
      launch: { command: "/bin/sh", args: ["-c", "true"] },
      meta: { satisfies: ["weather"], dependsOn: [], isolation: "subprocess" },
    },
    "test",
  );
  assert.equal(plain.meta.scope, "instance");

  // **逆向きは許す**——Project ごとに分けたい理由はフォルダだけではない
  // （Project ごとに別の状態を持ちたい Module は、根を受け取らなくてよい）
  const perProjectState = parseModuleDeclaration(
    {
      name: "cache",
      launch: { command: "/bin/sh", args: ["-c", "true"] },
      meta: { satisfies: ["weather"], dependsOn: [], isolation: "subprocess", scope: "project" },
    },
    "test",
  );
  assert.equal(perProjectState.meta.scope, "project");
});

// **閉じ込めの広さは宣言が持つ**——以前は `satisfies` から推していたので、
// `shell` を名乗るだけで広いほう（PATH の実行を許す）を取れた
test("閉じ込めの広さは宣言が持ち、書かなければ狭いほう", () => {
  const shell = DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === "shell")!;
  assert.equal(
    (shell.meta as { confinement?: { profile?: string } }).confinement?.profile,
    "exec",
    "コマンドを走らせる Module の profile が宣言に無い（host が satisfies から推していた形に戻っている）",
  );
  const noProfile = parseModuleDeclaration(
    {
      name: "q",
      launch: { command: "/bin/sh", args: ["-c", "true", "${projectRoot}"] },
      meta: {
        satisfies: ["weather"],
        dependsOn: [],
        isolation: "subprocess",
        // 閉じ込めは scope:"project" が要る（`meta.ts` の assertConsistent）
        scope: "project",
        confinement: { kind: "landlock", root: "project" },
      },
    },
    "test",
  );
  assert.equal(noProfile.meta.confinement?.profile, "files-only", "書いていないのに広いほうになった");
});

// **banto 全体に1本の Module も閉じ込められる**（追加・2026-09-15）。
// 以前は閉じ込めが `scope:"project"` 必須だったので、instance の Module は
// **閉じ込めようが無かった**——その帰結として、外から繋いだ instance の
// Module を起動できなかった（起動を断っていた）。
test("根を持たない閉じ込めは、banto 全体に1本の Module でも宣言できる", () => {
  const d = parseModuleDeclaration(
    {
      name: "weather",
      launch: { command: "/bin/sh", args: ["-c", "true"] },
      meta: {
        satisfies: ["weather"],
        dependsOn: [],
        isolation: "subprocess",
        confinement: { kind: "landlock", root: "none" },
      },
    },
    "test",
  );
  assert.equal(d.meta.scope, "instance");
  assert.equal(d.meta.confinement?.root, "none");
  assert.equal(d.meta.confinement?.profile, "files-only", "書いていないのに広いほうになった");
});

test("根が Project の閉じ込めは、Project ごとの Module でしか宣言できない", () => {
  assert.throws(
    () =>
      parseModuleDeclaration(
        {
          name: "bad",
          launch: { command: "/bin/sh", args: ["-c", "true"] },
          meta: {
            satisfies: ["weather"],
            dependsOn: [],
            isolation: "subprocess",
            confinement: { kind: "landlock", root: "project" },
          },
        },
        "test",
      ),
    /scope:"project" が必要/,
  );
});

// ---- 2026-09-16：秘密を宣言に書かせない（`${secret:名前}`）------------------

// **`mcpServers` の慣習は env に API キーを直に書くこと**。ところが banto の
// 宣言は Event Store に残るので、書いた瞬間に記録へ永久に残る。名前だけ書かせる。
test("秘密は env の値にだけ書ける——コマンドと引数には書かせない", () => {
  const ok = parseModuleDeclaration(
    {
      name: "weather",
      launch: { command: "/bin/sh", args: ["-c", "true"], env: { API_KEY: "${secret:weather-key}" } },
      meta: { satisfies: [], dependsOn: [], isolation: "subprocess" },
    },
    "test",
  );
  assert.deepEqual(secretPlaceholders(ok.launch), [{ envName: "API_KEY", alias: "weather-key" }]);

  // **argv に載ると ps に平文が出る**——envSecrets が避けているのと同じ理由
  assert.throws(
    () =>
      parseModuleDeclaration(
        {
          name: "leaky",
          launch: { command: "/bin/sh", args: ["-c", "echo ${secret:weather-key}"] },
          meta: { satisfies: [], dependsOn: [], isolation: "subprocess" },
        },
        "test",
      ),
    /環境変数の値にしか書けません/,
  );
});

test("名前の無い ${secret:} は弾く", () => {
  assert.throws(
    () =>
      parseModuleDeclaration(
        {
          name: "x",
          launch: { command: "/bin/sh", args: [], env: { K: "${secret:}" } },
          meta: { satisfies: [], dependsOn: [], isolation: "subprocess" },
        },
        "test",
      ),
    /名前がありません/,
  );
});

// **解かれないまま起動しない**（規則2——空文字で埋めて静かに壊さない）
test("金庫の語が解かれないまま起動しようとしたら止まる", () => {
  const d = parseModuleDeclaration(
    {
      name: "weather",
      launch: { command: "/bin/sh", args: [], env: { API_KEY: "${secret:weather-key}" } },
      meta: { satisfies: [], dependsOn: [], isolation: "subprocess" },
    },
    "test",
  );
  assert.throws(
    () =>
      expandLaunch(d.launch, {
        nodeExec: "/usr/bin/node",
        monorepoRoot: "/x",
        dataDir: "/d",
        hostRelayUrl: "http://x",
        hostRelayToken: "t",
        moduleDataDir: "/m",
      }),
    /解かれないまま/,
  );
});

test("引いた値は env にだけ入る——引けなかったものは空で埋めない", () => {
  const d = parseModuleDeclaration(
    {
      name: "weather",
      launch: {
        command: "/bin/sh",
        args: [],
        env: { API_KEY: "${secret:weather-key}", OTHER: "plain" },
      },
      meta: { satisfies: [], dependsOn: [], isolation: "subprocess" },
    },
    "test",
  );
  const filled = fillSecrets(d.launch, new Map([["weather-key", "sk-REAL"]]));
  assert.equal(filled.env?.API_KEY, "sk-REAL");
  assert.equal(filled.env?.OTHER, "plain");
  // **argv には何も起きていない**
  assert.deepEqual(filled.args, []);
  assert.throws(() => fillSecrets(d.launch, new Map()), /引けませんでした/);
});

// **秘密を渡してよい相手の定義**（追加・2026-09-16）。host の起動処理の中に
// 埋めずに出してあるのは、ここが安全の柵そのものだから（規則1——試験できる形に）。
const metaFor = (over: Record<string, unknown> = {}) =>
  ({
    satisfies: [],
    dependsOn: [],
    isolation: "subprocess",
    scope: "instance",
    origin: "external",
    ...over,
  }) as never;

test("金庫そのものは ${secret:…} を使えない——窓口も同じ", () => {
  for (const role of ["vault", "vault-directory"]) {
    const verdict = secretsAllowedFor(metaFor({ satisfies: [role], origin: "bundled" }));
    assert.equal(verdict.ok, false, `${role} に秘密を渡してしまう`);
    assert.match((verdict as { reason: string }).reason, /金庫そのもの/);
  }
});

test("閉じ込めの無い外部 Module には渡さない——同梱は自分のコードなので渡す", () => {
  // 外から繋いだコードで、閉じ込めが無い＝断る
  const external = secretsAllowedFor(metaFor({}));
  assert.equal(external.ok, false);
  assert.match((external as { reason: string }).reason, /閉じ込めの無い/);

  // 閉じ込めがあれば通る
  assert.equal(
    secretsAllowedFor(metaFor({ confinement: { kind: "landlock", root: "none" } })).ok,
    true,
  );
  // 同梱は閉じ込めが無くても通る（banto 自身のコード）
  assert.equal(secretsAllowedFor(metaFor({ origin: "bundled" })).ok, true);
});
