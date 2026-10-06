// **本物の Infisical を相手にする統合試験。**
//
// 組み込み Vault の試験が実 `sops`/`age` を叩いているのと同じ形（規則1）
// ——模造を相手にすると「繋がっていないのに通る」試験になる。
//
// 相手は `dev/docker-compose.yml` で立てた自前ホスト。**立っていなければ
// 試験は飛ばさず落とす**……のではなく、**立っていないことをはっきり言って
// 飛ばす**——このリポジトリを初めて触る人が、docker を立てずに全試験を
// 走らせたときに「Infisical が落ちている」と分かる必要がある（規則2——
// 黙って緑にしない）。立て方は `dev/README.md`。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { InfisicalConnection, type InfisicalConfig } from "./client.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalSettingsStore } from "./settings-store.js";
import { InfisicalTokenCache, tokenKeyOf } from "./token-cache.js";
import { createInfisicalVaultServer } from "./server.js";

/** host が刻む「誰のための呼び出しか」。ここは人の管理面のつもり。 */
const ADMIN = { "dev.banto/caller": { admin: true } } as const;

const IDENTITY = join(dirname(fileURLToPath(import.meta.url)), "../dev/.identity.json");

/** 開発用の Infisical が立っているか。立っていないなら**理由を言って**飛ばす。 */
function devConfig(): InfisicalConfig | undefined {
  if (!existsSync(IDENTITY)) return undefined;
  return JSON.parse(readFileSync(IDENTITY, "utf8")) as InfisicalConfig;
}

const config = devConfig();
const skip = config
  ? false
  : "開発用の Infisical が用意されていません（packages/modules/vault-infisical/dev/README.md）";

/** 試験ごとに別のグループを使う——同じ Infisical を共有するので混ざらないように。 */
function uniqueGroup(label: string): string {
  return `t-${label}-${Date.now().toString(36)}`;
}

async function connected(): Promise<InfisicalConnection> {
  const conn = new InfisicalConnection(config!);
  await conn.connect();
  return conn;
}

test("Infisical backend: 置いて・読んで・消す（本物の Infisical で）", { skip }, async () => {
  const backend = new InfisicalBackend(await connected());
  const g = uniqueGroup("roundtrip");
  await backend.putSecret(`${g}/github-token`, "ghp_real_value");
  assert.equal(await backend.getSecret(`${g}/github-token`), "ghp_real_value");

  // 上書きできる（Infisical は create と update が別の口なので、そこを吸収している）
  await backend.putSecret(`${g}/github-token`, "ghp_changed");
  assert.equal(await backend.getSecret(`${g}/github-token`), "ghp_changed");

  assert.ok((await backend.listPaths()).includes(`${g}/github-token`));
  await backend.deleteSecret(`${g}/github-token`);
  await assert.rejects(() => backend.getSecret(`${g}/github-token`));
});

test("createGroup は冪等——組み込み Vault と契約を揃える", { skip }, async () => {
  // **2本目を書いて見つかった差**（2026-09-12）。SOPS は `mkdir -p` なので
  // 何度でも通るが、Infisical の folders.create は既にあると 400 で落ちる。
  // 呼び出し側は alias を作るたびに呼ぶので、ここが冪等でないと2つ目が作れない
  const backend = new InfisicalBackend(await connected());
  const g = uniqueGroup("idem");
  await backend.createGroup(g);
  await backend.createGroup(g); // ← 直す前はここで 400
  await backend.createGroup(g);
  assert.ok((await backend.listGroups()).includes(g));
});

test("グループ名で置き場の外を指せない（`/` も `..` も通さない）", { skip }, async () => {
  const backend = new InfisicalBackend(await connected());
  for (const bad of ["../escaped", "..", ".", "a/b", "/abs", "", "-leading"]) {
    await assert.rejects(() => backend.createGroup(bad), /グループ名に使えるのは/);
  }
  await assert.rejects(() => backend.putSecret("../escaped/key", "v"), /グループ名に使えるのは/);
});

test("SSH 鍵を作って、本物の ssh-agent に積める", { skip }, async () => {
  const backend = new InfisicalBackend(await connected());
  const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh", "ssh-identities/e2e-key");
  assert.ok(publicKey.startsWith("ssh-ed25519"));
  try {
    const { socketPath } = await backend.loadIntoAgent(privateKeyRef);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("ssh-add", ["-l"], {
      env: { ...process.env, SSH_AUTH_SOCK: socketPath },
    });
    assert.ok(stdout.includes("ED25519"), `積まれていない: ${stdout}`);
    // 同じ鍵で agent を増やさない
    const again = await backend.loadIntoAgent(privateKeyRef);
    assert.equal(again.socketPath, socketPath);
  } finally {
    await backend.stopAgents();
    await backend.deleteSecret(privateKeyRef);
  }
});

// ---- メタデータの置き場（ここが SOPS と決定的に違う）------------------------

test("メタデータは Infisical の中にある——別のホストからでも見える形", { skip }, async () => {
  // **これが「複数台のホストで共有する」の本体**（決定・2026-09-12）。
  // メタデータをローカルのファイルに置くと、2台目からは値はあるのに
  // 名前も種別も用途も分からない——共有が半分しか成立しない。
  const conn = await connected();
  const backend = new InfisicalBackend(conn);
  const store = new InfisicalAliasStore(conn);
  const g = uniqueGroup("meta");
  const name = `alias-${Date.now().toString(36)}`;

  await backend.putSecret(`${g}/${name}`, "v");
  await store.create({
    name,
    kind: "secret",
    note: "CI 用",
    backendPath: `${g}/${name}`,
  });

  // **別のホストのつもりで、新しい接続から読む**（手元の写しを一切使わない）
  const otherHost = new InfisicalAliasStore(await connected());
  const seen = (await otherHost.list()).find((a) => a.name === name);
  assert.ok(seen, "別のホストから alias が見えない（メタデータが手元にしか無い）");
  assert.equal(seen.kind, "secret");
  assert.equal(seen.name, name, "alias 名が置き場から作り直されている");
  assert.equal(seen.note, "CI 用");
  assert.equal(seen.backendPath, `${g}/${name}`);

  await store.markUsed(`${g}/${name}`);
  assert.ok(((await otherHost.list()).find((a) => a.name === name))?.lastUsedAt, "使った印も共有されていない");

  await backend.deleteSecret(`${g}/${name}`);
  assert.equal((await otherHost.list()).find((a) => a.name === name), undefined, "消しても残っている");
});

// **決め直した**（訂正・2026-09-13、ユーザー指摘）。以前ここは
// 「banto が付けた注記の無い秘密は alias として数えない」を押さえていた
// ——理由は「人が別の用途で置いた秘密まで一覧に混ざる」。**前提が逆だった**：
// 既に Infisical をフォルダで分けて使っている人にとって、そこに在る秘密は
// 混ざりものではなく**本体**である。数える側に変えた。
test("banto 以外が置いた秘密も、alias として数える", { skip }, async () => {
  const conn = await connected();
  const backend = new InfisicalBackend(conn);
  const store = new InfisicalAliasStore(conn);
  const g = uniqueGroup("foreign");
  await backend.putSecret(`${g}/not-a-banto-alias`, "v");
  // **置き場で特定する**——同じ名前は過去の実行の残骸にもあるので、
  // 名前だけで引くと別のものを掴む（実際に掴んだ）
  const found = (await store.list()).find((a) => a.backendPath === `${g}/not-a-banto-alias`);
  assert.ok(found, "backend に既にある秘密が alias として出てこない");
  // **中身を見て推測しない**——種別は secret 扱い、置き場はそのまま
  assert.equal(found.kind, "secret");
  assert.equal(found.backendPath, `${g}/not-a-banto-alias`);
  await backend.deleteSecret(`${g}/not-a-banto-alias`);
});

// ---- Module として（kit との合成が本当に動くか）------------------------------

test("Module 越しに、登録 → 一覧 → 解決 → 削除が通る", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-test-"));
  const name = `mod-${Date.now().toString(36)}`;
  try {
    // **設定は画面から入れるのが本筋**（2026-09-13）。統合試験では、その
    // 保存先に直接置いてから起こす——実運用と同じ経路（保存 → 立ち上げ）
    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);

    // **同じ MCP の面が出ている**（kit が配線しているので当然だが、確かめる）
    const { tools } = await client.listTools();
    for (const expected of ["requestAlias", "resolveAlias", "createAlias", "generateSecret"]) {
      assert.ok(
        tools.some((t) => t.name === expected),
        `${expected} が無い`,
      );
    }

    await client.callTool({
      name: "createAlias",
      arguments: { name, kind: "secret", scope: "instance", value: "through-the-module", note: "統合試験" },
    });
    const resolved = await client.callTool({ name: "resolveAlias", arguments: { name }, _meta: ADMIN });
    assert.equal((resolved.content as { text: string }[])[0]?.text, "through-the-module");

    const read = await client.readResource({ uri: "vault://aliases", _meta: ADMIN });
    const list = JSON.parse((read.contents as { text: string }[])[0]!.text) as Array<Record<string, unknown>>;
    const mine = list.find((a) => a.name === name);
    assert.ok(mine, "一覧に出てこない");
    assert.equal(mine.note, "統合試験");
    // **値も backend 内のパスも漏れない**
    assert.equal(JSON.stringify(list).includes("through-the-module"), false);
    assert.equal(mine.backendPath, undefined);

    await client.callTool({ name: "deleteAlias", arguments: { name }, _meta: ADMIN });
    const after = await client.readResource({ uri: "vault://aliases" });
    assert.equal(
      (JSON.parse((after.contents as { text: string }[])[0]!.text) as Array<{ name: string }>).some(
        (a) => a.name === name,
      ),
      false,
    );
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("会話の中の入力欄は、Module ごとに別の URI を持つ", { skip }, async () => {
  // 2本並んだとき、どちらの画面かが URI から分かる必要がある
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-uri-"));
  try {
    // **設定は画面から入れるのが本筋**（2026-09-13）。統合試験では、その
    // 保存先に直接置いてから起こす——実運用と同じ経路（保存 → 立ち上げ）
    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes("ui://banto-vault-infisical/request"), `画面の URI が違う: ${uris.join(", ")}`);
    assert.ok(!uris.includes("ui://banto-vault/request"), "組み込み Vault と同じ URI を名乗っている");
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// **鍵ペアを作ると、名前が公開鍵に化けていた**（回帰・2026-09-13、ユーザー報告）。
//
// 台帳（注記）が alias 名を持たず「置き場から導ける」としていたが、
// **秘密鍵の置き場は backend が決める**（`ssh/<公開鍵の先頭>`）ので前提が崩れる。
// `github-ssh` として作った鍵が `AAAAC3NzaC1lZDI1` という名前で一覧に出た。
test("鍵ペアを作っても、alias は付けた名前のまま（公開鍵に化けない）", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-key-"));
  const name = `ssh-${Date.now().toString(36)}`;
  try {
    // **設定は画面から入れるのが本筋**（2026-09-13）。統合試験では、その
    // 保存先に直接置いてから起こす——実運用と同じ経路（保存 → 立ち上げ）
    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);

    const made = await client.callTool({
      name: "generateSecret",
      arguments: { name, kind: "ssh-identity", scope: "instance" },
    });
    const body = JSON.parse((made.content as { text: string }[])[0]!.text) as Record<string, string>;

    // **公開鍵は返る**——返らないと相手方に登録できない（画面に空の箱が出ていた）
    assert.match(body.publicKey ?? "", /^ssh-ed25519 AAAA/, "公開鍵が返っていない");
    assert.equal(body.name, name);
    // **秘密鍵は返らない**
    assert.equal(JSON.stringify(body).includes("PRIVATE KEY"), false);

    const read = await client.readResource({ uri: "vault://aliases", _meta: ADMIN });
    const list = JSON.parse((read.contents as { text: string }[])[0]!.text) as Array<Record<string, unknown>>;
    const mine = list.find((a) => a.name === name);
    assert.ok(mine, `一覧に「${name}」が無い（出ている名前: ${list.map((a) => a.name).join(", ")}）`);
    assert.equal(mine.kind, "ssh-identity");
    // 公開鍵の断片が名前に混ざっていないこと
    assert.equal(
      list.some((a) => String(a.name).startsWith("AAAA")),
      false,
      "公開鍵の断片が alias 名になっている",
    );

    await client.callTool({ name: "deleteAlias", arguments: { name }, _meta: ADMIN });
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// **backend に既にある秘密も alias として読む**（訂正・2026-09-13、ユーザー指摘）。
// 当初は「banto の注記が無い秘密は数えない」としていたが、**前提が逆だった**
// ——既に Infisical をフォルダで分けて使っている人にとって、そこに在る秘密は
// 混ざりものではなく本体。あわせて「黙って上書き」も塞がる（実測で踏んだ）。
test("banto 以外が置いた秘密も読める——そして同じ名前で上書きしない", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-read-"));
  const group = `human-${Date.now().toString(36)}`;
  const key = "DATABASE_URL";
  const conn = await connected();
  try {
    // 人が先に置いた秘密（banto の注記は無い。Infisical 自身の注記はある）
    await conn.folders().create({ ...conn.scope, name: group, path: "/" });
    await conn
      .secrets()
      .createSecret(key, { ...conn.scope, secretPath: `/${group}`, secretValue: "HUMAN", secretComment: "本番のDB" });

    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await client.callTool({ name: "setGroupBinding", arguments: { projectId: "p-read", group }, _meta: ADMIN });

    const list = JSON.parse(
      (
        (await client.callTool({ name: "listAliases", arguments: {}, _meta: ADMIN })).content as {
          text: string;
        }[]
      )[0]!.text,
    ) as Array<{ name: string; kind: string; note?: string; group: string }>;
    const mine = list.find((a) => a.name === key);
    assert.ok(mine, "人が置いた秘密が alias として見えない");
    // **中身を見て推測しない**——種別は secret 扱い
    assert.equal(mine.kind, "secret");
    // 用途は Infisical 側の注記をそのまま出す
    assert.equal(mine.note, "本番のDB");
    assert.equal(mine.group, group);

    // 値も読める（その Project から）
    const got = await client.callTool({
      name: "resolveAlias",
      arguments: { name: key },
      _meta: { "dev.banto/caller": { project: "p-read" } },
    });
    assert.equal((got.content as { text: string }[])[0]?.text, "HUMAN");

    // **同じ名前では登録させない**——以前はここで人の値を黙って上書きしていた
    await assert.rejects(
      () =>
        client.callTool({
          name: "createAlias",
          arguments: { name: key, kind: "secret", value: "BANTO", forProject: "p-read" },
          _meta: ADMIN,
        }),
      /には既に別の秘密があります/,
    );
    const after = await conn.secrets().getSecret({ ...conn.scope, secretName: key, secretPath: `/${group}` });
    assert.equal(after.secretValue, "HUMAN", "人が置いた値が上書きされた");

    await client.close();
  } finally {
    try {
      await conn.secrets().deleteSecret(key, { ...conn.scope, secretPath: `/${group}` });
    } catch {
      // 片づけの失敗は本題ではない
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ---- ログインを起動のたびに繰り返さない（追加・2026-09-20、ユーザー指示）-------
//
// Client Secret には**使用回数の上限**を付けられる。起動のたびに1回ログインして
// いたので、再起動のたびに残数が減り、実際に切れた
// （`Access denied due to client secret usage limit reached`、2026-09-20）。

/**
 * **「ログインしていない」をどう観測するか。**
 *
 * 回数は外から数えられないので、**Client Secret をでたらめに差し替える**。
 * それでも繋がるなら、ログインを通っていない——これ以外に区別のしようがない。
 */
test("2回目からはログインしない——覚えたトークンで繋ぐ", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "infisical-token-"));
  try {
    const tokens = new InfisicalTokenCache(dir);
    // 1回目：本物の資格情報でログインし、結果を覚える
    await new InfisicalConnection(config!, tokens).connect();

    // 2回目：**Client Secret を壊しても繋がる**（＝ログインしていない）
    const broken = { ...config!, clientSecret: "definitely-not-the-secret" };
    const second = new InfisicalConnection(broken, tokens);
    await second.connect();
    // 繋がっただけでなく、**実際に読める**（規則14——通った、では見たことにならない）
    assert.ok(Array.isArray(await new InfisicalBackend(second).listGroups()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("設定画面からの保存は、覚えたトークンで通さない——資格情報そのものを試す", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "infisical-token-force-"));
  try {
    const tokens = new InfisicalTokenCache(dir);
    await new InfisicalConnection(config!, tokens).connect();

    // **間違った Client Secret を貼ったら、繋がったことにしない**（規則1）
    const broken = { ...config!, clientSecret: "definitely-not-the-secret" };
    await assert.rejects(
      () => new InfisicalConnection(broken, tokens).connect({ forceLogin: true }),
      "間違った秘密でも「繋がった」ことになっている（覚えたトークンで通している）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("接続先が変われば、覚えたトークンは使わない", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "infisical-token-key-"));
  try {
    const tokens = new InfisicalTokenCache(dir);
    await new InfisicalConnection(config!, tokens).connect();
    // 別の Project のトークンとして読もうとしても、出てこない
    assert.equal(await tokens.load(tokenKeyOf({ ...config!, projectId: "another" })), undefined);
    assert.ok(await tokens.load(tokenKeyOf(config!)), "同じ接続なのに覚えていない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **参照**（決定・2026-10-04、仕様 §2.1 C節「参照」）。参照の置き場に秘密を1つ置き、
// 値は Infisical 自身の参照の書き方 `${環境.フォルダ.キー}`、注記に元の置き場（linkTo）。
// **Infisical がそれを展開すること**（banto の外の道具が読んでも元の値が取れる）と、
// **banto が linkTo を辿って元を引くこと**の両方を、本物で見る。
test("参照：Infisical 側で ${環境.フォルダ.キー} が元の値に展開され、banto からも参照で引ける", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-link-"));
  const src = uniqueGroup("link-src");
  const dst = uniqueGroup("link-dst");
  try {
    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const call = (name: string, args: Record<string, unknown>, meta: Record<string, unknown> = ADMIN) =>
      client.callTool({ name, arguments: args, _meta: meta });

    await call("createAlias", { name: "CF_TOKEN", kind: "secret", group: src, value: "cf-real-value" });
    await call("linkAlias", { name: "CF_TOKEN", group: src, toGroup: dst });

    // Infisical 自身が展開する（banto の外の道具の見え方）
    const conn = await connected();
    const raw = await conn.secrets().getSecret({
      ...conn.scope,
      secretName: "CF_TOKEN",
      secretPath: `/${dst}`,
      expandSecretReferences: false,
    });
    assert.equal(raw.secretValue, `\${${config!.environment}.${src}.CF_TOKEN}`);
    const expanded = await conn.secrets().getSecret({
      ...conn.scope,
      secretName: "CF_TOKEN",
      secretPath: `/${dst}`,
      expandSecretReferences: true,
    });
    assert.equal(expanded.secretValue, "cf-real-value", "Infisical が参照を展開していない");

    // banto は linkTo を辿る。一覧は注記の linkTo を落とさない
    const list = JSON.parse(
      ((await call("listAliases", {})).content as { text: string }[])[0]!.text,
    ) as Array<{ group: string; name: string; kind?: string; linkTo?: { group: string; name: string } }>;
    const link = list.find((a) => a.group === dst && a.name === "CF_TOKEN");
    assert.deepEqual(link?.linkTo, { group: src, name: "CF_TOKEN" });
    assert.equal(link?.kind, "secret");
    const resolved = await call("resolveAlias", { name: "CF_TOKEN", group: dst });
    assert.equal((resolved.content as { text: string }[])[0]!.text, "cf-real-value");

    // 元を移すと、注記と参照の書き方の両方が新しい場所を指す
    const moved = uniqueGroup("link-moved");
    await call("migrateAlias", { name: "CF_TOKEN", group: src, toGroup: moved });
    const relinked = await conn.secrets().getSecret({
      ...conn.scope,
      secretName: "CF_TOKEN",
      secretPath: `/${dst}`,
      expandSecretReferences: false,
    });
    assert.equal(relinked.secretValue, `\${${config!.environment}.${moved}.CF_TOKEN}`);
    assert.equal(
      ((await call("resolveAlias", { name: "CF_TOKEN", group: dst })).content as { text: string }[])[0]!.text,
      "cf-real-value",
    );

    // 参照を消しても元は残る
    await call("deleteAlias", { name: "CF_TOKEN", group: dst });
    assert.equal(
      ((await call("resolveAlias", { name: "CF_TOKEN", group: moved })).content as { text: string }[])[0]!.text,
      "cf-real-value",
    );
    await call("deleteAlias", { name: "CF_TOKEN", group: moved });
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// **Infisical の展開で、見えないグループの値を引き出せない**（2026-10-04、レビュー）。Project の刻印で
// 呼べる putSecret で自分のグループに `${環境.見えないフォルダ.キー}` を置いても、引いて返るのはその文字列。
test("参照の書き方を自分で置いても、見えないグループの値は返らない（Infisical に展開させない）", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-expand-"));
  const hidden = uniqueGroup("hidden");
  const mine = uniqueGroup("mine");
  try {
    await new InfisicalSettingsStore(dataDir).save(config!);
    const server = createInfisicalVaultServer(dataDir);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const project = { "dev.banto/caller": { project: `p-${mine}` } };
    await client.callTool({ name: "createAlias", arguments: { name: "SECRET", kind: "secret", group: hidden, value: "hidden-value" }, _meta: ADMIN });
    await client.callTool({ name: "setGroupBinding", arguments: { projectId: `p-${mine}`, group: mine }, _meta: ADMIN });
    const reference = `\${${config!.environment}.${hidden}.SECRET}`;
    await client.callTool({ name: "putSecret", arguments: { name: "STEAL", value: reference, forProject: `p-${mine}` }, _meta: project });
    const got = await client.callTool({ name: "resolveAlias", arguments: { name: "STEAL" }, _meta: project });
    assert.equal((got.content as { text: string }[])[0]!.text, reference, "見えないグループの値が返った");
    await client.callTool({ name: "deleteAlias", arguments: { name: "STEAL", group: mine }, _meta: ADMIN });
    await client.callTool({ name: "deleteAlias", arguments: { name: "SECRET", group: hidden }, _meta: ADMIN });
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("版（環境）：環境の一覧を Infisical の API から読み、g@prod は prod のフォルダに置いて一覧・数に出る（本物の Infisical で）", { skip }, async () => {
  const conn = await connected();
  const backend = new InfisicalBackend(conn);
  const store = new InfisicalAliasStore(conn);
  // SDK に口が無いので REST を直接呼んでいる（GET /api/v1/projects/{id}）——応答の形を本物で確かめる
  const axis = await backend.variants();
  assert.equal(axis.label, "環境");
  assert.equal(axis.default, config!.environment);
  assert.ok(axis.options.includes(config!.environment), `既定の環境が選択肢に無い: ${axis.options.join(",")}`);
  const other = axis.options.find((e) => e !== axis.default);
  assert.ok(other, "既定のほかに環境が無い（Infisical の Project の既定は dev/staging/prod）");

  const g = uniqueGroup("variant");
  await backend.putSecret(`${g}@${other}/sub/K`, "real");
  await backend.putSecret(`${g}/sub/K`, ""); // 既定の環境には名前だけの空欄
  assert.equal(await backend.getSecret(`${g}@${other}/sub/K`), "real");

  // フォルダを起点にした再帰の一覧が、絶対の道（/g/sub）を返すこと
  const rows = await store.list({ alsoGroups: [`${g}@${other}`] });
  const mine = rows.filter((a) => a.backendPath.startsWith(g));
  assert.deepEqual(
    mine.map((a) => [a.backendPath, a.name, a.empty ?? false]).sort(),
    [
      [`${g}/sub/K`, "sub/K", true],
      [`${g}@${other}/sub/K`, "sub/K", false],
    ],
  );
  const counts = await backend.countByVariant(g);
  assert.deepEqual(counts.find((c) => c.variant === other), { variant: other, filled: 1, total: 1 });
  assert.deepEqual(counts.find((c) => c.variant === axis.default), { variant: axis.default, filled: 0, total: 1 });

  await backend.deleteSecret(`${g}@${other}/sub/K`);
  await backend.deleteSecret(`${g}/sub/K`);
});
