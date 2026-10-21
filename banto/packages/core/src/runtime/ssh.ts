// **実行場所「別のサーバ」へ SSH で繋ぐ部品**（決定・2026-10-08、`docs/specs/v4-security.md` §1「Project の実行場所——
// 別のサーバ」）。登録の画面（Backlog `remote-runtime-registry`）と、Module の起動（`remote-ssh.ts`、Backlog `remote-runtime-ssh`）が
// 同じものを使う——host 鍵を引く・前提を確かめる・向こうのフォルダを引く・根を正規化する。
//
// **`ssh` の設定は banto が固定し、人の設定を読まない**：
//   - `-F /dev/null`——`~/.ssh/config` を読まない（`ForwardAgent yes` があると Vault の窓口が丸ごと向こうへ渡る）
//   - known_hosts は banto の置き場の1行だけ（`HostKeyAlias` で宛先の書き方に左右されない）・`StrictHostKeyChecking=yes`
//   - 鍵は Vault が立てた ssh-agent の窓口だけ。`IdentitiesOnly=yes` と公開鍵のファイルで、その鍵だけを出す
//     （`-i` に公開鍵を渡すと、秘密鍵の代わりに agent が署名する。人の `~/.ssh/id_*` は試さない）
//   - `ForwardAgent=no`・`BatchMode=yes`（パスワードや「この鍵を覚えますか」を聞かない）
//
// コマンドを向こうに渡すときは、引数ではなく標準入力に台本を流す（`sh -s`）——ログインシェルを通る引用を考えなくてよい。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  aptUsable,
  commonFixes,
  dockerFixCommands,
  markAutoFixes,
  mayInstallDocker,
  preparedCheck,
  runFixes,
  type RanCommand,
  type RootRun,
} from "./host-autoprep.js";
import type { ProjectWokeCause } from "../project-thread/types.js";

/** 繋ぐ先（登録した1件の、SSH に要る分） */
export interface SshTarget {
  host: string;
  user: string;
  port: number;
}

/** 覚えた（か、いま返ってきた）host 鍵 */
export interface HostKey {
  /** 鍵の種類（`ssh-ed25519`・`ecdsa-sha2-nistp256`・`ssh-rsa` 等。known_hosts に書く形） */
  type: string;
  /** 公開鍵の本体（base64） */
  key: string;
  /** `SHA256:…`（`ssh-keygen -l` と同じ形。人が向こうで打って見比べる） */
  fingerprint: string;
}

/** 前提の1項目の結果。fail は断る、warn は使えるが注意を出す */
export interface RuntimeCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  /** fail・warn のときの説明 */
  detail?: string;
  /** 直し方（向こうで人が打つコマンド） */
  fix?: string;
  /** 覚えておく値（画面には出さない。`cpu-avx2` は `"1"`／`"0"`） */
  value?: string;
  /** banto が登録・確かめ直しのときに sudo -n で整える項目（画面は「準備して登録する」にする。v4-security.md §1「足りないものは banto が入れる」） */
  autoFix?: boolean;
}

/** 繋いだときに使う、host の側のファイル */
export interface SshFiles {
  /** その相手の host 鍵だけを書いた known_hosts */
  knownHostsFile: string;
  /** Vault が立てた ssh-agent の窓口 */
  agentSocket: string;
  /** 使う鍵の公開鍵のファイル（agent の中のその鍵だけを出す） */
  publicKeyFile: string;
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** known_hosts と `HostKeyAlias` で使う名前。宛先の書き方（名前・IP・ポート）に左右されないように1つに決める */
export const HOST_KEY_ALIAS = "banto-runtime";

/** 指紋：公開鍵の本体の SHA-256 を base64（末尾の `=` は落とす）——`ssh-keygen -lf` と同じ */
export function fingerprintOf(keyBase64: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** 人に見せる種類の名前（`ssh-keygen -l` の括弧の中と同じ） */
export function hostKeyTypeLabel(type: string): string {
  if (type === "ssh-ed25519") return "ED25519";
  if (type.startsWith("ecdsa-")) return "ECDSA";
  if (type === "ssh-rsa") return "RSA";
  return type;
}

/** 種類の好み（強い順）。`ssh-keyscan` が返した中から1つ選ぶ */
const KEY_PREFERENCE = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

/** その鍵の種類で、繋ぐときに使わせる署名の方式（`HostKeyAlgorithms`）。RSA は SHA-2 の署名だけ */
function hostKeyAlgorithmsFor(type: string): string {
  return type === "ssh-rsa" ? "rsa-sha2-512,rsa-sha2-256" : type;
}

/** known_hosts の1行 */
export function knownHostsLine(key: HostKey): string {
  return `${HOST_KEY_ALIAS} ${key.type} ${key.key}\n`;
}

/** `ssh-keyscan` の出力から鍵を選ぶ。無ければ undefined */
export function pickHostKey(keyscanOutput: string): HostKey | undefined {
  const keys = new Map<string, string>();
  for (const line of keyscanOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [, type, key] = trimmed.split(/\s+/);
    if (type && key && !keys.has(type)) keys.set(type, key);
  }
  const type = KEY_PREFERENCE.find((t) => keys.has(t));
  if (!type) return undefined;
  const key = keys.get(type)!;
  return { type, key, fingerprint: fingerprintOf(key) };
}

/** 宛先の形を確かめる（ssh の引数に混ざって別の意味にならないように——`-o…` で始まる名前などを断る） */
export function targetProblem(t: SshTarget): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(t.host) || t.host.length > 253) {
    return "ホストは名前か IP アドレスで書いてください（英数字と . : - だけ）";
  }
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(t.user) || t.user.length > 32) {
    return "ユーザーの名前に使えない字があります";
  }
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return "ポートは 1〜65535 の数です";
  return undefined;
}

function run(file: string, args: string[], opts: { input?: string; timeoutMs: number }): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: sshEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 255) : 0;
      // 時間切れ（kill された）は stderr に言葉を足す——黙って「繋がらない」にしない
      const killed = err && (err as { killed?: boolean }).killed ? `\n（${Math.round(opts.timeoutMs / 1000)} 秒で終わらなかったので止めました）` : "";
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + killed });
    });
    child.stdin?.end(opts.input ?? "");
  });
}

/** ssh・ssh-keyscan に渡す環境。人の agent（`SSH_AUTH_SOCK`）を引き継がない——使うのは Vault の窓口だけ */
export function sshEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * **向こうの host 鍵を引く**（繋ぐ前。覚えるのは人が指紋を確かめてから）。
 * 名前が引けない・届かない・sshd がいない、は理由を添えて投げる
 */
export async function scanHostKey(t: Pick<SshTarget, "host" | "port">, opts: { timeoutMs?: number } = {}): Promise<HostKey> {
  const r = await run("ssh-keyscan", ["-T", "5", "-p", String(t.port), "-t", "ed25519,ecdsa,rsa", "--", t.host], {
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const key = pickHostKey(r.stdout);
  if (!key) {
    const why = r.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("#")).join(" ").trim();
    throw new Error(`${t.host}:${t.port} から host 鍵を受け取れませんでした（届かないか、SSH が待ち受けていません）${why ? `：${why}` : ""}`);
  }
  return key;
}

/** 固定した ssh の引数（宛先の手前まで） */
export function sshArgs(t: SshTarget, files: SshFiles, hostKeyType: string): string[] {
  return [
    "-F", "/dev/null",
    "-o", `UserKnownHostsFile=${files.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `HostKeyAlias=${HOST_KEY_ALIAS}`,
    "-o", "CheckHostIP=no",
    "-o", "UpdateHostKeys=no",
    "-o", `HostKeyAlgorithms=${hostKeyAlgorithmsFor(hostKeyType)}`,
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "IdentitiesOnly=yes",
    "-o", `IdentityAgent=${files.agentSocket}`,
    "-i", files.publicKeyFile,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-p", String(t.port),
    "-l", t.user,
  ];
}

/** 覚えた鍵と違う（か、覚えた種類の鍵をもう持っていない）ので ssh が断った */
export function isHostKeyRefusal(r: SshResult): boolean {
  return (
    r.code === 255 &&
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|no matching host key type found/i.test(r.stderr)
  );
}

/**
 * **ssh がそもそも向こうに繋がらなかった**（追加・2026-10-16、v4-architecture.md §2.4 の 3.）。終了コード 255 は ssh 自身の
 * 失敗（届かない・時間切れ・認証が通らない）。鍵の違いは別に扱う（人が確かめるもので、待っても直らない）
 */
export function isSshUnreachable(r: SshResult): boolean {
  return r.code === 255 && !isHostKeyRefusal(r);
}

/** 張っていた SSH の接続が途中で閉じた（向こうのコマンドの失敗ではない） */
export class SshConnectionClosedError extends Error {}

/** 向こうで台本（sh）を流す。台本は標準入力で渡す */
export function runRemoteScript(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  script: string,
  opts: { extraArgs?: string[]; timeoutMs?: number } = {},
): Promise<SshResult> {
  return run("ssh", [...sshArgs(t, files, hostKeyType), ...(opts.extraArgs ?? []), "--", t.host, "sh -s"], {
    input: script,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
}

/** sh の単一引用 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 向こうのパスを sh の式にする（`~`・`~/…` は向こうの `$HOME` で） */
export function remotePathExpr(path: string): string {
  if (path === "~" || path === "") return `"$HOME"`;
  if (path.startsWith("~/")) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

/** ssh が失敗したときの、人に見せる1行（ssh 自身の言葉をそのまま添える） */
export function sshFailure(what: string, r: SshResult): Error {
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@") && !l.startsWith("Warning: Permanently"));
  return new Error(`${what}（ssh の終了コード ${r.code}）${lines.length ? `：${lines.slice(-3).join(" ")}` : ""}`);
}

/** ssh そのものが落ちた（繋げなかった・鍵が違う）。呼び手が結果を見て、鍵の違いなら記録する */
export class SshCommandError extends Error {
  constructor(
    readonly what: string,
    readonly result: SshResult,
  ) {
    super(sshFailure(what, result).message);
  }
}

// ── 前提の確かめ ────────────────────────────────────────────────────────────

/** 標準出力の、ログインシェルが出したものと台本の出力の境目 */
const PROBE_MARKER = "__BANTO_PROBE_BEGIN__";

/** banto が動くのに要る道具（無ければ断る）。tmux は Terminal、docker は「中で Docker を使う」だけ（注意にとどめる） */
const REQUIRED_TOOLS = ["git", "ssh", "curl", "tar"] as const;

function probeScript(dataRoot: string, opts: { sudo?: boolean } = {}): string {
  return [
    `printf '%s\\n' ${PROBE_MARKER}`,
    // OS と apt（banto が足りないものを入れられるか。v4-security.md §1「足りないものは banto が入れる」）
    `if [ -r /etc/os-release ]; then (. /etc/os-release; printf 'os.id=%s\\nos.like=%s\\nos.version=%s\\nos.codename=%s\\n' "\${ID:-}" "\${ID_LIKE:-}" "\${VERSION_ID:-}" "\${VERSION_CODENAME:-}"); fi`,
    `if command -v apt-get >/dev/null 2>&1; then printf 'apt=1\\n'; else printf 'apt=0\\n'; fi`,
    `if command -v cloud-init >/dev/null 2>&1; then printf 'cloudinit=1\\n'; fi`,
    `if command -v dpkg >/dev/null 2>&1; then printf 'dpkg.arch=%s\\n' "$(dpkg --print-architecture)"; fi`,
    // sudo -n が通るか（登録の前と整えるときだけ。繋ぐたびには試さない——向こうの記録を汚さない）
    ...(opts.sudo ? [`if /usr/bin/sudo -n true >/dev/null 2>&1; then printf 'sudo=1\\n'; else printf 'sudo=0\\n'; fi`] : []),
    `printf 'arch=%s\\n' "$(uname -m)"`,
    // AVX2 の有無（覚えるだけで断らない——OpenCode の本体をどちら向けにするかに使う、アーキ仕様 §4.1）
    `if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then printf 'avx2=1\\n'; else printf 'avx2=0\\n'; fi`,
    `if v=$(getconf GNU_LIBC_VERSION 2>/dev/null); then printf 'libc=%s\\n' "$v"; elif ldd --version 2>&1 | grep -qi musl; then printf 'libc=musl\\n'; else printf 'libc=unknown\\n'; fi`,
    `for t in ${[...REQUIRED_TOOLS, "tmux", "docker", "rsync"].join(" ")}; do if command -v "$t" >/dev/null 2>&1; then printf 'tool.%s=1\\n' "$t"; else printf 'tool.%s=0\\n' "$t"; fi; done`,
    `uid=$(id -u); user=$(id -un)`,
    `printf 'uid=%s\\nuser=%s\\nhome=%s\\n' "$uid" "$user" "$HOME"`,
    `printf 'gid=%s\\n' "$(id -g)"`,
    // 補助のグループ（「中で Docker を使う」Project を人が開くときに、docker グループに足すか決める）
    `printf 'groups=%s\\n' "$(id -nG)"`,
    `if [ -S "/run/user/$uid/bus" ]; then printf 'bus=1\\n'; else printf 'bus=0\\n'; fi`,
    `if [ -e "/var/lib/systemd/linger/$user" ]; then printf 'linger=1\\n'; else printf 'linger=0\\n'; fi`,
    `root=${remotePathExpr(dataRoot)}`,
    `printf 'root=%s\\n' "$root"`,
    `if mkdir -p "$root" 2>/dev/null && [ -w "$root" ]; then printf 'writable=1\\n'; else printf 'writable=0\\n'; fi`,
    `if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then printf 'docker=1\\n'; else printf 'docker=0\\n'; fi`,
    // sshd の設定は root でないと `sshd -T` で読めない。ファイルを読む（Ubuntu は sshd_config.d を先に読み、最初の値が効く）
    `ms=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1)=="match"{exit} tolower($1)=="maxsessions"{print $2; exit}')`,
    `printf 'maxsessions=%s\\n' "\${ms:-10}"`,
    "",
  ].join("\n");
}

/** host の CPU の種類と libc（向こうと比べる） */
export function hostPlatform(): { arch: string; libc: string } {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return { arch, libc: header?.glibcVersionRuntime ? "glibc" : "musl" };
}

/** 台本の出力から、向こうの様子を読む */
export function parseProbe(stdout: string): { before: string; values: Map<string, string> } | undefined {
  const at = stdout.indexOf(`${PROBE_MARKER}\n`);
  if (at < 0) return undefined;
  const values = new Map<string, string>();
  for (const line of stdout.slice(at + PROBE_MARKER.length + 1).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { before: stdout.slice(0, at), values };
}

/** 転送の確かめの結果（`ExitOnForwardFailure` で -R を頼む） */
export interface ForwardingProbe {
  tcp: boolean;
  streamLocal: boolean;
}

/** 向こうの様子から前提の一覧を作る（判断はここだけ——画面は結果をそのまま出す） */
export function evaluateProbe(
  probe: { before: string; values: Map<string, string> },
  forwarding: ForwardingProbe,
  host: { arch: string; libc: string },
): RuntimeCheck[] {
  const v = probe.values;
  const user = v.get("user") ?? "";
  const uid = v.get("uid") ?? "";
  const checks: RuntimeCheck[] = [];

  const arch = v.get("arch") ?? "";
  const libcRaw = v.get("libc") ?? "unknown";
  const libc = libcRaw.startsWith("glibc") ? "glibc" : libcRaw === "musl" ? "musl" : "unknown";
  const sameArch = arch === host.arch && libc === host.libc;
  checks.push({
    id: "platform",
    label: `CPU の種類と libc（${host.arch}・${host.libc}）が banto と同じ`,
    status: sameArch ? "ok" : "fail",
    ...(sameArch
      ? {}
      : { detail: `向こうは ${arch || "不明"}・${libc === "unknown" ? "libc が不明" : libc} です。banto は同じ種類の node を送るので、違う機械では動かせません。` }),
  });

  // **覚えるだけで、無くても断らない**（追加・2026-10-17、アーキ仕様 §4.1「エージェントの本体を取ってくる」）——無ければ OpenCode は
  // AVX2 の無い機械向けの本体（baseline）を送る
  const avx2 = v.get("avx2") === "1";
  checks.push({
    id: "cpu-avx2",
    label: `CPU の AVX2（${avx2 ? "あり" : "なし"}。OpenCode の本体をどちら向けにするかに使う）`,
    status: "ok",
    value: avx2 ? "1" : "0",
    ...(avx2 ? {} : { detail: "AVX2 がありません。OpenCode は AVX2 の無い機械向けの本体を送ります（断りません）。" }),
  });

  const noisy = probe.before.trim();
  checks.push({
    id: "silent-login",
    label: "ログインしたときに何も出力しない",
    status: noisy ? "fail" : "ok",
    ...(noisy
      ? {
          detail: `SSH でコマンドを流すと、先に「${noisy.split("\n")[0]!.slice(0, 80)}」が出ます。Module の標準入出力が壊れます。~/.bashrc などの出力を、対話のときだけにしてください。`,
          fix: `# ~/.bashrc の先頭に\ncase $- in *i*) ;; *) return ;; esac`,
        }
      : {}),
  });

  const missing = REQUIRED_TOOLS.filter((t) => v.get(`tool.${t}`) !== "1");
  checks.push({
    id: "tools",
    label: `道具（${REQUIRED_TOOLS.join("・")}）`,
    status: missing.length ? "fail" : "ok",
    ...(missing.length
      ? {
          detail: `${missing.join("・")} がありません。`,
          fix: `sudo apt install ${missing.map((t) => (t === "ssh" ? "openssh-client" : t)).join(" ")}`,
        }
      : {}),
  });

  const tmux = v.get("tool.tmux") === "1";
  checks.push({
    id: "tmux",
    label: "tmux（Terminal が使う）",
    status: tmux ? "ok" : "warn",
    ...(tmux ? {} : { detail: "tmux がありません。Terminal は使えません（ほかの Module は動きます）。", fix: "sudo apt install tmux" }),
  });

  const rsync = v.get("tool.rsync") === "1";
  checks.push({
    id: "rsync",
    label: "rsync（前に居た場所へ戻すときに差分で写す）",
    status: rsync ? "ok" : "warn",
    ...(rsync
      ? {}
      : {
          detail: "rsync がありません。Project をこのサーバの前に居た場所へ戻すときは差分で写すので、断ります（ほかは動きます）。",
          fix: "sudo apt install rsync",
        }),
  });

  const bus = v.get("bus") === "1";
  checks.push({
    id: "user-systemd",
    label: `ユーザーの systemd（/run/user/${uid}/bus）`,
    status: bus ? "ok" : "fail",
    ...(bus
      ? {}
      : {
          detail: `/run/user/${uid}/bus がありません。Service・裏で流すコマンド・Module の起こし方が使います。`,
          fix: `sudo loginctl enable-linger ${user}  # のあと、${user} で一度ログインし直す`,
        }),
  });

  const linger = v.get("linger") === "1";
  checks.push({
    id: "linger",
    label: "SSH を閉じても動き続ける設定（linger）",
    status: linger ? "ok" : "warn",
    ...(linger
      ? {}
      : { detail: "SSH の接続を閉じると、Service と裏で流したコマンドが止まります。", fix: `sudo loginctl enable-linger ${user}` }),
  });

  const root = v.get("root") ?? "";
  const writable = v.get("writable") === "1";
  checks.push({
    id: "data-root",
    label: `置き場に書ける（${root}）`,
    status: writable ? "ok" : "fail",
    ...(writable ? {} : { detail: `${root} を作れないか、書けません。`, fix: `sudo install -d -o ${user} ${shq(root)}` }),
  });

  const maxSessions = Number(v.get("maxsessions") ?? "10");
  const denied = [!forwarding.tcp ? "AllowTcpForwarding" : "", !forwarding.streamLocal ? "AllowStreamLocalForwarding" : ""].filter(Boolean);
  const fewSessions = Number.isFinite(maxSessions) && maxSessions < 10;
  checks.push({
    id: "sshd",
    label: `SSH の転送が許されている・同時に開ける数（MaxSessions ${Number.isFinite(maxSessions) ? maxSessions : "不明"}）`,
    status: denied.length ? "fail" : fewSessions ? "warn" : "ok",
    ...(denied.length
      ? {
          detail: `sshd が転送を断りました（${denied.join("・")}）。banto との行き来は SSH の転送を通ります。`,
          fix: `# /etc/ssh/sshd_config.d/00-banto.conf に\n${denied.map((d) => `${d} yes`).join("\n")}\n# のあと sudo systemctl reload ssh`,
        }
      : fewSessions
        ? { detail: "1本の接続に開けるセッションが少ないので、Module が多いと起こせないことがあります。", fix: "# /etc/ssh/sshd_config.d/00-banto.conf に\nMaxSessions 20\n# のあと sudo systemctl reload ssh" }
        : {}),
  });

  const docker = v.get("docker") === "1";
  checks.push({
    id: "docker",
    label: "Docker（containerlab）",
    status: docker ? "ok" : "warn",
    ...(docker
      ? {}
      : {
          detail:
            "Docker がないか、このユーザーでは使えません。「中で Docker を使う」Project を人が作る・開くときに、sudo -n が通れば banto が入れます（通らなければ断ります）。",
          fix: `sudo apt install docker.io && sudo usermod -aG docker ${user}`,
        }),
  });
  return checks;
}

/** 向こうの様子と転送の確かめ（`machine`・`containers` の前提の確かめが共に使う）。繋げなかったら `probe` 無し */
export interface BaseProbe {
  probe?: { before: string; values: Map<string, string> };
  forwarding?: ForwardingProbe;
  result: SshResult;
}

/**
 * **向こうの様子を引き、転送が許されるかを確かめる**。1回目の接続で様子を引き、2回目の接続で転送が許されるかを実際に頼んで
 * 確かめる（`ExitOnForwardFailure`）
 */
export async function probeBase(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
  opts: { sudo?: boolean } = {},
): Promise<BaseProbe> {
  const first = await runRemoteScript(t, files, hostKeyType, probeScript(dataRoot, opts));
  const probe = first.code === 0 ? parseProbe(first.stdout) : undefined;
  if (!probe) return { result: first };

  // 転送：向こうの sshd に -R を頼む（TCP と UNIX ソケット）。断られれば ssh が名指しして終わる。`ExitOnForwardFailure` は
  // 最初の断りで終わるので、1本ずつ別の接続で（並べて）頼む——片方の断りで、もう片方が分からなくならないように
  const sock = `/tmp/banto-probe-${Math.random().toString(36).slice(2, 10)}.sock`;
  const ask = (forward: string) =>
    runRemoteScript(t, files, hostKeyType, `rm -f ${shq(sock)}\n`, { extraArgs: ["-o", "ExitOnForwardFailure=yes", "-R", forward] });
  const [tcp, stream] = await Promise.all([ask("0:127.0.0.1:9"), ask(`${sock}:127.0.0.1:9`)]);
  for (const r of [tcp, stream]) {
    // 転送の断り以外で落ちた（途中で切れた等）——確かめられなかったことを、断られたことに見せない
    if (r.code !== 0 && !/forwarding failed/i.test(r.stderr)) return { result: r };
  }
  return { probe, forwarding: { tcp: tcp.code === 0, streamLocal: stream.code === 0 }, result: first };
}

/**
 * **前提を確かめる**（`machine`。v4-security.md §1「前提の確かめ」）。繋げなかったら `checks` は空（ssh の結果を添える）
 */
export async function probePrerequisites(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
  opts: { stage?: "check" | "prepare" | "verify"; run?: RootRun; log?: (line: string) => void; base?: typeof probeBase } = {},
): Promise<{ checks: RuntimeCheck[]; result: SshResult; ran: RanCommand[] }> {
  const stage = opts.stage ?? "verify";
  const base = opts.base ?? probeBase;
  let { probe, forwarding, result } = await base(t, files, hostKeyType, dataRoot, { sudo: stage !== "verify" });
  if (!probe || !forwarding) return { checks: [], result, ran: [] };
  const sudo = probe.values.get("sudo") === "1";
  let fixes = commonFixes({ values: probe.values, forwarding, mode: "machine", requiredTools: REQUIRED_TOOLS });
  let ran: RanCommand[] = [];
  // 登録・人の「確かめ直す」：足りないものを sudo -n で入れてから確かめ直す（CPU の種類・ログインの静けさは入れられない——
  // そこが断られていれば何もしない。ログインで何か出る相手ではコマンドの答えが崩れる）
  if (stage === "prepare" && sudo && fixes.length > 0) {
    const first = evaluateProbe(probe, forwarding, hostPlatform());
    if (!first.some((c) => (c.id === "platform" || c.id === "silent-login") && c.status === "fail")) {
      const labels = new Map(first.map((c) => [c.id, c.label]));
      ran = await runFixes(opts.run ?? sshRun(t, files, hostKeyType), fixes, { labelOf: (id) => labels.get(id) ?? id, log: opts.log });
      ({ probe, forwarding, result } = await base(t, files, hostKeyType, dataRoot, { sudo: true }));
      if (!probe || !forwarding) return { checks: [], result, ran };
      fixes = commonFixes({ values: probe.values, forwarding, mode: "machine", requiredTools: REQUIRED_TOOLS });
    }
  }
  // 整えたあとに残ったものは、入れても直らなかった——「登録するときに入れます」とは言わない
  const checks = markAutoFixes(evaluateProbe(probe, forwarding, hostPlatform()), ran.length > 0 ? [] : fixes, stage, sudo);
  return { checks: ran.length > 0 ? [...checks, preparedCheck(ran)] : checks, result, ran };
}

/**
 * **「中で Docker を使う」Project を人が作る・開くときに、Docker を入れる**（`machine`。v4-security.md §1「足りないものは banto が
 * 入れる」の 5a.、Backlog #414）。登録では入れない（使わない VM で dockerd が資源を使わないよう）。使えていれば何もしない。
 * 自動化・届いたもので起きたとき・sudo -n が通らない・apt の無い OS では入れずに `skipped` を返す（呼び手は今どおり断る）。
 * 途中で落ちたら `AutoFixError`（それまでに行ったことを添える）
 */
export async function installDockerOnMachine(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
  opts: { cause: ProjectWokeCause; run?: RootRun; log?: (line: string) => void; base?: typeof probeBase },
): Promise<{ ran: RanCommand[]; skipped?: string }> {
  if (!mayInstallDocker(opts.cause)) return { ran: [], skipped: "人が作る・開くときではない" };
  const { probe } = await (opts.base ?? probeBase)(t, files, hostKeyType, dataRoot, { sudo: true });
  if (!probe) return { ran: [], skipped: "向こうの様子を引けない" };
  const v = probe.values;
  const commands = dockerFixCommands(v);
  if (commands.length === 0) return { ran: [] };
  if (v.get("sudo") !== "1") return { ran: [], skipped: "sudo -n が通らない" };
  if (!aptUsable(v) && v.get("tool.docker") !== "1") return { ran: [], skipped: "apt で入れられない OS" };
  const ran = await runFixes(opts.run ?? sshRun(t, files, hostKeyType), [{ id: "docker", commands }], {
    labelOf: () => "Docker（中で Docker を使う）",
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { ran };
}

/**
 * 向こうのユーザーとしてコマンドを1つ流す口を、SSH で作る（1つごとに別の接続——多重化しないので、替えたグループが次から効く）。
 * `input` はヒアドキュメントで標準入力に渡す（区切りは毎回でたらめな印）。出力は捨てない
 */
export function sshRun(t: SshTarget, files: SshFiles, hostKeyType: string): RootRun {
  return async (args, opts) => {
    const cmd = `exec ${args.map(shq).join(" ")}`;
    let script = `${cmd}\n`;
    if (opts?.input !== undefined) {
      const mark = `BANTO_EOF_${createHash("sha256").update(`${Math.random()}${Date.now()}`).digest("hex").slice(0, 16)}`;
      if (opts.input.includes(mark)) throw new Error("標準入力に区切りの印が入っています");
      const body = opts.input.endsWith("\n") ? opts.input : `${opts.input}\n`;
      script = `${cmd} >/dev/null <<'${mark}'\n${body}${mark}\n`;
    }
    return runRemoteScript(t, files, hostKeyType, script, { timeoutMs: opts?.timeoutMs ?? 30_000 });
  };
}

// ── 向こうのフォルダ ─────────────────────────────────────────────────────────

export interface RemoteDirectoryListing {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string }>;
}

/**
 * **向こうのフォルダの中のフォルダ**（`GET /api/fs/directories` と同じく名前だけ）。開こうとした場所が無い・読めないなら投げる。
 * 名前は NUL で区切って受け取る（改行を含む名前でも崩れない）
 */
export async function listRemoteDirectories(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  path: string | undefined,
): Promise<RemoteDirectoryListing> {
  const script = [
    `p=${remotePathExpr((path ?? "").trim())}`,
    `cd -- "$p" 2>/dev/null || { printf 'このフォルダを開けません：%s\\n' "$p" >&2; exit 3; }`,
    `printf '%s\\0' "$(pwd)"`,
    `for e in * .[!.]* ..?*; do [ -d "$e" ] && printf '%s\\0' "$e"; done`,
    "exit 0",
    "",
  ].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code === 3) throw new Error(r.stderr.trim().split("\n").pop() ?? "このフォルダを開けません");
  if (r.code !== 0) throw new SshCommandError("向こうのフォルダを読めませんでした", r);
  const parts = r.stdout.split("\0");
  // ログインシェルが何か出していると、先頭に混ざる——最初の区切りまでの中の最後の行を場所として読む
  const at = (parts.shift() ?? "").split("\n").pop() ?? "";
  if (!at.startsWith("/")) throw new Error("向こうのフォルダの場所を読めませんでした");
  const entries = parts
    .filter((name) => name !== "")
    .map((name) => ({ name, path: at === "/" ? `/${name}` : `${at}/${name}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const parent = at === "/" ? undefined : at.slice(0, at.lastIndexOf("/")) || "/";
  return { path: at, ...(parent ? { parent } : {}), entries };
}

/** **向こうで根を正規化する**（作るときに1回。v4-security.md §1「Project の記録に実行場所を持つ」）。フォルダでなければ投げる */
export async function realpathRemote(t: SshTarget, files: SshFiles, hostKeyType: string, path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") && trimmed !== "~" && !trimmed.startsWith("~/")) {
    throw new Error(`Root パスは絶対パスか ~ で始めてください（${JSON.stringify(path)}）`);
  }
  const script = [
    `p=${remotePathExpr(trimmed)}`,
    `[ -d "$p" ] || { printf '向こうにそのフォルダがありません：%s\\n' "$p" >&2; exit 3; }`,
    `cd -P -- "$p" && printf '%s\\0' "$(pwd -P)"`,
    "",
  ].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code === 3) throw new Error(r.stderr.trim().split("\n").pop() ?? "向こうにそのフォルダがありません");
  if (r.code !== 0) throw new SshCommandError("向こうのフォルダを確かめられませんでした", r);
  const resolved = (r.stdout.split("\0")[0] ?? "").split("\n").pop() ?? "";
  if (!resolved.startsWith("/")) throw new Error("向こうのフォルダの場所を読めませんでした");
  return resolved;
}

/**
 * **向こうにフォルダを1つ作る**（追加・2026-10-20、ユーザー）。親（`~`・`~/…`・絶対パス）の中に1段だけ（`mkdir -p` はしない）。
 * 名前は呼び手が確かめる（区切り・`..` は来ない）。親が無い・同じ名前がある・作れないは理由を添えて投げる。作ったフォルダの
 * 正規化した絶対パスを返す。`containers` でも VM のユーザーで作る——中身の無いフォルダを1つ作るだけで、見せたフォルダの中身を
 * 書く・解釈することではない（条件3）
 */
export async function createRemoteDirectory(t: SshTarget, files: SshFiles, hostKeyType: string, parent: string | undefined, name: string): Promise<string> {
  const script = [
    `p=${remotePathExpr((parent ?? "").trim())}`,
    `n=${shq(name)}`,
    `[ -d "$p" ] || { printf '向こうにそのフォルダがありません：%s\\n' "$p" >&2; exit 3; }`,
    `cd -P -- "$p" || exit 3`,
    `[ -e "$n" ] && { printf '同じ名前のものがもうあります：%s\\n' "$n" >&2; exit 3; }`,
    `mkdir -m 0755 -- "$n" 2>/dev/null || { printf 'その場所には作れません（権限がありません）\\n' >&2; exit 3; }`,
    `cd -P -- "$n" && printf '%s\\0' "$(pwd -P)"`,
    "",
  ].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code === 3) throw new Error(r.stderr.trim().split("\n").pop() ?? "向こうにフォルダを作れませんでした");
  if (r.code !== 0) throw new SshCommandError("向こうにフォルダを作れませんでした", r);
  const made = (r.stdout.split("\0")[0] ?? "").split("\n").pop() ?? "";
  if (!made.startsWith("/")) throw new Error("作ったフォルダの場所を読めませんでした");
  return made;
}

/**
 * **向こうの空のフォルダを1つ消す**（追加・2026-10-20、v4-frontend.md §6.49）。新しい Project の始め方で作ったフォルダに
 * Project を作れなかったときの片づけ。`rmdir` なので空でなければ消えない（自分が作ったものだけを消す）。無ければ何もしない
 */
export async function removeRemoteEmptyDirectory(t: SshTarget, files: SshFiles, hostKeyType: string, path: string): Promise<void> {
  const script = [`p=${shq(path)}`, `[ -d "$p" ] || exit 0`, `rmdir -- "$p"`, ""].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code !== 0) throw new SshCommandError("向こうに作ったフォルダを片づけられませんでした", r);
}

/**
 * **その根が、向こうの banto の置き場を含むか**（v4-security.md §1「登録と選び方」——広すぎる根の警告は、向こうの banto の
 * 置き場の根を含むかで判断する）。どちらも向こうで正規化して比べる。根がまだ無い（打っている途中）なら含まない
 */
export async function remoteRootIncludesDataRoot(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  root: string,
  dataRoot: string,
): Promise<{ includes: boolean; dataRoot: string }> {
  const script = [
    `p=${remotePathExpr(root.trim())}`,
    `d=${remotePathExpr(dataRoot)}`,
    `[ -d "$d" ] && d=$(cd -P -- "$d" && pwd -P)`,
    `printf '%s\\0' "$d"`,
    `[ -d "$p" ] || { printf 'no\\0'; exit 0; }`,
    `p=$(cd -P -- "$p" && pwd -P)`,
    `case "$d/" in "$p"/*|"$p"/) printf 'yes\\0' ;; *) if [ "$p" = / ]; then printf 'yes\\0'; else printf 'no\\0'; fi ;; esac`,
    "",
  ].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code !== 0) throw new SshCommandError("向こうの置き場を確かめられませんでした", r);
  const parts = r.stdout.split("\0");
  const resolvedDataRoot = (parts[0] ?? "").split("\n").pop() ?? "";
  return { includes: parts[1] === "yes", dataRoot: resolvedDataRoot };
}

/**
 * **向こうの home と置き場の根を正規化して引く**（containers の根の重なりを見るため）。置き場の根がまだ無ければ、
 * 綴りを展開しただけのもの
 */
export async function remoteHomeAndDataRoot(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
): Promise<{ home: string; dataRoot: string }> {
  const script = [
    `h=$(cd -P -- "$HOME" && pwd -P) || exit 1`,
    `d=${remotePathExpr(dataRoot)}`,
    `[ -d "$d" ] && d=$(cd -P -- "$d" && pwd -P)`,
    `printf '%s\\0%s\\0' "$h" "$d"`,
    "",
  ].join("\n");
  const r = await runRemoteScript(t, files, hostKeyType, script);
  if (r.code !== 0) throw new SshCommandError("向こうの home と置き場を確かめられませんでした", r);
  const parts = r.stdout.split("\0");
  const home = (parts[0] ?? "").split("\n").pop() ?? "";
  const resolved = parts[1] ?? "";
  if (!home.startsWith("/") || !resolved.startsWith("/")) throw new Error("向こうの home と置き場の場所を読めませんでした");
  return { home, dataRoot: resolved };
}
