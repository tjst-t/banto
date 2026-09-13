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
  const seen = await otherHost.get(name);
  assert.ok(seen, "別のホストから alias が見えない（メタデータが手元にしか無い）");
  assert.equal(seen.kind, "secret");
  assert.equal(seen.name, name, "alias 名が置き場から作り直されている");
  assert.equal(seen.note, "CI 用");
  assert.equal(seen.backendPath, `${g}/${name}`);

  await store.markUsed(name);
  assert.ok((await otherHost.get(name))?.lastUsedAt, "使った印も共有されていない");

  await backend.deleteSecret(`${g}/${name}`);
  assert.equal(await otherHost.get(name), undefined, "消しても残っている");
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
      /既にあります/,
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
