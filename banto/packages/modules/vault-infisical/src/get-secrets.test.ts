// **まとめて引く——Infisical の getSecrets と markUsedMany**（2026-10-18、仕様 §2.1「Infisical の getSecrets」）。
//
// 値は（環境・グループの根）ごとに listSecrets を1回、使った日は（環境・フォルダ）ごとに v4 の一括更新を1回。
// 偽の Infisical への呼び出しを数えて、回数が alias の数に比例しないことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "@banto/vault-kit";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { InfisicalConnection } from "./client.js";
import { fakeConnection } from "./testing/fake-connection.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;

/** 30件：/g1 に10・/g1/sub に5・/g2 に10・prod の /g3 に5。根は3つ、（環境・フォルダ）は4つ */
function seeded() {
  const fake = fakeConnection({ environment: "dev", environments: ["dev", "prod"] });
  for (const f of ["/g1", "/g1/sub", "/g2", "prod|/g3"]) fake.folders.add(f);
  const items: Array<{ name: string; group?: string }> = [];
  const expected = new Map<string, string>();
  const put = (where: string, key: string, name: string, group?: string) => {
    const value = `value-of-${name}`;
    fake.secrets.set(`${where}\0${key}`, { secretValue: value, secretComment: JSON.stringify({ name, kind: "secret" }) });
    items.push(group ? { name, group } : { name });
    expected.set(name, value);
  };
  for (let i = 0; i < 10; i++) put("/g1", `A${i}`, `A${i}`);
  for (let i = 0; i < 5; i++) put("/g1/sub", `S${i}`, `S${i}`);
  for (let i = 0; i < 10; i++) put("/g2", `B${i}`, `B${i}`);
  for (let i = 0; i < 5; i++) put("prod|/g3", `P${i}`, `P${i}`, "g3@prod");
  // 頼まれていない値（一覧には出るが、返してはいけない）
  fake.secrets.set("/g1\0OTHER", { secretValue: "not-asked-for", secretComment: JSON.stringify({ name: "OTHER", kind: "secret" }) });
  return { ...fake, items, expected };
}

async function withServer(
  fake: ReturnType<typeof seeded>,
  fn: (c: Client, store: InfisicalAliasStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "infisical-batch-"));
  try {
    const store = new InfisicalAliasStore(fake.conn);
    const backend = new InfisicalBackend(fake.conn, () => store.forget());
    const server = createVaultModuleServer({ moduleName: "vault-infisical", backend, aliasStore: store, dataDir: dir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(b);
    try {
      await fn(client, store);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function resolveAll(c: Client, items: unknown[]): Promise<Array<{ name: string; value: string }>> {
  const res = await c.callTool({ name: "resolveAliases", arguments: { items }, _meta: ADMIN });
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  assert.equal(res.isError, undefined, text);
  return (JSON.parse(text) as { values: Array<{ name: string; value: string }> }).values;
}

/** 分け合っている一覧の中身（試験のために中を覗く） */
async function sharedRows(store: InfisicalAliasStore): Promise<unknown[]> {
  const shared = (store as unknown as { shared: Map<string, { rows: Promise<unknown[]> }> }).shared;
  return (await Promise.all([...shared.values()].map((e) => e.rows))).flat();
}

const lastUsedOf = (fake: ReturnType<typeof seeded>, key: string) =>
  JSON.parse(fake.secrets.get(key)!.secretComment!).lastUsedAt as string | undefined;

test("30件の resolveAliases：listSecrets は一覧も値もグループの数だけ、使った日の書き込みは（環境・フォルダ）の数だけ", async () => {
  const fake = seeded();
  await withServer(fake, async (c, store) => {
    const values = await resolveAll(c, fake.items);
    assert.deepEqual(
      values.map((v) => [v.name, v.value]),
      fake.items.map((i) => [i.name, fake.expected.get(i.name)]),
    );
    // 一覧：既定の環境の根を1回＋紐付けた版（g3@prod）を1回。値：根（dev の g1・g2、prod の g3）ごとに1回
    const reads = fake.listOptions.map((o) => `${o.environment as string} ${o.secretPath as string}`).sort();
    assert.deepEqual(reads, ["dev /", "dev /g1", "dev /g2", "prod /g3", "prod /g3"], JSON.stringify(fake.listOptions));
    // 値の一覧は getSecret と同じ読み方
    for (const o of fake.listOptions.filter((o) => o.secretPath !== "/")) {
      assert.equal(o.recursive, true);
      assert.equal(o.viewSecretValue, true);
      assert.equal(o.expandSecretReferences, false);
    }
    // 使った日：（環境・フォルダ）ごとに一括更新1回。1件ずつの書き込みは出ない
    assert.deepEqual(
      fake.batchCalls.map((b) => `${b.environment as string} ${b.secretPath as string} ${(b.secrets as unknown[]).length}`).sort(),
      ["dev /g1 10", "dev /g1/sub 5", "dev /g2 10", "prod /g3 5"],
    );
    assert.equal(fake.updateCalls.length, 0);
    assert.ok(lastUsedOf(fake, "/g1/sub\0S3"));
    assert.ok(lastUsedOf(fake, "prod|/g3\0P0"));
    assert.equal(lastUsedOf(fake, "/g1\0OTHER"), undefined, "頼まれていないものの使った日を書いた");
    // 注記の中身は元のまま（名前・種別を落とさない）
    assert.equal(JSON.parse(fake.secrets.get("/g2\0B4")!.secretComment!).name, "B4");

    // 分け合う一覧に値は入らない。行の使った日は直っている（読み直さずに）
    const rows = await sharedRows(store);
    assert.ok(rows.length > 0);
    const dump = JSON.stringify(rows);
    for (const v of [...fake.expected.values(), "not-asked-for"]) assert.ok(!dump.includes(v), `分け合う一覧に値が入った: ${v}`);
    const before = fake.listOptions.length;
    const listed = await store.list();
    assert.equal(fake.listOptions.length, before, "一覧を読み直した");
    assert.equal(listed.find((a) => a.name === "A0")!.lastUsedAt, lastUsedOf(fake, "/g1\0A0"));
  });
});

test("値を読む権限が無ければ、全部を getSecret の1件ずつに落とす", async () => {
  const fake = seeded();
  const real = fake.conn.secrets;
  const gets: string[] = [];
  (fake.conn as unknown as { secrets: () => unknown }).secrets = () => {
    const api = real.call(fake.conn) as unknown as Record<string, (o: Record<string, unknown>) => Promise<unknown>>;
    return {
      ...api,
      listSecrets: async (o: Record<string, unknown>) => {
        if (o.viewSecretValue === true) throw new Error("[StatusCode=403] You are not allowed to read secret values");
        return api.listSecrets!(o);
      },
      getSecret: async (o: Record<string, unknown>) => {
        gets.push(`${o.environment as string} ${o.secretPath as string}/${o.secretName as string}`);
        return api.getSecret!(o);
      },
    };
  };
  await withServer(fake, async (c) => {
    const values = await resolveAll(c, fake.items);
    assert.deepEqual(values.map((v) => v.value), fake.items.map((i) => fake.expected.get(i.name)));
    assert.equal(gets.length, 30, gets.join(", "));
  });
});

test("一括更新が失敗したら、そのフォルダは1件ずつ書く（値は渡さない）", async () => {
  const fake = seeded();
  fake.control.failBatch = true;
  await withServer(fake, async (c) => {
    const values = await resolveAll(c, fake.items);
    assert.equal(values.length, 30);
    assert.equal(fake.batchCalls.length, 4);
    assert.equal(fake.updateCalls.length, 30);
    // 1件ずつの書き込みも値は渡さない
    assert.ok(fake.updateCalls.every((u) => u.secretValue === undefined));
    assert.ok(lastUsedOf(fake, "/g1\0A9"));
    assert.ok(lastUsedOf(fake, "prod|/g3\0P4"));
  });
});

test("一覧に見つからないパスだけ getSecret で読み直す。読めなければ投げる", async () => {
  const fake = seeded();
  const real = fake.conn.secrets;
  const gets: string[] = [];
  (fake.conn as unknown as { secrets: () => unknown }).secrets = () => {
    const api = real.call(fake.conn) as unknown as Record<string, (o: Record<string, unknown>) => Promise<unknown>>;
    return {
      ...api,
      // 一覧に A3 が出てこない（一覧の取りこぼし）
      listSecrets: async (o: Record<string, unknown>) => {
        const listed = (await api.listSecrets!(o)) as { secrets: Array<{ secretKey: string }> };
        return { secrets: listed.secrets.filter((s) => s.secretKey !== "A3") };
      },
      getSecret: async (o: Record<string, unknown>) => {
        gets.push(`${o.secretPath as string}/${o.secretName as string}`);
        return api.getSecret!(o);
      },
    };
  };
  const backend = new InfisicalBackend(fake.conn);
  const got = await backend.getSecrets(["g1/A1", "g1/A3", "g1/sub/S0", "g3@prod/P2"]);
  assert.deepEqual(Object.fromEntries(got), {
    "g1/A1": "value-of-A1",
    "g1/A3": "value-of-A3",
    "g1/sub/S0": "value-of-S0",
    "g3@prod/P2": "value-of-P2",
  });
  assert.deepEqual(gets, ["/g1/A3"]);
  await assert.rejects(backend.getSecrets(["g1/A1", "g1/NOPE"]), /not found/);
});

test("一括更新は PATCH /api/v4/secrets/batch を接続の認証で呼び、値を渡さない。断られたら状態符号つきで投げる", async () => {
  const seen: Array<{ method?: string; url?: string; auth?: string; body: unknown }> = [];
  let status = 200;
  let reply = "{}";
  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { "Content-Type": "application/json" }).end(reply);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const port = (http.address() as { port: number }).port;
    const conn = new InfisicalConnection({
      siteUrl: `http://127.0.0.1:${port}/`,
      clientId: "id",
      clientSecret: "secret",
      projectId: "p1",
      environment: "dev",
    });
    // ログイン済みの SDK の代わり（トークンを返すだけ）
    (conn as unknown as { sdk: unknown }).sdk = { auth: () => ({ getAccessToken: () => "tok" }) };
    const update = {
      projectId: "p1",
      environment: "dev",
      secretPath: "/g",
      secrets: [{ secretKey: "K", secretComment: "{}" }],
    };
    await conn.batch().updateSecrets(update);
    assert.deepEqual(seen[0], {
      method: "PATCH",
      url: "/api/v4/secrets/batch",
      auth: "Bearer tok",
      body: { projectId: "p1", environment: "dev", secretPath: "/g", secrets: [{ secretKey: "K", secretComment: "{}" }] },
    });

    status = 404;
    reply = JSON.stringify({ message: "Secret not found" });
    await assert.rejects(conn.batch().updateSecrets(update), /\[StatusCode=404\] Secret not found/);
    // 429 は retryOnRateLimit が見分ける（待つと 30 秒を超えるので待たずに断る）
    status = 429;
    reply = JSON.stringify({ message: "Rate limit exceeded. Please try again in 40 seconds" });
    await assert.rejects(conn.batch().updateSecrets(update), /Infisical の回数制限で書けませんでした（41 秒後に/);
  } finally {
    http.close();
  }
});
