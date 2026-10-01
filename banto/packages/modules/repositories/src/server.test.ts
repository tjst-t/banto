// Module の口：人の操作だけを受ける・Project の一覧は中継から呼び出しの印つきで引く・画面と申告を名乗る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CALLER_META_KEY, CALL_ID_META_KEY, CANVAS_META_KEY, MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { createRepositoriesServer } from "./server.js";
import type { ProjectsSource } from "./relay-client.js";
import type { ProjectSummary } from "./repositories.js";

const ADMIN = { [CALLER_META_KEY]: { admin: true }, [CALL_ID_META_KEY]: "call-1" };

async function withServer(
  projects: ProjectsSource,
  fn: (c: Client, w: { home: string; repo: string }) => Promise<void>,
): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-server-")));
  const repo = join(home, "kakeibo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/tjst-t/kakeibo.git"], { cwd: repo });
  const server = createRepositoriesServer({ dataDir: join(home, ".data"), projects, home });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    await fn(client, { home, repo });
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

test("道具はどれも人の画面からだけ——可視性は admin、刻印の無い呼び出しは断る", async () => {
  const seen: Array<string | undefined> = [];
  await withServer({ listProjects: async (id) => (seen.push(id), []) }, async (client, w) => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    for (const t of tools) assert.equal((t._meta as Record<string, unknown>)[VISIBILITY_META_KEY], "admin", t.name);

    // 刻印が無い（AI のターン・Module 間）——断る。台帳は書かない
    const refused = await client.callTool({ name: "import_repository", arguments: { path: w.repo } });
    assert.ok(isError(refused));
    assert.match(textOf(refused), /人の操作からだけ/);
    const turn = await client.callTool({ name: "list_repositories", arguments: {}, _meta: { [CALLER_META_KEY]: { project: "p1" } } });
    assert.ok(isError(turn));
    assert.deepEqual(seen, [], "断ったのに Project の一覧を引きに行った");
  });
});

test("一覧は Project の一覧を呼び出しの印つきで引く——引けなければ理由を添えて一覧は出す", async () => {
  const seen: Array<string | undefined> = [];
  let projects: ProjectSummary[] | Error = [];
  const source: ProjectsSource = {
    listProjects: async (id) => {
      seen.push(id);
      if (projects instanceof Error) throw projects;
      return projects;
    },
  };
  await withServer(source, async (client, w) => {
    const added = await client.callTool({ name: "import_repository", arguments: { path: "~/kakeibo" }, _meta: ADMIN });
    assert.ok(!isError(added), textOf(added));

    projects = [{ id: "p1", name: "家計簿", root: w.repo, status: "active" }];
    const listing = JSON.parse(textOf(await client.callTool({ name: "list_repositories", arguments: {}, _meta: ADMIN })));
    assert.deepEqual(seen, ["call-1"], "中継へ呼び出しの印を渡していない（人の画面からの呼び出しだと分からない）");
    assert.equal(listing.rows[0].section, "used");
    assert.deepEqual(listing.rows[0].projects, [{ id: "p1", name: "家計簿", closed: false, viaWorktree: false }]);

    projects = new Error("banto 自身のコード（同梱）だけが引ける");
    const degraded = JSON.parse(textOf(await client.callTool({ name: "list_repositories", arguments: {}, _meta: ADMIN })));
    assert.equal(degraded.projectsError, "banto 自身のコード（同梱）だけが引ける");
    assert.equal(degraded.rows.length, 1);
    assert.equal(degraded.rows[0].section, "unknown");
  });
});

test("外す・元に戻す・置き場の設定が、画面の口から通る", async () => {
  await withServer({ listProjects: async () => [] }, async (client, w) => {
    await client.callTool({ name: "import_repository", arguments: { path: w.repo }, _meta: ADMIN });
    const removed = JSON.parse(textOf(await client.callTool({ name: "remove_repository", arguments: { path: w.repo }, _meta: ADMIN })));
    assert.deepEqual(removed.removed, { path: w.repo, github: { owner: "tjst-t", name: "kakeibo" } });
    const empty = JSON.parse(textOf(await client.callTool({ name: "list_repositories", arguments: {}, _meta: ADMIN })));
    assert.deepEqual(empty.rows, []);
    const restored = await client.callTool({ name: "restore_repository", arguments: { entry: removed.removed }, _meta: ADMIN });
    assert.ok(!isError(restored), textOf(restored));

    const bad = await client.callTool({ name: "set_repository_home", arguments: { repoHome: "~" }, _meta: ADMIN });
    assert.ok(isError(bad));
    assert.match(textOf(bad), /ホームや \/ をそのまま置き場にはできません/);
    const set = JSON.parse(textOf(await client.callTool({ name: "set_repository_home", arguments: { repoHome: "~/code" }, _meta: ADMIN })));
    assert.equal(set.repoHome, "~/code");
    const reset = JSON.parse(textOf(await client.callTool({ name: "set_repository_home", arguments: { repoHome: null }, _meta: ADMIN })));
    assert.deepEqual([reset.repoHome, reset.isDefault], ["~/banto", true]);
  });
});

test("入口（launcher）と設定の面を名乗り、banto 全体の Module だと申告する", async () => {
  await withServer({ listProjects: async () => [] }, async (client) => {
    const { resources } = await client.listResources();
    const byKind = (kind: string) => resources.filter((r) => (r._meta as Record<string, unknown> | undefined)?.[CANVAS_META_KEY] === kind);
    assert.deepEqual(byKind("launcher").map((r) => r.uri), ["ui://banto-repositories/list"]);
    assert.deepEqual(byKind("config").map((r) => r.uri), ["ui://banto-repositories/settings"]);
    const report = resources.find((r) => (r._meta as Record<string, unknown> | undefined)?.[MODULE_META_KEY]);
    assert.deepEqual((report!._meta as Record<string, unknown>)[MODULE_META_KEY], {
      satisfies: ["repositories"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
    });
    for (const uri of ["ui://banto-repositories/list", "ui://banto-repositories/settings"]) {
      const { contents } = await client.readResource({ uri });
      assert.equal(contents[0]!.mimeType, "text/html;profile=mcp-app");
      assert.match(String((contents[0] as { text: string }).text), /リポジトリ/);
    }
  });
});
