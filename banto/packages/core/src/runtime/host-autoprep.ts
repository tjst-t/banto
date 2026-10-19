// **実行場所の登録で、足りないものを banto が入れる**（決定・2026-10-19、ユーザー。`docs/specs/v4-security.md` §1
// 「足りないものは banto が入れる」）。`machine`・`containers` に共通の項目——道具（apt）・置き場の根・sshd の転送と同時に開ける
// 数——と、`machine` だけの linger とユーザーの systemd を、**登録と人の「確かめ直す」のときだけ** `sudo -n` で整える。
// 繋ぐたび・Module を起こすときは sudo しない（今どおり）。
//
// ここは「何が足りないか（前提の確かめの様子）から、root で打つコマンドを作る」「確かめの一覧に、banto が入れるものの印を付ける」
// 「打つ」の3つ。様子を引く・確かめの一覧を作るのは ssh.ts（`probeBase`・`evaluateProbe`）。
//
// **root で打つのは項目ごとのコマンドで、`sh -c` の台本は使わない**（Fable のレビュー、2026-10-19。sudoers で決まったコマンドだけを
// 許す形を取れるように）。ファイルを書くのは `tee <ファイル>` に中身を標準入力で渡す。

import type { IncusResult } from "@banto/container";
import type { ForwardingProbe, RuntimeCheck } from "./ssh.js";

/**
 * sudo は絶対パスで呼び、後ろのコマンドは名前で書いて sudo の `secure_path` で引かせる（向こうのユーザーの PATH を当てにしない）。
 * これは乗っ取りへの守りではない——向こうのログインシェルと `~/.bashrc` を書き換えられる人には sh ごとすり替えられる。守りの
 * 根拠は「`sudo -n` が通る machine の AI はもともと root になれる」「containers の AI は VM のユーザーのホームを見られない」の方
 */
export const SUDO = "/usr/bin/sudo";

/** 1つのコマンドの上限。apt は lock を最長 5 分待ってから入れるので、合わせて 15 分 */
export const LONG_ROOT_COMMAND_MS = 900_000;
export const ROOT_COMMAND_MS = 180_000;

/** 向こうでコマンドを1つ流す口（`input` は標準入力に渡す——`tee` でファイルを書くとき） */
export type RootRun = (args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<IncusResult>;

/** root で打つ1つ */
export interface RootCommand {
  args: string[];
  /** 人に見せる1行（標準入力で中身を渡すものは、何を書くかの言葉で） */
  display?: string;
  timeoutMs?: number;
  /** 標準入力に渡す中身（打つ直前に作る——Zabbly の鍵は host が取って確かめる） */
  input?: () => Promise<string>;
  /** 落ちても止めない（cloud-init の待ちなど） */
  ignoreFailure?: boolean;
  /** 落ちたら、代わりにこれを打つ（`systemctl reload ssh` が無ければ `sshd`） */
  orElse?: RootCommand;
  /** 落ちたら、これを打ってから止める（書いた設定を消す） */
  undoOnFail?: RootCommand;
}

/** 前提の1項目を整えるもの */
export interface AutoFix {
  /** 前提の項目の id（`RuntimeCheck.id`） */
  id: string;
  commands: RootCommand[];
}

/** banto が入れるときの1行（確かめの一覧で、注意・断りの後ろに添える） */
export const WILL_FIX_ON_REGISTER = "登録するときに banto が sudo -n で入れます。";
export const WILL_FIX_ON_RECHECK = "設定の「実行場所」で「確かめ直す」を押すと、banto が sudo -n で入れます。";

/** apt を非対話で（needrestart は一覧だけにして、サービスを勝手に起こし直させない） */
const APT_ENV = ["env", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l", "apt-get", "-o", "DPkg::Lock::Timeout=300"];

/** cloud-init が終わるまで待つ（apt の lock と sshd_config.d への書き込みがぶつかる）。無い・失敗した状態でも先へ進む */
export function cloudInitWait(): RootCommand {
  return {
    args: ["timeout", "600", "cloud-init", "status", "--wait"],
    display: "sudo cloud-init status --wait（cloud-init が終わるまで待つ）",
    timeoutMs: 660_000,
    ignoreFailure: true,
  };
}

export function aptUpdate(): RootCommand {
  return { args: [...APT_ENV, "update", "-q"], display: "sudo apt-get update", timeoutMs: LONG_ROOT_COMMAND_MS };
}

export function aptInstall(pkgs: string[]): RootCommand {
  return {
    args: [...APT_ENV, "install", "-y", "-q", "--no-install-recommends", ...pkgs],
    display: `sudo apt-get install --no-install-recommends ${pkgs.join(" ")}`,
    timeoutMs: LONG_ROOT_COMMAND_MS,
  };
}

/** apt で入れる前に打つもの（cloud-init が居れば待ち、索引を新しくする） */
export function aptPrelude(values: Map<string, string>): RootCommand[] {
  return [...(values.get("cloudinit") === "1" ? [cloudInitWait()] : []), aptUpdate()];
}

/** 道具の名前 → apt のパッケージ */
function packageOf(tool: string): string {
  return tool === "ssh" ? "openssh-client" : tool;
}

/** 向こうで apt を使えるか（Debian・Ubuntu で apt-get がある） */
export function aptUsable(values: Map<string, string>): boolean {
  if (values.get("apt") !== "1") return false;
  const ids = `${values.get("os.id") ?? ""} ${values.get("os.like") ?? ""}`.split(/\s+/);
  return ids.includes("debian") || ids.includes("ubuntu");
}

/** ファイルを root で書く（`tee` に中身を標準入力で渡す。出力は捨てる） */
export function writeRootFile(path: string, content: () => Promise<string>, display: string): RootCommand {
  return { args: ["tee", path], input: content, display };
}

/**
 * **banto が持つ sshd の設定**。Ubuntu の sshd_config は先頭で `sshd_config.d/*.conf` を名前の順に読み、同じ鍵は最初に出た値が効く
 * ——名前を 00- にして `50-cloud-init.conf` や人の設定より先に読ませる。中身は banto のもので、毎回3行を丸ごと書く
 * （`AllowTcpForwarding`・`AllowStreamLocalForwarding` の既定は yes、`MaxSessions 20` は既定の 10 より多いだけ）
 */
export const SSHD_CONF = "/etc/ssh/sshd_config.d/00-banto.conf";
export const SSHD_LINES = ["AllowTcpForwarding yes", "AllowStreamLocalForwarding yes", "MaxSessions 20"];

/** sshd の直し：書く → `sshd -t`（落ちたら書いたものを消して止める——締め出さない）→ reload（ssh、無ければ sshd） */
export function sshdFix(): RootCommand[] {
  return [
    writeRootFile(SSHD_CONF, async () => `${SSHD_LINES.join("\n")}\n`, `sudo tee ${SSHD_CONF}（${SSHD_LINES.join("・")}）`),
    { args: ["sshd", "-t"], undoOnFail: { args: ["rm", "-f", SSHD_CONF] } },
    { args: ["systemctl", "reload", "ssh.service"], orElse: { args: ["systemctl", "reload", "sshd.service"] } },
  ];
}

export interface CommonFixInput {
  values: Map<string, string>;
  forwarding: ForwardingProbe;
  mode: "machine" | "containers";
  /** その動かし方で要る道具（無ければ断る分） */
  requiredTools: readonly string[];
}

/**
 * **共通の項目を整えるコマンドを作る**（何も足りなければ空）。apt の無い OS では道具は作らない（人が入れる）
 */
export function commonFixes({ values: v, forwarding, mode, requiredTools }: CommonFixInput): AutoFix[] {
  const fixes: AutoFix[] = [];
  const user = v.get("user") ?? "";
  const uid = v.get("uid") ?? "";
  const gid = v.get("gid") ?? "";
  const apt = aptUsable(v);
  const missing = (tools: readonly string[]) => tools.filter((t) => v.get(`tool.${t}`) !== "1");

  // 道具：1回の apt-get update のあと、まとめて入れる（項目ごとに分けると update を何度もする）。ユーザーの systemd の bus が
  // 無いのは dbus-user-session が無いことがある（Debian の小さいイメージ）——一緒に入れる
  const required = missing(requiredTools);
  const optional = mode === "machine" ? missing(["tmux", "rsync"]) : [];
  const busPkg = mode === "machine" && v.get("bus") !== "1" ? ["dbus-user-session"] : [];
  if (apt && required.length + optional.length + busPkg.length > 0) {
    const pkgs = [...required.map(packageOf), ...optional, ...busPkg];
    const commands = [...aptPrelude(v), aptInstall(pkgs)];
    // 一覧の項目ごとに同じコマンドを出す（打つのは1回——runFixes が同じものを重ねて打たない）
    if (required.length) fixes.push({ id: "tools", commands });
    for (const t of optional) fixes.push({ id: t, commands });
    if (busPkg.length) fixes.push({ id: "user-systemd", commands });
  }

  const root = v.get("root") ?? "";
  if (v.get("writable") !== "1" && root.startsWith("/") && !/[\0\n]/.test(root) && user && gid) {
    fixes.push({ id: "data-root", commands: [{ args: ["install", "-d", "-o", user, "-g", gid, "-m", "0700", root] }] });
  }

  const maxSessions = Number(v.get("maxsessions") ?? "10");
  if (!forwarding.tcp || !forwarding.streamLocal || (Number.isFinite(maxSessions) && maxSessions < 10)) {
    fixes.push({ id: "sshd", commands: sshdFix() });
  }

  if (mode === "machine" && user) {
    const linger = v.get("linger") === "1";
    const lingerCmd: RootCommand = { args: ["loginctl", "enable-linger", user] };
    if (!linger) fixes.push({ id: "linger", commands: [lingerCmd] });
    if (v.get("bus") !== "1" && /^\d+$/.test(uid)) {
      const prev = fixes.find((f) => f.id === "user-systemd");
      const start: RootCommand[] = [...(linger ? [] : [lingerCmd]), { args: ["systemctl", "start", `user@${uid}.service`] }];
      if (prev) prev.commands = [...prev.commands, ...start];
      else fixes.push({ id: "user-systemd", commands: start });
    }
  }
  return fixes;
}

/** sudo の後ろの引数を、人が打つ1行にする */
export function sudoLine(args: string[]): string {
  return `sudo ${args.map((a) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ")}`;
}

export function displayOf(c: RootCommand): string {
  return c.display ?? sudoLine(c.args);
}

/**
 * **確かめの一覧に、banto が入れるものの印を付ける**。`check`（登録の前）で sudo -n が通るなら、断り（fail）を注意（warn）に
 * して「登録するときに banto が入れます」と添える。`verify`（繋ぐたび）は断りのまま「確かめ直すと banto が入れます」と添える。
 * sudo -n が通らない（か分からない）ときは今どおり（人が打つコマンドだけ）
 */
export function markAutoFixes(checks: RuntimeCheck[], fixes: AutoFix[], stage: "check" | "prepare" | "verify", sudo: boolean | undefined): RuntimeCheck[] {
  const byId = new Map(fixes.map((f) => [f.id, f]));
  return checks.map((c) => {
    const fix = byId.get(c.id);
    if (!fix || c.status === "ok") return c;
    const fixText = fix.commands.map(displayOf).join("\n");
    if (stage === "verify") return { ...c, detail: `${c.detail ?? ""}${WILL_FIX_ON_RECHECK}`, fix: fixText, autoFix: true };
    if (!sudo) return c;
    return { ...c, status: "warn", detail: `${c.detail ?? ""}${WILL_FIX_ON_REGISTER}`, fix: fixText, autoFix: true };
  });
}

/** 打った1つの記録 */
export interface RanCommand {
  display: string;
  code: number;
}

/** 整えている途中で失敗した（どの項目のどのコマンドが何と言ったか・それまでに行ったことを添える） */
export class AutoFixError extends Error {
  constructor(
    message: string,
    readonly ran: RanCommand[],
  ) {
    super(message);
  }
}

/** 1つを sudo -n で打つ（`orElse`・`undoOnFail`・`ignoreFailure` を含む）。落ちて止めるなら投げる */
export async function runRootCommand(
  run: RootRun,
  c: RootCommand,
  ran: RanCommand[],
  opts: { what: string; log?: (line: string) => void },
): Promise<void> {
  const once = async (x: RootCommand) => {
    const input = x.input ? await x.input() : undefined;
    const r = await run([SUDO, "-n", ...x.args], { timeoutMs: x.timeoutMs ?? ROOT_COMMAND_MS, ...(input !== undefined ? { input } : {}) });
    ran.push({ display: displayOf(x), code: r.code });
    opts.log?.(`${displayOf(x)} → ${r.code}`);
    return r;
  };
  const first = await once(c);
  let r = first;
  if (r.code !== 0 && c.orElse) r = await once(c.orElse);
  if (r.code === 0 || c.ignoreFailure) return;
  if (c.undoOnFail) await once(c.undoOnFail);
  const why = (x: IncusResult) => (x.stderr || x.stdout).trim().slice(-300);
  throw new AutoFixError(
    `${opts.what}${displayOf(c)} が失敗しました（終了コード ${first.code}）：${why(first)}` +
      (c.orElse ? `。代わりの ${displayOf(c.orElse)} も失敗しました（終了コード ${r.code}）：${why(r)}` : "") +
      (c.undoOnFail ? `（${displayOf(c.undoOnFail)} で元に戻しました）` : ""),
    ran,
  );
}

/**
 * **コマンドを順に sudo -n で打つ**。同じコマンド（`args` が同じ）は1回だけ。1つでも落ちたら、そこで止めて `AutoFixError`
 * （それまでに入れたものは残す——入っていれば何もしないので、確かめ直せば続きから）
 */
export async function runFixes(
  run: RootRun,
  fixes: AutoFix[],
  opts: { labelOf: (id: string) => string; log?: (line: string) => void },
): Promise<RanCommand[]> {
  const ran: RanCommand[] = [];
  const done = new Set<string>();
  for (const fix of fixes) {
    for (const c of fix.commands) {
      const key = JSON.stringify(c.args);
      if (done.has(key)) continue;
      done.add(key);
      await runRootCommand(run, c, ran, { what: `「${opts.labelOf(fix.id)}」を整える `, log: opts.log });
    }
  }
  return ran;
}

/** banto が向こうで行ったことを、確かめの一覧の1行にする（設定の一覧に出る。次に繋いだときの確かめで消える） */
export function preparedCheck(ran: RanCommand[]): RuntimeCheck {
  return {
    id: "prepared",
    label: `banto が向こうで行ったこと（${ran.length} 件）`,
    status: "ok",
    detail: ran.map((r) => `${r.display}${r.code === 0 ? "" : `（終了コード ${r.code}）`}`).join("\n"),
  };
}

/** 行ったことを、失敗の文の後ろに添える（画面は文だけを出す） */
export function ranSuffix(ran: RanCommand[]): string {
  return ran.length ? `\nそれまでに banto が向こうで行ったこと：\n${ran.map((r) => `${r.display}（終了コード ${r.code}）`).join("\n")}` : "";
}
