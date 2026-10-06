// 版（＝Infisical の環境）と値が空の秘密（決定・2026-10-06、仕様 §2.1「グループの『版』」「値が空の秘密」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { fakeConnection } from "./testing/fake-connection.js";

test("一覧：既定の環境だけを読み、紐付けた版付きのグループ（g@prod）はその環境のそのフォルダだけ足す", async () => {
  const { conn, secrets } = fakeConnection({ environment: "dev" });
  secrets.set("/homelab\0HOST", { secretValue: "" }); // dev は名前だけの空欄
  secrets.set("prod|/homelab\0HOST", { secretValue: "pve.local" });
  secrets.set("prod|/homelab/generated\0KEY", { secretValue: "k" });
  secrets.set("prod|/other\0X", { secretValue: "x" }); // 紐付けていない prod のフォルダ
  const store = new InfisicalAliasStore(conn);

  const plain = (await store.list()).map((a) => a.backendPath).sort();
  assert.deepEqual(plain, ["homelab/HOST"], "紐付けていない版まで読んだ");

  const rows = await store.list({ alsoGroups: ["homelab@prod"] });
  assert.deepEqual(
    rows.map((a) => [a.name, a.backendPath]).sort(),
    [
      ["HOST", "homelab/HOST"],
      ["HOST", "homelab@prod/HOST"],
      ["generated/KEY", "homelab@prod/generated/KEY"],
    ],
  );
  // 空の印：dev の空欄だけに付く。値そのものは行に入らない
  assert.equal(rows.find((a) => a.backendPath === "homelab/HOST")!.empty, true);
  assert.equal(rows.find((a) => a.backendPath === "homelab@prod/HOST")!.empty, undefined);
  assert.ok(!JSON.stringify(rows).includes("pve.local"), "値が行に残っている");
});

test("紐付けた環境にまだフォルダが無いのは空の置き場（一覧ごと落ちない）", async () => {
  const { conn, secrets } = fakeConnection();
  const real = conn.secrets;
  (conn as unknown as { secrets: () => unknown }).secrets = () => {
    const api = real.call(conn) as unknown as Record<string, (o: { environment: string }) => Promise<unknown>>;
    return {
      ...api,
      listSecrets: async (o: { environment: string }) => {
        if (o.environment === "prod") throw new Error("Folder with path '/homelab' not found");
        return api.listSecrets!(o);
      },
    };
  };
  secrets.set("/homelab\0HOST", { secretValue: "h" });
  const rows = await new InfisicalAliasStore(conn).list({ alsoGroups: ["homelab@prod"] });
  assert.deepEqual(rows.map((a) => a.backendPath), ["homelab/HOST"]);
});

test("1件を引く口は値を読まないので、注記の書き直しで空の印を注記に書かない", async () => {
  const { conn, secrets } = fakeConnection();
  secrets.set("/g\0K", { secretValue: "" });
  const store = new InfisicalAliasStore(conn);
  // 注記の書き直しは値を読まずに1件を引く——そのあとの注記に empty を書かない
  await store.update("g/K", { note: "メモ" });
  const comment = JSON.parse(secrets.get("/g\0K")!.secretComment!);
  assert.equal(comment.note, "メモ");
  assert.equal("empty" in comment, false, "一覧の印を注記に書いた");
});

test("版付きのグループの注記の書き直し・使った記録は、その環境の秘密に書く", async () => {
  const { conn, secrets } = fakeConnection();
  secrets.set("prod|/g\0K", { secretValue: "v" });
  const store = new InfisicalAliasStore(conn);
  await store.update("g@prod/K", { note: "本番" });
  await store.markUsed("g@prod/K");
  const comment = JSON.parse(secrets.get("prod|/g\0K")!.secretComment!);
  assert.equal(comment.note, "本番");
  assert.ok(comment.lastUsedAt);
});

test("backend：g@prod は環境 prod で読み・書き・消し、フォルダも prod に作る", async () => {
  const { conn, secrets, folders } = fakeConnection();
  const backend = new InfisicalBackend(conn);
  await backend.createGroup("homelab@prod");
  assert.deepEqual([...folders], ["prod|/homelab"]);
  await backend.putSecret("homelab@prod/net/PW", "secret");
  assert.equal(secrets.get("prod|/homelab/net\0PW")!.secretValue, "secret");
  assert.equal(await backend.getSecret("homelab@prod/net/PW"), "secret");
  await backend.deleteSecret("homelab@prod/net/PW");
  assert.equal(secrets.size, 0);
  // 既定の環境の一覧（listGroups）には版付きのグループは出ない
  await backend.createGroup("homelab");
  assert.deepEqual(await backend.listGroups(), ["homelab"]);
  await assert.rejects(() => backend.createGroup("homelab@../x"), /環境の名前/);
});

test("backend：版は「環境」、選択肢は Project の環境、版ごとに値の入った数を数える", async () => {
  const { conn, secrets } = fakeConnection({ environment: "dev", environments: ["dev", "staging", "prod"] });
  const backend = new InfisicalBackend(conn);
  assert.deepEqual(await backend.variants(), { label: "環境", options: ["dev", "staging", "prod"], default: "dev" });
  secrets.set("/homelab\0A", { secretValue: "" });
  secrets.set("/homelab\0B", { secretValue: "b" });
  secrets.set("prod|/homelab\0A", { secretValue: "a" });
  secrets.set("prod|/homelab/sub\0B", { secretValue: "b" });
  secrets.set("prod|/other\0C", { secretValue: "c" });
  assert.deepEqual(await backend.countByVariant("homelab"), [
    { variant: "dev", filled: 1, total: 2 },
    { variant: "staging", filled: 0, total: 0 },
    { variant: "prod", filled: 2, total: 2 },
  ]);
});

test("接続設定の環境が Project の環境の一覧に無くても、既定として選択肢に残す", async () => {
  const { conn } = fakeConnection({ environment: "local", environments: ["dev", "prod"] });
  assert.deepEqual(await new InfisicalBackend(conn).variants(), {
    label: "環境",
    options: ["local", "dev", "prod"],
    default: "local",
  });
});

test("参照の書き方の環境は、指す先の置き場の版（無ければ既定）", async () => {
  const { conn, secrets, folders } = fakeConnection({ environment: "dev" });
  folders.add("prod|/proj").add("/proj"); // kit がグループのフォルダを先に作る
  secrets.set("prod|/tools\0CF", { secretValue: "real" });
  const store = new InfisicalAliasStore(conn);
  await store.createLink({ name: "CF", backendPath: "proj@prod/CF", linkTo: "tools@prod/CF" });
  assert.equal(secrets.get("prod|/proj\0CF")!.secretValue, "${prod.tools.CF}");
  await store.createLink({ name: "CF2", backendPath: "proj/CF2", linkTo: "tools/CF" });
  assert.equal(secrets.get("/proj\0CF2")!.secretValue, "${dev.tools.CF}");
});

test("揃え方：いまの既定の環境を指す g@<既定> は g、ほかの環境はそのまま", () => {
  const { conn } = fakeConnection({ environment: "prod" });
  const backend = new InfisicalBackend(conn);
  assert.equal(backend.canonicalGroup("homelab@prod"), "homelab");
  assert.equal(backend.canonicalGroup("homelab@dev"), "homelab@dev");
  assert.equal(backend.canonicalGroup("homelab"), "homelab");
});

test("既定の環境を後から変えても、同じ秘密を2行にしない（g@<既定> は既定の一覧に任せる）", async () => {
  const { conn, secrets } = fakeConnection({ environment: "prod" });
  secrets.set("/homelab\0HOST", { secretValue: "pve" });
  const rows = await new InfisicalAliasStore(conn).list({ alsoGroups: ["homelab@prod"] });
  assert.deepEqual(rows.map((a) => a.backendPath), ["homelab/HOST"]);
});

test("値を読む権限が無ければ、値を読まない一覧に戻す（空かどうかは付けない）", async () => {
  const { conn, secrets } = fakeConnection();
  secrets.set("/g\0K", { secretValue: "" });
  const real = conn.secrets;
  (conn as unknown as { secrets: () => unknown }).secrets = () => {
    const api = real.call(conn) as unknown as Record<string, (o: { viewSecretValue?: boolean }) => Promise<unknown>>;
    return {
      ...api,
      listSecrets: async (o: { viewSecretValue?: boolean }) => {
        if (o.viewSecretValue) throw new Error("[StatusCode=403] You are not allowed to read secret values");
        return api.listSecrets!(o);
      },
    };
  };
  const rows = await new InfisicalAliasStore(conn).list();
  assert.deepEqual(rows.map((a) => [a.backendPath, a.empty]), [["g/K", undefined]]);
});

test("フォルダが無いと見なすのは、文言がフォルダの不在を言うときだけ（404 だけでは決めない）", async () => {
  const { isFolderMissing } = await import("./infisical-backend.js");
  assert.equal(isFolderMissing(new Error("[StatusCode=404] Folder with path '/g' not found")), true);
  assert.equal(isFolderMissing(new Error("[StatusCode=404] Environment with slug 'prod' not found")), false);
  assert.equal(isFolderMissing(new Error("[StatusCode=404] Project not found")), false);
});
