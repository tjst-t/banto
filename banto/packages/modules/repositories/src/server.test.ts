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
import { createRepositoriesServer, type RepositoriesServerDeps } from "./server.js";
import type { ProjectsSource } from "./relay-client.js";
import { GITHUB_COM, httpGithub } from "./github.js";
import { MemoryVault, RecordingNotices } from "./test-fakes.js";
import type { ProjectSummary } from "./repositories.js";

const ADMIN = { [CALLER_META_KEY]: { admin: true }, [CALL_ID_META_KEY]: "call-1" };

async function withServer(
  projects: ProjectsSource,
  fn: (c: Client, w: { home: string; repo: string }) => Promise<void>,
  extra: Partial<RepositoriesServerDeps> = {},
): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-server-")));
  const repo = join(home, "kakeibo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/tjst-t/kakeibo.git"], { cwd: repo });
  const server = createRepositoriesServer({
    dataDir: join(home, ".data"),
    projects,
    home,
    vault: new MemoryVault(),
    // 段階1の試験は GitHub に繋がない（繋いだら本物へ行ってしまうので、繋ぐ試験は偽物を渡す）
    github: httpGithub(GITHUB_COM),
    notices: new RecordingNotices(),
    ...extra,
  });
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
      dependsOn: [
        { role: "vault-directory", required: false },
        { role: "vault", required: false },
      ],
      isolation: "subprocess",
      scope: "instance",
      handlesSecrets: true,
    });
    for (const uri of ["ui://banto-repositories/list", "ui://banto-repositories/settings"]) {
      const { contents } = await client.readResource({ uri });
      assert.equal(contents[0]!.mimeType, "text/html;profile=mcp-app");
      assert.match(String((contents[0] as { text: string }).text), /リポジトリ/);
    }
  });
});

test("アカウントの口：PAT とブラウザでログインが画面の口から通り、返る値に秘密が入らない。Vault には呼び出しの印を渡す", async () => {
  const { startFakeGithub, FAKE_CLIENT_ID } = await import("./test-fakes.js");
  const gh = await startFakeGithub();
  const vault = new MemoryVault();
  const slept: number[] = [];
  try {
    await withServer(
      { listProjects: async () => [] },
      async (client, w) => {
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const r = await client.callTool({ name, arguments: args, _meta: ADMIN });
          assert.ok(!isError(r), `${name}: ${textOf(r)}`);
          return { text: textOf(r), body: JSON.parse(textOf(r)) };
        };
        gh.users.set("ghp_server_pat", "tjst-t");
        const results: string[] = [];
        const added = await call("add_github_account_with_pat", { pat: "ghp_server_pat" });
        results.push(added.text);
        assert.equal(added.body.login, "tjst-t");

        // ブラウザでログイン：client ID が無いと断る→入れる→始める→待つ→登録
        const noClient = await client.callTool({ name: "start_github_login", arguments: {}, _meta: ADMIN });
        assert.ok(isError(noClient));
        assert.match(textOf(noClient), /client ID が設定されていません/);
        await call("set_github_app_client_id", { clientId: FAKE_CLIENT_ID });
        gh.loginForDevice = "octo-bot";
        gh.script = ["pending", "authorized"];
        const start = await call("start_github_login");
        results.push(start.text);
        assert.equal(start.body.userCode, "WDJB-MJHT");
        const first = await call("poll_github_login", { flowId: start.body.flowId });
        assert.equal(first.body.state, "pending");
        const done = await call("poll_github_login", { flowId: start.body.flowId });
        results.push(first.text, done.text);
        assert.equal(done.body.state, "done");
        // 待ちは本物の時計（ここは間隔を守っているかだけ見る——細かい順は accounts.test）
        assert.equal(slept.length, 2);
        assert.ok(slept.every((ms) => ms > 4_000 && ms <= 5_000), `interval（5秒）どおりに待っていない：${slept.join(",")}`);

        const listed = await call("list_github_accounts");
        results.push(listed.text);
        assert.deepEqual(listed.body.accounts.map((a: { login: string }) => a.login), ["tjst-t", "octo-bot"]);
        assert.equal(listed.body.appClientId, FAKE_CLIENT_ID);
        const verified = await call("verify_github_account", { login: "octo-bot" });
        results.push(verified.text);
        assert.deepEqual(verified.body, { login: "octo-bot" });
        const choices = await call("list_credential_aliases");
        results.push(choices.text);
        assert.deepEqual(choices.body.secrets.map((a: { name: string }) => a.name), ["github-tjst-t-pat"]);

        // 台帳の一覧にもアカウントが出る（kakeibo の持ち主は tjst-t）
        await call("import_repository", { path: w.repo });
        const listing = await call("list_repositories");
        assert.deepEqual(listing.body.rows[0].account, { login: "tjst-t", registered: true });

        const removed = await call("remove_github_account", { login: "octo-bot" });
        results.push(removed.text);
        assert.equal(removed.body.loginRemoved, true);

        for (const secret of ["ghp_server_pat", ...gh.users.keys(), ...gh.refreshTokens.keys()]) {
          assert.ok(!results.join("\n").includes(secret), `画面に返す値に秘密（${secret.slice(0, 8)}…）が入った`);
        }
        assert.ok(vault.calls.length > 0);
        assert.ok(vault.calls.every((c) => c.callId === "call-1"), `Vault に呼び出しの印を渡していない：${JSON.stringify(vault.calls)}`);

        // AI のターン（Project の刻印）からは呼べない
        const turn = await client.callTool({ name: "list_github_accounts", arguments: {}, _meta: { [CALLER_META_KEY]: { project: "p1" } } });
        assert.ok(isError(turn));
      },
      {
        vault,
        github: httpGithub(gh.endpoints),
        sleep: async (ms) => void slept.push(ms),
      },
    );
  } finally {
    await gh.close();
  }
});
