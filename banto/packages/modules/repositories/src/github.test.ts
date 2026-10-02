// GitHub の口：**偽の GitHub に HTTP で繋いで**、デバイスフローの各応答・更新・`/user` を読めるか。
// 偽物は本物と同じ話し方（form・`{error}` を 200 で返す・refresh token は回る）をする（`test-fakes.ts`）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubError, httpGithub } from "./github.js";
import { FAKE_CLIENT_ID, startFakeGithub } from "./test-fakes.js";

const NOW = 1_800_000_000_000;

test("デバイスコードをもらい、待つ・遅くしろ・期限切れ・断られた・許可された、を読み分ける", async () => {
  const gh = await startFakeGithub();
  try {
    const api = httpGithub(gh.endpoints, () => NOW);
    const code = await api.requestDeviceCode(FAKE_CLIENT_ID);
    assert.deepEqual(
      { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn, interval: code.interval },
      { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 },
    );
    // 送った形も本物どおり（form・grant_type）
    assert.deepEqual(gh.requests.at(-1), { path: "/login/device/code", form: { client_id: FAKE_CLIENT_ID } });

    gh.script = ["pending", "slow_down", "expired_token", "access_denied", "authorized"];
    assert.deepEqual(await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode), { kind: "pending" });
    assert.deepEqual(gh.requests.at(-1)!.form, {
      client_id: FAKE_CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    assert.deepEqual(await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode), { kind: "slow-down", interval: 10 });
    assert.deepEqual(await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode), { kind: "expired" });
    assert.deepEqual(await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode), { kind: "denied" });
    const done = await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode);
    assert.equal(done.kind, "authorized");
    if (done.kind !== "authorized") return;
    assert.match(done.tokens.accessToken, /^ghu_/);
    assert.match(done.tokens.refreshToken ?? "", /^ghr_/);
    assert.equal(done.tokens.expiresAt, NOW + 8 * 3600 * 1000);
    assert.equal(done.tokens.refreshTokenExpiresAt, NOW + 15897600 * 1000);
    assert.deepEqual(await api.currentUser(done.tokens.accessToken), { login: "tjst-t" });
  } finally {
    await gh.close();
  }
});

test("断りは理由つき——client ID が違う・デバイスフローが無効・資格情報が違う。秘密は文言に入らない", async () => {
  const gh = await startFakeGithub();
  try {
    const api = httpGithub(gh.endpoints);
    await assert.rejects(() => api.requestDeviceCode("Iv23liWRONGWRONG"), (err: GithubError) => {
      assert.equal(err.code, "incorrect_client_credentials");
      assert.match(err.message, /client ID/);
      return true;
    });
    gh.script = ["device_flow_disabled"];
    const code = await api.requestDeviceCode(FAKE_CLIENT_ID);
    await assert.rejects(() => api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode), /Enable Device Flow/);
    await assert.rejects(() => api.currentUser("ghp_not_a_real_token_123"), (err: Error) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /ghp_not_a_real_token_123/);
      return true;
    });
    await assert.rejects(() => api.refresh(FAKE_CLIENT_ID, "ghr_stale_one"), (err: GithubError) => {
      assert.equal(err.code, "bad_refresh_token");
      assert.doesNotMatch(err.message, /ghr_stale_one/);
      return true;
    });
  } finally {
    await gh.close();
  }
});

test("更新は client ID と refresh token だけで送り（client secret は送らない）、新しい組を受け取る——古い鍵はもう効かない", async () => {
  const gh = await startFakeGithub();
  try {
    const api = httpGithub(gh.endpoints, () => NOW);
    gh.script = ["authorized"];
    const code = await api.requestDeviceCode(FAKE_CLIENT_ID);
    const first = await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode);
    assert.equal(first.kind, "authorized");
    if (first.kind !== "authorized") return;
    const next = await api.refresh(FAKE_CLIENT_ID, first.tokens.refreshToken!);
    assert.deepEqual(gh.requests.at(-1)!.form, {
      client_id: FAKE_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: first.tokens.refreshToken!,
    });
    assert.notEqual(next.refreshToken, first.tokens.refreshToken);
    await assert.rejects(() => api.refresh(FAKE_CLIENT_ID, first.tokens.refreshToken!), /refresh token/);
  } finally {
    await gh.close();
  }
});

test("期限を切っていない App のトークン（expires_in も refresh_token も無い）も読める", async () => {
  const gh = await startFakeGithub();
  try {
    gh.accessTokenTtl = undefined;
    gh.script = ["authorized"];
    const api = httpGithub(gh.endpoints, () => NOW);
    const code = await api.requestDeviceCode(FAKE_CLIENT_ID);
    const r = await api.pollDeviceToken(FAKE_CLIENT_ID, code.deviceCode);
    assert.equal(r.kind, "authorized");
    if (r.kind === "authorized") assert.deepEqual(Object.keys(r.tokens), ["accessToken"]);
  } finally {
    await gh.close();
  }
});
