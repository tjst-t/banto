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
import { createVaultServer } from "@banto/module-vault-local";
import { createVaultDirectoryServer } from "./server.js";
import { MANAGE_APP_HTML } from "./manage-app.js";
import { MANAGE_APP_URI } from "./manage-app.js";
import type { RelayLike } from "./relay-client.js";

/** 実 Vault を1本以上ぶら下げた、中継の差し替え。 */
/** host が刻む「誰のための呼び出しか」（実運用では中継が付ける）。 */
const ADMIN = { "dev.banto/caller": { admin: true } } as const;
const forProject = (project: string) => ({ "dev.banto/caller": { project } });

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
      // **窓口が backend を呼ぶときも、host が刻む**（実運用では中継の仕事）。
      // 窓口は人の管理面として横断するので、ここは admin
      const result = await client.callTool({ name, arguments: args, _meta: ADMIN });
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
    // 既定は「人が管理画面から触っている」。Project からの見え方は明示して確かめる
    const rawCall = ui.callTool.bind(ui);
    ui.callTool = ((params: Record<string, unknown>, ...rest: unknown[]) =>
      rawCall({ _meta: ADMIN, ...params } as never, ...(rest as []))) as typeof ui.callTool;
    const rawRead = ui.readResource.bind(ui);
    ui.readResource = ((params: Record<string, unknown>, ...rest: unknown[]) =>
      rawRead({ _meta: ADMIN, ...params } as never, ...(rest as []))) as typeof ui.readResource;

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

/** JSON ではない戻り（公開鍵など）をそのまま読む。 */
function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}

test("窓口の面は3段に分かれている——AI には1本と目録だけ", async () => {
  // **窓口になった**（改訂・2026-09-12）。以前は全部 admin（人専用）だったが、
  // backend が2本になって「AI にはどちらの requestAlias？」が現実の問題に
  // なったので、**A 面は窓口が1本だけ持つ**（backend 側は module に降格）。
  const expected: Record<string, string> = {
    requestAlias: "agent", // 秘密が無いとき、人に登録を頼む
    // **公開鍵は秘密ではない**（追加・2026-09-13）——相手方に登録するための
    // ものなので AI が読めてよい。秘密鍵は通らない
    getPublicKey: "agent",
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
    assert.deepEqual(agentTools.map((t) => t.name).sort(), ["getPublicKey", "requestAlias"]);

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
        arguments: { implementation: "vault", name: "a1", kind: "secret", value: "v" },
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
        arguments: { implementation: "vault-keychain", name: "where", kind: "secret", value: "v" },
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
        arguments: { implementation: "vault", name: "dup", kind: "secret", value: "v1" },
      });
      await assert.rejects(
        () =>
          ui.callTool({
            name: "createAlias",
            arguments: { implementation: "vault-keychain", name: "dup", kind: "secret", value: "v2" },
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
      arguments: { name: "only-one", kind: "secret", value: "v" },
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
        arguments: { implementation: "vault", name: "a-in-sops", kind: "secret", value: "v1" },
      });
      await ui.callTool({
        name: "createAlias",
        arguments: {
          implementation: "vault-keychain",
          name: "b-in-keychain",
          kind: "secret",
          forProject: "proj-1",
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
        arguments: { implementation: "vault", name: "alive", kind: "secret", value: "v" },
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
          arguments: { implementation: "どこかの vault", name: "x", kind: "secret", value: "v" },
        }),
      /vault を名乗っていないか/,
    );
  });
});

test("用途の書き直しと削除が、実 Vault まで届く", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { implementation: "vault", name: "t", kind: "secret", value: "v", note: "最初" },
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
    assert.deepEqual(bindings.projects, []);
    // **共通グループも紐付けとして見える**（追加・2026-09-13）
    assert.equal(bindings.shared, "instance");

    await ui.callTool({
      name: "setGroupBinding",
      arguments: { implementation: "vault", projectId: "proj-9", group: "shared-team" },
    });
    ({ groups, bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault" } })));
    assert.deepEqual(bindings.projects, [{ projectId: "proj-9", group: "shared-team" }]);

    // 紐付けたグループに、その Project の alias が入る（実 Vault 側で確かめる）
    await ui.callTool({
      name: "createAlias",
      arguments: {
        implementation: "vault",
        name: "for-proj-9",
        kind: "secret",
        forProject: "proj-9",
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
        arguments: { implementation: "vault", name: "gh-id", kind: "ssh-identity" },
      }),
    );
    assert.match(made.publicKey, /^ssh-ed25519 /);
    // **窓口でも backend でも、同じ形で返る**（規則3——包むと、会話の中の
    // 入力欄には公開鍵が「無い」ように見える。実際そうなっていた）
    assert.equal(made.created, undefined, "backend の返事を包んでいる");
    assert.equal(made.name, "gh-id");
    assert.equal(JSON.stringify(made).includes("PRIVATE KEY"), false, "秘密鍵が返っている");

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    assert.equal(aliases.find((a: any) => a.name === "gh-id").kind, "ssh-identity");
  });
});

// **窓口も絞る**（決定・2026-09-13）。backend の `listAliases` は人の管理面
// なので**全部返す**——窓口がそれをそのまま AI に渡したら、backend 側の
// 制限は素通りになる。横断して見せるのが窓口の仕事なら、絞るのも窓口の仕事。
test("横断した目録は、その Project から使えるものだけ（backend の制限を素通りさせない）", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "a-only", kind: "secret", forProject: "proj-a", value: "v" },
      });
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-keychain", name: "for-all", kind: "secret", value: "v" },
      });

      const seenBy = async (project: string) =>
        (
          JSON.parse(
            (
              (await ui.readResource({ uri: "vault://aliases", _meta: forProject(project) }))
                .contents as { text: string }[]
            )[0]!.text,
          ) as Array<{ name: string }>
        ).map((a) => a.name);

      assert.deepEqual((await seenBy("proj-a")).sort(), ["a-only", "for-all"]);
      assert.deepEqual(await seenBy("proj-b"), ["for-all"]);
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

test("在りかも、使えない Project には教えない", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { implementation: "vault", name: "a-only", kind: "secret", forProject: "proj-a", value: "v" },
    });
    const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "a-only" }, _meta: forProject("proj-a") }));
    assert.equal(found.implementation, "vault");
    await assert.rejects(
      () => ui.callTool({ name: "lookupAlias", arguments: { name: "a-only" }, _meta: forProject("proj-b") }),
      /どの Vault にもありません/,
    );
  });
});

test("共通グループは窓口から選べる——backend ごとに決まる", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({ name: "setSharedGroup", arguments: { implementation: "vault", group: "team-shared" } });
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault", name: "s1", kind: "secret", value: "v" },
      });
      const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
      const mine = aliases.find((a: { name: string }) => a.name === "s1");
      assert.equal(mine.group, "team-shared");
      assert.equal(mine.scope, "shared");

      const { bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault" } }));
      assert.equal(bindings.shared, "team-shared");
      // **もう片方の backend は影響を受けない**——共通グループは backend ごと
      const other = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-keychain" } }));
      assert.equal(other.bindings.shared, "instance");
    },
    { vaultNames: ["vault", "vault-keychain"] },
  );
});

// **登録画面は2枚ある**（会話の中の入力欄と、この管理 Canvas）。同じ規則を
// 2箇所に書いていたせいで片方だけ直り、**管理画面では鍵ペアなのに「作る強さ」が
// 出たまま**だった（2026-09-13、ユーザー報告）。規則は `@banto/vault-kit` の
// 1枚に集めたので、こちらも**それを使っていること**を押さえる（規則3）。
test("管理画面も、種別ごとの規則を共有の表から引いている", () => {
  assert.ok(MANAGE_APP_HTML.includes("const ALIAS_KIND_RULES ="), "共有の表が埋め込まれていない");
  assert.ok(MANAGE_APP_HTML.includes("kindRule("), "表を使っていない（直書きに戻っている）");
  assert.ok(MANAGE_APP_HTML.includes("generatableKinds("), "作れる種別を直書きしている");
  // **CSS が hidden を殺していないこと**——これが元の不具合そのもの
  assert.ok(
    MANAGE_APP_HTML.includes("[hidden] { display: none !important; }"),
    "[hidden] を効かせる規則が無い（.field の display に負けて何も隠れない）",
  );
});

// **公開鍵は秘密ではない**（追加・2026-09-13、ユーザー指摘「公開鍵は AI に
// 見せてもいいはず。その口は作らない？」）。作った直後の1回しか返して
// いなかったので、画面を閉じたら二度と見られなかった。
test("公開鍵は AI からも読める——秘密鍵は通らない、使えない Project には出さない", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "generateSecret",
      arguments: { implementation: "vault", name: "deploy-key", kind: "ssh-identity", forProject: "proj-a" },
    });

    const pub = textOf(
      await ui.callTool({ name: "getPublicKey", arguments: { name: "deploy-key" }, _meta: forProject("proj-a") }),
    );
    assert.match(pub, /^ssh-ed25519 AAAA/);
    // **何度でも読める**（作った直後の1回きりではない）
    assert.equal(
      textOf(await ui.callTool({ name: "getPublicKey", arguments: { name: "deploy-key" }, _meta: forProject("proj-a") })),
      pub,
    );
    assert.equal(pub.includes("PRIVATE KEY"), false, "秘密鍵が混ざっている");

    // 使える範囲は他の口と揃っている
    await assert.rejects(
      () => ui.callTool({ name: "getPublicKey", arguments: { name: "deploy-key" }, _meta: forProject("proj-b") }),
      /どの Vault にもありません/,
    );
  });
});
