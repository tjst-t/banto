// **既にある秘密の値を置き換える**（決定・2026-10-07、ユーザー。仕様 §2.1 C節 `replaceSecretValue`）。
//
// 以前は「差し替えは消して作る」だった——消すと用途・参照の指す先が切れ、作り直すまで名前が無くなる。
// 見るのは：人専用であること（AI に出ない・人の刻印が無ければ断る）、値を返さないこと、種別ごとの置き換え方
// （secret・file は value、ssh-identity は value か regenerate で公開鍵だけ返す）、断るもの（oauth-token・参照）、
// 読めない鍵を貼ったら元に戻すこと、版付きのグループの行はその置き場を置き換えること、置き換えた日時が台帳と一覧に残ること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;
/** 鍵として読める値の頭（偽の backend の publicKeyOf が見る）。 */
const KEY_HEAD = "-----BEGIN OPENSSH PRIVATE KEY-----";

/** 秘密を Map に持ち、呼ばれた口を記録する backend。鍵は「頭が KEY_HEAD なら読める」とする。 */
function fakeBackend() {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  let keyCount = 0;
  const backend: VaultBackend = {
    async getSecret(path) {
      const v = secrets.get(path);
      if (v === undefined) throw new Error(`vault secret not found: ${path}`);
      return v;
    },
    async putSecret(path, value) {
      calls.push(`put ${path}`);
      secrets.set(path, String(value));
    },
    async deleteSecret(path) {
      secrets.delete(path);
    },
    async listPaths() {
      return [...secrets.keys()];
    },
    async generateKeypair(_kind, path) {
      calls.push(`generateKeypair ${path}`);
      keyCount++;
      secrets.set(path, `${KEY_HEAD}\nmade-${keyCount}\n`);
      return { publicKey: `ssh-ed25519 MADE${keyCount}`, privateKeyRef: path };
    },
    async publicKeyOf(path) {
      const v = secrets.get(path) ?? "";
      // 実物の ssh-keygen は読めない鍵の断片を出力に含めうる——kit がそれを文言に載せないことを見るため、わざと含める。
      // 実物と同じく、CRLF の鍵・末尾に改行の無い鍵は読めない（実測 `error in libcrypto`、2026-10-07）
      if (!v.startsWith(KEY_HEAD) || v.includes("\r") || !v.endsWith("\n")) throw new Error(`ssh-keygen: invalid format: ${v}`);
      return `ssh-ed25519 PUB(${v.split("\n")[1]})`;
    },
    async loadIntoAgent() {
      throw new Error("使わない");
    },
    async listGroups() {
      return [];
    },
    async createGroup(name) {
      calls.push(`createGroup ${name}`);
    },
  };
  return { backend, secrets, calls };
}

async function withKit(fn: (c: Client, rec: ReturnType<typeof fakeBackend>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-replace-"));
  try {
    const rec = fakeBackend();
    const server = createVaultModuleServer({
      moduleName: "vault-test",
      backend: rec.backend,
      aliasStore: new LocalFileAliasStore(dir),
      dataDir: dir,
    });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await fn(client, rec);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (c: Client, name: string, args: Record<string, unknown>, meta: Record<string, unknown> = ADMIN) =>
  c.callTool({ name, arguments: args, _meta: meta });
const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;
async function list(c: Client): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(textOf(await call(c, "listAliases", {}))) as Array<Record<string, unknown>>;
}

test("secret・file は値を置き換える——値は返さず、置き換えた日時が台帳と一覧に残る", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "g", value: "old-secret" });
    await call(c, "createAlias", { name: "conf", kind: "file", group: "g", value: "a=1\n" });
    // 作っただけでは付かない（作った日時ではない）
    assert.equal((await list(c)).find((a) => a.name === "tok")!.valueUpdatedAt, undefined);

    const before = Date.now();
    const res = textOf(await call(c, "replaceSecretValue", { name: "tok", group: "g", value: "NEW-SECRET-VALUE" }));
    assert.doesNotMatch(res, /NEW-SECRET-VALUE|old-secret/, "答えに値が載っている");
    assert.deepEqual(JSON.parse(res), { ok: true, name: "tok", group: "g", kind: "secret" });
    assert.equal(rec.secrets.get("g/tok"), "NEW-SECRET-VALUE");
    await call(c, "replaceSecretValue", { name: "conf", group: "g", value: "a=2\nb=3\n" });
    assert.equal(rec.secrets.get("g/conf"), "a=2\nb=3\n");

    const rows = await list(c);
    const at = Date.parse(String(rows.find((a) => a.name === "tok")!.valueUpdatedAt));
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `置き換えた日時が残っていない: ${String(at)}`);
    assert.ok(rows.find((a) => a.name === "conf")!.valueUpdatedAt);
    assert.doesNotMatch(JSON.stringify(rows), /NEW-SECRET-VALUE/);
    // 引けば新しい値
    const got = await call(c, "resolveAlias", { name: "tok", group: "g" });
    assert.equal(textOf(got), "NEW-SECRET-VALUE");
  });
});

test("ssh-identity：貼った秘密鍵で置き換え、新しい公開鍵だけを返す。作り直し（regenerate）は backend に作らせる", async () => {
  await withKit(async (c, rec) => {
    await call(c, "generateSecret", { name: "deploy", kind: "ssh-identity", group: "keys" });
    rec.calls.length = 0;

    const pasted = await call(c, "replaceSecretValue", { name: "deploy", group: "keys", value: `${KEY_HEAD}\npasted\n` });
    const body = JSON.parse(textOf(pasted)) as Record<string, unknown>;
    assert.equal(body.publicKey, "ssh-ed25519 PUB(pasted)");
    assert.doesNotMatch(textOf(pasted), /PRIVATE KEY/, "秘密鍵が答えに載っている");
    assert.equal(rec.secrets.get("keys/deploy"), `${KEY_HEAD}\npasted\n`);

    const regen = JSON.parse(textOf(await call(c, "replaceSecretValue", { name: "deploy", group: "keys", regenerate: true })));
    assert.equal(regen.publicKey, "ssh-ed25519 MADE2");
    assert.ok(rec.calls.includes("generateKeypair keys/deploy"), `同じ置き場に作り直していない: ${rec.calls.join(", ")}`);
    assert.ok((await list(c)).find((a) => a.name === "deploy")!.valueUpdatedAt);
  });
});

test("ssh-identity：鍵として読めないものを貼ったら、元の鍵に戻して断る（貼ったものは文言に出さない）", async () => {
  await withKit(async (c, rec) => {
    await call(c, "generateSecret", { name: "deploy", kind: "ssh-identity", group: "keys" });
    const original = rec.secrets.get("keys/deploy");
    await assert.rejects(
      () => call(c, "replaceSecretValue", { name: "deploy", group: "keys", value: "NOT-A-KEY-PASTED" }),
      (err: Error) => {
        assert.match(err.message, /秘密鍵として読めませんでした。"deploy" は元の鍵のままです/);
        assert.doesNotMatch(err.message, /NOT-A-KEY-PASTED/, "貼ったものが文言に出ている");
        return true;
      },
    );
    assert.equal(rec.secrets.get("keys/deploy"), original, "読めない鍵が残っている");
    assert.equal((await list(c)).find((a) => a.name === "deploy")!.valueUpdatedAt, undefined, "置き換えていないのに日時が付いた");
  });
});

test("引数の取り違えは断る——value と regenerate の両方・どちらも無い・secret に regenerate", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "g", value: "v1" });
    await call(c, "generateSecret", { name: "deploy", kind: "ssh-identity", group: "keys" });
    rec.calls.length = 0;
    await assert.rejects(() => call(c, "replaceSecretValue", { name: "deploy", group: "keys", value: `${KEY_HEAD}\nx\n`, regenerate: true }), /一緒に渡せません/);
    await assert.rejects(() => call(c, "replaceSecretValue", { name: "tok", group: "g" }), /value.*か regenerate: true が要ります/);
    await assert.rejects(() => call(c, "replaceSecretValue", { name: "tok", group: "g", regenerate: true }), /regenerate は ssh-identity だけです/);
    await assert.rejects(() => call(c, "replaceSecretValue", { name: "tok", group: "g", value: "" }), /value が要ります/);
    await assert.rejects(() => call(c, "replaceSecretValue", { name: "nope", group: "g", value: "x" }), /"nope" は g にありません/);
    assert.deepEqual(rec.calls, [], `断る前に backend に触った: ${rec.calls.join(", ")}`);
  });
});

test("参照は断って元の場所を言う、banto が置くログイン情報（oauth-token）も断る——どちらも値に触らない", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "tok", kind: "secret", group: "src", value: "v1" });
    await call(c, "linkAlias", { name: "tok", group: "src", toGroup: "dst", toName: "tok2" });
    await call(c, "putSecret", { name: "gh-login", value: "oauth-v1", group: "g" });
    rec.calls.length = 0;

    await assert.rejects(
      () => call(c, "replaceSecretValue", { name: "tok2", group: "dst", value: "x" }),
      /"tok2" は参照です。値は元の場所（vault-test\/src\/tok）で変えてください/,
    );
    await assert.rejects(
      () => call(c, "replaceSecretValue", { name: "gh-login", group: "g", value: "x" }),
      /banto が置くログイン情報（oauth-token）です。手では置き換えられません/,
    );
    assert.deepEqual(rec.calls, [], `断ったのに backend に触った: ${rec.calls.join(", ")}`);
    assert.equal(rec.secrets.get("src/tok"), "v1");
    assert.equal(rec.secrets.get("g/gh-login"), "oauth-v1");
  });
});

test("人専用——AI の一覧に出ない（admin）、人の刻印が無い呼び出し（Project・banto 全体・刻印なし）は断る", async () => {
  await withKit(async (c, rec) => {
    const { tools } = await c.listTools();
    const t = tools.find((x) => x.name === "replaceSecretValue")!;
    assert.equal(t._meta?.["dev.banto/visibility"], "admin");
    // 監査に残す引数に値は無い
    assert.ok(!(t._meta?.["dev.banto/auditArgs"] as string[]).includes("value"));

    await call(c, "createAlias", { name: "tok", kind: "secret", group: "g", value: "v1" });
    for (const meta of [{ "dev.banto/caller": { project: "P" } }, { "dev.banto/caller": { instance: true } }, {}]) {
      await assert.rejects(
        () => call(c, "replaceSecretValue", { name: "tok", group: "g", value: "x" }, meta),
        /値の置き換え は人の管理画面からしか行えません/,
      );
    }
    assert.equal(rec.secrets.get("g/tok"), "v1");
  });
});

test("版付きのグループの行は、その行の置き場（g@prod）の値を置き換える——既定の版の同名には触らない", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "HOST", kind: "secret", group: "homelab", value: "dev-host" });
    await call(c, "createAlias", { name: "HOST", kind: "secret", group: "homelab@prod", value: "prod-host" });
    await call(c, "replaceSecretValue", { name: "HOST", group: "homelab@prod", value: "prod-host-2" });
    assert.equal(rec.secrets.get("homelab@prod/HOST"), "prod-host-2");
    assert.equal(rec.secrets.get("homelab/HOST"), "dev-host");
  });
});

test("describeGroups：backend が名乗った添え書きを返し、名乗らなければ null", async () => {
  await withKit(async (c) => {
    assert.deepEqual(JSON.parse(textOf(await call(c, "describeGroups", {}))), { createNote: null });
  });
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-describe-"));
  try {
    const server = createVaultModuleServer({
      moduleName: "vault-test",
      backend: fakeBackend().backend,
      aliasStore: new LocalFileAliasStore(dir),
      dataDir: dir,
      groupCreateNote: "フォルダができます",
    });
    const [s, cl] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(cl)]);
    assert.deepEqual(JSON.parse(textOf(await call(client, "describeGroups", {}))), { createNote: "フォルダができます" });
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **貼った SSH の秘密鍵の改行をそろえる**（2026-10-07、レビュー）。ssh-keygen は末尾に改行の無い鍵・CRLF の鍵を読めないので、
// 置く前に `\r` を除いて末尾に `\n` を補う。**ssh-identity だけ**——secret・file の値は1バイトも変えない
test("ssh-identity の貼った鍵は CRLF を LF にし末尾の改行を補ってから置く（作る・置き換えるの両方）。secret・file は変えない", async () => {
  await withKit(async (c, rec) => {
    await call(c, "createAlias", { name: "k1", kind: "ssh-identity", group: "keys", value: `${KEY_HEAD}\r\nbody1\r\n-----END-----` });
    assert.equal(rec.secrets.get("keys/k1"), `${KEY_HEAD}\nbody1\n-----END-----\n`);
    const pub = await call(c, "getPublicKey", { name: "k1", group: "keys" });
    assert.equal(textOf(pub), "ssh-ed25519 PUB(body1)");

    const replaced = await call(c, "replaceSecretValue", { name: "k1", group: "keys", value: `${KEY_HEAD}\r\nbody2` });
    assert.equal(JSON.parse(textOf(replaced)).publicKey, "ssh-ed25519 PUB(body2)");
    assert.equal(rec.secrets.get("keys/k1"), `${KEY_HEAD}\nbody2\n`);

    // secret・file は貼られたとおり（\r も末尾の改行の無さも保つ）
    await call(c, "createAlias", { name: "s", kind: "secret", group: "g", value: "a\r\nb" });
    await call(c, "createAlias", { name: "f", kind: "file", group: "g", value: "x=1\r\ny=2" });
    assert.equal(rec.secrets.get("g/s"), "a\r\nb");
    assert.equal(rec.secrets.get("g/f"), "x=1\r\ny=2");
    await call(c, "replaceSecretValue", { name: "s", group: "g", value: "c\r\nd" });
    await call(c, "replaceSecretValue", { name: "f", group: "g", value: "z=3\r\n" });
    assert.equal(rec.secrets.get("g/s"), "c\r\nd");
    assert.equal(rec.secrets.get("g/f"), "z=3\r\n");
  });
});

test("読めない鍵を貼り、元の鍵にも戻せなかったら、そう言う——backend の失敗の文言は載せない", async () => {
  await withKit(async (c, rec) => {
    await call(c, "generateSecret", { name: "deploy", kind: "ssh-identity", group: "keys" });
    let puts = 0;
    const realPut = rec.backend.putSecret.bind(rec.backend);
    rec.backend.putSecret = async (path, value) => {
      puts++;
      // 1回目（貼ったものを置く）は通し、2回目（元に戻す）で落とす。文言に値の断片を混ぜる
      if (puts === 2) throw new Error(`BACKEND-DETAIL ${String(value).slice(0, 20)}`);
      return realPut(path, value);
    };
    await assert.rejects(
      () => call(c, "replaceSecretValue", { name: "deploy", group: "keys", value: "NOT-A-KEY-PASTED" }),
      (err: Error) => {
        assert.match(err.message, /元の鍵にも戻せませんでした/);
        assert.doesNotMatch(err.message, /BACKEND-DETAIL|NOT-A-KEY|PRIVATE KEY/, `backend の文言が載っている: ${err.message}`);
        return true;
      },
    );
  });
});

// **createGroup の口は人専用**（2026-10-07、レビュー）。台帳・置き場を変える他の口と揃える。kit の中で置くついでに作る
// （putSecret・createAlias の groupForNewAlias）は口を通らないので、Module からの置き場づくりは今までどおり
test("createGroup の口は人の刻印が無ければ断る（作らない）。人の口は通り、置くついでに作るのは Module からでも通る", async () => {
  await withKit(async (c, rec) => {
    for (const meta of [{ "dev.banto/caller": { project: "P" } }, { "dev.banto/caller": { instance: true } }, {}]) {
      await assert.rejects(() => call(c, "createGroup", { name: "g1" }, meta), /グループの作成 は人の管理画面からしか行えません/);
    }
    assert.ok(!rec.calls.includes("createGroup g1"), "断ったのに作った");
    await call(c, "createGroup", { name: "g1" });
    assert.ok(rec.calls.includes("createGroup g1"), "人の口から作れない");
    // banto が置く秘密を Module が置くと、置き場のグループはついでに作られる（口を通らない）
    await call(c, "putSecret", { name: "tok", value: "v", group: "g2" }, {
      "dev.banto/caller": { instance: true },
      "dev.banto/callerModule": { name: "repositories", conn: "repositories" },
    });
    assert.ok(rec.calls.includes("createGroup g2"), "置くついでのグループづくりまで止めた");
  });
});
