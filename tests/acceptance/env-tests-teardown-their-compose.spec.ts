/**
 * **受け入れ試験が立てた compose は、失敗しても必ず畳む**（inc-0083・task-0214）。
 *
 * ## 何が起きたか（2026-08-16・PO の実測）
 *
 * docker のアドレスプールが枯渇して、**工場の着地が全部止まった**：
 *
 * ```
 * docker compose up failed: Error response from daemon:
 *   all predefined address pools have been fully subnetted
 * ```
 *
 * `banto-env-*` のネットワークが 27本・コンテナが 31件（全部 `Up`）残っていたのに、
 * 台帳が知っていたのは 4件だけ。残りを1件ずつ調べたら、**20件が受け入れ試験の取り残し**
 * （`tests/fixtures/docker` の検体そのまま）、**3件がリビルド試験の取り残し**だった。
 * ワークツリーが既に消えているタスクのコンテナまで動き続けていた。
 *
 * 取り残しの形はどれも同じ——**後片付けをテスト本文の最後の行に書いていた**。
 * アサーションが落ちた瞬間にそこへ到達しなくなるので、**落ちたぶんだけ残る**。
 * しかも `npm test` は `env-docker-` を grep -v で除外しているので、これらの試験が
 * 何を残そうと**誰も気づかない**。気づいたのは機械が止まってからだった。
 *
 * ## この番人がすること
 *
 * docker を**使わない**。名指しの spec の**中身を文字列として読み**、
 * 「compose を立てる呼び出しがあるのに、対になる後片付けが無い」ものを落とす。
 * 静的な検査なので検証環境の中（docker に届かない）でも回り、
 * ファイル名が `env-docker-` で始まらないので **`npm test` に含まれる**
 * ——次に誰かが後片付けを外したら、ここで気づける。
 *
 * 見るのは2つ：
 *
 *   1. **控えと対になっているか**。立てる呼び出しのある区画（`it` / `describe` /
 *      helper）に、控え（`cleanup.track*`）か、その呼び出しより後ろの `finally` がある
 *   2. **畳む場所があるか**。ファイルに `after` / `afterEach` があり、その中で
 *      `teardownAll()` を呼んでいる
 *
 * **後片付けのフック（`after*`）の中身は「控え」として数えない。** そこを数えると
 * 「畳むコードがどこかにあれば通る」になり、番人が形骸化する。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 見張る先。**docker の compose を立てる受け入れ試験**（inc-0083 で犯人だったもの、
 * および同じ検体を立てるもの）。増えたらここへ足す。
 */
const WATCHED = [
  "env-docker-project-per-env.spec.ts",
  "env-docker-rebuild.spec.ts",
  "env-docker-provision-setup-order.spec.ts",
  "env-profile-setup.spec.ts",
];

/** compose プロジェクトを立てる（＝残骸になりうる）呼び出しの見分け。 */
const CREATE_PATTERNS: ReadonlyArray<{ what: string; re: RegExp }> = [
  { what: "pool.provision(", re: /\.provision\s*\(/g },
  { what: "pool.verify(", re: /\.verify\s*\(/g },
  { what: 'ドライバの "provision"', re: /\binvoke\w*\s*\(\s*"provision"/g },
  { what: "docker compose ... up", re: /\[[^\]]*"compose"[^\]]*"up"[^\]]*\]/g },
];

/** 控え（作った者が片付けるための登録）。 */
const TRACK_RE = /\.track(?:Env|Project)?\s*\(/;
/** 後片付けのフック。`(?<![.\w])` は `foo.after(` のような別物を拾わないため。 */
const HOOK_RE = /(?<![.\w])(?:t\.)?after(?:Each|All)?\s*\(/g;
/** 区画の切れ目（ここから次の切れ目までを1つの区画として見る）。 */
const BOUNDARY_RE =
  /(?<![.\w])(?:t\.)?(?:it|test|describe|before|beforeEach|after|afterEach|afterAll)\s*\(/g;
/** 立てない試験だと明示する印（理由を必ず書かせる）。 */
const EXEMPT_RE = /cleanup-exempt:\s*\S/;

export interface Finding {
  line: number;
  what: string;
  reason: string;
}

/** コメントを空白に潰す（長さと改行はそのまま＝行番号がずれない）。 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === quote) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 文字列の中身を空白に潰す（波括弧の数合わせを、文字列に邪魔させない）。 */
function blankStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          if (out[i] !== "\n") out[i] = " ";
          if (i + 1 < out.length && out[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        if (out[i] !== "\n") out[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** `from` 以降の最初の `{` から、対応する `}` の次までの範囲。見つからなければ末尾まで。 */
function blockRange(skeleton: string, from: number): { start: number; end: number } {
  const start = skeleton.indexOf("{", from);
  if (start === -1) return { start: from, end: skeleton.length };
  let depth = 0;
  for (let i = start; i < skeleton.length; i += 1) {
    if (skeleton[i] === "{") depth += 1;
    else if (skeleton[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: skeleton.length };
}

/**
 * **本体**。ソースを読んで「立てているのに畳む対がない」箇所を挙げる。
 *
 * 挙がるのは次のどちらか：
 *   - 立てる呼び出しの区画に、控え（`.track*(`）も、後ろの `finally` も無い
 *   - ファイルに `teardownAll()` を呼ぶ `after` / `afterEach` が無い（畳む場所が無い）
 */
export function findUncoveredSites(rawSrc: string): Finding[] {
  const code = stripComments(rawSrc);
  const skeleton = blankStrings(code);
  const rawLines = rawSrc.split("\n");

  // 後片付けフックの範囲。**控えの探索からは外す**（形骸化させないため）
  const hookRanges: Array<{ start: number; end: number }> = [];
  let hasTeardownAllHook = false;
  HOOK_RE.lastIndex = 0;
  for (let m = HOOK_RE.exec(skeleton); m !== null; m = HOOK_RE.exec(skeleton)) {
    const range = blockRange(skeleton, m.index + m[0].length - 1);
    hookRanges.push(range);
    if (/\bteardownAll\s*\(/.test(code.slice(range.start, range.end))) hasTeardownAllHook = true;
  }

  // 控えを探すときに見る文字列（フックの中身は伏せる）
  const coverageSrc = ((): string => {
    const out = code.split("");
    for (const r of hookRanges) {
      for (let k = r.start; k < r.end; k += 1) if (out[k] !== "\n") out[k] = " ";
    }
    return out.join("");
  })();

  const boundaries: number[] = [];
  BOUNDARY_RE.lastIndex = 0;
  for (let m = BOUNDARY_RE.exec(skeleton); m !== null; m = BOUNDARY_RE.exec(skeleton)) {
    boundaries.push(m.index);
  }

  const regionOf = (index: number): { start: number; end: number } => {
    let start = 0;
    let end = code.length;
    for (const b of boundaries) {
      if (b <= index) start = b;
      else {
        end = b;
        break;
      }
    }
    return { start, end };
  };

  /** 印（`cleanup-exempt:`）は同じ行か、直前5行のコメントに書く。 */
  const exempted = (line: number): boolean => {
    for (let l = Math.max(1, line - 5); l <= line; l += 1) {
      if (EXEMPT_RE.test(rawLines[l - 1] ?? "")) return true;
    }
    return false;
  };

  const findings: Finding[] = [];
  let creates = 0;

  for (const { what, re } of CREATE_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const line = lineOf(code, m.index);
      if (exempted(line)) continue;
      // 後片付けフックの中で立てているなら、それは畳む対が無い
      const inHook = hookRanges.some((r) => m.index >= r.start && m.index < r.end);
      if (inHook) {
        findings.push({
          line,
          what,
          reason: "後片付け（after*）の中で立てている——畳む者がいない",
        });
        continue;
      }
      creates += 1;
      const region = regionOf(m.index);
      const covered =
        TRACK_RE.test(coverageSrc.slice(region.start, region.end)) ||
        /\bfinally\s*\{/.test(code.slice(m.index, region.end));
      if (!covered) {
        findings.push({
          line,
          what,
          reason:
            "この区画に控え（cleanup.track*）も、後ろの finally も無い" +
            "——ここで落ちると compose が残る",
        });
      }
    }
  }

  if (creates > 0 && !hasTeardownAllHook) {
    findings.push({
      line: 1,
      what: "ファイル全体",
      reason: "teardownAll() を呼ぶ after / afterEach が無い——畳む場所そのものが無い",
    });
  }

  return findings;
}

function report(file: string, findings: Finding[]): string {
  return (
    `${file}: 立てた compose を畳めない箇所が ${findings.length} 件ある\n` +
    findings.map((f) => `  - ${file}:${f.line} ${f.what} … ${f.reason}`).join("\n") +
    "\n（後片付けは try/finally・afterEach・afterAll・t.after のいずれかに置く。" +
    "本文の最後の行に置くと、アサーションが落ちた回だけ残る＝inc-0083 の形）"
  );
}

// ── 見張り本体 ────────────────────────────────────────────────────────────────

describe("[inc-0083] 受け入れ試験が立てた compose は、失敗しても必ず畳む", () => {
  for (const name of WATCHED) {
    it(`${name} は、立てた compose の後片付けが対になっている`, () => {
      const file = path.join(_thisDir, name);
      // I1: 見張る先が消えていたら「通った」ではなく落ちる
      assert.equal(fs.existsSync(file), true, `見張る先が無い: ${file}（名前が変わった？）`);
      const findings = findUncoveredSites(fs.readFileSync(file, "utf-8"));
      assert.deepEqual(findings, [], findings.length > 0 ? report(name, findings) : "");
    });
  }
});

// ── 番人自身が形骸化していないこと ────────────────────────────────────────────

describe("[inc-0083] 番人は、後片付けを外したら落ちる", () => {
  /** inc-0083 の形そのもの——後片付けが**本文の最後の行**にある。 */
  const LAST_LINE_TEARDOWN = [
    'import { describe, it } from "node:test";',
    'describe("x", () => {',
    '  it("y", async () => {',
    '    const env = await pool.provision({ profile: "test" });',
    "    assert.equal(env.ok, true);",
    "    await pool.teardown(env.envId);",
    "  });",
    "});",
  ].join("\n");

  it("**最後の行で畳む**書き方を落とす（アサーションが落ちたら到達しない）", () => {
    const findings = findUncoveredSites(LAST_LINE_TEARDOWN);
    assert.equal(findings.length > 0, true, "inc-0083 そのものの形を見逃した");
    assert.match(findings.map((f) => f.reason).join("\n"), /控え|畳む場所/);
  });

  it("控え（track）を外すと落ちる", () => {
    const good = [
      'const cleanup = createComposeCleanup();',
      "afterEach(async () => { await cleanup.teardownAll(); });",
      'describe("x", () => {',
      '  it("y", async () => {',
      '    const env = await pool.provision({ profile: "test" });',
      "    cleanup.trackEnv(env.envId);",
      "    assert.equal(env.ok, true);",
      "  });",
      "});",
    ].join("\n");
    assert.deepEqual(findUncoveredSites(good), [], "対になっているものを落としてはならない");

    const broken = good.replace("    cleanup.trackEnv(env.envId);\n", "");
    const findings = findUncoveredSites(broken);
    assert.equal(findings.length, 1, `控えを外したのに落ちない: ${JSON.stringify(findings)}`);
    assert.match(findings[0]?.what ?? "", /provision/);
  });

  it("畳む場所（teardownAll を呼ぶ after*）を外すと落ちる", () => {
    const noHook = [
      'const cleanup = createComposeCleanup();',
      'describe("x", () => {',
      '  it("y", async () => {',
      '    const env = await pool.provision({ profile: "test" });',
      "    cleanup.trackEnv(env.envId);",
      "  });",
      "});",
    ].join("\n");
    const findings = findUncoveredSites(noHook);
    assert.match(
      findings.map((f) => f.reason).join("\n"),
      /畳む場所そのものが無い/,
      `控えるだけで畳まないものを見逃した: ${JSON.stringify(findings)}`
    );
  });

  it("後片付けフックの中の track を「控え」として数えない（形骸化の穴）", () => {
    const hookOnly = [
      'const cleanup = createComposeCleanup();',
      "after(async () => { cleanup.trackEnv(other); await cleanup.teardownAll(); });",
      'describe("x", () => {',
      '  it("y", async () => {',
      '    const env = await pool.provision({ profile: "test" });',
      "  });",
      "});",
    ].join("\n");
    const findings = findUncoveredSites(hookOnly);
    assert.equal(
      findings.length,
      1,
      `after の中の track を控えとして数えてしまっている: ${JSON.stringify(findings)}`
    );
  });

  it("直に docker compose up する呼び出しも見つける", () => {
    const direct = [
      'const cleanup = createComposeCleanup();',
      "after(async () => { await cleanup.teardownAll(); });",
      'describe("x", () => {',
      '  it("y", () => {',
      '    childProcess.spawnSync("docker", ["compose", "-p", p, "-f", f, "up", "-d"]);',
      "  });",
      "});",
    ].join("\n");
    const findings = findUncoveredSites(direct);
    assert.equal(findings.length, 1, `直の compose up を見逃した: ${JSON.stringify(findings)}`);
    assert.match(findings[0]?.what ?? "", /compose/);
  });

  it("コメントの中の呼び出しは数えない（誤検知で番人を無視させない）", () => {
    const commented = [
      "// pool.provision( をコメントで説明しているだけ",
      "/* ここでは立てない: invoke(\"provision\") */",
      'describe("x", () => {',
      '  it("y", () => { assert.ok(true); });',
      "});",
    ].join("\n");
    assert.deepEqual(findUncoveredSites(commented), []);
  });
});
