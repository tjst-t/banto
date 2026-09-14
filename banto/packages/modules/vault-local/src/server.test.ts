// Vault の MCP 面（docs/specs/v4-modules.md §2.1 の A/B/C）を、実際の
// MCP サーバ越しに見る。backend は本物（sops/age）——ここを模造にすると
// 「繋がっていないのに通る」試験になる（規則1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createVaultServer } from "./server.js";

type TextContent = { text: string }[];

/**
 * **host が刻む「誰のための呼び出しか」**（決定・2026-09-13）。
 *
 * 実運用では host が `_meta` に付ける。この試験の既定は「人が管理画面から
 * 触っている」（`admin`）——C 節の道具を見る試験がほとんどだから。
 * Project からの見え方は、下のほうで `stamp` を明示して確かめる。
 */
const ADMIN = { "dev.banto/caller": { admin: true } } as const;
const forProject = (project: string) => ({ "dev.banto/caller": { project } });

/** 人の代わりに Elicitation へ答える係。`answer` を差し替えて使う。 */
interface Harness {
  client: Client;
  answer: { action: "accept" | "decline" | "cancel" };
}

async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-vault-server-test-"));
  const harness: Harness = { client: undefined as unknown as Client, answer: { action: "accept" } };
  try {
    const server = createVaultServer(dir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => harness.answer);
    await Promise.all([server.connect(s), client.connect(c)]);
    // **刻印を既定で付ける**（実運用では host の仕事）。個別に変えたい試験は
    // `_meta` を明示すれば上書きされる
    const raw = client.callTool.bind(client);
    client.callTool = ((params: Record<string, unknown>, ...rest: unknown[]) =>
      raw({ _meta: ADMIN, ...params } as never, ...(rest as []))) as typeof client.callTool;
    const rawRead = client.readResource.bind(client);
    client.readResource = ((params: Record<string, unknown>, ...rest: unknown[]) =>
      rawRead({ _meta: ADMIN, ...params } as never, ...(rest as []))) as typeof client.readResource;
    harness.client = client;
    await fn(harness);
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function textOf(result: unknown): string {
  return ((result as { content: TextContent }).content[0]?.text ?? "") as string;
}

/** resource の中身（この Module は必ず text で返す）。 */
function resourceText(read: unknown): string {
  return (read as { contents: TextContent }).contents[0]!.text;
}

test("createAlias -> resolveAlias roundtrip through the actual MCP server", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("requestAlias"));
    assert.ok(names.includes("resolveAlias"));
    assert.ok(names.includes("createAlias"));

    await client.callTool({
      name: "createAlias",
      arguments: { name: "github-token", kind: "secret", forProject: "p1", value: "ghp_abc123" },
    });

    const resolved = await client.callTool({ name: "resolveAlias", arguments: { name: "github-token" } });
    assert.equal(textOf(resolved), "ghp_abc123");

    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "vault://aliases/github-token"));

    const read = await client.readResource({ uri: "vault://aliases/github-token" });
    const meta = JSON.parse(resourceText(read));
    assert.equal(meta.kind, "secret");
    assert.equal(meta.name, "github-token");
    // **使える範囲は alias に書かれていない**——置き場から導く（規則3）
    assert.equal(meta.projectId, undefined);
    assert.equal(meta.scope, undefined);
    assert.equal(meta.backendPath, undefined, "backendPath (internal detail) must not leak into the resource");
    assert.equal(meta.value, undefined, "the secret value itself must never appear in resource metadata");
  });
});

// ---- A節：AI 向けの入口 -----------------------------------------------------

test("一覧そのもの（vault://aliases）が resources/list に載っている", async () => {
  // 読めるのに一覧に無いと、辿り着けない（2026-09-12）。
  //
  // **可視性は `module`**（改訂・2026-09-12、窓口の導入）——実装が2本になると
  // AI には目録が2つ並び、**AI はどちらを見る材料を持たない**。
  // AI に見せる目録は窓口（`vault-directory`）が横断して1つだけ出す。
  // backend の目録は、窓口からは今までどおり読める。
  await withServer(async ({ client }) => {
    const { resources } = await client.listResources();
    const listing = resources.find((r) => r.uri === "vault://aliases");
    assert.ok(listing, `vault://aliases が一覧に無い: ${resources.map((r) => r.uri).join(", ")}`);
    assert.equal((listing._meta as Record<string, unknown>)["dev.banto/visibility"], "module");

    await client.callTool({
      name: "createAlias",
      arguments: { name: "a1", kind: "secret", value: "v1" },
    });
    const read = await client.readResource({ uri: "vault://aliases" });
    const list = JSON.parse(resourceText(read)) as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "a1");
    assert.equal(list[0]!.backendPath, undefined, "backend 内のパスが一覧に漏れている");
  });
});

test("requestAlias は、会話の中に入力欄を出す印を持っている", async () => {
  // **Elicitation はやめた**（改訂・2026-09-12）——banto は Elicitation の応答を
  // 解決しない設計なので、人が答えても Module には届かず 60 秒待つだけだった。
  // 代わりに、この tool の結果そのものが会話の中の画面を開く。
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const request = tools.find((t) => t.name === "requestAlias")!;
    const ui = (request._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
    assert.equal(ui?.resourceUri, "ui://banto-vault-local/request", "入力欄を出す印が無い");

    // その画面は実際に読める（**在ると言っておいて読めない、を作らない**）
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "ui://banto-vault-local/request"), "画面が一覧に無い");
    const html = resourceText(await client.readResource({ uri: "ui://banto-vault-local/request" }));
    assert.match(html, /profile=mcp-app|<!doctype html>/i);
    // **値を取る道具を画面が呼ぼうとしていない**
    assert.equal(html.includes("resolveAlias"), false);
    // 人が入れる道と、作らせる道の両方がある
    assert.match(html, /createAlias/);
    assert.match(html, /generateSecret/);
    // **SSH 鍵はその場で作れて、公開鍵が出る**（出さないと相手方に登録できない）
    assert.match(html, /ssh-identity/);
    assert.match(html, /公開鍵/);
  });
});

test("requestAlias はすぐ返る——人を待たせたまま呼び出しを止めない", async () => {
  await withServer(async ({ client }) => {
    const result = await client.callTool({
      name: "requestAlias",
      arguments: { name: "missing-token", hint: "CI に要る" },
    });
    assert.match(textOf(result), /入力欄を/, `想定と違う返事: ${textOf(result)}`);
    // **頼んだだけで、まだ無い**——「頼めた」を「使える」と取り違えさせない
    assert.match(textOf(result), /まだ存在しません/);
    assert.match(textOf(result), /値はあなたには渡りません/);

    // 実際、この時点では登録されていない
    const list = JSON.parse(resourceText(await client.readResource({ uri: "vault://aliases" })));
    assert.deepEqual(list, []);
  });
});

// ---- B節：他 Module 向け ----------------------------------------------------

test("verify は正しい署名だけを通す（長さ違い・1文字違いも false）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "webhook-key", kind: "secret", value: "s3cr3t" },
    });
    const payload = "{\"event\":\"push\"}";
    const good = createHmac("sha256", "s3cr3t").update(payload).digest("hex");

    assert.equal(
      textOf(await client.callTool({ name: "verify", arguments: { alias: "webhook-key", payload, signature: good } })),
      "true",
    );
    // 末尾1文字違い
    const bad = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    assert.equal(
      textOf(await client.callTool({ name: "verify", arguments: { alias: "webhook-key", payload, signature: bad } })),
      "false",
    );
    // 長さ違い（timingSafeEqual は長さが違うと投げる——投げさせない）
    assert.equal(
      textOf(await client.callTool({ name: "verify", arguments: { alias: "webhook-key", payload, signature: "ab" } })),
      "false",
    );
    // 16進ですらない
    assert.equal(
      textOf(await client.callTool({ name: "verify", arguments: { alias: "webhook-key", payload, signature: "zz" } })),
      "false",
    );
  });
});

test("SSH 鍵も generateSecret で作れる——公開鍵だけが返り、秘密鍵は返らない", async () => {
  // **入口を1つにした**（統合・2026-09-12、ユーザー指摘）。以前は `generateKeypair`
  // という別の tool で、しかも `module` 可視性だったので**呼び出し元が1つも無く**、
  // 人の画面からは一生届かなかった。
  await withServer(async ({ client }) => {
    // その別 tool はもう無い
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((t) => t.name === "generateKeypair"),
      false,
      "作る入口が2本に割れたまま",
    );

    const made = JSON.parse(
      textOf(
        await client.callTool({
          name: "generateSecret",
          arguments: { name: "github-id", kind: "ssh-identity", note: "push 用" },
        }),
      ),
    );
    assert.equal(made.kind, "ssh-identity");
    assert.equal(made.note, "push 用");
    // **公開鍵は返る**——これが返らないと相手方（GitHub 等）に登録できず、使えない
    assert.match(made.publicKey, /^ssh-ed25519 /);
    // **秘密鍵は返らない**
    assert.equal(made.privateKey, undefined);
    assert.equal(JSON.stringify(made).includes("PRIVATE KEY"), false);

    // 登録された alias は ssh-identity なので、そのまま ssh-agent に積める
    const meta = JSON.parse(resourceText(await client.readResource({ uri: "vault://aliases/github-id" })));
    assert.equal(meta.kind, "ssh-identity");
    const agent = JSON.parse(
      textOf(await client.callTool({ name: "startSshAgent", arguments: { identity: "github-id" } })),
    );
    assert.match(agent.socketPath, /banto-ssh-agent/);

    // 同じ名前で2回は作らせない（前の鍵が迷子になる）
    await assert.rejects(
      () =>
        client.callTool({
          name: "generateSecret",
          arguments: { name: "github-id", kind: "ssh-identity" },
        }),
      /には既に別の秘密があります/,
    );
  });
});

test("鍵の強さは鍵の種類が決める——SSH に format/bytes を渡したら黙って捨てない", async () => {
  await withServer(async ({ client }) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "generateSecret",
          arguments: { name: "k", kind: "ssh-identity", bytes: 64 },
        }),
      /ssh-identity では format \/ bytes は指定できません/,
    );
  });
});

test("作れない種類は作らせない（ファイルの中身をランダムには作れない）", async () => {
  await withServer(async ({ client }) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "generateSecret",
          arguments: { name: "k", kind: "file" },
        }),
      /kind は secret \/ ssh-identity/,
    );
  });
});

test("startSshAgent は ssh-identity 以外の alias を受け取らない", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "just-a-token", kind: "secret", value: "t" },
    });
    await assert.rejects(
      () => client.callTool({ name: "startSshAgent", arguments: { identity: "just-a-token" } }),
      /ssh-identity ではありません/,
    );
  });
});

// ---- C節：人の管理操作 ------------------------------------------------------

test("語彙の外の kind は拒否する——黙って既定に倒さない", async () => {
  await withServer(async ({ client }) => {
    await assert.rejects(
      () =>
        client.callTool({
          name: "createAlias",
          arguments: { name: "x", kind: "secrets", value: "v" },
        }),
      /kind は secret \/ ssh-identity \/ file/,
    );
  });
});

// **使える範囲は保存しない——置き場から導く**（決定・2026-09-13、ユーザー指摘）。
// 以前は alias が `scope` を持っていたが、置き場（グループ）と二重管理になり、
// 実際に食い違っていた（鍵ペアは `scope` を無視して `ssh-identities` へ）。
test("使える範囲は置き場から導く——共通グループ・紐付いた Project・どこにも紐付いていない", async () => {
  await withServer(async ({ client }) => {
    // 置き先を言わなければ共通グループ
    await client.callTool({
      name: "createAlias",
      arguments: { name: "everywhere", kind: "secret", value: "v" },
    });
    // Project を言えば、その Project のグループ
    await client.callTool({
      name: "createAlias",
      arguments: { name: "only-a", kind: "secret", forProject: "proj-a", value: "v" },
    });
    // どこにも紐付いていないグループを直に指定
    await client.callTool({
      name: "createAlias",
      arguments: { name: "orphan", kind: "secret", group: "nobody", value: "v" },
    });

    const list = JSON.parse(textOf(await client.callTool({ name: "listAliases", arguments: {} }))) as Array<{
      name: string;
      scope: string;
      group: string;
      projects: string[];
    }>;
    const by = (n: string) => list.find((a) => a.name === n)!;
    assert.equal(by("everywhere").scope, "shared");
    assert.equal(by("only-a").scope, "project");
    assert.deepEqual(by("only-a").projects, ["proj-a"]);
    // **使えないものを黙って消さない**（規則2）——人の画面には出して、直せるようにする
    assert.equal(by("orphan").scope, "unbound");
    // **保存はしていない**（導出値なので、alias 自身は持たない）
    assert.equal((by("everywhere") as Record<string, unknown>).projectId, undefined);
  });
});

test("Project の alias は、その Project のグループに入る（紐付けは台帳に残る）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "t1", kind: "secret", forProject: "proj-a", value: "v1" },
    });

    // 既定は「projectId をそのままグループ名に使う」（§2.1）
    const groups = JSON.parse(textOf(await client.callTool({ name: "listGroups", arguments: {} }))) as string[];
    assert.ok(groups.includes("proj-a"), `グループが作られていない: ${groups.join(", ")}`);

    // **暗黙の既定を台帳に書き留める**——画面が見るのはこの台帳（規則3）
    const bindings = JSON.parse(
      textOf(await client.callTool({ name: "listGroupBindings", arguments: {} })),
    ) as { shared: string; projects: Array<{ projectId: string; group: string }> };
    assert.deepEqual(bindings.projects, [{ projectId: "proj-a", group: "proj-a" }]);
    // **共通グループも紐付けとして見える**（以前は決め打ちで、見る口が無かった）
    assert.equal(bindings.shared, "instance");
  });
});

test("紐付けを変えると、次の alias は新しいグループへ行く（共有の合図になる）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "setGroupBinding",
      arguments: { projectId: "proj-b", group: "shared-team" },
    });
    await client.callTool({
      name: "createAlias",
      arguments: { name: "t2", kind: "secret", forProject: "proj-b", value: "v2" },
    });
    const groups = JSON.parse(textOf(await client.callTool({ name: "listGroups", arguments: {} }))) as string[];
    assert.ok(groups.includes("shared-team"));
    assert.ok(!groups.includes("proj-b"), "紐付けを無視して既定のグループを作っている");
    // 値は新しいグループ越しに解決できる
    assert.equal(textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "t2" } })), "v2");
  });
});

test("グループ名の検査は紐付けにも効く（Vault の置き場の外を指させない）", async () => {
  await withServer(async ({ client }) => {
    await assert.rejects(
      () => client.callTool({ name: "setGroupBinding", arguments: { projectId: "p", group: "../escaped" } }),
      /グループ名に使えるのは/,
    );
  });
});

test("updateAlias は覚え書きだけ——使える範囲は alias では変えられない", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "t3", kind: "secret", forProject: "proj-c", value: "v3", note: "最初" },
    });

    await client.callTool({ name: "updateAlias", arguments: { name: "t3", note: "あとで書き直した" } });
    let meta = JSON.parse(resourceText(await client.readResource({ uri: "vault://aliases/t3" })));
    assert.equal(meta.note, "あとで書き直した");
    // **触っていない項目が消えていない**（素の spread だと飛ぶ）
    assert.equal(meta.kind, "secret");
    // **置き場は動かせない**——以前は scope を付け替えられたが、値は元の
    // グループに残ったままで、画面の表示だけが変わる嘘になっていた
    await assert.rejects(
      () => client.callTool({ name: "updateAlias", arguments: { name: "t3", scope: "instance" } }),
      /使える範囲は alias では変えられません/,
    );
    // 値はそのまま
    assert.equal(textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "t3" } })), "v3");

    // 覚え書きを消しても、置き場は動かない
    await client.callTool({ name: "updateAlias", arguments: { name: "t3" } });
    meta = JSON.parse(resourceText(await client.readResource({ uri: "vault://aliases/t3" })));
    assert.equal(meta.name, "t3");
  });
});

test("メタデータの書き込みは、途中で落ちても中途半端な JSON を残さない形で行う", async () => {
  // 一覧を失うと、値は backend に残っているのに「どれが何か」が分からなくなる。
  // ここで見るのは結果の整合——同時に走らせても全部残ること
  const dir = await mkdtemp(join(tmpdir(), "banto-vault-save-test-"));
  try {
    const server = createVaultServer(dir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);

    await Promise.all(
      ["a", "b", "c", "d"].map((n) =>
        client.callTool({
          name: "createAlias",
          arguments: { name: n, kind: "secret", value: `value-${n}` },
        }),
      ),
    );

    const onDisk = JSON.parse(await readFile(join(dir, "aliases.json"), "utf8")) as Array<{ name: string }>;
    assert.deepEqual(
      onDisk.map((a) => a.name).sort(),
      ["a", "b", "c", "d"],
      "同時に登録したぶんが取りこぼされている",
    );
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 秘密を Vault の中で作る（`generateSecret`、2026-09-12）-------------------

test("generateSecret は値を返さない——作ったことだけを返す", async () => {
  await withServer(async ({ client }) => {
    const made = JSON.parse(
      textOf(
        await client.callTool({
          name: "generateSecret",
          arguments: { name: "signing-key", note: "webhook 署名用" },
        }),
      ),
    );
    assert.deepEqual(made, {
      name: "signing-key",
      kind: "secret",
      note: "webhook 署名用",
      format: "base64url",
      bytes: 32,
    });
    // **値そのものは、戻り値のどこにも無い**
    assert.equal(JSON.stringify(made).includes("=") || Object.keys(made).includes("value"), false);

    // それでも**実体はある**——部品からは解決できる（値を知らずに使える、が要点）
    const value = textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "signing-key" } }));
    assert.match(value, /^[A-Za-z0-9_-]{43}$/, `base64url 32バイトになっていない: ${value}`);

    // 一覧にも値は出ない
    const list = JSON.parse(resourceText(await client.readResource({ uri: "vault://aliases" })));
    assert.equal(list[0].note, "webhook 署名用");
    assert.equal(JSON.stringify(list).includes(value), false, "一覧に値が漏れている");
  });
});

test("generateSecret は毎回ちがう値を作る（乱数であることを実際に見る）", async () => {
  await withServer(async ({ client }) => {
    const values = new Set<string>();
    for (const name of ["k1", "k2", "k3"]) {
      await client.callTool({ name: "generateSecret", arguments: { name } });
      values.add(textOf(await client.callTool({ name: "resolveAlias", arguments: { name } })));
    }
    assert.equal(values.size, 3, "同じ値が作られている");
  });
});

test("generateSecret は形式と強さを選べる——語彙と範囲の外は拒否する", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "generateSecret",
      arguments: { name: "hexkey", format: "hex", bytes: 16 },
    });
    assert.match(
      textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "hexkey" } })),
      /^[0-9a-f]{32}$/,
    );

    await assert.rejects(
      () => client.callTool({ name: "generateSecret", arguments: { name: "x", format: "uuid" } }),
      /format は base64url \/ hex/,
    );
    // **弱い長さを黙って受けない**（規則2）
    await assert.rejects(
      () => client.callTool({ name: "generateSecret", arguments: { name: "x", bytes: 4 } }),
      /bytes は 16〜256/,
    );
    await assert.rejects(
      () => client.callTool({ name: "generateSecret", arguments: { name: "x", bytes: 1000 } }),
      /bytes は 16〜256/,
    );

  });
});

test("生成した秘密は、AI からは見えない道具で作られる（visibility の確認）", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const gen = tools.find((t) => t.name === "generateSecret");
    assert.ok(gen);
    assert.equal((gen._meta as Record<string, unknown>)["dev.banto/visibility"], "admin");
  });
});

// ---- AI が使い方に辿り着けるか（2026-09-12、ユーザー指摘）--------------------

test("AI に見える面には、使い方が書いてある", async () => {
  // **道具はあるのに使い方がどこにも書いていない**状態だった。system prompt は
  // 個々の tool を語らない決まり（決定・2026-09-05、規則3）なので、伝わる場所は
  // tool と resource の description しかない——そこに在ることを試験で押さえる
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const request = tools.find((t) => t.name === "requestAlias")!;
    assert.match(request.description ?? "", /vault:\/\/aliases/, "一覧の在りかが書かれていない");
    assert.match(request.description ?? "", /envSecrets/, "使うときの渡し方が書かれていない");
    assert.match(request.description ?? "", /値は受け取らない/, "値を見ないことが書かれていない");

    const { resources } = await client.listResources();
    const listing = resources.find((r) => r.uri === "vault://aliases")!;
    assert.match(listing.description ?? "", /envSecrets/, "一覧から使い方へ繋がっていない");
  });
});

// ---- アクセス制限（決定・2026-09-13、ユーザー指摘）--------------------------
//
// 以前は `scope` がただの札で、**別の Project からでも普通に引けていた**
// （規則13——画面が制約を示しているのに、実装は制約していない）。
// 「その Project に紐付いたグループ＋共通グループ」だけ使える、にした。

test("別の Project からは引けない——共通グループのものは引ける", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "a-only", kind: "secret", forProject: "proj-a", value: "va" },
    });
    await client.callTool({
      name: "createAlias",
      arguments: { name: "for-all", kind: "secret", value: "vall" },
    });

    // 持ち主の Project からは引ける
    assert.equal(
      textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "a-only" }, _meta: forProject("proj-a") })),
      "va",
    );
    // **別の Project からは引けない**
    await assert.rejects(
      () => client.callTool({ name: "resolveAlias", arguments: { name: "a-only" }, _meta: forProject("proj-b") }),
      /この Project からは使えません/,
    );
    // 共通グループのものは、どの Project からでも引ける
    assert.equal(
      textOf(await client.callTool({ name: "resolveAlias", arguments: { name: "for-all" }, _meta: forProject("proj-b") })),
      "vall",
    );
  });
});

test("使えないものは、名前も見せない（AI の目録から消える）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "a-only", kind: "secret", forProject: "proj-a", value: "va" },
    });
    await client.callTool({ name: "createAlias", arguments: { name: "for-all", kind: "secret", value: "v" } });

    const seenBy = async (project: string) =>
      (JSON.parse(
        resourceText(await client.readResource({ uri: "vault://aliases", _meta: forProject(project) })),
      ) as Array<{ name: string }>).map((a) => a.name);

    assert.deepEqual((await seenBy("proj-a")).sort(), ["a-only", "for-all"]);
    assert.deepEqual(await seenBy("proj-b"), ["for-all"]);
    // 人の管理画面は全部見える（使えないものも直せるように）
    const all = JSON.parse(textOf(await client.callTool({ name: "listAliases", arguments: {} }))) as Array<{
      name: string;
    }>;
    assert.deepEqual(all.map((a) => a.name).sort(), ["a-only", "for-all"]);
  });
});

test("刻印が無い呼び出しには値を渡さない（名乗らないだけで通り抜けさせない）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({ name: "createAlias", arguments: { name: "x", kind: "secret", value: "v" } });
    // **共通グループのものでも**、誰のためか分からなければ止まる（規則2）
    await assert.rejects(
      () => client.callTool({ name: "resolveAlias", arguments: { name: "x" }, _meta: {} }),
      /誰のために使うのかが分かりません/,
    );
    await assert.rejects(
      () => client.callTool({ name: "resolveAlias", arguments: { name: "x" }, _meta: { "dev.banto/caller": { project: "" } } }),
      /誰のために使うのかが分かりません/,
    );
  });
});

test("紐付けを変えると、使える範囲もその場で変わる（写しを持っていない）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "createAlias",
      arguments: { name: "shared-later", kind: "secret", forProject: "proj-a", value: "v" },
    });
    await assert.rejects(
      () => client.callTool({ name: "resolveAlias", arguments: { name: "shared-later" }, _meta: forProject("proj-b") }),
      /この Project からは使えません/,
    );
    // proj-b も同じグループを向ける＝**人の意図で共有が起きる**
    await client.callTool({ name: "setGroupBinding", arguments: { projectId: "proj-b", group: "proj-a" } });
    assert.equal(
      textOf(
        await client.callTool({ name: "resolveAlias", arguments: { name: "shared-later" }, _meta: forProject("proj-b") }),
      ),
      "v",
    );
  });
});

test("共通グループは選べる——変えると、そこに置いたものが共通になる", async () => {
  await withServer(async ({ client }) => {
    // 既定の共通グループに1つ置く
    await client.callTool({ name: "createAlias", arguments: { name: "old-shared", kind: "secret", value: "v1" } });
    // 共通グループを別のものに移す
    await client.callTool({ name: "setSharedGroup", arguments: { group: "team-shared" } });
    await client.callTool({ name: "createAlias", arguments: { name: "new-shared", kind: "secret", value: "v2" } });

    const list = JSON.parse(textOf(await client.callTool({ name: "listAliases", arguments: {} }))) as Array<{
      name: string;
      scope: string;
      group: string;
    }>;
    assert.equal(list.find((a) => a.name === "new-shared")!.group, "team-shared");
    assert.equal(list.find((a) => a.name === "new-shared")!.scope, "shared");
    // **前の共通グループは、もう共通ではない**——誰にも紐付いていない
    assert.equal(list.find((a) => a.name === "old-shared")!.scope, "unbound");
    await assert.rejects(
      () => client.callTool({ name: "resolveAlias", arguments: { name: "old-shared" }, _meta: forProject("p") }),
      /この Project からは使えません/,
    );
  });
});

test("鍵ペアも、言われたグループに入る（backend が置き場を決めない）", async () => {
  await withServer(async ({ client }) => {
    await client.callTool({
      name: "generateSecret",
      arguments: { name: "deploy-key", kind: "ssh-identity", forProject: "proj-a" },
    });
    const list = JSON.parse(textOf(await client.callTool({ name: "listAliases", arguments: {} }))) as Array<{
      name: string;
      group: string;
      scope: string;
    }>;
    const key = list.find((a) => a.name === "deploy-key")!;
    assert.equal(key.group, "proj-a", "鍵だけ別のグループに置かれている");
    assert.equal(key.scope, "project");
    // 持ち主からは ssh-agent に積める。別の Project からは積めない
    assert.ok(
      textOf(
        await client.callTool({ name: "startSshAgent", arguments: { identity: "deploy-key" }, _meta: forProject("proj-a") }),
      ).includes("socketPath"),
    );
    await assert.rejects(
      () => client.callTool({ name: "startSshAgent", arguments: { identity: "deploy-key" }, _meta: forProject("proj-b") }),
      /この Project からは使えません/,
    );
  });
});

// **公開鍵は秘密ではない**（追加・2026-09-13、ユーザー指摘）。
// 以前は `generateSecret` の戻りに1回出るだけで、**画面を閉じたら二度と
// 見られなかった**——相手方（GitHub 等）に登録するためのものなのに。
// 保存はしない：秘密鍵から `ssh-keygen -y` で導く（規則3・規則12）。
test("公開鍵は、作ったあとでも何度でも読める（秘密鍵は返らない）", async () => {
  await withServer(async ({ client }) => {
    const made = JSON.parse(
      textOf(
        await client.callTool({
          name: "generateSecret",
          arguments: { name: "gh-key", kind: "ssh-identity", forProject: "proj-a" },
        }),
      ),
    ) as { publicKey: string };

    const again = textOf(
      await client.callTool({ name: "getPublicKey", arguments: { name: "gh-key" }, _meta: forProject("proj-a") }),
    );
    assert.equal(again, made.publicKey, "作った直後と、あとから読んだ公開鍵が違う");
    assert.match(again, /^ssh-ed25519 AAAA/);
    assert.equal(again.includes("PRIVATE KEY"), false, "秘密鍵が返っている");

    // 使える範囲は他の口と揃っている
    await assert.rejects(
      () => client.callTool({ name: "getPublicKey", arguments: { name: "gh-key" }, _meta: forProject("proj-b") }),
      /この Project からは使えません/,
    );
    // 鍵でないものには使えない（黙って何か返さない）
    await client.callTool({ name: "createAlias", arguments: { name: "plain", kind: "secret", value: "v" } });
    await assert.rejects(
      () => client.callTool({ name: "getPublicKey", arguments: { name: "plain" } }),
      /ssh-identity ではありません/,
    );
  });
});
