/**
 * ツリーを探す土台（task-0068・PO報告 2026-08-07）。
 *
 * **「一部しか見ていない」をやめる。** 元は自前でツリーを歩き、上限に達したら走査ごと
 * 打ち切っていた——番頭が `limit: 1000` と書いても 200 で返り、しかも**あと何件あるかを
 * 言わない**。返り値だけ見ると全部に見えるので、番頭は「網羅した」と読んで判断を進める。
 *
 * 直し方は2つ：
 *
 *   1. **探すのは外の道具に委ねる**（PO 指示）。`rg` → `grep` → 自前の走査。自前を最後に
 *      残すのは、どちらも無い環境で黙って0件にしないため（I2）
 *   2. **総数を必ず返す**。上限で切っても数え上げは最後まで進める。数え上げ自体を
 *      打ち切ったときは `totalExact: false`——分からないことを分かったふりにしない
 *
 * **方言は到達先のもの**：rg は Rust regex、grep は PCRE（`-P` が使えるとき。使えなければ
 * ERE）、自前は JS の `RegExp`。日常の書き方（`\d` `\b` `|` `()`）は揃うが端は揃わない。
 * どれで探したかは呼び出し側へ返す（`engine`）——揃わなかったときに追えるように。
 *
 * D6: node:child_process / node:fs / node:path のみ。外の道具は「あれば使う」で、依存に
 *     しない（無くても自前の走査で成立する）。
 * I2: 到達先が無いことを「0件」と混同しない。壊れた正規表現は理由を返す。
 * P1（砦）: パターン・glob は**必ず引数の配列で渡す**（シェルを経由しない）。`--` を置いて
 *     パターンが旗として読まれるのも塞ぐ。番頭が書いた文字列がそのまま子プロセスへ行く面。
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** どの道具で探したか。 */
export type SearchEngine = "ripgrep" | "grep" | "builtin";

/** よくある除外。番頭が見て意味のないものを既定で隠す。 */
export const HIDDEN_NAMES = [".git", "node_modules", "dist", ".DS_Store"] as const;

/** 自前の走査で開くファイルサイズの上限。rg / grep には掛からない。 */
export const MAX_BUILTIN_SEARCH_BYTES = 1_000_000;

/** 数え上げの天井。ここを超えたら数えるのをやめ、`totalExact: false` で返す。 */
const COUNT_CEILING = 100_000;

/** 1行が長すぎるとそのまま返して文脈を食う。 */
const MAX_LINE_CHARS = 300;

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface GrepRequest {
  /** 検索する正規表現。 */
  pattern: string;
  /** 探索を始めるディレクトリ（root からの相対）。 */
  start: string;
  /** 対象ファイルを絞る glob。 */
  glob?: string;
  ignoreCase?: boolean;
  /** ドット始まり・node_modules・dist も探す。 */
  includeHidden?: boolean;
  /** 返す最大件数。**総数はこれに関係なく数える**。 */
  limit: number;
}

export interface GrepOutcome {
  hits: GrepHit[];
  /** どの道具で探したか。 */
  engine: SearchEngine;
  /** 一致した行の総数（上限で切る**前**）。 */
  total: number;
  /** `total` が正確か。数え上げ自体を打ち切ったら false。 */
  totalExact: boolean;
  truncated: boolean;
  /**
   * 未検索のまま飛ばしたファイル数。**自前の走査のときだけ 0 以外になる**
   * ——rg / grep は大きさでファイルを飛ばさない。
   */
  skippedLarge: number;
}

// ── 到達先の解決 ──────────────────────────────────────────────────────────────

/** 一度調べたら覚える（毎回 `--version` を起こさない）。 */
let resolved: { ripgrep: string | null; grep: string | null; grepPcre: boolean } | undefined;

function probe(bin: string, args: string[], input?: string): boolean {
  try {
    const result = spawnSync(bin, args, {
      timeout: 5000,
      ...(input === undefined ? { stdio: "ignore" as const } : { input, stdio: "pipe" as const }),
    });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * 使える道具を調べる。
 *
 * `BANTO_RIPGREP_BIN` / `BANTO_GREP_BIN` で到達先を差せる——**入れなくても使える口**を
 * 残しておくため（この機械には rg が入っておらず、`/usr/bin/grep` は ugrep だった）。
 */
export function resolveSearchBinaries(force = false): {
  ripgrep: string | null;
  grep: string | null;
  grepPcre: boolean;
} {
  if (resolved && !force) return resolved;
  const rgBin = process.env["BANTO_RIPGREP_BIN"] ?? "rg";
  const grepBin = process.env["BANTO_GREP_BIN"] ?? "grep";
  const ripgrep = probe(rgBin, ["--version"]) ? rgBin : null;
  const grep = probe(grepBin, ["--version"]) ? grepBin : null;
  // `-P` は GNU grep でも無効ビルドがある。使えるかを実物で確かめる（推測しない）。
  // **一致するものを食わせる**——`/dev/null` で試すと「一致なし」の 1 が返り、
  // -P が使えるのに使えない判定になる（最初そう書いて、grep 経路が丸ごと死んだ）
  const grepPcre = grep !== null && probe(grep, ["-P", "-q", "-e", "x"], "x\n");
  resolved = { ripgrep, grep, grepPcre };
  return resolved;
}

/** テスト用：覚えた到達先を忘れる。 */
export function forgetSearchBinaries(): void {
  resolved = undefined;
}

// ── 引数の組み立て ────────────────────────────────────────────────────────────

/**
 * ripgrep の引数。
 *
 * 既定で隠しファイルを見ないのは rg の元からの振る舞いで、`includeHidden: false` と
 * ちょうど噛み合う。`--no-ignore` を渡すのは、**何を除くかはこの道具の契約**であって
 * リポジトリの .gitignore ではないため（隠す物を2箇所で決めない）。
 */
function ripgrepArgs(request: GrepRequest, target: string): string[] {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--with-filename",
    "--null",
    "--no-messages",
    "--no-ignore",
  ];
  if (request.ignoreCase) args.push("--ignore-case");
  if (request.includeHidden) {
    args.push("--hidden");
  } else {
    for (const name of HIDDEN_NAMES) args.push("--glob", `!${name}`);
  }
  if (request.glob) args.push("--glob", request.glob);
  // `--` より前に `-e` を置く。パターンが旗として読まれない
  args.push("-e", request.pattern, "--", target);
  return args;
}

/**
 * grep（GNU grep / ugrep）の引数。
 *
 * **`--exclude-dir=.*` は使わない。** 探索の起点が `.` なので、ugrep ではその起点自身が
 * 除外に一致してツリーが丸ごと消える（0件で返る）。ドット始まりの扱いは
 * `keepPath` の後始末に任せる——道具ごとの癖に振り回されず、3経路で同じ結果になる。
 */
function grepArgs(request: GrepRequest, target: string, pcre: boolean): string[] {
  const args = ["-r", "-n", "-I", "-Z", pcre ? "-P" : "-E"];
  if (request.ignoreCase) args.push("-i");
  if (request.glob) args.push(`--include=${request.glob}`);
  if (!request.includeHidden) {
    // 降りないで済むものは道具に任せる（速い）。取りこぼしは keepPath が拾う
    for (const name of HIDDEN_NAMES) args.push(`--exclude-dir=${name}`);
  }
  args.push("-e", request.pattern, "--", target);
  return args;
}

/**
 * 返してよいパスか。**3つの道具の癖を1箇所で吸収する**（a5）。
 *
 * 隠すものの線引きは道具ごとに違う（rg は既定で隠しを見ない、grep は見る、自前は自分の規則）。
 * 引数だけで揃えようとすると道具ごとの方言に引きずられるので、**最後にここで揃える**。
 * 引数側の除外は「降りずに済ませる」ための速さの工夫であって、正しさはここが持つ。
 */
function keepPath(relative: string, includeHidden: boolean): boolean {
  if (includeHidden) return true;
  const hidden = new Set<string>(HIDDEN_NAMES);
  return !relative.split("/").some((seg) => seg.startsWith(".") || hidden.has(seg));
}

// ── 子プロセスの読み取り ──────────────────────────────────────────────────────

/**
 * `path\0line:text` の並びを読み、上限までを溜めつつ**総数は数え切る**。
 *
 * 数え上げが天井に達したら子を止めて `totalExact: false` で返す——止めないと、
 * 一致が数十万件あるツリーで番頭が待たされ続ける。
 */
async function readMatches(
  bin: string,
  args: string[],
  cwd: string,
  limit: number,
  keep: (relative: string) => boolean
): Promise<{ hits: GrepHit[]; total: number; totalExact: boolean } | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const hits: GrepHit[] = [];
    let total = 0;
    let totalExact = true;
    let rest = "";
    let failed = false;

    child.on("error", () => {
      failed = true;
    });
    // 読めないディレクトリ等の苦情は捨てる（走査全体を止める理由にしない）
    child.stderr.resume();

    const consume = (line: string): void => {
      const nul = line.indexOf("\0");
      if (nul === -1) return;
      const colon = line.indexOf(":", nul + 1);
      if (colon === -1) return;
      const lineNo = Number.parseInt(line.slice(nul + 1, colon), 10);
      if (!Number.isFinite(lineNo)) return;
      // rg も grep も `./` を付けて返す。番頭に見せるのは root からの相対
      const relative = line.slice(0, nul).replace(/^\.\//, "");
      if (!keep(relative)) return;
      total++;
      if (hits.length < limit) {
        const raw = line.slice(colon + 1);
        hits.push({
          path: relative,
          line: lineNo,
          text: raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw,
        });
      }
      if (total >= COUNT_CEILING) {
        totalExact = false;
        child.kill();
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const merged = rest + chunk;
      const lines = merged.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });

    child.on("close", (code) => {
      if (rest.length > 0) consume(rest);
      // I2: 起こせなかった／使い方を断られた（2 以上）のを「0件」と混同しない。
      //     rg も grep も「一致なし」は 1 で返すので、それは正常
      if (failed || (code !== 0 && code !== 1 && total === 0)) {
        resolve(null);
        return;
      }
      resolve({ hits, total, totalExact });
    });
  });
}

// ── 自前の走査（最後の砦）────────────────────────────────────────────────────

/**
 * ルート配下のファイルを走査する。
 *
 * @param visit false を返すと走査を打ち切る
 */
export function walkFiles(
  root: string,
  startRelative: string,
  includeHidden: boolean,
  visit: (relativePath: string, absolutePath: string) => boolean
): void {
  const hidden = new Set<string>(HIDDEN_NAMES);
  const stack: string[] = [startRelative];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    const absolute = path.join(root, relative === "." ? "" : relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      // 読めないディレクトリは飛ばす（権限等）。走査全体を止めない
      continue;
    }
    for (const entry of entries) {
      if (!includeHidden && (entry.name.startsWith(".") || hidden.has(entry.name))) continue;
      const childRelative = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(childRelative);
      } else if (entry.isFile()) {
        if (!visit(childRelative, path.join(absolute, entry.name))) return;
      }
    }
  }
}

/**
 * NUL を含むならバイナリとみなす（テキストとして出すと文脈を壊す）。
 *
 * **先頭だけを見ない**（task-0068）。元は先頭 8000 バイトしか見ておらず、後ろの方に NUL を
 * 持つファイルを「テキスト」として検索していた——rg / grep は全体を見て飛ばすので、
 * 自前の走査だけ結果が増えて食い違う。「一部しか見ない」がここにも1つあった。
 *
 * 実際にこのリポジトリの `places.ts` がこれに当たる（`"\x00DEEP\x00"` が生のバイトで
 * 書かれている）。**rg / grep からは丸ごと見えないファイル**なので、inc-0024 に上げた。
 */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function builtinGrep(
  root: string,
  request: GrepRequest,
  fileFilter: ((relative: string) => boolean) | undefined
): GrepOutcome {
  let re: RegExp;
  try {
    re = new RegExp(request.pattern, request.ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(`正規表現が壊れています "${request.pattern}": ${String(err)}`);
  }

  const hits: GrepHit[] = [];
  let total = 0;
  let totalExact = true;
  let skippedLarge = 0;

  walkFiles(root, request.start, request.includeHidden === true, (relative, absolute) => {
    if (fileFilter && !fileFilter(relative)) return true;
    // I2: 開かなかったファイルは「一致なし」ではない。飛ばした数を返して穴を見せる
    if (fs.statSync(absolute).size > MAX_BUILTIN_SEARCH_BYTES) {
      skippedLarge++;
      return true;
    }
    const buffer = fs.readFileSync(absolute);
    if (looksBinary(buffer)) return true;

    const lines = buffer.toString("utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      total++;
      if (hits.length < request.limit) {
        const raw = lines[i]!;
        hits.push({
          path: relative,
          line: i + 1,
          text: raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw,
        });
      }
      if (total >= COUNT_CEILING) {
        totalExact = false;
        return false;
      }
    }
    return true;
  });

  return {
    hits,
    engine: "builtin",
    total,
    totalExact,
    truncated: total > hits.length,
    skippedLarge,
  };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export interface SearchOverrides {
  /** この道具だけを使う（テストで3経路を突き合わせるため）。 */
  engine?: SearchEngine;
}

/**
 * ツリーの中身を探す。
 *
 * @param root ワークスペースのルート（子プロセスの cwd になる）
 * @param request 検索の指定。`start` は**呼び出し側が砦を通してから**渡すこと
 */
export async function grepTree(
  root: string,
  request: GrepRequest,
  fileFilter?: (relative: string) => boolean,
  overrides: SearchOverrides = {}
): Promise<GrepOutcome> {
  // I2: 壊れた正規表現は、どの道具へ行く前に断る。到達先ごとに違う文面で落ちない
  try {
    new RegExp(request.pattern);
  } catch (err) {
    throw new Error(`正規表現が壊れています "${request.pattern}": ${String(err)}`);
  }

  const target = request.start === "." ? "." : `./${request.start}`;
  const bins = resolveSearchBinaries();
  const want = overrides.engine;
  const keep = (relative: string): boolean =>
    keepPath(relative, request.includeHidden === true);

  if ((want === undefined || want === "ripgrep") && bins.ripgrep) {
    const result = await readMatches(
      bins.ripgrep,
      ripgrepArgs(request, target),
      root,
      request.limit,
      keep
    );
    if (result) {
      return {
        ...result,
        engine: "ripgrep",
        truncated: result.total > result.hits.length,
        skippedLarge: 0,
      };
    }
    // 落ちたら次の道具へ。**黙って0件にしない**（I2）
  }

  if ((want === undefined || want === "grep") && bins.grep) {
    const result = await readMatches(
      bins.grep,
      grepArgs(request, target, bins.grepPcre),
      root,
      request.limit,
      keep
    );
    if (result) {
      return {
        ...result,
        engine: "grep",
        truncated: result.total > result.hits.length,
        skippedLarge: 0,
      };
    }
  }

  // どちらも無い／どちらも落ちた。**自分で歩く**——探せないことを 0 件で返さない
  return builtinGrep(root, request, fileFilter);
}

/**
 * ファイル名を探す（`file.find`）。
 *
 * ripgrep があれば `--files` に任せ、無ければ自前で歩く。どちらでも**総数は数え切る**
 * ——「上限で打ち切り」だけ言って何件見落としたか黙るのが、一番読み違えを生む。
 */
export async function listTree(
  root: string,
  start: string,
  includeHidden: boolean,
  overrides: SearchOverrides = {}
): Promise<{ paths: string[]; engine: SearchEngine }> {
  const bins = resolveSearchBinaries();
  const want = overrides.engine;

  if ((want === undefined || want === "ripgrep") && bins.ripgrep) {
    const args = ["--files", "--no-messages", "--no-ignore"];
    if (includeHidden) {
      args.push("--hidden");
    } else {
      for (const name of HIDDEN_NAMES) args.push("--glob", `!${name}`);
    }
    args.push("--", start === "." ? "." : `./${start}`);
    const rgOut = await new Promise<string | null>((resolve) => {
      const child = spawn(bins.ripgrep!, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let failed = false;
      child.on("error", () => {
        failed = true;
      });
      child.stderr.resume();
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
      });
      child.on("close", (code) => {
        resolve(failed || (code !== 0 && code !== 1 && buffer.length === 0) ? null : buffer);
      });
    });
    if (rgOut !== null) {
      return {
        paths: rgOut
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => l.replace(/^\.\//, ""))
          // 隠すものの線引きは1箇所（grepTree と同じ理由）
          .filter((p) => keepPath(p, includeHidden)),
        engine: "ripgrep",
      };
    }
  }

  const paths: string[] = [];
  walkFiles(root, start, includeHidden, (relative) => {
    paths.push(relative);
    return true;
  });
  return { paths, engine: "builtin" };
}
