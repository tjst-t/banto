/**
 * 決定番号（「決定NNN」）は `docs/adr/**` の中で一意である（task-0159 / imp-0073）。
 *
 * 記録の id（imp / inc / prop / adr）の重複は `record-id-uniqueness.spec.ts` が押さえた。
 * だがその**内側**、ADR の中で採られる「決定NNN」には採番の検査が無く、並走した枝が
 * それぞれ「直前の ADR の続き」から採った結果、別内容の同番号が生まれていた
 * （決定47＝ADR-0010／ADR-0011、決定69＝ADR-0013／ADR-0014、決定113〜123＝ADR-0026 と
 * ADR-0023・ADR-0025）。2026-08-16 に振り直し、以後はここで落とす。
 *
 * **見出しの書式は2つある。片方を落とすとこの試験は黙って空振りする**（task-0153 で
 * 実際に起きた——`### 決定N` だけを見て `### N.` の67番を候補にすら入れず、
 * それでも当時のしきい値50を超えていたため緑になった）:
 *   A: `### N. タイトル（…）`      — ADR-0010〜ADR-0013（古い層）
 *   B: `### 決定N: タイトル`        — ADR-0014 以降。`#### 決定99a:` の枝番、
 *      `### 決定105〜108:` の範囲、`### 決定113・118:` の並記、
 *      `### 決定84 の実装（…）` の後置注記つきがある
 *
 * ここで落とすもの:
 *   1. ADR をまたいだ決定番号の重複（同一 ADR 内の再掲は畳む——枝番の節などが該当する）
 *   2. 走査の空振り（拾えた決定番号が 120 件未満）
 *   3. 引用の除外一覧に載っているのに、その見出しが実在しない
 *      （除外は黙って増やせる抜け道なので、腐りを機械が見つける形にしておく）
 *
 * ここで落とさないもの（一覧だけ出す）:
 *   - 欠番。振り直しで空いた番号は**埋めない**という規約なので、欠番は正常な姿。
 *   - 番号を読み取れなかった「決定NNN らしき見出し」（`決定` または数字で始まる見出し）。
 *     取りこぼして緑になるのがいちばん悪いので、**必ず見出しの全文を出す**。
 *     `## 文脈` のような番号を名乗っていない見出しは候補に入れない（雑音になるだけ）。
 *
 * 採番の規約: 決定番号は `docs/adr/**` を走査した**最大 +1** から採る（この試験が出す）。
 * 「直前の ADR の続き」から採ってはいけない——並走した枝がそれぞれ別の ADR を
 * 「直前」とみなすため、同じ衝突をもう一度起こす。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

/** 走査する場所。ここより外で採られた決定番号（`docs/notes/**` など）との衝突は拾えない */
const ADR_ROOT = "docs/adr";

/** 走査が空振りしていないことの下限。いまは 131 件ある（2026-08-16） */
const MIN_DECISIONS = 120;

/**
 * 他所で決まった決定を**引用しているだけ**の見出し。名乗りとして数えない。
 *
 * 行番号ではなく「ファイル＋見出しの全文」で持つ——行はすぐずれる。
 * 一覧に在るのに実在しない見出しがあれば落ちる（下の [a3]）。
 */
const CITATION_HEADINGS: ReadonlyArray<{ relPath: string; heading: string }> = [
  {
    // 決定64 の実体は docs/adr/adr-0013-kobo-uses-modules.md の `### 64. 積んだ後の訂正は…`
    relPath: "docs/adr/adr-0014-contract-amendment.md",
    heading: "### 決定64（もとの裁定）",
  },
  {
    // 決定84 の実体は同じ ADR の `### 決定84: 道具定義は…`。ここは実装の記録
    relPath: "docs/adr/adr-0019-inventory-and-presentation.md",
    heading: "### 決定84 の実装（task-0100・2026-08-13）",
  },
];

/** 見出し行（`##` 〜 `######`）から、後ろのテキストを取る */
const HEADING = /^(#{2,6})\s+(.*?)\s*$/;

/** 書式A: `39. 検証環境の公開は…` */
const FORMAT_A = /^(\d+)\.\s/;

/**
 * 書式B: `決定105〜108: …` / `決定99a: …` / `決定113・118: …` / `決定84 の実装（…）`
 *
 * 番号の並びを1つのまとまりとして取り、その直後が `:` `：` 空白 `（` か行末であることを要求する
 * （`決定29d の宛先の改訂` のような文中表現を見出しの先頭で誤って拾わないため）。
 */
const FORMAT_B = /^決定\s*(\d+[a-z]?(?:\s*[〜～・、,]\s*\d+[a-z]?)*)\s*(?:[:：]|\s|（|$)/;

/** 「決定NNN を名乗っていそうな見出し」か。読み取れなければ警告として名前を出す対象になる */
const LOOKS_LIKE_DECISION = /^(?:決定\s*\d|\d)/;

interface Decision {
  /** リポジトリ相対のパス */
  relPath: string;
  /** 決定番号（枝番は base に畳む。`99a` → 99） */
  num: number;
  /** 見出しの全文（`### ` を含む生の行） */
  heading: string;
}

function listMarkdown(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/** `105〜108` → [105,106,107,108] / `113・118` → [113,118] / `99a` → [99] */
function expandNumberSpec(spec: string): number[] {
  const out: number[] = [];
  // 範囲（`〜`）と並記（`・` `、` `,`）が混ざりうるので、まず並記で割り、各片を範囲として読む
  for (const part of spec.split(/[・、,]/)) {
    const ends = part.split(/[〜～]/).map((s) => Number.parseInt(s.trim(), 10));
    if (ends.some((n) => !Number.isFinite(n))) continue;
    if (ends.length === 1) out.push(ends[0]);
    else {
      const [from, to] = [ends[0], ends[ends.length - 1]];
      if (to < from || to - from > 50) return []; // 範囲として読めない＝読み取り失敗として扱う
      for (let n = from; n <= to; n++) out.push(n);
    }
  }
  return out;
}

interface Scan {
  decisions: Decision[];
  /** 決定を名乗っていそうなのに番号を読み取れなかった見出し */
  unreadable: { relPath: string; heading: string }[];
  /** 実際に除外に当たった見出し（除外一覧の腐りを見るために持つ） */
  citationsHit: Set<string>;
}

function citationKey(relPath: string, heading: string): string {
  return `${relPath} :: ${heading}`;
}

function scan(): Scan {
  const excluded = new Set(CITATION_HEADINGS.map((c) => citationKey(c.relPath, c.heading)));
  const decisions: Decision[] = [];
  const unreadable: { relPath: string; heading: string }[] = [];
  const citationsHit = new Set<string>();

  for (const relPath of listMarkdown(ADR_ROOT)) {
    const lines = fs.readFileSync(path.join(repoRoot, relPath), "utf8").split("\n");
    let inFence = false;
    for (const raw of lines) {
      if (/^\s*```/.test(raw)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = HEADING.exec(raw);
      if (!h) continue;
      const text = h[2];
      if (!LOOKS_LIKE_DECISION.test(text)) continue;

      const heading = raw.trimEnd();
      const key = citationKey(relPath, heading);
      if (excluded.has(key)) {
        citationsHit.add(key);
        continue; // 引用の見出しは名乗りとして数えない
      }

      const a = FORMAT_A.exec(text);
      const b = FORMAT_B.exec(text);
      const nums = a ? [Number.parseInt(a[1], 10)] : b ? expandNumberSpec(b[1]) : [];
      if (nums.length === 0) {
        unreadable.push({ relPath, heading });
        continue;
      }
      for (const num of nums) decisions.push({ relPath, num, heading });
    }
  }
  return { decisions, unreadable, citationsHit };
}

const { decisions, unreadable, citationsHit } = scan();

/** 決定番号 → その番号を名乗っている ADR（同一 ADR 内の再掲は畳む） */
function byNumber(): Map<number, Map<string, string[]>> {
  const map = new Map<number, Map<string, string[]>>();
  for (const d of decisions) {
    let files = map.get(d.num);
    if (!files) map.set(d.num, (files = new Map()));
    const headings = files.get(d.relPath);
    if (headings) headings.push(d.heading);
    else files.set(d.relPath, [d.heading]);
  }
  return map;
}

const numbers = byNumber();

describe("[AC-T0159-1] 決定番号は docs/adr/** の中で一意", () => {
  it("そもそも決定番号が拾えている（走査の空振りで緑になっていない）", () => {
    assert.ok(
      numbers.size >= MIN_DECISIONS,
      `${ADR_ROOT} から拾えた決定番号が ${numbers.size} 件しかない（下限 ${MIN_DECISIONS}）。` +
        `2つの書式（\`### N.\` と \`### 決定N\`）の片方を落としていないか。` +
        `読み取れなかった見出し: ${unreadable.length} 件`,
    );
  });

  it("[a1] 同じ決定番号を2つ以上の ADR が名乗っていない", () => {
    const dups = [...numbers]
      .filter(([, files]) => files.size > 1)
      .sort((x, y) => x[0] - y[0])
      .map(([num, files]) => {
        const where = [...files]
          .map(([relPath, headings]) => `${relPath}（${headings.join(" / ")}）`)
          .join(" / ");
        return `  決定${num}: ${where}`;
      });
    assert.equal(
      dups.length,
      0,
      `別内容の同番号がある。参照の少ない側を空き番号（いま使われている最大 +1）へ移し、\n` +
        `参照も付け替えること。旧→新の対応は work/inbox/improvement/ に残す（imp-0073）:\n` +
        dups.join("\n"),
    );
  });

  it("[a3] 引用の除外一覧が腐っていない（載っているのに実在しない見出しが無い）", () => {
    const stale = CITATION_HEADINGS.filter(
      (c) => !citationsHit.has(citationKey(c.relPath, c.heading)),
    ).map((c) => `  ${c.relPath}: ${c.heading}`);
    assert.equal(
      stale.length,
      0,
      `除外一覧に在るのに、その見出しが実在しない。見出しを直したなら一覧も直し、` +
        `引用でなくなったなら一覧から外すこと:\n${stale.join("\n")}`,
    );
  });

  it("欠番と、読み取れなかった見出しは落とさない——一覧に出すだけ", () => {
    const used = [...numbers.keys()].sort((a, b) => a - b);
    const max = used[used.length - 1] ?? 0;
    const missing: number[] = [];
    for (let n = 1; n <= max; n++) if (!numbers.has(n)) missing.push(n);

    console.log(
      `[decision-number] 拾えた決定番号 ${numbers.size} 件（見出し ${decisions.length} 箇所）。` +
        `**次に採るべき番号は ${max + 1}**（いま使われている最大 ${max} の +1）`,
    );
    if (missing.length > 0) {
      console.log(
        `[decision-number] 欠番（振り直しで空いた跡。埋めない）:\n  ${missing.join(", ")}`,
      );
    }
    if (unreadable.length > 0) {
      console.log(
        `[decision-number] 番号を読み取れなかった見出し（取りこぼしていないか目で確かめる）:\n` +
          unreadable.map((u) => `  ${u.relPath}: ${u.heading}`).join("\n"),
      );
    }
    // 欠番・読み取れない見出しは失敗にしない（この試験の主は重複を落とすこと）
    assert.ok(true);
  });
});
