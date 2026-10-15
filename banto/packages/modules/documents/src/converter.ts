// **変換役の中身**（決定・2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」）——LibreOffice で PDF への変換・xlsx の
// 計算し直し、poppler（pdftoppm）でページの画像。
//
// **1件ごとに bubblewrap で囲む**。囲いはこの Module（道具用のコンテナの中の root）が起こし、中のプログラムは nobody
// （65534）に落とす。測ったこと（2026-10-15、Incus の道具用のコンテナと同じ作りの箱、`docs/notes/2026-10-15-office-converter.md`）：
//
// - 一般ユーザーの bwrap は Ubuntu 24.04 の既定（`kernel.apparmor_restrict_unprivileged_userns=1`）で止まる
// - root から `--unshare-all --uid 65534` で起こすと、囲いの中で `/proc` を付けられない（Incus の中では proc の mount が
//   断られる）うえ、中のプロセスは囲いの外から見ると root のまま（作った user namespace の 65534 が外の 0 に対応する。
//   nobody の持ち物のフォルダに書けなかった）。そこで **user namespace は作らず**（root なので要らない）、ネットワーク・
//   IPC・PID・UTS・cgroup を分けた囲いの中で **`setpriv` で本当に nobody に落とし、能力をすべて捨てる**
// - LibreOffice は囲いの外では文書の中の `http://` の画像を取りに行き（2回）、`file:///` の画像を PDF に埋め込んだ。
//   囲いの中では通信 0 件・埋め込み 0 件
//
// 囲いの中に見せるのは `/usr`（読み取り専用）・フォントの設定・LibreOffice の設定（`/etc/libreoffice`、`/usr/lib/libreoffice`
// から張られている）・使い捨ての作業フォルダだけ。ホーム・Module の置き場・中継の合言葉（環境変数）は見せない
// （`--clearenv`）。親が死ねば死ぬ（`--die-with-parent`）。**囲めなければ変換しない**（囲まずに走らせない）

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 入力・出力の上限（Module の stdio は1通 10MB——base64 で収まる大きさ、`v4-modules.md` §2.2） */
export const MAX_BYTES = 7 * 1024 * 1024;
/** 変換だけの打ち切り（中身を運ぶ時間は数えない） */
export const CONVERT_TIMEOUT_MS = 60_000;
/** 囲いの中の uid・gid（nobody） */
export const SANDBOX_ID = 65534;
/** この Module の変換の作法の版。プロファイル・囲いの作りを変えたら上げる（FileSystem の置き場の鍵に入る） */
export const RECIPE_VERSION = "1";

export const TOO_LARGE_MESSAGE = "大きすぎて変換できません（7MB まで）";

/** PDF にできる拡張子 */
export const PDF_SOURCES = ["docx", "doc", "odt", "pptx", "ppt", "odp", "xlsx", "xlsm", "xls", "ods"] as const;
/** 計算し直せる拡張子（表） */
export const SPREADSHEET_SOURCES = ["xlsx", "xlsm", "xls", "ods"] as const;

export type ConvertKind = "pdf" | "recalculate" | "pageImage";

/**
 * **LibreOffice のプロファイル**（1件ごとに作業フォルダの中に作って捨てる）。マクロは最高の安全の水準で、実行もしない。
 * 外のリンクは更新しない（Writer 2＝しない、Calc 1＝しない）。信頼できない参照元のリンクを塞ぐ。xlsx・ods は読むときに
 * いつも計算し直す（AI が作った xlsx には式の値が入っていない——`v4-modules.md` §2.2「描き方」の表）
 */
export const PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`;

/** 囲いの中から見える作業フォルダ */
const WORK = "/work";

/**
 * **bwrap の引数**（`--` まで）。`workDir` は外の作業フォルダ（中では `/work`）。user namespace は作らない（上の測ったこと）
 */
export function sandboxArgs(workDir: string): string[] {
  return [
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    // bwrap が自分で作る親のフォルダは nobody から読めない（0700）——/etc は 0755 で先に作る（実測：LibreOffice が
    // /etc/fonts を開けずに RuntimeException で落ちた）
    "--perms", "0755", "--dir", "/etc",
    "--ro-bind", "/etc/fonts", "/etc/fonts",
    "--ro-bind-try", "/etc/libreoffice", "/etc/libreoffice",
    "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig",
    "--proc", "/proc",
    "--dev", "/dev",
    "--perms", "01777", "--tmpfs", "/tmp",
    "--bind", workDir, WORK,
    "--chdir", WORK,
    "--clearenv",
    "--setenv", "HOME", WORK,
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TMPDIR", `${WORK}/tmp`,
  ];
}

/** 囲いの中で nobody に落とし、能力をすべて捨て、特権を取り直せなくする */
export function dropPrivilegesArgs(): string[] {
  return [
    "/usr/bin/setpriv",
    `--reuid=${SANDBOX_ID}`,
    `--regid=${SANDBOX_ID}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
  ];
}

/** 変換のコマンド（囲いの中のパス）。入力は `/work/in/input.<ext>`、出力は `/work/out` */
export function convertCommand(kind: ConvertKind, extension: string, opts: { page?: number; dpi?: number } = {}): string[] {
  const input = `${WORK}/in/input.${extension}`;
  if (kind === "pageImage") {
    const page = String(opts.page ?? 1);
    return ["/usr/bin/pdftoppm", "-png", "-r", String(opts.dpi ?? 110), "-f", page, "-l", page, "-singlefile", input, `${WORK}/out/page`];
  }
  return [
    "/usr/bin/soffice",
    `-env:UserInstallation=file://${WORK}/profile`,
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--nologo",
    "--convert-to",
    kind === "pdf" ? "pdf" : "xlsx:Calc Office Open XML",
    "--outdir",
    `${WORK}/out`,
    input,
  ];
}

/** 出力のファイル名（`/work/out` の中）と種類 */
export function outputOf(kind: ConvertKind): { file: string; mimeType: string } {
  if (kind === "pageImage") return { file: "page.png", mimeType: "image/png" };
  if (kind === "pdf") return { file: "input.pdf", mimeType: "application/pdf" };
  return { file: "input.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

/** 頼みを確かめる。だめなら理由つきで投げる */
export function validateRequest(kind: ConvertKind, extension: string, input: Buffer): void {
  const allowed: readonly string[] = kind === "pdf" ? PDF_SOURCES : kind === "recalculate" ? SPREADSHEET_SOURCES : ["pdf"];
  if (!allowed.includes(extension)) {
    throw new Error(`${extension} は${kind === "pdf" ? " PDF にできません" : kind === "recalculate" ? "計算し直せません" : "ページの画像にできません"}（${allowed.join("・")} だけ）`);
  }
  if (input.length > MAX_BYTES) throw new Error(TOO_LARGE_MESSAGE);
  if (input.length === 0) throw new Error("中身が空です");
}

export interface ConverterDescriptor {
  /** LibreOffice・poppler の版と、この Module の作法の版 */
  version: string;
  /** フォント一式の印（入っているフォントのファイルの一覧の sha256）。日本語フォントを足すと変わる */
  fonts: string;
}

export interface ConvertResult {
  data: Buffer;
  mimeType: string;
  /** 変換だけにかかった時間 */
  ms: number;
}

/** 囲いを起こす口（試験では偽物） */
export interface SandboxRunner {
  run(workDir: string, command: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }>;
}

/** 本物：bwrap → setpriv → コマンド。打ち切りは囲いごと（プロセスの組へ SIGKILL） */
export const bwrapRunner: SandboxRunner = {
  run(workDir, command, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", [...sandboxArgs(workDir), "--", ...dropPrivilegesArgs(), ...command], {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        env: {},
      });
      let stderr = "";
      child.stderr.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString("utf8")).slice(-4000);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, timedOut });
      });
    });
  },
};

/** 囲いが起きるか確かめる。だめなら理由（起こせないなら変換しない） */
export async function checkSandbox(runner: SandboxRunner, uid: number | undefined): Promise<string | undefined> {
  if (uid !== 0) return `変換役が root で動いていません（uid ${uid ?? "不明"}）——囲いを起こせないので変換しません`;
  const dir = mkdtempSync(join(tmpdir(), "banto-documents-check-"));
  try {
    chmodSync(dir, 0o755);
    const r = await runner.run(dir, ["/usr/bin/id", "-u"], 10_000).catch((err: unknown) => ({
      code: -1,
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    }));
    if (r.code !== 0) return `囲い（bubblewrap）を起こせないので変換しません：${r.stderr.trim().slice(-500) || `終了コード ${r.code}`}`;
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 入っているものの版とフォント一式の印（変換の前に1回読む） */
export function describeInstalled(): ConverterDescriptor {
  const q = (pkg: string) => {
    const r = spawnSync("dpkg-query", ["-W", "-f=${Version}", pkg], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${pkg} の版を読めません（入っていません）：${(r.stderr || "").trim()}`);
    return r.stdout.trim();
  };
  const version = `libreoffice ${q("libreoffice-core")}; poppler ${q("poppler-utils")}; recipe ${RECIPE_VERSION}`;
  const fc = spawnSync("fc-list", ["--format", "%{file}\\n"], { encoding: "utf8" });
  if (fc.status !== 0) throw new Error(`フォントの一覧を読めません：${(fc.stderr || "").trim()}`);
  const files = fc.stdout.split("\n").filter(Boolean).sort();
  const fonts = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
  return { version, fonts };
}

/**
 * **1件を変換する**。使い捨ての作業フォルダ（この Module の置き場ではなく、コンテナの中の一時の場所）を作り、囲いの中で
 * 変換し、出力を読んで、フォルダを消す（Project の文書を残さない）
 */
export async function convertOne(
  runner: SandboxRunner,
  kind: ConvertKind,
  extension: string,
  input: Buffer,
  /** `chownTo`：作業フォルダを渡す uid（既定 nobody。root でない試験だけが null で渡さない） */
  opts: { page?: number; dpi?: number; timeoutMs?: number; chownTo?: number | null } = {},
): Promise<ConvertResult> {
  validateRequest(kind, extension, input);
  const dir = mkdtempSync(join(tmpdir(), "banto-documents-"));
  try {
    // 作業フォルダごと nobody に渡す（HOME もここ。測ったときと同じ形）
    for (const sub of ["in", "out", "tmp", "profile/user"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "in", `input.${extension}`), input);
    writeFileSync(join(dir, "profile", "user", "registrymodifications.xcu"), PROFILE_XCU);
    const owner = opts.chownTo === undefined ? SANDBOX_ID : opts.chownTo;
    if (owner !== null) {
      for (const p of ["", "in", "out", "tmp", "profile", "profile/user", "profile/user/registrymodifications.xcu", `in/input.${extension}`]) {
        chownSync(join(dir, p), owner, owner);
      }
    }
    const started = performance.now();
    const r = await runner.run(dir, convertCommand(kind, extension, opts), opts.timeoutMs ?? CONVERT_TIMEOUT_MS);
    const ms = Math.round(performance.now() - started);
    if (r.timedOut) throw new Error(`変換が ${Math.round((opts.timeoutMs ?? CONVERT_TIMEOUT_MS) / 1000)} 秒で終わらなかったので止めました`);
    const out = outputOf(kind);
    const outPath = join(dir, "out", out.file);
    // LibreOffice は読めなかったときも 0 で終わることがある——出力が無ければ失敗
    if (r.code !== 0 || !existsSync(outPath)) {
      throw new Error(`変換できませんでした（${r.code === 0 ? "何も書き出されませんでした" : `終了コード ${r.code}`}）：${r.stderr.trim().slice(-500)}`);
    }
    if (statSync(outPath).size > MAX_BYTES) throw new Error("変換した結果が大きすぎて返せません（7MB まで）");
    return { data: readFileSync(outPath), mimeType: out.mimeType, ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
