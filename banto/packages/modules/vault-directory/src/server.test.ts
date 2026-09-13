// vault-directory の横断（docs/specs/v4-modules.md §2.1 C節）を、**本物の Vault を
// 相手にして**見る。中継だけを差し替える（HTTP まで持ち込まない）——
// 相手を作り物にすると「繋がっていないのに通る」試験になる（規則1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultServer } from "@banto/module-vault";
import { createVaultDirectoryServer } from "./server.js";
import { MANAGE_APP_URI } from "./manage-app.js";
import type { RelayLike } from "./relay-client.js";

/** 実 Vault を1本以上ぶら下げた、中継の差し替え。 */
function relayTo(vaults: Map<string, Client>, broken: Map<string, string> = new Map()): RelayLike {
  return {
    async listTargets() {
      return [...[...vaults.keys()], ...broken.keys()].map((name) => ({ name, roles: ["vault"] }));
    },
    async callTool(targetModule, name, args) {
      const failure = broken.get(targetModule);
      if (failure) throw new Error(failure);
      const client = vaults.get(targetModule);
      if (!client) throw new Error(`unknown target: ${targetModule}`);
      const result = await client.callTool({ name, arguments: args });
      return (result.content as { text: string }[])[0]!.text;
    },
  };
}

interface Ctx {
  ui: Client;
  vaults: Map<string, Client>;
}

async function withUi(
  fn: (ctx: Ctx) => Promise<void>,
  opts: { vaultNames?: string[]; broken?: Map<string, string> } = {},
): Promise<void> {
  const dirs: string[] = [];
  const vaults = new Map<string, Client>();
  try {
    for (const name of opts.vaultNames ?? ["vault"]) {
      const dir = await mkdtemp(join(tmpdir(), "banto-vault-directory-test-"));
      dirs.push(dir);
      const server = createVaultServer(dir);
      const [s, c] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "host", version: "0.0.0" });
      await Promise.all([server.connect(s), client.connect(c)]);
      // **立ち上がりを待ってから先へ進む**。Vault は接続した時点で鍵の用意
      // （age-keygen）を始めるので、待たずに片づけると置き場を消しながら
      // 走らせることになる——試験が本体と競走して落ちる
      await client.listTools();
      vaults.set(name, client);
    }

    const uiServer = createVaultDirectoryServer({ relay: relayTo(vaults, opts.broken) });
    const [us, uc] = InMemoryTransport.createLinkedPair();
    const ui = new Client({ name: "canvas", version: "0.0.0" });
    await Promise.all([uiServer.connect(us), ui.connect(uc)]);

    await fn({ ui, vaults });
    await ui.close();
    for (const client of vaults.values()) await client.close();
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}

function parse(result: unknown): any {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

test("窓口の面は3段に分かれている——AI には1本と目録だけ", async () => {
  // **窓口になった**（改訂・2026-09-12）。以前は全部 admin（人専用）だったが、
  // backend が2本になって「AI にはどちらの requestAlias？」が現実の問題に
  // なったので、**A 面は窓口が1本だけ持つ**（backend 側は module に降格）。
  const expected: Record<string, string> = {
    requestAlias: "agent", // AI に見せるのはこれだけ
    lookupAlias: "module", // 名前 → 在りか（値は返さない）
  };
  await withUi(async ({ ui }) => {
    const { tools } = await ui.listTools();
    assert.ok(tools.length > 0);
    for (const t of tools) {
      const visibility = (t._meta as Record<string, unknown> | undefined)?.["dev.banto/visibility"];
      assert.equal(visibility, expected[t.name] ?? "admin", `${t.name} の可視性が違う`);
    }
    // **AI に見せる道具は1本だけ**——2本目が紛れ込んでいないこと
    const agentTools = tools.filter(
      (t) => (t._meta as Record<string, unknown> | undefined)?.["dev.banto/visibility"] === "agent",
    );
    assert.deepEqual(agentTools.map((t) => t.name), ["requestAlias"]);

    // `handlesSecrets: true` の Module は、**全ての資源にも**明示の可視性が要る
    const { resources } = await ui.listResources();
    for (const r of resources) {
      const visibility = (r._meta as Record<string, unknown> | undefined)?.["dev.banto/visibility"];
      assert.ok(visibility, `${r.uri} に可視性が無い（host が繋がない）`);
    }
    // AI に見せる資源は、横断した目録と入力欄だけ
    const agentResources = resources
      .filter((r) => (r._meta as Record<string, unknown> | undefined)?.["dev.banto/visibility"] === "agent")
      .map((r) => r.uri)
      .sort();
    assert.deepEqual(agentResources, ["ui://banto-vault-directory/request", "vault://aliases"]);
  });
});

test("横断した目録には、どの Vault のものかを載せない（AI に選ばせない）", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "a1", kind: "secret", scope: "instance", value: "v" },
      });
      const read = await ui.readResource({ uri: "vault://aliases" });
      const list = JSON.parse((read.contents as { text: string }[])[0]!.text) as Array<Record<string, unknown>>;
      assert.equal(list.length, 1);
      assert.equal(list[0]!.name, "a1");
      assert.equal(list[0]!.implementation, undefined, "AI に金庫を選ぶ材料を渡している");
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

test("lookupAlias は在りかを返す——値は返さない。同名が2つなら通さない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-keychain", name: "where", kind: "secret", scope: "instance", value: "v" },
      });
      const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "where" } }));
      assert.equal(found.implementation, "vault-keychain");
      assert.equal(found.kind, "secret");
      assert.equal(JSON.stringify(found).includes("\"v\""), false, "値が返っている");

      await assert.rejects(
        () => ui.callTool({ name: "lookupAlias", arguments: { name: "無い名前" } }),
        /どの Vault にもありません/,
      );
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

test("同じ名前は2つ作らせない——名前で引く以上、一意でなければ決められない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "dup", kind: "secret", scope: "instance", value: "v1" },
      });
      await assert.rejects(
        () =>
          ui.callTool({
            name: "createAlias",
            arguments: { implementation: "vault-keychain", name: "dup", kind: "secret", scope: "instance", value: "v2" },
          }),
        /既に vault にあります/,
      );
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

test("実装が1本しか無いときは、どこに入れるか聞かない", async () => {
  await withUi(async ({ ui }) => {
    // `implementation` を渡さなくても通る（選択肢が1つのときに選ばせない）
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "only-one", kind: "secret", scope: "instance", value: "v" },
    });
    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    assert.equal(aliases[0].name, "only-one");
  });
});

test("入口（launcher）として名乗っていて、中身が読める", async () => {
  await withUi(async ({ ui }) => {
    const { resources } = await ui.listResources();
    const canvas = resources.find((r) => r.uri === MANAGE_APP_URI);
    assert.ok(canvas, "管理画面の資源が無い");
    assert.equal((canvas._meta as Record<string, unknown>)["dev.banto/canvas"], "launcher");
    assert.match(String(canvas.mimeType), /profile=mcp-app/);

    const read = await ui.readResource({ uri: MANAGE_APP_URI });
    const html = (read.contents as { text: string }[])[0]!.text;
    assert.match(html, /Vault を管理/);
    // **値を出す作りになっていない**ことの最低限の確認
    assert.ok(!html.includes("resolveAlias"), "画面が値を取る tool を呼ぼうとしている");
  });
});

test("横断：2本の Vault の alias が、どちらの backend のものか分かる形で1つの一覧になる", async () => {
  await withUi(
    async ({ ui }) => {
      assert.deepEqual(parse(await ui.callTool({ name: "listVaults", arguments: {} })), [
        "vault",
        "vault-keychain",
      ]);

      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "a-in-sops", kind: "secret", scope: "instance", value: "v1" },
      });
      await ui.callTool({
        name: "createAlias",
        arguments: {
          implementation: "vault-keychain",
          name: "b-in-keychain",
          kind: "secret",
          scope: "project",
          projectId: "proj-1",
          value: "v2",
          note: "CI 用",
        },
      });

      const { aliases, failures } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
      assert.deepEqual(failures, []);
      assert.deepEqual(
        aliases.map((a: any) => [a.implementation, a.name]).sort(),
        [
          ["vault", "a-in-sops"],
          ["vault-keychain", "b-in-keychain"],
        ],
      );
      // **値は一度も出てこない**（§2.1 A/C——画面に出るのは存在と用途まで）
      assert.equal(JSON.stringify(aliases).includes("v1"), false);
      assert.equal(JSON.stringify(aliases).includes("v2"), false);
      assert.equal(aliases.find((a: any) => a.name === "b-in-keychain").note, "CI 用");
      // backend 内のパスも漏れない
      assert.equal(aliases.some((a: any) => a.backendPath !== undefined), false);
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

test("読めない backend があっても、読めたぶんは出す——ただし黙って消さない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "alive", kind: "secret", scope: "instance", value: "v" },
      });
      const { aliases, failures } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
      assert.deepEqual(
        aliases.map((a: any) => a.name),
        ["alive"],
      );
      assert.equal(failures.length, 1, "落ちている backend が結果に残っていない");
      assert.equal(failures[0].implementation, "vault-dead");
      assert.match(failures[0].error, /繋がっていない/);
    },
    { vaultNames: ["vault"], broken: new Map([["vault-dead", "プロセスが繋がっていない"]]) },
  );
});

test("名乗っていない実装は宛先にできない（fail closed）", async () => {
  await withUi(async ({ ui }) => {
    await assert.rejects(
      () =>
        ui.callTool({
          name: "createAlias",
          arguments: { implementation: "どこかの vault", name: "x", kind: "secret", scope: "instance", value: "v" },
        }),
      /vault を名乗っていないか/,
    );
  });
});

test("用途の書き直しと削除が、実 Vault まで届く", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { implementation: "vault", name: "t", kind: "secret", scope: "instance", value: "v", note: "最初" },
    });

    await ui.callTool({ name: "updateAlias", arguments: { implementation: "vault", name: "t", note: "書き直した" } });
    let { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    assert.equal(aliases[0].note, "書き直した");

    await ui.callTool({ name: "deleteAlias", arguments: { implementation: "vault", name: "t" } });
    ({ aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} })));
    assert.deepEqual(aliases, []);
  });
});

test("Project ↔ グループの紐付けを、画面から読んで変えられる", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault", name: "shared-team" } });
    let { groups, bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault" } }));
    assert.ok(groups.includes("shared-team"));
    assert.deepEqual(bindings, []);

    await ui.callTool({
      name: "setGroupBinding",
      arguments: { implementation: "vault", projectId: "proj-9", group: "shared-team" },
    });
    ({ groups, bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault" } })));
    assert.deepEqual(bindings, [{ projectId: "proj-9", group: "shared-team" }]);

    // 紐付けたグループに、その Project の alias が入る（実 Vault 側で確かめる）
    await ui.callTool({
      name: "createAlias",
      arguments: {
        implementation: "vault",
        name: "for-proj-9",
        kind: "secret",
        scope: "project",
        projectId: "proj-9",
        value: "v",
      },
    });
    ({ groups } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault" } })));
    assert.ok(!groups.includes("proj-9"), "紐付けを無視して、既定のグループを作っている");
  });
});

test("vault-directory からも SSH 鍵を作れる——公開鍵だけが返る", async () => {
  // 「作る」の入口を1つにした結果（2026-09-12）、横断管理の画面からも
  // そのまま SSH の身元を作れるようになった
  await withUi(async ({ ui }) => {
    const made = parse(
      await ui.callTool({
        name: "generateSecret",
        arguments: { implementation: "vault", name: "gh-id", kind: "ssh-identity", scope: "instance" },
      }),
    );
    assert.equal(made.ok, true);
    assert.match(made.created.publicKey, /^ssh-ed25519 /);
    assert.equal(JSON.stringify(made).includes("PRIVATE KEY"), false, "秘密鍵が返っている");

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    assert.equal(aliases.find((a: any) => a.name === "gh-id").kind, "ssh-identity");
  });
});
