// Vault の口（`RelayVault`）：**banto が置く秘密は、新しく置くときも金庫へ直接**（2026-10-06）。金庫は置いた Module
// （host が刻む呼び元）を持ち主として残し、置き換えは持ち主からだけ受ける——窓口の putSecret を通すと持ち主が窓口になり、
// あとで回った鍵を金庫へ直接書き戻せない。中継の口を記録する偽物で、どこへ何を頼んだかを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayVault } from "./vault.js";
import type { ModuleCaller } from "./relay-client.js";

function recordingCaller(answers: Record<string, string>) {
  const calls: Array<{ target: string; name: string; args: Record<string, unknown>; callId?: string }> = [];
  const caller: ModuleCaller = {
    async callTool(target, name, args, callId) {
      calls.push({ target, name, args, ...(callId ? { callId } : {}) });
      const answer = answers[`${target}.${name}`];
      if (answer === undefined) throw new Error(`${target} の ${name} は頼まれない筈`);
      return answer;
    },
  };
  return { caller, calls };
}

test("新しく置く：窓口に既定の Vault を聞き、その金庫の putSecret へ直接置いて、在りかを窓口に引く（窓口の putSecret は使わない）", async () => {
  const { caller, calls } = recordingCaller({
    "vault-directory.getDefaultVault": JSON.stringify({ vault: "vault-infisical", fallback: "vault-local" }),
    "vault-infisical.putSecret": "stored oauth-github-x",
    "vault-directory.lookupAlias": JSON.stringify({ implementation: "vault-infisical", name: "oauth-github-x", group: "shared" }),
  });
  const place = await new RelayVault(caller).putOwned({ name: "oauth-github-x", value: "{}", note: "n" }, undefined, "call-1");
  assert.deepEqual(place, { implementation: "vault-infisical", name: "oauth-github-x", group: "shared" });
  assert.deepEqual(
    calls.map((c) => `${c.target}.${c.name}`),
    ["vault-directory.getDefaultVault", "vault-infisical.putSecret", "vault-directory.lookupAlias"],
  );
  assert.deepEqual(calls[1]!.args, { name: "oauth-github-x", value: "{}", note: "n" });
  assert.ok(calls.every((c) => c.callId === "call-1"), "呼び出しの印を添えていない");
});

test("置き換える：在りかの金庫へ直接（窓口には聞かない）。既定の Vault が分からなければ置かずに断る", async () => {
  const { caller, calls } = recordingCaller({ "vault-local.putSecret": "stored" });
  const at = { implementation: "vault-local", name: "oauth-github-x", group: "instance" };
  assert.deepEqual(await new RelayVault(caller).putOwned({ name: "ignored", value: "{}", note: "n" }, at), at);
  assert.deepEqual(calls.map((c) => `${c.target}.${c.name}`), ["vault-local.putSecret"]);
  assert.deepEqual(calls[0]!.args, { name: "oauth-github-x", value: "{}", note: "n", group: "instance" });

  const broken = recordingCaller({ "vault-directory.getDefaultVault": JSON.stringify({}) });
  await assert.rejects(() => new RelayVault(broken.caller).putOwned({ name: "x", value: "{}", note: "n" }, undefined), /既定の Vault が分かりません/);
  assert.deepEqual(broken.calls.map((c) => c.name), ["getDefaultVault"]);
});
