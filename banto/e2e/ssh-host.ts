// **E2E で SSH で入れる相手**（追加・2026-10-08、Backlog `remote-runtime-e2e-host`、v4-security.md §1
// 「Project の実行場所——別のサーバ」の「試験」）。
//
// 実行場所「別のサーバ」の試験の相手を、入れ子のコンテナで立てる。本番の相手（人が組んだ Ubuntu）に寄せる：
//   - **専用のユーザー**（`banto-remote`、uid 1500。host の uid と違う番号にして、同じパスで見えている前提を持ち込まない）
//   - **sudo できない**——banto は向こうで sudo しない（仕様「前提の確かめ」）。土台のイメージの「誰でも sudo」は外す
//   - **道具**は土台のイメージ（`BASE_PACKAGES`・node）のまま＋sshd
//   - **linger は無い**——入れ子では `loginctl enable-linger` が root でも断られる（2026-10-07 実測）。代わりに root が
//     起動時に `user@1500.service` を起こしておく。`/run/user/1500/bus` はあるが linger は無い、という形になる
//     （前提の確かめは本番と同じ規則で通り、linger の注意が出る）
//   - **host 鍵はコンテナごとに作る**（イメージに焼かない）——host 鍵の確かめ・鍵が変わったら断る試験のため
//
// **片づけ**：コンテナに札（`user.banto.owner`＝その回のデータの置き場）を付ける——終わるとき（`global-teardown.ts`）・
// 回が死んだのを見届ける片づけ役（`run-reaper.ts`）・次の回の始め（`global-setup.ts`）が、Project のコンテナと同じく消す。
// 土台を作る一時のコンテナにも同じ札を付ける（作っている途中で殺されても拾われる）。
//
// **鍵**：試験の側で鍵ペアを作り、公開鍵を相手の `authorized_keys` に置く。秘密鍵は試験の Vault（vault-local）に
// `ssh-identity` として預けられる（`vaultAlias`）——banto はそこから使う（秘密鍵を host のディスクに出さない）。
// 試験の側にも同じ鍵のファイルを残すのは、banto を通さずに「入れる」ことを試験が自分で確かめるため。
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANTO_POOL, baseImageAlias, ensureBaseImage, runIncus, type IncusResult } from "@banto/container";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "./config.ts";
import { listOwnedContainers, removeContainers } from "./containers.ts";

/** 相手のユーザー（本番では人が作る専用のユーザー） */
export const SSH_HOST_USER = "banto-remote";
export const SSH_HOST_UID = 1500;

/**
 * 土台（banto の土台イメージ）に足す手順。root で1回だけ流し、止めてイメージにする。
 * **ssh.socket は使わない**——起動時の準備（下の unit）を sshd より先に流すと、socket は basic.target より前に立つので
 * 順序が輪になり、systemd が ssh.socket を落とす（2026-10-08 実測：起こし直したら 22 番が誰も待ち受けていなかった）
 */
const RECIPE = `set -e
apt-get install -y -q --no-install-recommends openssh-server
apt-get clean
useradd -m -s /bin/bash -u ${SSH_HOST_UID} ${SSH_HOST_USER}
install -d -m 700 -o ${SSH_HOST_USER} -g ${SSH_HOST_USER} /home/${SSH_HOST_USER}/.ssh
rm -f /etc/sudoers.d/banto
cat > /etc/ssh/sshd_config.d/banto-e2e.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding yes
AllowStreamLocalForwarding yes
EOF
cat > /etc/systemd/system/banto-e2e-prepare.service <<'EOF'
[Unit]
Description=banto E2E: host keys and the user session (linger is refused in nested containers)
Before=ssh.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/ssh-keygen -A
ExecStart=/bin/systemctl start --no-block user@${SSH_HOST_UID}.service
[Install]
WantedBy=multi-user.target
EOF
systemctl disable ssh.socket
systemctl enable ssh.service banto-e2e-prepare.service
rm -f /etc/ssh/ssh_host_*
`;

/** 土台の名前・手順から決まる名前（どちらかが変われば作り直す） */
function sshHostImageAlias(): string {
  const h = createHash("sha256").update(`${baseImageAlias()}\n${RECIPE}`).digest("hex").slice(0, 12);
  return `banto-e2e-sshd-${h}`;
}

export interface SshHost {
  /** コンテナの名前 */
  name: string;
  /** 相手のアドレス（ブリッジの IPv4） */
  address: string;
  port: number;
  user: string;
  uid: number;
  /** 試験の側の秘密鍵のファイル（banto を通さずに入れることを確かめる用） */
  identityFile: string;
  publicKey: string;
  /** 相手の host 鍵（`ssh-ed25519 AAAA…`、`incus exec` で読んだもの——SSH の外から得た正しい値） */
  hostKey: string;
  /** 相手の host 鍵だけを入れた known_hosts */
  knownHostsFile: string;
  /** 秘密鍵を預けた Vault の alias（預けたときだけ） */
  vaultAlias?: string;
  /** 試験の鍵で入ってコマンドを流す（ssh の設定は固定、人の `~/.ssh` を読まない） */
  ssh(command: string, opts?: { timeoutMs?: number }): Promise<IncusResult>;
  /** 相手の中で root でコマンドを流す（`incus exec`） */
  rootExec(command: string): Promise<IncusResult>;
  /** コンテナを消し、Vault の alias と試験の側の鍵を消す。全部やってから、できなかったものをまとめて投げる */
  close(): Promise<void>;
}

export interface SshHostOptions {
  /** 秘密鍵を試験の Vault（vault-local）にこの alias で預ける */
  vaultAlias?: string;
  /** 札（既定はこの回のデータの置き場）。片づけ役の試験だけが変える */
  owner?: string;
}

/** 相手を立てて、終わったら必ず片づける。`fn` が失敗していれば、片づけの失敗は元の失敗を隠さない */
export async function withSshHost<T>(fn: (host: SshHost) => Promise<T>, opts: SshHostOptions = {}): Promise<T> {
  const host = await startSshHost(opts);
  let failed = false;
  try {
    return await fn(host);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    try {
      await host.close();
    } catch (cleanupErr) {
      if (!failed) throw cleanupErr;
      console.warn("[e2e] SSH の相手を片づけられませんでした（元の失敗を先に出します）:", cleanupErr);
    }
  }
}

export async function startSshHost(opts: SshHostOptions = {}): Promise<SshHost> {
  const owner = opts.owner ?? DATA_DIR;
  const image = await ensureSshHostImage(owner);
  const name = `e2e-ssh-${randomBytes(4).toString("hex")}`;
  const keyDir = mkdtempSync(join(tmpdir(), "banto-e2e-ssh-"));
  const identityFile = join(keyDir, "id_ed25519");
  const knownHostsFile = join(keyDir, "known_hosts");
  let vaultAlias: string | undefined;

  const rootExec = (command: string) => runIncus(["exec", name, "--", "sh", "-c", command], { timeoutMs: 120_000 });

  const close = async (): Promise<void> => {
    const problems: string[] = [];
    try {
      const failed = removeContainers([name], () => undefined);
      if (failed.length > 0) problems.push(`コンテナ ${name} を消せません`);
    } catch (err) {
      problems.push(`コンテナ ${name} を消せません：${(err as Error).message}`);
    }
    if (vaultAlias) {
      await vaultCall("deleteAlias", { implementation: "vault-local", name: vaultAlias }).catch((err: unknown) =>
        problems.push(`Vault の alias ${vaultAlias} を消せません：${(err as Error).message}`),
      );
    }
    rmSync(keyDir, { recursive: true, force: true });
    if (problems.length > 0) throw new Error(`[e2e] SSH の相手の片づけ：${problems.join("／")}`);
  };

  try {
    await must(["launch", image, name, "--storage", BANTO_POOL, "-c", `user.banto.owner=${owner}`], "SSH の相手を立てる", 180_000);
    await waitSystemReady(name);

    await execFileP("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `banto-e2e-${name}`, "-f", identityFile]);
    const publicKey = readFileSync(`${identityFile}.pub`, "utf8").trim();
    const authorized = `/home/${SSH_HOST_USER}/.ssh/authorized_keys`;
    await mustExec(
      rootExec,
      `printf '%s\\n' '${publicKey}' > ${authorized} && chown ${SSH_HOST_USER}: ${authorized} && chmod 600 ${authorized}`,
      "公開鍵を置く",
    );
    // host 鍵は SSH の外（incus exec）から読む——試験が「正しい鍵」を独立に知っておく
    const hostKey = (await mustExec(rootExec, "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub", "host 鍵を読む")).trim();
    const address = await waitAddress(name);
    writeFileSync(knownHostsFile, `${address} ${hostKey}\n`);

    const ssh = (command: string, sshOpts: { timeoutMs?: number } = {}) =>
      sshRun({ address, identityFile, knownHostsFile }, command, sshOpts.timeoutMs ?? 30_000);
    await waitSshReady(ssh);

    if (opts.vaultAlias) {
      await vaultCall("createAlias", {
        implementation: "vault-local",
        name: opts.vaultAlias,
        kind: "ssh-identity",
        value: readFileSync(identityFile, "utf8"),
        note: `E2E の SSH の相手 ${name}`,
      });
      vaultAlias = opts.vaultAlias;
    }

    return {
      name,
      address,
      port: 22,
      user: SSH_HOST_USER,
      uid: SSH_HOST_UID,
      identityFile,
      publicKey,
      hostKey,
      knownHostsFile,
      vaultAlias,
      ssh,
      rootExec,
      close,
    };
  } catch (err) {
    await close().catch((cleanupErr: unknown) => console.warn("[e2e] 立たなかった SSH の相手を片づけられませんでした:", cleanupErr));
    throw err;
  }
}

/** ssh の設定は固定（`-F /dev/null`・覚えた host 鍵だけ・試験の鍵だけ・agent を使わない） */
function sshRun(
  target: { address: string; identityFile: string; knownHostsFile: string },
  command: string,
  timeoutMs: number,
): Promise<IncusResult> {
  const args = [
    "-F", "/dev/null",
    "-i", target.identityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    `${SSH_HOST_USER}@${target.address}`,
    command,
  ];
  return runProcess("ssh", args, timeoutMs);
}

let building: Promise<string> | undefined;

/** 相手の土台が無ければ作る（banto の土台イメージから）。同じ worker の中で同時に呼ばれても1回だけ作る */
function ensureSshHostImage(owner: string): Promise<string> {
  building ??= buildSshHostImage(owner).finally(() => {
    building = undefined;
  });
  return building;
}

async function buildSshHostImage(owner: string): Promise<string> {
  const alias = sshHostImageAlias();
  const project = (await must(["project", "get-current"], "いまの区画を引く")).trim();
  const imagePath = `/1.0/images/aliases/${alias}?project=${encodeURIComponent(project)}`;
  if ((await runIncus(["query", imagePath], { timeoutMs: 30_000 })).code === 0) return alias;

  const base = await ensureBaseImage(runIncus);
  const tmp = `${alias}-build-${process.pid}`;
  try {
    await must(["launch", base, tmp, "--storage", BANTO_POOL, "-c", `user.banto.owner=${owner}`], "SSH の相手の土台を作る一時のコンテナを立てる", 180_000);
    await waitSystemReady(tmp);
    await must(
      ["exec", tmp, "--env", "DEBIAN_FRONTEND=noninteractive", "--", "sh", "-c", `apt-get update -q && ${RECIPE}`],
      "SSH の相手の土台に sshd と専用のユーザーを入れる",
      600_000,
    );
    await must(["stop", tmp], "一時のコンテナを止める", 120_000);
    const published = await runIncus(["publish", tmp, "--alias", alias], { timeoutMs: 600_000 });
    // 別の回が同時に作り終えていれば、それを使う
    if (published.code !== 0 && (await runIncus(["query", imagePath], { timeoutMs: 30_000 })).code !== 0) {
      throw new Error(`SSH の相手の土台をイメージにできません：${(published.stderr || published.stdout).trim().slice(-800)}`);
    }
    return alias;
  } finally {
    await runIncus(["delete", "--force", tmp], { timeoutMs: 120_000 });
  }
}

/**
 * init が上がりきるまで待つ。起こした直後は `systemctl` が bus に繋がらない（「Failed to connect to bus」、
 * 2026-10-08 実測）ので、それは「まだ」として待つ。degraded（何かが落ちた）は落ちたものを添えて投げる
 */
async function waitSystemReady(name: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await runIncus(["exec", name, "--", "systemctl", "is-system-running", "--wait"], { timeoutMs: 120_000 });
    last = (r.stdout || r.stderr).trim();
    if (last === "running") return;
    if (last === "degraded") {
      const failed = await runIncus(["exec", name, "--", "systemctl", "--failed", "--no-legend"], { timeoutMs: 30_000 });
      throw new Error(`${name} の中で落ちた unit があります：${failed.stdout.trim()}`);
    }
    await sleep(500);
  }
  throw new Error(`${name} の init が 120 秒で上がりません（最後の答え：${last}）`);
}

/** ブリッジの IPv4 が付くまで待つ */
async function waitAddress(name: string): Promise<string> {
  // `incus query` は区画を自分で補わない（人の Incus は既定の区画を使わせない）
  const project = (await must(["project", "get-current"], "いまの区画を引く")).trim();
  const statePath = `/1.0/instances/${name}/state?project=${encodeURIComponent(project)}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await runIncus(["query", statePath], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`${name} の状態を読めません：${r.stderr.trim()}`);
    const state = JSON.parse(r.stdout) as { network?: Record<string, { addresses?: { family: string; scope: string; address: string }[] }> };
    const address = state.network?.eth0?.addresses?.find((a) => a.family === "inet" && a.scope === "global")?.address;
    if (address) return address;
    await sleep(500);
  }
  throw new Error(`${name} に 60 秒でアドレスが付きません`);
}

/** sshd が試験の鍵を受けるまで待つ（起動時の準備のあとで sshd が上がる） */
async function waitSshReady(ssh: SshHost["ssh"]): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: IncusResult | undefined;
  while (Date.now() < deadline) {
    last = await ssh("true", { timeoutMs: 15_000 });
    if (last.code === 0) return;
    await sleep(500);
  }
  throw new Error(`SSH で 60 秒入れません：${last?.stderr.trim()}`);
}

/** banto 全体の Module を画面と同じ口で呼ぶ（人の管理操作） */
async function vaultCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CORE_BASE_URL}/api/ui-tool-call`, {
    method: "POST",
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ server: "vault-directory", tool, arguments: args }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vault-directory の ${tool} が ${res.status}：${text.slice(0, 500)}`);
  const body = JSON.parse(text) as { isError?: boolean; content?: { text?: string }[] };
  if (body.isError) throw new Error(`vault-directory の ${tool} が失敗しました：${body.content?.[0]?.text ?? text.slice(0, 500)}`);
  return body;
}

async function must(args: string[], what: string, timeoutMs = 120_000): Promise<string> {
  const r = await runIncus(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what}のに失敗しました：${(r.stderr || r.stdout).trim().slice(-800) || `終了コード ${r.code}`}`);
  return r.stdout;
}

async function mustExec(exec: (command: string) => Promise<IncusResult>, command: string, what: string): Promise<string> {
  const r = await exec(command);
  if (r.code !== 0) throw new Error(`${what}のに失敗しました：${(r.stderr || r.stdout).trim().slice(-800) || `終了コード ${r.code}`}`);
  return r.stdout;
}

function runProcess(file: string, args: string[], timeoutMs: number): Promise<IncusResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

async function execFileP(file: string, args: string[]): Promise<void> {
  const r = await runProcess(file, args, 30_000);
  if (r.code !== 0) throw new Error(`${file} が失敗しました：${r.stderr.trim()}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 試験の後ろで、この札のものが残っていないかを見る */
export function sshHostsOwnedBy(owner: string): string[] {
  return listOwnedContainers().filter((c) => c.owner === owner && c.name.startsWith("e2e-ssh-")).map((c) => c.name);
}
