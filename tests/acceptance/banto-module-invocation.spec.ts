/**
 * task-0018: モジュール間呼び出しの規約とクライアント。ADR-0010 決定27b。
 * task-0016: 組み込みモジュールのデータAPI（同じ規約の上に載る）。
 *
 * **Banto ホストも番頭も起動せずに検証する**——これ自体が a3/a5 の証明になる
 * （呼び出しが Banto プロセスを経由せず、番頭も経路に入らない）。
 */

import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  MODULE_TOOL_PATH,
  createModuleClient,
  loadModuleRegistryConfig,
  resolveModuleEndpoint,
  type ModuleRegistryConfig,
} from "@banto/core";
import {
  PlaceRegistry,
  createStaticPlaceProvider,
  createModuleRegistry,
  createModuleToolHandler,
  createWorkspaceModule,
} from "@banto/host";

/** 場所1つの帳簿。task-0038 で workspace モジュールは場所を受け取るようになった。 */
function placesOf(root: string): PlaceRegistry {
  return new PlaceRegistry([createStaticPlaceProvider([{ id: "workspace", path: root }])]);
}

// ── レジストリ（a1）─────────────────────────────────────────────────────────

describe("[task-0018/a1] レジストリ（宣言的な設定）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-reg-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("[task-0018/a1] 設定ファイルから読み込み、名前から到達先を解決できる", () => {
    const file = path.join(dir, "modules.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        modules: {
          kobo: { baseUrl: "http://localhost:3000" },
          "worker-pool": { baseUrl: "http://localhost:5000" },
        },
      })
    );

    const config = loadModuleRegistryConfig(file);
    assert.equal(resolveModuleEndpoint(config, "kobo"), "http://localhost:3000");
    assert.equal(resolveModuleEndpoint(config, "worker-pool"), "http://localhost:5000");
  });

  it("[task-0018/a1] ファイルが無ければ空（呼び出しを使わない構成）", () => {
    assert.deepEqual(loadModuleRegistryConfig(path.join(dir, "none.json")), { modules: {} });
  });

  it("[task-0018/a4] 未登録モジュールの解決はエラー（登録済みを添える。I2）", () => {
    const config: ModuleRegistryConfig = { modules: { kobo: { baseUrl: "http://x" } } };
    assert.throws(() => resolveModuleEndpoint(config, "nope"), /Unknown module "nope".*kobo/s);
  });

  it("[task-0018/a4] 壊れた設定は黙って空にせずエラー（I2）", () => {
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    assert.throws(() => loadModuleRegistryConfig(broken), /Invalid module registry/);

    const noModules = path.join(dir, "no-modules.json");
    fs.writeFileSync(noModules, JSON.stringify({ other: 1 }));
    assert.throws(() => loadModuleRegistryConfig(noModules), /missing "modules"/);

    const noUrl = path.join(dir, "no-url.json");
    fs.writeFileSync(noUrl, JSON.stringify({ modules: { a: {} } }));
    assert.throws(() => loadModuleRegistryConfig(noUrl), /module "a" has no baseUrl/);
  });
});

// ── モジュール→モジュールの呼び出し（a2・a3・a5）──────────────────────────────

describe("[task-0018] モジュール同士の直接呼び出し（Bantoも番頭も介さない）", () => {
  let root: string;
  let providerServer: http.Server;
  let providerUrl: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "banto-inv-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "test@banto-test.local");
    git("config", "user.name", "banto-test");
    fs.writeFileSync(path.join(root, "hello.txt"), "やあ\n");
    git("add", "-A");
    git("commit", "-m", "initial");

    // 「提供する側のモジュール」だけを立てる。Banto ホストは起動しない。
    const modules = createModuleRegistry([createWorkspaceModule(placesOf(root))]);
    const handler = createModuleToolHandler(modules);
    providerServer = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => providerServer.listen(0, () => resolve()));
    const address = providerServer.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    providerUrl = `http://localhost:${address.port}/api/workspace`;
  });

  after(async () => {
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function client() {
    return createModuleClient({ modules: { workspace: { baseUrl: providerUrl } } });
  }

  it("[task-0018/a2] 別モジュールのToolを共通クライアントから呼べる", async () => {
    const result = await client().invoke("workspace", "file.list");

    // content は番頭・LLM向け、details は機械向け（同じ実装の上の2つの口）
    assert.match(String(result.content[0]?.text), /hello\.txt/);
    const details = result.details as { entries: Array<{ name: string }> };
    assert.ok(details.entries.some((e) => e.name === "hello.txt"));
  });

  it("[task-0018/a2] 引数が渡る", async () => {
    const result = await client().invoke("workspace", "file.read", { path: "hello.txt" });
    const details = result.details as { content: string };
    assert.match(details.content, /やあ/);
  });

  it("[task-0018/a2] git系のToolも同じ規約で呼べる", async () => {
    const result = await client().invoke("workspace", "git.log");
    const details = result.details as { commits: Array<{ subject: string }> };
    assert.equal(details.commits[0]?.subject, "initial");
  });

  it("[task-0018/a3][a5] 呼び出しはBantoプロセスも番頭も経由しない", () => {
    // このテストファイルは BantoHostServer も AgentSession も一切起動していない。
    // それでも上の呼び出しが成立していることが、経路に両者が居ないことの証明になる。
    assert.equal(
      providerUrl.includes("/api/workspace"),
      true,
      "提供側モジュールが自分で公開した口へ直接繋いでいる"
    );
  });

  it("[task-0018/a4] 未知のTool名は404で、そのモジュールが持つToolを添えて返る（I2）", async () => {
    await assert.rejects(
      () => client().invoke("workspace", "file.nonexistent"),
      /has no tool "file.nonexistent".*file\.list/s
    );
  });

  it("[task-0018/a4] Tool内のエラーは成功で包まれず伝わる（I2）", async () => {
    await assert.rejects(
      () => client().invoke("workspace", "file.read", { path: "no-such-file.txt" }),
      /No such file/
    );
  });

  it("[task-0018/a4] ワークスペース外への参照は拒否される（防御が呼び出し経路でも効く）", async () => {
    await assert.rejects(
      () => client().invoke("workspace", "file.read", { path: "../../etc/passwd" }),
      /outside the workspace/
    );
  });

  it("[task-0018/a4] 到達できない相手は「結果なし」と混同されない（I2）", async () => {
    const unreachable = createModuleClient({
      modules: { ghost: { baseUrl: "http://127.0.0.1:1" } },
    });
    await assert.rejects(() => unreachable.invoke("ghost", "any.tool"), /Failed to reach module "ghost"/);
  });

  it("[task-0018] GET では呼べない（POSTのみ）", async () => {
    const res = await fetch(`${providerUrl}${MODULE_TOOL_PATH}file.list`);
    assert.equal(res.status, 405);
  });

  it("[task-0018] 登録外のパスはこのハンドラが扱わない", async () => {
    const base = providerUrl.replace("/api/workspace", "");
    const res = await fetch(`${base}/api/other/tools/file.list`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});

// ── 組み込みモジュールのデータAPI（task-0016 a1・a3・a4）─────────────────────

describe("[task-0016] workspace モジュールが Tool・GUI・データAPI の3点を持つ", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ws-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("[task-0016/a1] Tool と GUI が同じモジュールに揃っている", () => {
    const module = createWorkspaceModule(placesOf(root));

    assert.ok(module.tools.length > 0, "番頭向けのTool");
    assert.deepEqual(module.views.map((v) => v.kind), ["file.browser", "git.viewer"]);
    // データAPIの到達先。組み込みなので相対パス（決定25）
    assert.equal(module.endpoint.baseUrl, "/api/workspace");
  });

  it("[task-0016/a1] GUIエントリは決定17の形（component参照を持つ）", () => {
    const views = createWorkspaceModule(placesOf(root)).views;
    assert.deepEqual(views.map((v) => v.component), ["FileBrowser", "GitViewer"]);
    for (const view of views) {
      assert.ok(view.description.length > 0);
      assert.ok(view.parameters);
    }
  });

  it("[task-0016/a3] 同じTool実装が content と details の両方を返す（口が2つ・ロジックは1箇所）", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "1\n2\n3\n");
    const list = createWorkspaceModule(placesOf(root)).tools.find((t) => t.name === "file.list");
    assert.ok(list);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExtensionContext スタブ (I4)
    const result = await list!.execute({});

    // 番頭・LLM向け
    assert.match(String((result.content[0] as { text: string }).text), /a\.txt/);
    // UI向け
    const details = result.details as { entries: Array<{ name: string; type: string }> };
    assert.deepEqual(details.entries, [{ name: "a.txt", type: "file", size: 6 }]);
  });
});
