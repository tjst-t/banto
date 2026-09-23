// 行単位の差分（v4-modules.md §2.2「editFile の結果は before/after の行単位差分で
// inline カードに埋め込む」）。
//
// **形は unified diff**（`diff -u` / `git diff` の形）。MCP 公式の filesystem
// リファレンス実装の `edit_file` も結果として unified diff を返す（規則12）。
// AI には前後の全文ではなく差分だけが届き、画面は同じ文字列を読んで色を付ける
// ——**差分の真実は tool の結果1つ**（規則3）。記録から画面を組み直すときも
// ファイルを読み直さない（その時点の中身はもう違うかもしれない）。
//
// 差分の求め方は Myers の O(ND) 法（`diff` や git の既定と同じもの）。
// 依存を足さなかったのは、この画面の JS をブラウザ側にも同じコードで持ち込む
// ためで（`ui/` から import する）、ここで要るのは行の一致だけだから。

export type LineOp = { kind: "equal" | "delete" | "insert"; line: string };

/** 共通の先頭・末尾を先に外してから Myers で中を比べる（編集は局所的なので速い）。 */
export function diffLines(a: readonly string[], b: readonly string[]): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const equal = (line: string): LineOp => ({ kind: "equal", line });
  return [
    ...a.slice(0, start).map(equal),
    ...myers(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(equal),
  ];
}

/** これを超える編集距離は探さない——前を全部消して後を全部足す形で返す（遅すぎるより粗いほうがよい）。 */
const MAX_EDIT_DISTANCE = 4000;

function myers(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: "insert", line }));
  if (m === 0) return a.map((line) => ({ kind: "delete", line }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  // v[k] = 対角線 k で届いた一番遠い x。負の k があるので offset でずらす
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 各 d の開始時点の v のうち、使う範囲 [-d, d] だけを取っておく（全部だと D×(N+M) になる）
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  // 編集距離が大きすぎる——粗く返す
  return [...a.map((line): LineOp => ({ kind: "delete", line })), ...b.map((line): LineOp => ({ kind: "insert", line }))];
}

function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[]): LineOp[] {
  const ops: LineOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const slice = trace[d]!;
    // slice[i] は v[k] で、k = i - d - 1
    const at = (k: number): number => slice[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "insert", line: b[y - 1]! });
      else ops.push({ kind: "delete", line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** 末尾の改行は「最後の空行」として数えない（`diff` と同じ数え方）。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const CONTEXT = 3;

export interface UnifiedDiff {
  text: string;
  additions: number;
  deletions: number;
}

/** `diff -u a/<path> b/<path>` と同じ形の文字列を作る。変化が無ければ見出しだけ。 */
export function unifiedDiff(path: string, before: string, after: string): UnifiedDiff {
  const ops = diffLines(splitLines(before), splitLines(after));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let additions = 0;
  let deletions = 0;

  // 各 op の手前までに、前・後それぞれ何行進んだか
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(nn);
    if (op.kind !== "insert") o++;
    if (op.kind !== "delete") nn++;
  }

  const changed = ops.flatMap((op, i) => (op.kind === "equal" ? [] : [i]));
  let i = 0;
  while (i < changed.length) {
    // 間の一致が 2×CONTEXT 行以内なら同じ塊にする
    let j = i;
    while (j + 1 < changed.length && changed[j + 1]! - changed[j]! <= 2 * CONTEXT) j++;
    const from = Math.max(0, changed[i]! - CONTEXT);
    const to = Math.min(ops.length, changed[j]! + CONTEXT + 1);
    const hunk = ops.slice(from, to);
    const oldCount = hunk.filter((op) => op.kind !== "insert").length;
    const newCount = hunk.filter((op) => op.kind !== "delete").length;
    // 0 行の側は「その直前の行番号」で書く（`diff -u` の約束）
    const oldStart = oldCount === 0 ? oldBefore[from]! : oldBefore[from]! + 1;
    const newStart = newCount === 0 ? newBefore[from]! : newBefore[from]! + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) {
      if (op.kind === "equal") out.push(` ${op.line}`);
      else if (op.kind === "delete") {
        out.push(`-${op.line}`);
        deletions++;
      } else {
        out.push(`+${op.line}`);
        additions++;
      }
    }
    i = j + 1;
  }
  return { text: `${out.join("\n")}\n`, additions, deletions };
}

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "add" | "remove"; text: string; oldNo?: number; newNo?: number };

export interface ParsedDiff {
  path?: string;
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

/** unified diff を行に分ける（画面が色を付けるため）。読めない行は捨てずに context として残す。 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let path: string | undefined;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (!inHunk && line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) continue;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      inHunk = true;
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      additions++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "remove", text: line.slice(1), oldNo: oldNo++ });
      deletions++;
    } else {
      rows.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { path, rows, additions, deletions };
}
