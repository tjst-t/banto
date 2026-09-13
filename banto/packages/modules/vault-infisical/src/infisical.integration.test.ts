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
import { createInfisicalVaultServer } from "./server.js";

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
  const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh");
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
    scope: "project",
    projectId: "proj-x",
    note: "CI 用",
    backendPath: `${g}/${name}`,
  });

  // **別のホストのつもりで、新しい接続から読む**（手元の写しを一切使わない）
  const otherHost = new InfisicalAliasStore(await connected());
  const seen = await otherHost.get(name);
  assert.ok(seen, "別のホストから alias が見えない（メタデータが手元にしか無い）");
  assert.equal(seen.kind, "secret");
  assert.equal(seen.projectId, "proj-x");
  assert.equal(seen.note, "CI 用");
  assert.equal(seen.backendPath, `${g}/${name}`);

  await store.markUsed(name);
  assert.ok((await otherHost.get(name))?.lastUsedAt, "使った印も共有されていない");

  await backend.deleteSecret(`${g}/${name}`);
  assert.equal(await otherHost.get(name), undefined, "消しても残っている");
});

test("banto が付けた注記の無い秘密は、alias として数えない", { skip }, async () => {
  // Infisical は banto 以外からも書ける。**注記が無いものを「たぶん secret」と
  // 見なすと、人が別の用途で置いた秘密まで一覧に混ざる**（規則2）
  const conn = await connected();
  const backend = new InfisicalBackend(conn);
  const store = new InfisicalAliasStore(conn);
  const g = uniqueGroup("foreign");
  await backend.putSecret(`${g}/not-a-banto-alias`, "v");
  const all = await store.list();
  assert.equal(
    all.some((a) => a.name === "not-a-banto-alias"),
    false,
    "banto が管理していない秘密が alias として出ている",
  );
  await backend.deleteSecret(`${g}/not-a-banto-alias`);
});

// ---- Module として（kit との合成が本当に動くか）------------------------------

test("Module 越しに、登録 → 一覧 → 解決 → 削除が通る", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-vault-infisical-test-"));
  const name = `mod-${Date.now().toString(36)}`;
  try {
    const server = createInfisicalVaultServer(config!, dataDir);
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
    const resolved = await client.callTool({ name: "resolveAlias", arguments: { name } });
    assert.equal((resolved.content as { text: string }[])[0]?.text, "through-the-module");

    const read = await client.readResource({ uri: "vault://aliases" });
    const list = JSON.parse((read.contents as { text: string }[])[0]!.text) as Array<Record<string, unknown>>;
    const mine = list.find((a) => a.name === name);
    assert.ok(mine, "一覧に出てこない");
    assert.equal(mine.note, "統合試験");
    // **値も backend 内のパスも漏れない**
    assert.equal(JSON.stringify(list).includes("through-the-module"), false);
    assert.equal(mine.backendPath, undefined);

    await client.callTool({ name: "deleteAlias", arguments: { name } });
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
    const server = createInfisicalVaultServer(config!, dataDir);
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
    const server = createInfisicalVaultServer(config!, dataDir);
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

    const read = await client.readResource({ uri: "vault://aliases" });
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

    await client.callTool({ name: "deleteAlias", arguments: { name } });
    await client.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
