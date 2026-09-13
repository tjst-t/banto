// **繋ぎ方は人が画面から入れる**（決定・2026-09-13、ユーザー要望）。
// ここで押さえるのは3つ：
//   1. 足りない設定を黙って既定に倒さない（規則2）
//   2. **Client Secret は画面に返さない**——入っているかどうかだけ
//   3. 保存先は**この Module の中**（banto の Event Store ではない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_SITES, InfisicalSettingsStore, toConfig, viewOf } from "./settings-store.js";

const FULL = { clientId: "id", clientSecret: "shhh", projectId: "p1" };

test("接続先は Cloud（US/EU）か自前——自前なら URL が要る", () => {
  assert.equal(toConfig({ target: "us", ...FULL }).siteUrl, CLOUD_SITES.us);
  assert.equal(toConfig({ target: "eu", ...FULL }).siteUrl, CLOUD_SITES.eu);
  assert.equal(toConfig({ target: "self", siteUrl: "http://127.0.0.1:8088", ...FULL }).siteUrl, "http://127.0.0.1:8088");

  // **足りないものを既定で埋めない**（規則2）
  assert.throws(() => toConfig({ target: "self", ...FULL }), /接続先の URL が要ります/);
  assert.throws(() => toConfig({ target: "self", siteUrl: "127.0.0.1:8088", ...FULL }), /http:\/\/ か https:\/\//);
  assert.throws(() => toConfig({ target: "us", ...FULL, clientId: "  " }), /Client ID が要ります/);
  assert.throws(() => toConfig({ target: "us", ...FULL, projectId: "" }), /Project ID が要ります/);
  // 環境だけは既定があってよい（Infisical 自体の既定が dev）
  assert.equal(toConfig({ target: "us", ...FULL }).environment, "dev");
});

test("画面に返す形に、Client Secret は入らない", () => {
  const view = viewOf(toConfig({ target: "eu", ...FULL }), "saved");
  assert.equal(JSON.stringify(view).includes("shhh"), false, "秘密が画面に返っている");
  assert.equal(view.hasClientSecret, true, "入っていることが分からない");
  assert.equal(view.target, "eu", "接続先を URL から言い当てられていない");
  assert.equal(view.configured, true);

  const none = viewOf(undefined, "none");
  assert.equal(none.configured, false);
  assert.equal(none.hasClientSecret, false);
});

test("保存先はこの Module の中——0600 で、読み書きが往復する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-infisical-settings-"));
  try {
    const store = new InfisicalSettingsStore(dir);
    assert.equal(await store.load(), undefined, "何も無いのに設定があることになっている");

    const config = toConfig({ target: "self", siteUrl: "http://127.0.0.1:8088", ...FULL });
    await store.save(config);
    assert.deepEqual(await store.load(), config);

    // **人以外に読ませない**（組み込み Vault の identity.txt と同じ扱い）
    const mode = (await stat(join(dir, "connection.json"))).mode & 0o777;
    assert.equal(mode, 0o600, `モードが緩い: ${mode.toString(8)}`);
    // banto の Event Store ではなく、この Module の置き場に在る
    assert.ok((await readFile(join(dir, "connection.json"), "utf8")).includes("shhh"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("壊れた設定は「たぶんこう」で読まない——未設定として扱う", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-infisical-broken-"));
  try {
    const store = new InfisicalSettingsStore(dir);
    await store.save(toConfig({ target: "us", ...FULL }));
    // 中身を壊す（途中で落ちた・手で編集した、など）
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "connection.json"), '{"siteUrl":"https://x"', { mode: 0o600 });
    assert.equal(await store.load(), undefined, "壊れた設定を読み取ったことにしている");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
