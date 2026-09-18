// **保管とボタンだけ**を見る（プロトコルは SDK の担当・規則12）。
// 見たいのは3つ：金庫に置く形・読めないものを「無い」にしないこと・
// 一時の値を推測で埋めないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { BantoOAuthProvider, oauthAliasFor } from "./provider.js";

function fakeVault(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    read: async (a: string) => store.get(a),
    write: async (a: string, v: string) => void store.set(a, v),
  };
}

test("トークンは金庫の1つの alias にまとまる——名前は Module 名から導く", async () => {
  const vault = fakeVault();
  const urls: URL[] = [];
  const p = new BantoOAuthProvider({
    moduleName: "weather",
    redirectUrl: "https://banto.example/api/oauth/callback",
    vault,
    onAuthorizationUrl: (u) => urls.push(u),
  });

  assert.equal(await p.tokens(), undefined, "何も無いのに値を返している");
  await p.saveTokens({ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1" });
  await p.saveClientInformation({ client_id: "cid", redirect_uris: [] } as never);

  // **1つの alias に JSON でまとまっている**（人の一覧を散らかさない）
  assert.deepEqual([...vault.store.keys()], [oauthAliasFor("weather")]);
  const stored = JSON.parse(vault.store.get("oauth-weather")!);
  assert.equal(stored.tokens.refresh_token, "rt-1");
  assert.equal(stored.client.client_id, "cid");

  // **回るたびに置き換わる**（refresh token は回る）
  await p.saveTokens({ access_token: "at-2", token_type: "Bearer", refresh_token: "rt-2" });
  assert.equal((await p.tokens())?.refresh_token, "rt-2");
  // 置き換えても client 情報は残る（同じ alias の別の欄）
  assert.equal((await p.clientInformation())?.client_id, "cid");
});

test("読めない中身を「まだログインしていない」にしない", async () => {
  const p = new BantoOAuthProvider({
    moduleName: "weather",
    redirectUrl: "https://banto.example/api/oauth/callback",
    vault: fakeVault({ "oauth-weather": "これはJSONではない" }),
    onAuthorizationUrl: () => {},
  });
  await assert.rejects(() => p.tokens(), /ログイン情報が読めません/);
});

test("banto はブラウザを開かない——URL を覚えて、人に押してもらう", () => {
  const urls: URL[] = [];
  const p = new BantoOAuthProvider({
    moduleName: "weather",
    redirectUrl: "https://banto.example/api/oauth/callback",
    vault: fakeVault(),
    onAuthorizationUrl: (u) => urls.push(u),
  });
  p.redirectToAuthorization(new URL("https://id.example/authorize?x=1"));
  assert.equal(urls.length, 1);
  assert.equal(urls[0]!.host, "id.example");

  // **一時の値は推測で埋めない**（規則2——押し直してもらう）
  assert.throws(() => p.codeVerifier(), /もう一度/);
  p.saveCodeVerifier("v-123");
  assert.equal(p.codeVerifier(), "v-123");
  p.invalidateCredentials("verifier");
  assert.throws(() => p.codeVerifier(), /もう一度/);
});

test("申告する戻り先は1つだけ——人が押す先と同じ", () => {
  const p = new BantoOAuthProvider({
    moduleName: "weather",
    redirectUrl: "https://banto.example/api/oauth/callback",
    vault: fakeVault(),
    onAuthorizationUrl: () => {},
  });
  assert.deepEqual(p.clientMetadata.redirect_uris, ["https://banto.example/api/oauth/callback"]);
  assert.equal(p.redirectUrl, "https://banto.example/api/oauth/callback");
  // **秘密を持たないクライアント**（PKCE で守る）
  assert.equal(p.clientMetadata.token_endpoint_auth_method, "none");
});

test("追っているログインのときだけ印を持つ——背景の接続は持たない", () => {
  const common = {
    moduleName: "weather",
    redirectUrl: "https://banto.example/api/oauth/callback",
    vault: fakeVault(),
    onAuthorizationUrl: () => {},
  };
  // 背景の接続（人が押していない）——**印は無い**
  assert.equal(new BantoOAuthProvider(common).state, undefined);
  // 人が押した流れ——戻ってきたときに引き当てられる
  assert.equal(new BantoOAuthProvider({ ...common, state: "st-1" }).state!(), "st-1");
});
