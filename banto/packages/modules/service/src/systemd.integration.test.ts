// 本物の systemd（ユーザー単位）で Service の一生を確かめる。`BANTO_TEST_SYSTEMD=1` のときだけ走る。
// Project のコンテナの中（systemd が PID 1、sudo が使える）で回す：
//   BANTO_TEST_SYSTEMD=1 node --test dist/systemd.integration.test.js
// unit はユーザーの本物の置き場（~/.config/systemd/user）に `banto-it<乱数>-*` で置き、終わったら消す。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceManager, type ServiceStatus } from "./manager.js";
import { ServiceStore } from "./store.js";
import { RealSystemctl } from "./systemd.js";
import type { ServiceState } from "./state.js";

const skip = process.env.BANTO_TEST_SYSTEMD === "1" ? false : "本物の systemd が要る（BANTO_TEST_SYSTEMD=1 のときだけ走る）";

test("Service：本物の systemd で、起こす・鍵・落ちる・終わる・外から止める・作り直す・止める・消す", { skip, timeout: 180_000 }, async () => {
  const tag = `it${Math.floor(Math.random() * 1e6)}`;
  const base = await mkdtemp(join(tmpdir(), "banto-service-it-"));
  const root = join(base, "root");
  execFileSync("mkdir", ["-p", root]);
  const sc = new RealSystemctl();
  await sc.ensureUserManager();
  const unitDir = join(userInfo().homedir, ".config/systemd/user");
  const tricky = `a "quoted" \\back $HOME 'single' %x`;
  const multiline = "-----BEGIN-----\nline2\n-----END-----";
  const manager = new ServiceManager({
    projectRoot: root,
    store: new ServiceStore(join(base, "data")),
    systemctl: sc,
    paths: { unitDir, stateDir: join(base, "state") },
    nodePath: process.execPath,
    wrapperPath: fileURLToPath(new URL("./log-wrapper.js", import.meta.url)),
    inheritedEnv: {},
    settleMs: 800,
    async resolveSecret(_env, alias) {
      return alias === "tricky" ? tricky : alias === "multi" ? multiline : `v-${alias}`;
    },
  });
  const n = (s: string) => `${tag}-${s}`;
  const find = async (name: string) => (await manager.list()).find((s) => s.name === name)!;
  const waitFor = async (name: string, ok: (s: ServiceStatus) => boolean, what: string): Promise<ServiceStatus> => {
    let last: ServiceStatus | undefined;
    for (let i = 0; i < 60; i++) {
      last = await find(name);
      if (ok(last)) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail(`${name}: ${what} にならなかった（最後：${JSON.stringify(last)}）`);
  };
  const is = (state: ServiceState) => (s: ServiceStatus) => s.state === state;
  const port = 38000 + Math.floor(Math.random() * 1000);

  try {
    // 1. 起こす・待ち受ける・鍵がそのまま届く・ログに時刻・作ったファイルの持ち主
    await manager.start({
      name: n("web"),
      command: `node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(${port},"127.0.0.1")' & printf 'K=%s\\n' "$K"; printf 'M=%s\\n' "$M" | tr '\\n' '|'; echo; touch made-by-service; wait`,
      ports: [port],
      envSecrets: { K: "tricky", M: "multi" },
    });
    const web = await waitFor(n("web"), (s) => s.state === "running" && s.listening.includes(port), "running＋待ち受け");
    const logs = (await manager.logs(n("web"))).lines;
    assert.ok(logs.some((l) => l.endsWith(`K=${tricky}`)), `鍵の値が崩れずに届く：${JSON.stringify(logs)}`);
    assert.ok(logs.some((l) => l.endsWith(`M=${multiline.replace(/\n/g, "|")}|`)), `改行を含む鍵の値も崩れない：${JSON.stringify(logs)}`);
    assert.match(logs[0]!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, "ログに時刻");
    assert.equal((await stat(join(root, "made-by-service"))).uid, userInfo().uid, "作ったファイルの持ち主は Module と同じ uid");
    assert.equal(web.desired, "running");

    // 2. 止める：子孫（node）まで止まる・自動起動から外れる
    const stopped = await manager.stop(n("web"));
    assert.equal(stopped.state, "stopped");
    await waitFor(n("web"), (s) => s.notListening.includes(port), "待ち受けが消える");
    assert.equal((await sc.run(["is-enabled", `banto-${n("web")}.service`])).stdout.trim(), "disabled");

    // 3. 落ち続ける → 上限で crashed → restartService で起き直す（reset-failed）
    await manager.start({ name: n("crash"), command: "echo boom; exit 3" });
    await waitFor(n("crash"), is("crashed"), "crashed");
    const again = await manager.restart(n("crash"));
    assert.ok(["restarting", "starting", "running", "crashed"].includes(again.state));
    assert.ok((await manager.logs(n("crash"), 2000)).lines.filter((l) => l.endsWith(" boom")).length >= 6, "起こし直しで再び走った");

    // 4. 自分で終わる（終了コード 0）→ exited、起こし直さない
    await manager.start({ name: n("once"), command: "echo done" });
    const once = await waitFor(n("once"), is("exited"), "exited");
    assert.equal(once.restarts, 0);

    // 5. 外から止める → stopped-externally。一覧を見ても起こさない
    await manager.start({ name: n("ext"), command: "sleep 1000" });
    await waitFor(n("ext"), is("running"), "running");
    await sc.run(["stop", `banto-${n("ext")}.service`]);
    await waitFor(n("ext"), is("stopped-externally"), "stopped-externally");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await find(n("ext"))).state, "stopped-externally", "止めたまま受け入れる");

    // 6. unit が消された（＋止まった）→ 作り直して起こす
    await sc.run(["stop", `banto-${n("ext")}.service`]);
    await unlink(join(unitDir, `banto-${n("ext")}.service`));
    await sc.run(["daemon-reload"]);
    await waitFor(n("ext"), is("running"), "作り直して running");
    assert.ok(await stat(join(unitDir, `banto-${n("ext")}.service`)));
  } finally {
    for (const s of await manager.list().catch(() => [])) await manager.remove(s.name).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
  // 7. 消したら unit のファイルも、systemd の中の印（落ちたものの not-found/failed）も残らない
  const left = execFileSync("sh", ["-c", `ls ${unitDir} | grep -c '^banto-${tag}-' || true`]).toString().trim();
  assert.equal(left, "0");
  const inSystemd = (await sc.run(["list-units", "--all", "--no-legend", `banto-${tag}-*`])).stdout.trim();
  assert.equal(inSystemd, "", `systemd に残っている：${inSystemd}`);
});
