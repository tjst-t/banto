// **続けて来た一覧は分け合う／回数制限は言われた秒数だけ待つ**（2026-10-18、Backlog #389）。
// runCommand に alias を25件渡すと、alias ごとに一覧を読み直して Infisical の回数制限（429）に当たっていた。
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { retryOnRateLimit } from "./client.js";
import { fakeConnection } from "./testing/fake-connection.js";

function seeded() {
  const fake = fakeConnection();
  fake.folders.add("/g");
  fake.secrets.set("/g\0A", { secretValue: "a", secretComment: JSON.stringify({ name: "A", kind: "secret" }) });
  return fake;
}

test("続けて来た一覧は1回の listSecrets を分け合う（同時に来たものも、少し後に来たものも）", async () => {
  const { conn, listOptions } = seeded();
  let now = 1_000;
  const store = new InfisicalAliasStore(conn, () => now);
  await Promise.all([store.list(), store.list(), store.list()]);
  now += 4_000;
  await store.list();
  assert.equal(listOptions.length, 1, `一覧を読み直した: ${listOptions.length} 回`);
});

test("使われないまま 5 秒経つか、最初に読んでから 30 秒経ったら読み直す", async () => {
  const { conn, listOptions } = seeded();
  let now = 0;
  const store = new InfisicalAliasStore(conn, () => now);
  await store.list();
  now = 5_001;
  await store.list();
  assert.equal(listOptions.length, 2, "使われないまま 5 秒経っても読み直さなかった");
  // 使われ続けていても、最初に読んでから 30 秒で読み直す（別のホストの変更が見えないままにならない）
  for (now = 9_000; now <= 5_001 + 30_000; now += 4_000) await store.list();
  await store.list();
  assert.equal(listOptions.length, 3, `30 秒で読み直さなかった: ${listOptions.length} 回`);
});

test("自分が書いたら分け合っている一覧を捨てる——書いたものがすぐ一覧に出る", async () => {
  const { conn, secrets } = seeded();
  const store = new InfisicalAliasStore(conn, () => 0);
  const backend = new InfisicalBackend(conn, () => store.forget());
  assert.equal((await store.list()).length, 1);
  await backend.putSecret("g/B", "b");
  await store.create({ name: "B", kind: "secret", backendPath: "g/B" });
  assert.deepEqual((await store.list()).map((a) => a.name).sort(), ["A", "B"]);
  // 値を空にしたら、一覧の「空」の印もすぐ変わる（backend の書き込みでも捨てる）
  await backend.putSecret("g/B", "");
  assert.equal((await store.list()).find((a) => a.name === "B")?.empty, true);
  await backend.deleteSecret("g/B");
  assert.deepEqual((await store.list()).map((a) => a.name), ["A"]);
  assert.equal(secrets.has("/g\0B"), false);
});

test("使った日を書くのに一覧を読み直さない——分け合っている行を元に書き、行の使った日も変わる", async () => {
  const { conn, listOptions, secrets } = seeded();
  const store = new InfisicalAliasStore(conn, () => 0);
  await store.list();
  await store.markUsed("g/A");
  assert.equal(listOptions.length, 1, `使った日を書くのに読み直した: ${JSON.stringify(listOptions)}`);
  const written = JSON.parse(secrets.get("/g\0A")!.secretComment!);
  assert.equal(written.name, "A");
  assert.ok(written.lastUsedAt);
  assert.equal((await store.list())[0]!.lastUsedAt, written.lastUsedAt);
  assert.equal(listOptions.length, 1);
});

test("読めなかった一覧は分け合わない——次の呼び出しは読み直す", async () => {
  const { conn, listOptions } = fakeConnection({ rateLimit: { calls: 0, persistent: true } });
  const store = new InfisicalAliasStore(conn, () => 0);
  await assert.rejects(store.list(), /回数制限で読めませんでした/);
  await assert.rejects(store.list(), /回数制限で読めませんでした/);
  assert.equal(listOptions.length, 0); // 偽の Infisical まで届く前に断られている
});

test("429 は言われた秒数（+1 秒）だけ待って試し直す", async () => {
  const { conn, sleeps } = seededWithLimit();
  const store = new InfisicalAliasStore(conn, () => 0);
  await store.list(); // 1回目は通る
  await store.markUsed("g/A"); // 2回目（updateSecret）は 429 → 待って通る
  assert.deepEqual(sleeps, [14_000]);
});

function seededWithLimit() {
  const fake = fakeConnection({ rateLimit: { calls: 1 } });
  fake.folders.add("/g");
  fake.secrets.set("/g\0A", { secretValue: "a", secretComment: JSON.stringify({ name: "A", kind: "secret" }) });
  return fake;
}

test("429 が続くなら、合計 30 秒まで待ってから「回数制限で読めませんでした（N 秒後に）」で断る", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const api = retryOnRateLimit(
    {
      async listSecrets() {
        calls++;
        throw new Error("[URL=/api/v3/secrets/raw] [Method=get] [StatusCode=429] Rate limit exceeded. Please try again in 13 seconds");
      },
      async updateSecret() {
        throw new Error("[StatusCode=429] Rate limit exceeded. Please try again in 40 seconds");
      },
    },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  await assert.rejects(api.listSecrets(), (err: Error) => {
    assert.match(err.message, /^Infisical の回数制限で読めませんでした（14 秒後にもう一度試してください。28 秒待って試し直しても断られました）/);
    return true;
  });
  assert.deepEqual(sleeps, [14_000, 14_000]);
  assert.equal(calls, 3);
  // 書き込みは「書けませんでした」。予算を超える待ちは待たずに断る
  await assert.rejects(api.updateSecret(), /Infisical の回数制限で書けませんでした（41 秒後にもう一度試してください。待つと 30 秒を超えるので試し直していません）/);
  assert.equal(sleeps.length, 2);
});

test("429 でない失敗は試し直さない", async () => {
  const sleeps: number[] = [];
  const api = retryOnRateLimit(
    { async getSecret() { throw new Error("[StatusCode=404] Secret not found"); } },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  await assert.rejects(api.getSecret(), /StatusCode=404/);
  assert.deepEqual(sleeps, []);
});
