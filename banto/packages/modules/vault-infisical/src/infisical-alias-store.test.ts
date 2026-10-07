// InfisicalAliasStore の**参照の持ち方**（決定・2026-10-04）を、Infisical の SDK の口を
// 記録する接続で見る。**本物で見るのは infisical.integration.test.ts**（展開されること）
// ——ここが見るのは「何を Infisical に書くか」と「注記から linkTo を落とさずに読むか」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalBackend } from "./infisical-backend.js";
import type { InfisicalConnection } from "./client.js";
import { fakeConnection } from "./testing/fake-connection.js";

test("参照は、参照の置き場に ${環境.フォルダ.キー} の秘密を1つ置き、注記に linkTo を書く（種別は書かない）", async () => {
  const { conn, folders, secrets } = fakeConnection();
  folders.add("/proj").add("/tools"); // kit がグループのフォルダを先に作る
  const store = new InfisicalAliasStore(conn);
  secrets.set("/tools\0CF_TOKEN", { secretValue: "real", secretComment: JSON.stringify({ name: "CF_TOKEN", kind: "secret" }) });
  await store.createLink({ name: "CF_TOKEN", backendPath: "proj/CF_TOKEN", linkTo: "tools/CF_TOKEN" });

  const placed = secrets.get("/proj\0CF_TOKEN")!;
  assert.equal(placed.secretValue, "${dev.tools.CF_TOKEN}");
  assert.deepEqual(JSON.parse(placed.secretComment!), { name: "CF_TOKEN", linkTo: "tools/CF_TOKEN" });
  assert.equal(secrets.get("/tools\0CF_TOKEN")!.secretValue, "real", "元に触った");
});

test("一覧は注記の linkTo を落とさない——参照の行として読む（種別は付けない）", async () => {
  const { conn, folders, secrets, listOptions } = fakeConnection();
  folders.add("/proj").add("/tools"); // kit がグループのフォルダを先に作る
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
  const { conn, folders, secrets } = fakeConnection();
  folders.add("/proj").add("/tools"); // kit がグループのフォルダを先に作る
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

test("注記が linkTo と kind を両方持っていても、参照として読み kind は捨てる（種別は元が正）", async () => {
  const { conn, secrets } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  secrets.set("/proj\0K", {
    secretValue: "${dev.tools.K}",
    secretComment: JSON.stringify({ name: "K", kind: "ssh-identity", linkTo: "tools/K" }),
  });
  const row = (await store.list()).find((a) => a.backendPath === "proj/K")!;
  assert.equal(row.linkTo, "tools/K");
  assert.equal(row.kind, undefined, "注記に書かれた種別の写しを読んでいる");
});

test("参照で指せるかを先に聞ける——`.` を含む置き場は断る、そうでなければ通す", async () => {
  const { conn } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  await store.assertCanLinkTo("tools/K");
  await assert.rejects(() => store.assertCanLinkTo("my.tools/K"), /"\." を含むフォルダ名を指せません/);
  await assert.rejects(() => store.assertCanLinkTo("tools/K.V"), /"\." を含むキー名を指せません/);
});

test("backend の getSecret は Infisical に参照を展開させない（展開すると見えないグループの値が返る）", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const conn = {
    scope: { projectId: "p1", environment: "dev" },
    scopeFor: (env?: string) => ({ projectId: "p1", environment: env ?? "dev" }),
    secrets: () => ({
      async getSecret(opts: Record<string, unknown>) {
        seen.push(opts);
        return { secretValue: "${dev.tools.CF_TOKEN}" };
      },
    }),
  } as unknown as InfisicalConnection;
  const backend = new InfisicalBackend(conn);
  assert.equal(await backend.getSecret("proj/CF_TOKEN"), "${dev.tools.CF_TOKEN}");
  assert.equal(seen[0]!.expandSecretReferences, false, "展開を切らずに読んでいる");
});

// **banto が置く秘密（`oauth-token`）を種別ごと読む**（訂正・2026-10-06）。以前は注記の種別を secret・ssh-identity・file
// だけ読み、`oauth-token` の注記を「banto の注記ではない」として捨てていた——一覧では種別 secret・注記の JSON が用途に
// 出て、`putSecret` の置き換えは「人が預けた秘密です（secret）」で断られていた（回った OAuth の鍵を書き戻せない）。
// 持ち主（`owner`）も注記に入り、読み戻せる
test("oauth-token の注記を種別ごと読み、持ち主も落とさない", async () => {
  const { conn, secrets } = fakeConnection();
  const store = new InfisicalAliasStore(conn);
  secrets.set("/shared\0oauth-github-x", { secretValue: "{}" });
  await store.create({ name: "oauth-github-x", kind: "oauth-token", backendPath: "shared/oauth-github-x", owner: "repositories" });
  const [listed] = await store.list();
  assert.deepEqual(listed, { name: "oauth-github-x", kind: "oauth-token", backendPath: "shared/oauth-github-x", owner: "repositories", note: undefined, lastUsedAt: undefined, expiresAt: undefined });
  // 持ち主の記録が無い既存のものに、あとから持ち主を書ける（注記の他の項目はそのまま）
  secrets.set("/shared\0oauth-old", { secretValue: "{}", secretComment: JSON.stringify({ name: "oauth-old", kind: "oauth-token", note: "前から" }) });
  await store.update("shared/oauth-old", { owner: "vault-directory" });
  assert.deepEqual(JSON.parse(secrets.get("/shared\0oauth-old")!.secretComment!), { name: "oauth-old", kind: "oauth-token", note: "前から", owner: "vault-directory" });
});

// **値を置き換えた日時は注記に残り、注記を書き直しても消えない**（追加・2026-10-07、仕様 §2.1 C節 `replaceSecretValue`）。
// 注記は書き直すたびに「読んだ行」から組み直すので、読むとき（toMeta）に拾わないと、次の使用記録（markUsed）や
// 用途の書き直しで黙って消える。空の秘密に値を入れたら「空」も外れる（空は一覧を読んだときの印で、保存しない）
test("置き換えた日時（valueUpdatedAt）は注記に残り、使用記録・用途の書き直しのあとも読める。値を入れたら空が外れる", async () => {
  const { conn, folders, secrets } = fakeConnection();
  folders.add("/proj");
  const store = new InfisicalAliasStore(conn);
  const backend = new InfisicalBackend(conn);
  secrets.set("/proj\0HOST", { secretValue: "", secretComment: JSON.stringify({ name: "HOST", kind: "secret" }) });
  assert.equal((await store.list()).find((a) => a.backendPath === "proj/HOST")!.empty, true);

  await backend.putSecret("proj/HOST", "example.org");
  await store.update("proj/HOST", { valueUpdatedAt: "2026-10-07T05:00:00.000Z" });
  await store.markUsed("proj/HOST");
  await store.update("proj/HOST", { note: "書き直し" });
  const row = (await store.list()).find((a) => a.backendPath === "proj/HOST")!;
  assert.equal(row.valueUpdatedAt, "2026-10-07T05:00:00.000Z", "注記を書き直したら置き換えた日時が消えた");
  assert.equal(row.empty, undefined, "値を入れたのに空のまま");
  assert.equal(row.note, "書き直し");
  assert.equal(secrets.get("/proj\0HOST")!.secretValue, "example.org");
});
