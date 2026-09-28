import { test } from "node:test";
import assert from "node:assert/strict";
import { withdrawPublications, type RelayCall } from "./publish-notice.js";

/** 中継を真似る：一覧に出す相手と、serviceRemoved への答え */
function fakeRelay(targets: { name: string; roles: string[] }[], answer: (target: string) => { text: string; isError: boolean }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call: RelayCall = async (name, args) => {
    calls.push({ name, args });
    if (name === "relayListTargets") return { text: JSON.stringify(targets), isError: false };
    return answer(String(args.targetModule));
  };
  return { call, calls };
}

test("公開の窓口が繋がっていなければ何もしない（公開の仕組みを入れていない Project）", async () => {
  const relay = fakeRelay([{ name: "vault-directory", roles: ["vault-directory"] }], () => ({ text: "", isError: true }));
  assert.deepEqual(await withdrawPublications(relay.call, "web"), { unpublished: [] });
  assert.deepEqual(relay.calls.map((c) => c.name), ["relayListTargets"]);
});

test("窓口に serviceRemoved で知らせ、やめた URL を返す。窓口が断ったら投げる", async () => {
  const ok = fakeRelay([{ name: "publish-directory", roles: ["publish-directory"] }], () => ({
    text: JSON.stringify({ unpublished: [{ url: "https://web-x.example.net", port: 3000, method: "publish-caddy" }], withdrawnRequests: [] }),
    isError: false,
  }));
  assert.deepEqual(await withdrawPublications(ok.call, "web"), { unpublished: [{ url: "https://web-x.example.net", port: 3000 }] });
  assert.deepEqual(ok.calls[1], { name: "relayCallTool", args: { targetModule: "publish-directory", name: "serviceRemoved", arguments: { service: "web" } } });

  const refused = fakeRelay([{ name: "publish-directory", roles: ["publish-directory"] }], () => ({ text: "やめられなかった出し方があります", isError: true }));
  await assert.rejects(withdrawPublications(refused.call, "web"), /やめられなかった出し方があります/);
});
