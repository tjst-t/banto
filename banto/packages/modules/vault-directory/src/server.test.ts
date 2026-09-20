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
import { CONFIG_APP_HTML } from "./config-app.js";
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
  opts: { vaultNames?: string[]; broken?: Map<string, string>; dataDir?: string } = {},
): Promise<void> {
  const dirs: string[] = [];
  const vaults = new Map<string, Client>();
  try {
    for (const name of opts.vaultNames ?? ["vault-local"]) {
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

    const uiServer = createVaultDirectoryServer({
      relay: relayTo(vaults, opts.broken),
      dataDir: opts.dataDir,
    });
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
        arguments: { implementation: "vault-local", name: "a1", kind: "secret", value: "v" },
      });
      const read = await ui.readResource({ uri: "vault://aliases" });
      // **形は { aliases, warning? }**（改訂・2026-09-15）——読めない金庫が
      // あっても読める分は返す
      const list = (JSON.parse((read.contents as { text: string }[])[0]!.text) as {
        aliases: Array<Record<string, unknown>>;
      }).aliases;
      assert.equal(list.length, 1);
      assert.equal(list[0]!.name, "a1");
      assert.equal(list[0]!.implementation, undefined, "AI に金庫を選ぶ材料を渡している");
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

test("lookupAlias は在りかを返す——値は返さない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-keychain", name: "where", kind: "secret", value: "v" },
      });
      const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "vault-keychain:where" } }));
      assert.equal(found.implementation, "vault-keychain");
      assert.equal(found.kind, "secret");
      assert.equal(JSON.stringify(found).includes('"v"'), false, "値が返っている");

      await assert.rejects(
        () => ui.callTool({ name: "lookupAlias", arguments: { name: "無い名前" } }),
        /どの Vault にもありません/,
      );
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

// **同じ名前が2つあっても止まらない**（改訂・2026-09-13、設計し直し）。
// 素の名前で引けるのは「この Project のもの」と「共通の**既定の**もの」だけ。
// それ以外は修飾名でだけ引ける——**候補が複数になる状態が構造的に消えた**。
test("同じ名前が2つあっても決まる——既定が素の名前、もう一方は修飾名", async () => {
  await withUi(
    async ({ ui }) => {
      // 既定（vault-local）の共通グループと、もう一方の共通グループに同じ名前
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "TOKEN", kind: "secret", value: "from-default" },
      });
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-keychain", name: "TOKEN", kind: "secret", value: "from-other" },
      });

      // 素の名前 → 既定のほう
      assert.equal(
        parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "TOKEN" }, _meta: forProject("p") }))
          .implementation,
        "vault-local",
      );
      // 修飾名 → そちらを直に指す
      assert.equal(
        parse(
          await ui.callTool({ name: "lookupAlias", arguments: { name: "vault-keychain:TOKEN" }, _meta: forProject("p") }),
        ).implementation,
        "vault-keychain",
      );

      // **一覧に出る名前が、そのまま使える名前**
      const seen = (
        JSON.parse(
          ((await ui.readResource({ uri: "vault://aliases", _meta: forProject("p") })).contents as { text: string }[])[0]!
            .text,
        ) as { aliases: Array<{ name: string }> }
      ).aliases.map((a) => a.name);
      assert.deepEqual(seen.sort(), ["TOKEN", "vault-keychain:TOKEN"]);
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

test("Project のものが、共通の既定に勝つ", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "shared" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", forProject: "p", group: "p-group", value: "project" },
    });
    await ui.callTool({ name: "setGroupBinding", arguments: { projectId: "p", group: "p-group" } });

    const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "TOKEN" }, _meta: forProject("p") }));
    assert.equal(found.group, "p-group", "共通のほうが勝っている（狭い文脈が負けている）");
    // 別の Project からは共通のほうが見える
    const other = parse(
      await ui.callTool({ name: "lookupAlias", arguments: { name: "TOKEN" }, _meta: forProject("q") }),
    );
    assert.equal(other.group, "instance");
  });
});

test("同じ置き場に同じ名前は作らせない——別のグループなら作れる", async () => {
  // **名前は全体で一意ではなくなった**（改訂・2026-09-13）。素の名前と修飾名で
  // 引き分けられるので、同じ名前が別のグループに在るのは正しい状態。
  // 作れないのは**同じ置き場**だけ——そこは backend のキーがぶつかる
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "dup", kind: "secret", value: "v1" },
      });
      // 別の Vault なら作れる（修飾名で引き分く）
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-keychain", name: "dup", kind: "secret", value: "v2" },
      });
      // 同じ Vault でも、別のグループなら作れる
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "dup", kind: "secret", group: "other", value: "v3" },
      });
      // **同じ置き場は作れない**
      await assert.rejects(
        () =>
          ui.callTool({
            name: "createAlias",
            arguments: { implementation: "vault-local", name: "dup", kind: "secret", value: "v4" },
          }),
        /には既に別の秘密があります/,
      );
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
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
        "vault-local",
        "vault-keychain",
      ]);

      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "a-in-sops", kind: "secret", value: "v1" },
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
          ["vault-keychain", "b-in-keychain"],
          ["vault-local", "a-in-sops"],
        ],
      );
      // **値は一度も出てこない**（§2.1 A/C——画面に出るのは存在と用途まで）
      assert.equal(JSON.stringify(aliases).includes("v1"), false);
      assert.equal(JSON.stringify(aliases).includes("v2"), false);
      assert.equal(aliases.find((a: any) => a.name === "b-in-keychain").note, "CI 用");
      // backend 内のパスも漏れない
      assert.equal(aliases.some((a: any) => a.backendPath !== undefined), false);
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

test("読めない backend があっても、読めたぶんは出す——ただし黙って消さない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "alive", kind: "secret", value: "v" },
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
    { vaultNames: ["vault-local"], broken: new Map([["vault-dead", "プロセスが繋がっていない"]]) },
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
      arguments: { implementation: "vault-local", name: "t", kind: "secret", value: "v", note: "最初" },
    });

    await ui.callTool({ name: "updateAlias", arguments: { implementation: "vault-local", name: "t", note: "書き直した" } });
    let { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    assert.equal(aliases[0].note, "書き直した");

    await ui.callTool({ name: "deleteAlias", arguments: { implementation: "vault-local", name: "t" } });
    ({ aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} })));
    assert.deepEqual(aliases, []);
  });
});

test("Project ↔ グループの紐付けを、画面から読んで変えられる", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "shared-team" } });
    let { groups, bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-local" } }));
    assert.ok(groups.includes("shared-team"));
    assert.deepEqual(bindings.projects, []);
    // **共通グループも紐付けとして見える**（追加・2026-09-13）
    assert.equal(bindings.shared, "instance");

    await ui.callTool({
      name: "setGroupBinding",
      arguments: { implementation: "vault-local", projectId: "proj-9", group: "shared-team" },
    });
    ({ groups, bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-local" } })));
    assert.deepEqual(bindings.projects, [{ projectId: "proj-9", group: "shared-team" }]);

    // 紐付けたグループに、その Project の alias が入る（実 Vault 側で確かめる）
    await ui.callTool({
      name: "createAlias",
      arguments: {
        implementation: "vault-local",
        name: "for-proj-9",
        kind: "secret",
        forProject: "proj-9",
        value: "v",
      },
    });
    ({ groups } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-local" } })));
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
        arguments: { implementation: "vault-local", name: "gh-id", kind: "ssh-identity" },
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
        arguments: { implementation: "vault-local", name: "a-only", kind: "secret", forProject: "proj-a", value: "v" },
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
          ) as { aliases: Array<{ name: string }> }
        ).aliases.map((a) => a.name);

      // **既定（vault-local）の外に居る共通のものは、修飾名で出る**
      // （決定・2026-09-13）——一覧に出る名前が、そのまま使える名前
      assert.deepEqual((await seenBy("proj-a")).sort(), ["a-only", "vault-keychain:for-all"]);
      assert.deepEqual(await seenBy("proj-b"), ["vault-keychain:for-all"]);
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

test("在りかも、使えない Project には教えない", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { implementation: "vault-local", name: "a-only", kind: "secret", forProject: "proj-a", value: "v" },
    });
    const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "a-only" }, _meta: forProject("proj-a") }));
    assert.equal(found.implementation, "vault-local");
    await assert.rejects(
      () => ui.callTool({ name: "lookupAlias", arguments: { name: "a-only" }, _meta: forProject("proj-b") }),
      /どの Vault にもありません/,
    );
  });
});

test("共通グループは窓口から選べる——backend ごとに決まる", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({ name: "setSharedGroup", arguments: { implementation: "vault-local", group: "team-shared" } });
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "s1", kind: "secret", value: "v" },
      });
      const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
      const mine = aliases.find((a: { name: string }) => a.name === "s1");
      assert.equal(mine.group, "team-shared");
      assert.equal(mine.scope, "shared");

      const { bindings } = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-local" } }));
      assert.equal(bindings.shared, "team-shared");
      // **もう片方の backend は影響を受けない**——共通グループは backend ごと
      const other = parse(await ui.callTool({ name: "listGroups", arguments: { implementation: "vault-keychain" } }));
      assert.equal(other.bindings.shared, "instance");
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
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
      arguments: { implementation: "vault-local", name: "deploy-key", kind: "ssh-identity", forProject: "proj-a" },
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

// **既定の置き場**（決定・2026-09-13、ユーザーとの設計）。
// これがあるので、画面は毎回「どの Vault に入れるか」を聞かない
// ——決めていないことを人に押し付けない。
test("既定の Vault が、置き場と素の名前の両方を決める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-vd-default-"));
  try {
    await withUi(
      async ({ ui }) => {
        // **既定の既定は vault-local**——黙って外（クラウド）へ出さない
        assert.equal(parse(await ui.callTool({ name: "getDefaultVault", arguments: {} })).vault, "vault-local");

        // 置き場を言わなければ既定へ入る
        await ui.callTool({ name: "createAlias", arguments: { name: "A", kind: "secret", value: "v" } });
        const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
        assert.equal(aliases.find((a: { name: string }) => a.name === "A").implementation, "vault-local");

        // 既定を変えると、置き場も素の名前も変わる
        await ui.callTool({ name: "setDefaultVault", arguments: { vault: "vault-keychain" } });
        await ui.callTool({ name: "createAlias", arguments: { name: "B", kind: "secret", value: "v" } });
        const after = parse(await ui.callTool({ name: "listAliases", arguments: {} })).aliases;
        assert.equal(after.find((a: { name: string }) => a.name === "B").implementation, "vault-keychain");

        // **既定を変えると名前が変わる**（仕様に書いた性質）——A は修飾名になる
        const seen = (
          JSON.parse(
            ((await ui.readResource({ uri: "vault://aliases", _meta: forProject("p") })).contents as {
              text: string;
            }[])[0]!.text,
          ) as { aliases: Array<{ name: string }> }
        ).aliases.map((a) => a.name);
        assert.ok(seen.includes("B"), "新しい既定のものが素の名前で出ていない");
        assert.ok(seen.includes("vault-local:A"), "既定の外のものが修飾名で出ていない");

        // 繋がっていない Vault は既定にできない（居ないものを既定と言い張らない）
        await assert.rejects(
          () => ui.callTool({ name: "setDefaultVault", arguments: { vault: "vault-nowhere" } }),
          /繋がっていません/,
        );
      },
      { vaultNames: ["vault-local", "vault-keychain"], dataDir: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **Project の秘密は1つの Vault にまとめる**（決定・2026-09-13、ユーザー指摘）。
// 1つの Project の秘密を2つの秘密管理に分ける理由が無い。**構造的にそうする**
// ので、Project 層では名前の衝突が起こりえない。
test("同じ Project を2つの Vault に紐付けさせない", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "setGroupBinding",
        arguments: { implementation: "vault-local", projectId: "p1", group: "g1" },
      });
      await assert.rejects(
        () =>
          ui.callTool({
            name: "setGroupBinding",
            arguments: { implementation: "vault-keychain", projectId: "p1", group: "g2" },
          }),
        /既に vault-local に紐付いています/,
      );
      // 別の Project なら、別の Vault に紐付けてよい
      await ui.callTool({
        name: "setGroupBinding",
        arguments: { implementation: "vault-keychain", projectId: "p2", group: "g2" },
      });
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

// **同じ失敗を2度した**（2026-09-14）。置換の範囲を広く取りすぎて、
// **絞り込みのイベント購読を丸ごと消した**——2回とも E2E でしか気づけなかった。
// 画面の JS は型検査が効かないので、**在ることを機械で押さえる**。
test("管理画面の配線が、消えていないこと", () => {
  // 絞り込みが打つそばから効く（2度消している）
  assert.ok(
    MANAGE_APP_HTML.includes('addEventListener("input", renderRows)'),
    "絞り込みのイベント購読が消えている（検索しても絞られない）",
  );
  // **置き場の設定はこの画面に無い**（設定画面と、保存時に決まる形へ移した）
  assert.equal(MANAGE_APP_HTML.includes('id="dlg-groups"'), false, "置き場のダイアログが残っている");
  assert.equal(MANAGE_APP_HTML.includes('id="new-impl"'), false, "登録画面がまだ backend を聞いている");
  // **聞くのは置き場、出すのは範囲**
  assert.ok(MANAGE_APP_HTML.includes('<span>保存先</span>'), "登録画面が保存先を聞いていない");
  assert.ok(MANAGE_APP_HTML.includes('id="new-scope-effect"'), "選んだ結果を出していない");
});

test("窓口が設定画面を名乗る——共通の置き場はそこで決める", async () => {
  await withUi(async ({ ui }) => {
    const { resources } = await ui.listResources();
    const config = resources.find((r) => r.uri === "ui://banto-vault-directory/config");
    assert.ok(config, "設定画面を名乗っていない");
    assert.equal((config._meta as Record<string, unknown>)["dev.banto/canvas"], "config");
    const read = await ui.readResource({ uri: "ui://banto-vault-directory/config" });
    const html = (read.contents as { text: string }[])[0]!.text;
    assert.ok(html.includes("Global の秘密の置き場"), "設定画面の中身が違う");
    // **Project の置き場はここで決めない**——保存したときに決まる
    assert.ok(html.includes("Project ごとの秘密は、ここでは決めません"), "その旨が書かれていない");
  });
});

// 同じ罠を窓口の2枚にも掛ける（`vault-kit` の app-html.test.ts と対）。
test("窓口の画面も、バッククォート混入と capabilities の取り違えをしない", () => {
  for (const [name, html] of [["manage", MANAGE_APP_HTML], ["config", CONFIG_APP_HTML]] as const) {
    assert.equal(html.includes("`"), false, `${name}: バッククォートが混ざっている`);
    if (html.includes("ui/initialize")) {
      assert.ok(html.includes("appCapabilities:"), `${name}: appCapabilities を送っていない`);
    }
  }
});

// ---- 移す（決定・2026-09-14、ユーザー指示）----------------------------------
//
// 置き場を変えるのは**設定ではなく操作**——値が動く。見るのは3つ：
//   1. **値が失われない**（写す → 確かめる → 消す）
//   2. **黙って上書きしない**（1つでもぶつかったら何もしない）
//   3. **移さない選択もできる**——ただし古いものは使えなくなる（unbound）

/** backend に直接聞いて値を確かめる（**窓口は値を返さない**ので）。 */
async function valueOf(vaults: Map<string, Client>, impl: string, name: string, group: string): Promise<string> {
  const r = await vaults.get(impl)!.callTool({
    name: "resolveAlias",
    arguments: { name, group },
    _meta: ADMIN,
  });
  return (r.content as { text: string }[])[0]!.text;
}

test("同じ Vault の中で移す——値は保たれ、置き場だけ変わる", async () => {
  await withUi(async ({ ui, vaults }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "movable", kind: "secret", value: "keep-me", forProject: "p1" },
    });
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "elsewhere" } });
    await ui.callTool({ name: "migrateAlias", arguments: { name: "movable", toGroup: "elsewhere" } });

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const moved = aliases.find((a: { name: string }) => a.name === "movable");
    assert.equal(moved.group, "elsewhere", "置き場が変わっていない");
    // **値は生きている**
    // **値は窓口を通らない**ので、確かめるのは backend に直接聞く
    assert.equal(await valueOf(vaults, "vault-local", "movable", "elsewhere"), "keep-me");
    // **元には残っていない**（1つだけ）
    assert.equal(aliases.filter((a: { name: string }) => a.name === "movable").length, 1);
  });
});

test("Vault をまたいで移せる——値は保たれる", async () => {
  await withUi(
    async ({ ui, vaults }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "cross", kind: "secret", value: "carried" },
      });
      await ui.callTool({
        name: "migrateAlias",
        arguments: { name: "cross", toImplementation: "vault-keychain", toGroup: "instance" },
      });
      const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
      const moved = aliases.find((a: { name: string }) => a.name === "cross");
      assert.equal(moved.implementation, "vault-keychain");
      assert.equal(await valueOf(vaults, "vault-keychain", "cross", "instance"), "carried");
    },
    { vaultNames: ["vault-local", "vault-keychain"] },
  );
});

// 同じ名前が複数の置き場に在るのは普通のこと（Project ごとの TOKEN など）。
// **指定を無視して既定解決に落ちると、一覧で選んだ行とは別の秘密が動く**
// ——実機で踏んだ（2026-09-14）。指定がそのまま効くことを測る
test("移す元を指定したら、その置き場のものだけが動く（同名の別物を動かさない）", async () => {
  await withUi(async ({ ui, vaults }) => {
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "dest" } });
    // 素の名前では p1 のものが引かれる（Project ＞ 共通）
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "in-project", forProject: "p1" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "in-shared", group: "instance" },
    });

    // **共通のほうを**移す
    await ui.callTool({
      name: "migrateAlias",
      arguments: { name: "TOKEN", group: "instance", toGroup: "dest" },
    });

    // 動いたのは共通のほう。Project のものは元の場所に、元の値のまま
    assert.equal(await valueOf(vaults, "vault-local", "TOKEN", "dest"), "in-shared");
    assert.equal(await valueOf(vaults, "vault-local", "TOKEN", "p1"), "in-project");
    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const groups = aliases
      .filter((a: { name: string }) => a.name === "TOKEN")
      .map((a: { group: string }) => a.group)
      .sort();
    assert.deepEqual(groups, ["dest", "p1"], `置き場が想定と違う: ${JSON.stringify(aliases)}`);
  });
});

test("もう その置き場に在るなら、動いたと言わない", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "stay", kind: "secret", value: "v", group: "instance" },
    });
    const r = parse(
      await ui.callTool({ name: "migrateAlias", arguments: { name: "stay", group: "instance", toGroup: "instance" } }),
    );
    assert.equal(r.moved, false, `動いていないのに moved=${r.moved}: ${JSON.stringify(r)}`);
  });
});

test("移す元に無ければ、どこを見たかを言って止まる", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "here", kind: "secret", value: "v", group: "instance" },
    });
    await assert.rejects(
      () => ui.callTool({ name: "migrateAlias", arguments: { name: "here", group: "nowhere", toGroup: "dest" } }),
      /nowhere にありません/,
    );
  });
});

test("移す先に同じ名前があったら、何もしない（黙って上書きしない）", async () => {
  await withUi(async ({ ui, vaults }) => {
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "dest" } });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "mine", forProject: "p1" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "theirs", group: "dest" },
    });

    await assert.rejects(
      () => ui.callTool({ name: "migrateAlias", arguments: { name: "TOKEN", group: "p1", toGroup: "dest" } }),
      /には既に別の秘密があります/,
    );
    // **どちらも無傷**
    assert.equal(await valueOf(vaults, "vault-local", "TOKEN", "dest"), "theirs");
    assert.equal(await valueOf(vaults, "vault-local", "TOKEN", "p1"), "mine");
  });
});

test("置き場を変える前に、何が起きるか分かる（移す対象・衝突・使えなくなるもの）", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "a", kind: "secret", value: "v", forProject: "p1" },
    });
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "next" } });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "a", kind: "secret", value: "other", group: "next" },
    });

    const plan = parse(
      await ui.callTool({
        name: "planProjectPlacement",
        arguments: { projectId: "p1", implementation: "vault-local", group: "next" },
      }),
    );
    assert.deepEqual(plan.current, { implementation: "vault-local", group: "p1" });
    assert.deepEqual(plan.moving, ["a"]);
    // **ぶつかることが、変える前に分かる**
    assert.deepEqual(plan.conflicts, ["a"]);
    // **移さないなら、これが使えなくなる**（黙って使えなくしない）
    assert.deepEqual(plan.strandedIfNotMigrated, ["a"]);
  });
});

test("移行なしで置き場を変えると、古いものは使えなくなる（そう出る）", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "left-behind", kind: "secret", value: "v", forProject: "p1" },
    });
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "fresh" } });
    await ui.callTool({
      name: "setProjectPlacement",
      arguments: { projectId: "p1", implementation: "vault-local", group: "fresh" },
    });

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const left = aliases.find((a: { name: string }) => a.name === "left-behind");
    // **値は消えていない。ただしどこにも紐付いていない**——人の画面には出る
    assert.equal(left.scope, "unbound");
    // その Project からは引けない
    await assert.rejects(
      () => ui.callTool({ name: "lookupAlias", arguments: { name: "left-behind" }, _meta: forProject("p1") }),
      /どの Vault にもありません/,
    );
  });
});

test("移行ありで置き場を変えると、秘密も一緒に動く", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "comes-along", kind: "secret", value: "v", forProject: "p1" },
    });
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "fresh" } });
    await ui.callTool({
      name: "setProjectPlacement",
      arguments: { projectId: "p1", implementation: "vault-local", group: "fresh", migrate: true },
    });

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const moved = aliases.find((a: { name: string }) => a.name === "comes-along");
    assert.equal(moved.group, "fresh");
    assert.equal(moved.scope, "project");
    // その Project から、素の名前で引ける
    assert.equal(
      parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "comes-along" }, _meta: forProject("p1") })).group,
      "fresh",
    );
  });
});

// ---- 2026-09-15 のレビューで見つかった穴 ------------------------------------

// **読めない金庫が1本あるだけで、AI が目録を読めなくなっていた**（訂正・2026-09-15）。
// `vault-infisical` は既定で宣言され、未設定でも立つ——つまり素のインストールでは
// AI は毎回失敗していた。しかも直せるのは人だけで、AI には手が無い。
test("読めない金庫があっても、読める分は AI に返る（事実は落とさない）", async () => {
  await withUi(
    async ({ ui }) => {
      await ui.callTool({
        name: "createAlias",
        arguments: { implementation: "vault-local", name: "usable", kind: "secret", value: "v" },
      });
      const body = JSON.parse(
        ((await ui.readResource({ uri: "vault://aliases" })).contents as { text: string }[])[0]!.text,
      );
      assert.deepEqual(
        body.aliases.map((a: { name: string }) => a.name),
        ["usable"],
        `読める分が返っていない: ${JSON.stringify(body)}`,
      );
      // **「読めていない」も同じ答えの中で言う**（空に化けさせない・規則2）。
      // ただし**金庫の名前は言わない**——AI に選ぶ材料を渡さない（訂正・2026-09-15）
      assert.equal(body.unreadable, 1);
      assert.match(body.warning, /全部ではありません/);
      assert.match(body.warning, /人に伝えて/);
      assert.equal(
        JSON.stringify(body).includes("vault-dead"),
        false,
        "読めていない金庫の名前を AI に見せている",
      );
    },
    { vaultNames: ["vault-local"], broken: new Map([["vault-dead", "設定されていません"]]) },
  );
});

// **backend の listAliases は誰にでも全部返していた**（訂正・2026-09-15）。
// この口は valueFree なので初回承認すら出ない——`dependsOn: [{role:"vault"}]` を
// 宣言した Module は、承認ゼロで全 Project の目録を読めていた。
test("backend の目録は、刻印で絞る——刻印が無ければ断る", async () => {
  await withUi(async ({ ui, vaults }) => {
    const vault = vaults.get("vault-local")!;
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "mine", kind: "secret", value: "v", forProject: "p1" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "theirs", kind: "secret", value: "v", forProject: "p2" },
    });

    const namesFor = async (meta: Record<string, unknown>) =>
      (
        JSON.parse(
          ((await vault.callTool({ name: "listAliases", arguments: {}, _meta: meta })).content as {
            text: string;
          }[])[0]!.text,
        ) as Array<{ name: string }>
      )
        .map((a) => a.name)
        .sort();

    // 人の管理面は全部（「どこにも紐付いていない」も——隠すと直せない）
    assert.deepEqual(await namesFor(ADMIN), ["mine", "theirs"]);
    // Project は自分の分だけ
    assert.deepEqual(await namesFor(forProject("p1")), ["mine"]);
    // **刻印が無ければ、空ではなく断る**（「無い」と「決められない」を混ぜない）
    await assert.rejects(
      () => vault.callTool({ name: "listAliases", arguments: {} }),
      /誰のために読むのかが分かりません/,
    );
  });
});

// **制限を守る側が、制限を書き換えられてはならない**（追加・2026-09-15）。
// `admin` 可視性は「Module から呼べない」を意味していなかった——host の中継は
// 可視性で拒否しないので、承認1回で setGroupBinding を呼べば usableBy の判定
// そのものを書き換えられた。
test("紐付けと台帳を変える口は、人の刻印が無ければ通さない", async () => {
  await withUi(async ({ ui, vaults }) => {
    const vault = vaults.get("vault-local")!;
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "guarded", kind: "secret", value: "v", forProject: "owner" },
    });

    // Project の刻印では変えられない
    for (const [name, args] of [
      ["setGroupBinding", { projectId: "intruder", group: "owner" }],
      ["clearGroupBinding", { projectId: "owner" }],
      ["setSharedGroup", { group: "owner" }],
      ["deleteAlias", { name: "guarded" }],
    ] as const) {
      await assert.rejects(
        () => vault.callTool({ name, arguments: args, _meta: forProject("intruder") }),
        /人の管理画面からしか行えません/,
        `${name} が Module から通ってしまう`,
      );
    }

    // **書き換わっていない**——侵入側からはまだ使えない
    await assert.rejects(
      () => vault.callTool({ name: "resolveAlias", arguments: { name: "guarded" }, _meta: forProject("intruder") }),
      /この Project からは使えません/,
    );
  });
});

// **無いものを「消した」と言わない**（訂正・2026-09-15、規則1）
test("置き場を指した削除は、その置き場のものだけを消す", async () => {
  await withUi(async ({ ui, vaults }) => {
    await ui.callTool({ name: "createGroup", arguments: { implementation: "vault-local", name: "dest" } });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "DUP", kind: "secret", value: "in-project", forProject: "p1" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "DUP", kind: "secret", value: "in-dest", group: "dest" },
    });

    await ui.callTool({ name: "deleteAlias", arguments: { implementation: "vault-local", name: "DUP", group: "dest" } });

    const { aliases } = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const left = aliases.filter((a: { name: string }) => a.name === "DUP");
    assert.equal(left.length, 1, `消しすぎ／消せていない: ${JSON.stringify(aliases)}`);
    assert.equal(left[0].group, "p1", "指定した置き場ではないほうが消えた");
    // 残ったほうの値は無事
    assert.equal(await valueOf(vaults, "vault-local", "DUP", "p1"), "in-project");

    // **無い置き場を指したら、消したと言わない**
    await assert.rejects(
      () =>
        ui.callTool({ name: "deleteAlias", arguments: { implementation: "vault-local", name: "DUP", group: "dest" } }),
      /dest にありません/,
    );
  });
});

// **使えない同名があるだけで、頼むことすらできなくなっていた**（訂正・2026-09-15）
test("requestAlias は、使えない同名があっても入力欄を開く", async () => {
  await withUi(async ({ ui }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "someone-elses", forProject: "other" },
    });
    const said = textOf(
      await ui.callTool({ name: "requestAlias", arguments: { name: "TOKEN" }, _meta: forProject("mine") }),
    );
    assert.match(said, /入力欄/, `袋小路になっている: ${said}`);
    // **金庫の名前は返さない**——AI に選ばせる材料にしない
    assert.equal(said.includes("vault-local"), false, `実装名を AI に見せている: ${said}`);
    // **待ち方まで書く**——ターンの途中で人を待つ手段は AI に無い
    assert.match(said, /ターンを終えて/);

    // 使えるものが既に在るなら、そう言う
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "TOKEN", kind: "secret", value: "mine", forProject: "mine" },
    });
    const again = textOf(
      await ui.callTool({ name: "requestAlias", arguments: { name: "TOKEN" }, _meta: forProject("mine") }),
    );
    assert.match(again, /既に登録されていて、いま使えます/);
  });
});

// **banto 全体のための呼び出しは、共通の秘密だけ**（追加・2026-09-16）。
// `${secret:…}` を banto 全体に1本の Module へ差し込むときに使う刻印。
// Project が決まらないので**広げない**（規則2——曖昧なら狭いほうに倒す）。
const forInstance = { "dev.banto/caller": { instance: true } };

test("banto 全体の刻印では、共通の秘密だけが使える", async () => {
  await withUi(async ({ ui, vaults }) => {
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "shared-key", kind: "secret", value: "v-shared", group: "instance" },
    });
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "project-key", kind: "secret", value: "v-project", forProject: "p1" },
    });

    // 共通のものは引ける
    const found = parse(await ui.callTool({ name: "lookupAlias", arguments: { name: "shared-key" }, _meta: forInstance }));
    assert.equal(found.name, "shared-key");

    // **Project のものは引けない**
    await assert.rejects(
      () => ui.callTool({ name: "lookupAlias", arguments: { name: "project-key" }, _meta: forInstance }),
      /どの Vault にもありません/,
      "Project の秘密が banto 全体から引けてしまう",
    );

    // backend も同じ規律——値の口で断る
    const vault = vaults.get("vault-local")!;
    await assert.rejects(
      () => vault.callTool({ name: "resolveAlias", arguments: { name: "project-key" }, _meta: forInstance }),
      /banto 全体からは使えません/,
    );
    // 共通のものは値が返る
    const value = (
      (await vault.callTool({ name: "resolveAlias", arguments: { name: "shared-key" }, _meta: forInstance }))
        .content as { text: string }[]
    )[0]!.text;
    assert.equal(value, "v-shared");
  });
});

// **banto 自身が置く秘密**（追加・2026-09-18、OAuth のため）。
// 金庫には値を書き換える口が無い——それは「人が預けたものを黙って書き換えない」
// という正しい設計。OAuth の refresh token は回るので置き換えが要るが、
// **置き換えてよい範囲は種別で区切る**。
test("putSecret は置き換えられる——ただし人が預けた秘密には届かない", async () => {
  await withUi(async ({ ui, vaults }) => {
    const vault = vaults.get("vault-local")!;

    // 1回目＝作る、2回目＝置き換える
    await ui.callTool({ name: "putSecret", arguments: { name: "oauth-weather", value: "tok-1" } });
    await ui.callTool({ name: "putSecret", arguments: { name: "oauth-weather", value: "tok-2" } });
    const value = (
      (await vault.callTool({ name: "resolveAlias", arguments: { name: "oauth-weather" }, _meta: ADMIN }))
        .content as { text: string }[]
    )[0]!.text;
    assert.equal(value, "tok-2", "置き換えられていない");

    // **種別は banto のもの**——人の登録画面には出ない側
    const listed = parse(await ui.callTool({ name: "listAliases", arguments: {} }));
    const found = listed.aliases.find((a: { name: string }) => a.name === "oauth-weather");
    assert.equal(found.kind, "oauth-token");

    // **人が預けた秘密は、この口からは触れない**（ここが柵）
    await ui.callTool({
      name: "createAlias",
      arguments: { name: "my-own", kind: "secret", value: "人のもの" },
    });
    await assert.rejects(
      () => ui.callTool({ name: "putSecret", arguments: { name: "my-own", value: "乗っ取り" } }),
      /人が預けた秘密です/,
      "人の秘密が putSecret で上書きできてしまう",
    );
    // 元の値は無事
    const still = (
      (await vault.callTool({ name: "resolveAlias", arguments: { name: "my-own" }, _meta: ADMIN }))
        .content as { text: string }[]
    )[0]!.text;
    assert.equal(still, "人のもの");
  });
});
