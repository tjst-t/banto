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

function probeScript(dataRoot: string): string {
  return [
    `printf '%s\\n' ${PROBE_MARKER}`,
    `printf 'arch=%s\\n' "$(uname -m)"`,
    `if v=$(getconf GNU_LIBC_VERSION 2>/dev/null); then printf 'libc=%s\\n' "$v"; elif ldd --version 2>&1 | grep -qi musl; then printf 'libc=musl\\n'; else printf 'libc=unknown\\n'; fi`,
    `for t in ${[...REQUIRED_TOOLS, "tmux", "docker"].join(" ")}; do if command -v "$t" >/dev/null 2>&1; then printf 'tool.%s=1\\n' "$t"; else printf 'tool.%s=0\\n' "$t"; fi; done`,
    `uid=$(id -u); user=$(id -un)`,
    `printf 'uid=%s\\nuser=%s\\nhome=%s\\n' "$uid" "$user" "$HOME"`,
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
          fix: `# /etc/ssh/sshd_config.d/banto.conf に\n${denied.map((d) => `${d} yes`).join("\n")}\n# のあと sudo systemctl reload ssh`,
        }
      : fewSessions
        ? { detail: "1本の接続に開けるセッションが少ないので、Module が多いと起こせないことがあります。", fix: "# /etc/ssh/sshd_config.d/banto.conf に\nMaxSessions 20" }
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
          detail: "Docker がないか、このユーザーでは使えません。「中で Docker を使う」Project では断ります。",
          fix: `sudo apt install docker.io && sudo usermod -aG docker ${user}`,
        }),
  });
  return checks;
}

/**
 * **前提を確かめる**（v4-security.md §1「前提の確かめ」）。繋げなかったら投げる（ssh の言葉を添えて）。
 * 1回目の接続で様子を引き、2回目の接続で転送が許されるかを実際に頼んで確かめる（`ExitOnForwardFailure`）
 */
export async function probePrerequisites(
  t: SshTarget,
  files: SshFiles,
  hostKeyType: string,
  dataRoot: string,
): Promise<{ checks: RuntimeCheck[]; result: SshResult }> {
  const first = await runRemoteScript(t, files, hostKeyType, probeScript(dataRoot));
  const probe = first.code === 0 ? parseProbe(first.stdout) : undefined;
  if (!probe) return { checks: [], result: first };

  // 転送：向こうの sshd に -R を頼む（TCP と UNIX ソケット）。断られれば ssh が名指しして終わる。`ExitOnForwardFailure` は
  // 最初の断りで終わるので、1本ずつ別の接続で（並べて）頼む——片方の断りで、もう片方が分からなくならないように
  const sock = `/tmp/banto-probe-${Math.random().toString(36).slice(2, 10)}.sock`;
  const ask = (forward: string) =>
    runRemoteScript(t, files, hostKeyType, `rm -f ${shq(sock)}\n`, { extraArgs: ["-o", "ExitOnForwardFailure=yes", "-R", forward] });
  const [tcp, stream] = await Promise.all([ask("0:127.0.0.1:9"), ask(`${sock}:127.0.0.1:9`)]);
  for (const r of [tcp, stream]) {
    // 転送の断り以外で落ちた（途中で切れた等）——確かめられなかったことを、断られたことに見せない
    if (r.code !== 0 && !/forwarding failed/i.test(r.stderr)) return { checks: [], result: r };
  }
  const forwarding: ForwardingProbe = { tcp: tcp.code === 0, streamLocal: stream.code === 0 };
  return { checks: evaluateProbe(probe, forwarding, hostPlatform()), result: first };
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
