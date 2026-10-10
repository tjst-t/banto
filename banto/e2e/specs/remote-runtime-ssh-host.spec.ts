// **E2E の SSH の相手**（追加・2026-10-08、Backlog `remote-runtime-e2e-host`）。実行場所「別のサーバ」の試験が
// 頼る相手（`ssh-host.ts`）そのものを確かめる——相手が本番の前提（v4-security.md §1「前提の確かめ」）と違う形だと、
// その上の試験は「通ったが本番では動かない」になる。
//
// 見るもの：
//   1. 試験の鍵で、決めた ssh の設定（`-F /dev/null`・覚えた host 鍵だけ）で入れる。相手は本番の前提の形
//      （専用のユーザー・sudo できない・道具がある・ログインシェルが何も出さない・`/run/user/<uid>/bus` があり linger は無い）
//   2. 覚えた host 鍵と違えば繋がない（StrictHostKeyChecking=yes が効く相手であること）
//   3. 秘密鍵が試験の Vault に ssh-identity として入り、片づけで消える
//   4. 片づけ：ふつうに閉じれば消える／回が死んだら片づけ役（`run-reaper.ts`）が消す／片づけ役ごと死んでも次の回の
//      始め（`global-setup.ts` の `staleOwnedContainers`）が拾う
import { test, expect } from "../test-base.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_PACKAGES } from "@banto/container";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR, E2E_BASE } from "../config.js";
import { listOwnedContainers, staleOwnedContainers } from "../containers.js";
import { SSH_HOST_UID, SSH_HOST_USER, startSshHost, withSshHost } from "../ssh-host.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test.describe.configure({ mode: "serial" });
// 初めての回は土台（sshd 入りのイメージ）を作る
test.setTimeout(900_000);

function containerExists(name: string): boolean {
  return listOwnedContainers().some((c) => c.name === name);
}

async function vaultAliases(): Promise<{ name: string; kind: string; implementation: string }[]> {
  const res = await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
    method: "POST",
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ server: "vault-directory", tool: "listAliases", arguments: {} }),
  });
  expect(res.status).toBe(200);
  return (JSON.parse(JSON.parse(await res.text()).content[0].text) as { aliases: { name: string; kind: string; implementation: string }[] })
    .aliases;
}

/** 終わった pid（生きていない印） */
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid!;
}

test("試験の鍵で SSH で入れる相手が立ち、本番の前提の形をしていて、閉じれば消える", async () => {
  const alias = `e2e-ssh-host-${Date.now()}`;
  let name = "";
  await withSshHost(
    async (host) => {
      name = host.name;
      // ---- 札：片づけ役・次の回が拾う形 ----
      expect(
        listOwnedContainers().find((c) => c.name === host.name)?.owner,
        "札がこの回の置き場でない（片づけ役が拾わない）",
      ).toBe(DATA_DIR);

      // ---- 1. 入れる・前提の形 ----
      const id = await host.ssh("id -u; id -un");
      expect(id.code, id.stderr).toBe(0);
      expect(id.stdout.trim().split("\n")).toEqual([String(SSH_HOST_UID), SSH_HOST_USER]);

      const silent = await host.ssh("true");
      expect(silent.code).toBe(0);
      expect(silent.stdout, "ログインシェルが何か出している（MCP の標準入出力が壊れる）").toBe("");

      // 道具：土台の一覧（sudo は「ある」が使えない——下）。node も
      const tools = ["git", "curl", "ssh", "unzip", "xz", "tmux", "node", "npm"];
      expect(BASE_PACKAGES, "土台の道具の一覧が変わった——ここで見る道具も見直す").toEqual([
        "git", "curl", "ca-certificates", "openssh-client", "unzip", "xz-utils", "sudo", "tmux",
      ]);
      const which = await host.ssh(tools.map((t) => `command -v ${t} >/dev/null && echo ${t}`).join("; "));
      expect(which.stdout.trim().split("\n")).toEqual(tools);

      const sudo = await host.ssh("sudo -n true");
      expect(sudo.code, "相手のユーザーが sudo できる（banto は向こうで sudo しない前提）").not.toBe(0);

      // ユーザーの systemd は使えるが linger は無い（入れ子では断られる形のまま——前提の確かめが注意を出す相手）
      const bus = await host.ssh(`test -S /run/user/${SSH_HOST_UID}/bus && echo bus`);
      expect(bus.stdout.trim(), `/run/user/${SSH_HOST_UID}/bus が無い：${bus.stderr}`).toBe("bus");
      const linger = await host.rootExec(`test -e /var/lib/systemd/linger/${SSH_HOST_USER} && echo linger || echo none`);
      expect(linger.stdout.trim()).toBe("none");
      // sshd から起こした非対話のセッションには XDG_RUNTIME_DIR が無いことがある（起動役が自分で組み立てる前提）——
      // ここでは「その上で bus を使える」ことだけ見る
      const userSystemd = await host.ssh(
        `XDG_RUNTIME_DIR=/run/user/${SSH_HOST_UID} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${SSH_HOST_UID}/bus systemctl --user is-system-running`,
      );
      expect(userSystemd.stdout.trim(), userSystemd.stderr).toMatch(/^(running|degraded)$/);

      // 置き場の根（既定 ~/.local/share/banto-remote）に書ける
      const writable = await host.ssh("mkdir -p ~/.local/share/banto-remote && test -w ~/.local/share/banto-remote && echo ok");
      expect(writable.stdout.trim()).toBe("ok");

      // ---- 2. 覚えた host 鍵と違えば繋がない ----
      const real = host.hostKey;
      expect(real).toMatch(/^ssh-ed25519 AAAA/);
      const other = otherHostKey();
      writeFileSync(host.knownHostsFile, `${host.address} ${other}\n`);
      const refused = await host.ssh("true");
      expect(refused.code, "覚えた host 鍵と違うのに繋がった").not.toBe(0);
      expect(refused.stderr).toMatch(/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
      writeFileSync(host.knownHostsFile, `${host.address} ${real}\n`);
      expect((await host.ssh("true")).code).toBe(0);

      // ---- 3. 秘密鍵は試験の Vault に ----
      expect(host.vaultAlias).toBe(alias);
      const mine = (await vaultAliases()).find((a) => a.name === alias);
      expect(mine, "Vault に試験の鍵が無い").toBeTruthy();
      expect(mine!.kind).toBe("ssh-identity");
      expect(mine!.implementation).toBe("vault-local");
    },
    { vaultAlias: alias },
  );

  // ---- 4a. 閉じれば消える（コンテナも Vault の鍵も） ----
  expect(containerExists(name), `閉じたのに ${name} が残っている`).toBe(false);
  expect((await vaultAliases()).some((a) => a.name === alias), "閉じたのに Vault に鍵が残っている").toBe(false);
});

test("回が死んだら片づけ役が、片づけ役ごと死んでも次の回の始めが、SSH の相手を消す", async () => {
  // ---- 4b. 片づけ役（run-reaper.ts）：Playwright が居なくなったら、その回の札のものを消す ----
  // 札はこの回の下の自前の置き場（`containers.ts` の E2E_OWNER の形・印はこの回）——別のセッションの次の回は
  // この回が生きている間は触らない。片づけ役の試験が落ちて残っても、この回が終われば次の回が拾う
  const reaperOwner = join(E2E_BASE, process.env.BANTO_E2E_RUN_ID!, "own-ssh-reaper", "data");
  mkdirSync(dirname(reaperOwner), { recursive: true });
  const forReaper = await startSshHost({ owner: reaperOwner });
  try {
    const gone = deadPid();
    // 画面の port は誰も使っていない番号（片づけ役が他の回の画面のサーバを巻き込まない）
    const reaper = spawn(process.execPath, [join(HERE, "..", "run-reaper.ts"), String(gone), String(gone), reaperOwner, "1"], {
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => reaper.once("exit", resolve));
    expect(code, "片づけ役が失敗した").toBe(0);
    expect(containerExists(forReaper.name), `片づけ役が ${forReaper.name} を消していない`).toBe(false);
  } finally {
    await forReaper.close().catch(() => undefined);
    rmSync(dirname(reaperOwner), { recursive: true, force: true });
  }

  // ---- 4c. 次の回の始め（global-setup.ts）：もう走っていない回の札のものを拾う ----
  const staleOwner = join(E2E_BASE, String(deadPid()), "data");
  const left = await startSshHost({ owner: staleOwner });
  try {
    expect(staleOwnedContainers(DATA_DIR), "死んだ回の SSH の相手を、次の回の始めが拾わない").toContain(left.name);
  } finally {
    await left.close();
  }
  expect(containerExists(left.name)).toBe(false);
});

/** 別の host 鍵（相手のものではない） */
function otherHostKey(): string {
  const dir = mkdtempSync(join(tmpdir(), "banto-e2e-hostkey-"));
  try {
    const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ssh-keygen：${r.stderr}`);
    return spawnSync("cut", ["-d", " ", "-f1,2", join(dir, "k.pub")], { encoding: "utf8" }).stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
