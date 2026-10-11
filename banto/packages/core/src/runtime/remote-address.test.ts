import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteAddress } from "./remote-address.js";
import { RemoteSshRuntime } from "./remote-ssh.js";
import type { RemoteRuntimes } from "./remote-runtimes.js";
import { RuntimeRouter } from "./router.js";
import type { Runtime } from "./runtime.js";

const errno = (code: string) => Object.assign(new Error(`getaddrinfo ${code} x`), { code });

test("別のサーバの宛先：IPv4 はそのまま・名前は引いた IPv4。どちらも「LAN に直に出ている」の印つき", async () => {
  const never = async () => assert.fail("IPv4 を名前として引いた");
  assert.deepEqual(await remoteAddress("lab", "192.168.10.50", never), { address: "192.168.10.50", exposedOnLan: true });
  assert.deepEqual(await remoteAddress("lab", "lab.lan", async (h) => (h === "lab.lan" ? "192.168.10.51" : "0.0.0.0")), {
    address: "192.168.10.51",
    exposedOnLan: true,
  });
});

test("確かに届かない（登録が無い・名前が無い・IPv6）は理由を値で、名前引きの一時の失敗は投げる", async () => {
  const none = await remoteAddress("lab", undefined);
  assert.ok("unavailable" in none);
  assert.match(none.unavailable, /実行場所「lab」の登録がありません/);

  const missing = await remoteAddress("lab", "gone.lan", async () => {
    throw errno("ENOTFOUND");
  });
  assert.ok("unavailable" in missing);
  assert.match(missing.unavailable, /gone\.lan の IPv4 のアドレスを、この banto の host で引けません（ENOTFOUND）/);

  const v6 = await remoteAddress("lab", "fd00::5");
  assert.ok("unavailable" in v6);
  assert.match(v6.unavailable, /IPv6/);

  await assert.rejects(
    () => remoteAddress("lab", "lab.lan", async () => { throw errno("EAI_AGAIN"); }),
    /別のサーバ「lab」の宛先 lab\.lan を引けませんでした/,
  );
});

test("振り分け：別のサーバの Project は登録した宛先の LAN のアドレス、それ以外はこの機械のコンテナ（SSH は繋がない）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "banto-remote-address-"));
  try {
    const remote = new RemoteSshRuntime({
      dataDir,
      monorepoRoot: dataDir,
      // 使うのは登録の宛先を引く口だけ
      runtimes: { get: (name: string) => (name === "lab" ? { host: "lab.lan" } : undefined) } as unknown as RemoteRuntimes,
      remoteNameOf: (id) => ({ pRemote: "lab", pGone: "removed" })[id],
      createRelayListener: () => assert.fail("待ち受けを立てた"),
      notify: async () => assert.fail("知らせた"),
      lookupIPv4: async () => "192.168.10.51",
    });
    const host = {
      instancePlaceId: "instance",
      address: async (id: string) => ({ address: `10.61.162.${id === "pLocal" ? 23 : 99}` }),
    } as unknown as Runtime;
    const router = new RuntimeRouter(host, remote);
    assert.deepEqual(await router.address("pRemote"), { address: "192.168.10.51", exposedOnLan: true });
    assert.deepEqual(await router.address("pLocal"), { address: "10.61.162.23" });
    const gone = await router.address("pGone");
    assert.ok("unavailable" in gone);
    assert.match(gone.unavailable, /実行場所「removed」の登録がありません/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
