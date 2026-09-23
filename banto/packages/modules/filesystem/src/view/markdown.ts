// Markdown を HTML に描く（ファイルのプレビュー用）。
//
// **生の HTML は通さない**——ファイルの中身は他人（AI や clone したリポジトリ）が
// 書いたものでありうる。この画面は自分の Module の tool（書き込み・削除）を
// 呼べるので、中身に紛れた `<img onerror=…>` が走れば、人の操作なしにファイルが
// 消せてしまう。**すべての文字をエスケープしてから、決まった形の要素だけを足す**。
// リンクは飛ばない（sandbox の中でページが遷移してしまう）——行き先は title に出す。
//
// 対応する書き方は GitHub で普段使うもの：見出し（ATX・setext）・段落・強調・
// 打ち消し・インラインコード・コードブロック・引用・箇条書き（入れ子・チェック
// ボックス）・番号つき・表・区切り線。**ライブラリを使っていない理由**：この画面の
// JS は Module が1枚の HTML として配る（外部の script を読めない CSP の中で動く）
// ので、足すなら組み立ての仕組みごと要る。書き方が増えて手に余るようになったら、
// そのときにライブラリと組み立てを一緒に入れる。
//
// DOM に触らない（試験から直接読むため）。

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** 行内の書式。**先にコードを退避 → 全部エスケープ → 決まった形だけ要素にする**。 */
export function renderInline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    codes.push(code.replace(/^ (.*) $/s, "$1"));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  // 画像は描かない（Project の中の相対パスを読みに行く口が画面に無い）——代わりの文字を出す
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, alt: string, url: string) =>
    `<span class="md-img" title="${url}">[画像: ${alt || url}]</span>`,
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, label: string, url: string) =>
    `<span class="md-link" title="${url}">${label}</span>`,
  );
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, url: string) => `<span class="md-link" title="${url}">${url}</span>`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${escapeHtml(codes[Number(i)] ?? "")}</code>`);
  return s;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || /^\s*$/.test(line);
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

function isTableStart(line: string, next: string | undefined): boolean {
  // 区切り行の列数が見出しと揃っていること（揃わない `---` は区切り線や setext 見出し）
  return (
    line.includes("|") &&
    next !== undefined &&
    next.includes("-") &&
    TABLE_SEP.test(next) &&
    splitRow(next).length === splitRow(line).length
  );
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(line, next)
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((l) => !isBlank(l)).map(indentOf);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.replace(/\t/g, "    ").slice(min));
}

function renderList(lines: readonly string[], start: number): [string, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || indentOf(m[1]!) !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
    const content = [m[3]!];
    const children: string[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        // 空行のあとも字下げが続くなら、同じ項目の中身
        const next = lines[i + 1];
        if (next !== undefined && !isBlank(next) && indentOf(next) > baseIndent) {
          children.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(line) > baseIndent) {
        children.push(line);
        i++;
        continue;
      }
      if (LIST_ITEM.test(line) || startsBlock(line, lines[i + 1])) break;
      // 字下げの無い続きの行（lazy continuation）
      if (children.length === 0) {
        content.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    let body = content.join("\n");
    let checkbox = "";
    const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(body);
    if (task) {
      checkbox = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> `;
      body = task[2]!;
    }
    const nested = children.length > 0 ? renderMarkdown(dedent(children).join("\n")) : "";
    items.push(`<li${checkbox ? ' class="task"' : ""}>${checkbox}${renderInline(body)}${nested}</li>`);
  }
  const startNum = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return [`<${tag}${startAttr}>${items.join("")}</${tag}>`, i];
}

function renderTable(lines: readonly string[], start: number): [string, number] {
  const header = splitRow(lines[start]!);
  const aligns = splitRow(lines[start + 1]!).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
  );
  const cell = (tag: "th" | "td", text: string, col: number) =>
    `<${tag}${aligns[col] ? ` style="text-align:${aligns[col]}"` : ""}>${renderInline(text)}</${tag}>`;
  let i = start + 2;
  const body: string[] = [];
  while (i < lines.length && !isBlank(lines[i]) && lines[i]!.includes("|")) {
    const cells = splitRow(lines[i]!);
    body.push(`<tr>${header.map((_h, c) => cell("td", cells[c] ?? "", c)).join("")}</tr>`);
    i++;
  }
  const head = `<tr>${header.map((h, c) => cell("th", h, c)).join("")}</tr>`;
  return [`<table><thead>${head}</thead><tbody>${body.join("")}</tbody></table>`, i];
}

function renderParagraph(lines: readonly string[]): string {
  // 行末の空白2つ・バックスラッシュは改行（hard break）
  return lines
    .map((line, idx) => {
      const last = idx === lines.length - 1;
      const hard = !last && (/ {2,}$/.test(line) || /\\$/.test(line));
      const text = renderInline(line.replace(/\\$/, "").trim());
      return hard ? `${text}<br>` : text;
    })
    .join("\n");
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // 閉じの行（無ければファイルの終わりまで）
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const [html, next] = renderTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]!) || inner.length > 0)) {
        if (!QUOTE.test(lines[i]!) && startsBlock(lines[i]!, lines[i + 1])) break;
        inner.push(lines[i]!.replace(QUOTE, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [html, next] = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    const para: string[] = [];
    let setext: number | undefined;
    while (i < lines.length && !isBlank(lines[i])) {
      const current = lines[i]!;
      const underline = para.length > 0 ? SETEXT.exec(current) : null;
      if (underline) {
        setext = underline[1]!.startsWith("=") ? 1 : 2;
        i++;
        break;
      }
      if (para.length > 0 && startsBlock(current, lines[i + 1])) break;
      para.push(current);
      i++;
    }
    out.push(setext ? `<h${setext}>${renderInline(para.join(" ").trim())}</h${setext}>` : `<p>${renderParagraph(para)}</p>`);
  }
  return out.join("\n");
}
