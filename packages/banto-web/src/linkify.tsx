/**
 * 会話の中の **URL とファイルパスを押せるようにする**（PO要望 2026-08-11）。
 *
 * 番頭も職人も、話の中に URL とパスを普通に書く。押せないと、PO は URL をコピーして
 * 貼り直し、パスはファイル面を開いて辿り直すことになる——**見えているのに届かない**。
 *
 * - **URL** は別タブで開く（`links.tsx` の決まりに揃える）
 * - **ファイルパス** は押すとファイル面（`file.browser`）がその場所を開く。行番号付き
 *   （`src/a.ts:42`）ならその行まで飛ぶ——`file.grep` の結果をそのまま押せる
 *
 * ## 何をパスと見なすか
 *
 * **拡張子か区切りを持つものだけ**。日本語の文中の語や、`1.5` のような数を巻き込むと、
 * 押せないリンクが散らかって読みにくくなる——**取りこぼす方に倒す**（押せないより、
 * 押せるものが少し減る方がまし）。末尾の句読点・閉じ括弧はリンクに含めない。
 *
 * D5: 判断は無い。文字列を見て印を付けるだけ。どこを開くかは受け取った側が決める。
 */

import React from "react";
import { isExternalHref } from "./links.js";

/** 押されたときに開くもの。 */
export interface LinkTargets {
  /** ファイル面を開く（`file.browser`）。 */
  openFile?(path: string, line?: number): void;
}

/**
 * URL とパスをまとめて拾う1本の正規表現。
 *
 * **1本にする**のは、URL の中のスラッシュをパスとして二重に拾わないため——
 * 交互に走らせると `https://a/b.ts` の後半がパスに見える。
 */
const TOKEN =
  // 1: URL（スキーム付き）
  /(https?:\/\/[^\s<>"'`）」】]+)|/.source +
  // 2: パス（`/` を含み、拡張子か先頭の `/`・`./`・`~/` を持つ）＋任意の :行番号
  /((?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+(?::\d+)?)/.source;

const TOKEN_RE = new RegExp(TOKEN, "g");

/** 末尾に付いてきやすい、リンクに含めたくない文字。 */
const TRAILING = /[.,;:。、）)\]】」』>]+$/u;

/** パスらしいか。**取りこぼす方に倒す**（誤爆したリンクの方が読みにくい）。 */
function looksLikePath(token: string): boolean {
  const bare = token.replace(/:\d+$/u, "");
  if (bare.length < 3 || bare.length > 200) return false;
  // 「a/b」だけでは足りない——`かつ/または` のような語を拾ってしまう。
  // 絶対パス・相対の明示・拡張子つき、のどれかを求める
  if (/^(?:~\/|\.{1,2}\/|\/)/u.test(bare)) return true;
  return /\.[A-Za-z0-9]{1,8}$/u.test(bare);
}

/** `src/a.ts:42` を場所と行に分ける。 */
export function splitPathAndLine(token: string): { path: string; line?: number } {
  const m = /^(.*):(\d+)$/u.exec(token);
  if (!m) return { path: token };
  return { path: m[1]!, line: Number(m[2]) };
}

/**
 * 平文を、URL とパスだけリンクにした React の並びへ変える。
 *
 * Markdown で描くところは `StreamingMarkdown` が同じことをする（`linkifyHast`）。
 * ここは**平文のまま出す行**（POの発言・職人の指示・解釈できなかった行）のためのもの。
 */
export function Linkify({
  text,
  targets,
}: {
  text: string;
  targets?: LinkTargets;
}): React.ReactElement {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m !== null; m = TOKEN_RE.exec(text)) {
    const whole = m[0];
    const trimmed = whole.replace(TRAILING, "");
    if (trimmed.length === 0) continue;
    const isUrl = m[1] !== undefined;
    if (!isUrl && !looksLikePath(trimmed)) continue;

    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      isUrl ? (
        <a key={key++} href={trimmed} target="_blank" rel="noreferrer">
          {trimmed}
        </a>
      ) : (
        <FileLink key={key++} token={trimmed} targets={targets} />
      )
    );
    last = m.index + trimmed.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** パスの1つ。**開ける先が無いときは素のまま**（押せない見た目にしない）。 */
function FileLink({
  token,
  targets,
}: {
  token: string;
  targets?: LinkTargets;
}): React.ReactElement {
  const { path, line } = splitPathAndLine(token);
  if (!targets?.openFile) return <>{token}</>;
  return (
    <button
      type="button"
      className="linkify-path"
      title={`${path}${line ? `:${line}` : ""} をファイル面で開く`}
      onClick={() => targets.openFile?.(path, line)}
    >
      {token}
    </button>
  );
}

// ── Markdown（hast）側 ───────────────────────────────────────────────────────

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Markdown の描画結果（hast）の中の URL・パスをリンクにする rehype プラグイン。
 *
 * **`a` と `code` の中は触らない**——既にリンクなら二重にしないし、コード片の中の
 * パスまでボタンにすると、コピーしたい文字列が押しにくくなる（`pre` の中も同じ）。
 *
 * URL は remark-gfm が既にリンクにするので、ここで拾うのは主にパス。
 */
export function rehypeLinkify(): (tree: HastNode) => void {
  return (tree: HastNode): void => {
    walk(tree, false);
  };
}

function walk(node: HastNode, inside: boolean): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    const skip =
      inside ||
      child.tagName === "a" ||
      child.tagName === "code" ||
      child.tagName === "pre";
    if (child.type === "text" && typeof child.value === "string" && !skip) {
      next.push(...splitTextNode(child.value));
      continue;
    }
    walk(child, skip);
    next.push(child);
  }
  node.children = next;
}

/** 1つの文字列を、素のテキストと `banto-path` の印を付けた span に割る。 */
function splitTextNode(value: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(value); m !== null; m = TOKEN_RE.exec(value)) {
    const trimmed = m[0].replace(TRAILING, "");
    if (trimmed.length === 0) continue;
    // URL は remark-gfm が既にリンクにしている。ここではパスだけ
    if (m[1] !== undefined || !looksLikePath(trimmed)) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "span",
      // 描画側（MARKDOWN_COMPONENTS の span）が押せるものに差し替える
      properties: { dataBantoPath: trimmed },
      children: [{ type: "text", value: trimmed }],
    });
    last = m.index + trimmed.length;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
