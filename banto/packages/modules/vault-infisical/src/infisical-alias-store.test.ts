// InfisicalAliasStore の**参照の持ち方**（決定・2026-10-04）を、Infisical の SDK の口を
// 記録する接続で見る。**本物で見るのは infisical.integration.test.ts**（展開されること）
// ——ここが見るのは「何を Infisical に書くか」と「注記から linkTo を落とさずに読むか」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import type { InfisicalConnection } from "./client.js";

type Stored = { secretValue: string; secretComment?: string };

/** フォルダ `/g` の秘密を Map で持つ、SDK の secrets() の写し。 */
function fakeConnection() {
  const secrets = new Map<string, Stored>(); // "/g\0key"
  const listOptions: Array<Record<string, unknown>> = [];
  const at = (path: string, key: string) => `${path}\0${key}`;
  const conn = {
    scope: { projectId: "p1", environment: "dev" },
    secrets: () => ({
      async listSecrets(opts: Record<string, unknown>) {
        listOptions.push(opts);
        return {
          secrets: [...secrets.entries()].map(([k, v]) => {
            const [secretPath, secretKey] = k.split("\0");
            return { secretPath, secretKey, secretComment: v.secretComment ?? "" };
          }),
        };
      },
      async createSecret(key: string, opts: { secretPath: string; secretValue: string; secretComment?: string }) {
        if (secrets.has(at(opts.secretPath, key))) throw new Error("Secret already exist");
        secrets.set(at(opts.secretPath, key), { secretValue: opts.secretValue, secretComment: opts.secretComment });
      },
      async updateSecret(key: string, opts: { secretPath: string; secretValue?: string; secretComment?: string }) {
        const cur = secrets.get(at(opts.secretPath, key));
        if (!cur) throw new Error("not found");
        secrets.set(at(opts.secretPath, key), {
          secretValue: opts.secretValue ?? cur.secretValue,
          secretComment: opts.secretComment ?? cur.secretComment,
        });
      },
      async deleteSecret(key: string, opts: { secretPath: string }) {
        if (!secrets.delete(at(opts.secretPath, key))) throw new Error("not found");
      },
    }),
  };
  return { conn: conn as unknown as InfisicalConnection, secrets, listOptions };
}

test("参照は、参照の置き場に ${環境.フォルダ.キー} の秘密を1つ置き、注記に linkTo を書く（種別は書かない）", async () => {
  const { conn, secrets } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  secrets.set("/tools\0CF_TOKEN", { secretValue: "real", secretComment: JSON.stringify({ name: "CF_TOKEN", kind: "secret" }) });
  await store.createLink({ name: "CF_TOKEN", backendPath: "proj/CF_TOKEN", linkTo: "tools/CF_TOKEN" });

  const placed = secrets.get("/proj\0CF_TOKEN")!;
  assert.equal(placed.secretValue, "${dev.tools.CF_TOKEN}");
  assert.deepEqual(JSON.parse(placed.secretComment!), { name: "CF_TOKEN", linkTo: "tools/CF_TOKEN" });
  assert.equal(secrets.get("/tools\0CF_TOKEN")!.secretValue, "real", "元に触った");
});

test("一覧は注記の linkTo を落とさない——参照の行として読む（種別は付けない）", async () => {
  const { conn, secrets, listOptions } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  secrets.set("/tools\0CF_TOKEN", { secretValue: "real", secretComment: JSON.stringify({ name: "CF_TOKEN", kind: "secret" }) });
  await store.createLink({ name: "cf", backendPath: "proj/cf", linkTo: "tools/CF_TOKEN", note: "外の道具も読む" });
  const list = await store.list();
  assert.deepEqual(
    list.find((a) => a.backendPath === "proj/cf"),
    { name: "cf", linkTo: "tools/CF_TOKEN", note: "外の道具も読む", backendPath: "proj/cf" },
  );
  // 一覧では参照を展開させない（元が消えた参照で一覧ごと読めなくならないように）
  assert.equal(listOptions.at(-1)!.expandSecretReferences, false);

  // 使った記録・用途の書き直しでも linkTo は残る
  await store.markUsed("proj/cf");
  await store.update("proj/cf", { note: "書き直し" });
  const again = (await store.list()).find((a) => a.backendPath === "proj/cf")!;
  assert.equal(again.linkTo, "tools/CF_TOKEN");
  assert.equal(again.note, "書き直し");
  assert.ok(again.lastUsedAt);
  assert.equal(secrets.get("/proj\0cf")!.secretValue, "${dev.tools.CF_TOKEN}", "注記を書くついでに値が変わった");
});

test("指し直すと、注記と参照の書き方の両方が変わる／参照を消すと参照の秘密だけが消える", async () => {
  const { conn, secrets } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  secrets.set("/tools\0K", { secretValue: "real", secretComment: JSON.stringify({ name: "K", kind: "secret" }) });
  await store.createLink({ name: "K", backendPath: "proj/K", linkTo: "tools/K" });
  await store.retargetLink("proj/K", "moved/K");
  assert.equal(secrets.get("/proj\0K")!.secretValue, "${dev.moved.K}");
  assert.equal(JSON.parse(secrets.get("/proj\0K")!.secretComment!).linkTo, "moved/K");

  await store.deleteLink("proj/K");
  assert.equal(secrets.has("/proj\0K"), false);
  assert.equal(secrets.has("/tools\0K"), true, "参照を消したら元まで消えた");
  // 参照でないものは参照として消さない
  await assert.rejects(() => store.deleteLink("tools/K"), /参照ではありません/);
});

test("`.` を含むフォルダ名・キーは Infisical の参照の書き方で指せないので、作らずに断る", async () => {
  const { conn, secrets } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  await assert.rejects(
    () => store.createLink({ name: "K", backendPath: "proj/K", linkTo: "my.tools/K" }),
    /"\." を含むフォルダ名を指せません/,
  );
  assert.equal(secrets.size, 0);
});
