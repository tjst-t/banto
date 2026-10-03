// 一覧と詳細の両方で使う小さな部品（モックの backlog-parts.tsx を素の DOM に写したもの）。
//
// 左端の印で状態を言う。順番の数字は入れない（2026-10-03、ユーザー「数字の意味がわからない」）。
//   着手できる＝青の輪／進めている＝青の輪に進みの弧／待っている＝点線の輪／積んだだけ＝灰の輪／
//   終わった＝緑の輪にチェック／やめた＝横棒
// ストーリーは角の丸い四角を、子の終わった割合だけ下から満たす（タスクの輪と形で分ける）。

import {
  childrenOf,
  rankState,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
  type RankState,
} from "../model.js";
import { h, type Child } from "./dom.js";

export const KIND_LABEL: Record<BacklogKind, string> = { story: "ストーリー", task: "タスク", bug: "バグ" };

// ready は「準備できた」——一覧の「着手できる」（待つものが全部終わった ready）と取り違えないため
export const STATUS_LABEL: Record<BacklogStatus, string> = {
  backlog: "積んだだけ",
  ready: "準備できた",
  "in-progress": "進めている",
  done: "終わった",
  dropped: "やめた",
};

export const PRIORITY_LABEL: Record<BacklogPriority, string> = { high: "高い", normal: "ふつう", low: "低い" };

export const RANK_STATE_LABEL: Record<RankState, string> = {
  actionable: "着手できる",
  "in-progress": "進めている",
  waiting: "待っている",
  backlog: "積んだだけ",
  done: "終わった",
  dropped: "やめた",
};

const SVG = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function circle(c: number, r: number, extra: Record<string, string | number>): SVGElement {
  return svgEl("circle", { cx: c, cy: c, r, fill: "none", stroke: "currentColor", ...extra });
}

/** 状態の印（タスク・バグ）。一覧で 22px、子の行と札では 18px */
export function rankMark(state: RankState, small = false): HTMLElement {
  const size = small ? 18 : 22;
  const r = size / 2 - 1.5;
  const c = size / 2;
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });
  if (state === "actionable") svg.append(circle(c, r, { "stroke-width": 1.5 }));
  if (state === "in-progress") {
    svg.append(
      circle(c, r, { "stroke-opacity": 0.3, "stroke-width": 1.5 }),
      // 進みの弧（12時から3/4周）。「動いている」を形で言う
      circle(c, r, {
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-dasharray": `${2 * Math.PI * r * 0.75} ${2 * Math.PI * r}`,
        transform: `rotate(-90 ${c} ${c})`,
      }),
    );
  }
  if (state === "backlog") svg.append(circle(c, r, { "stroke-width": 1.25 }));
  if (state === "waiting") svg.append(circle(c, r, { "stroke-width": 1.25, "stroke-dasharray": "2 2.4" }));
  if (state === "done") {
    svg.append(
      circle(c, r, { "stroke-width": 1.5 }),
      svgEl("path", {
        d: `M${c - r * 0.42} ${c + 0.2} L${c - r * 0.08} ${c + r * 0.36} L${c + r * 0.46} ${c - r * 0.32}`,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.6,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  }
  if (state === "dropped") {
    svg.append(
      svgEl("line", { x1: c - r * 0.5, y1: c, x2: c + r * 0.5, y2: c, stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" }),
    );
  }
  const el = h("span", {
    class: small ? "mark small" : "mark",
    attrs: { role: "img", "aria-label": RANK_STATE_LABEL[state] },
    data: { testid: "backlog-rank", state },
  });
  el.append(svg);
  return el;
}

/** ストーリーの印。角の丸い四角を、子のタスクの終わった割合だけ下から満たす。やめた子は数えない */
export function storyMark(item: BacklogItem, items: readonly BacklogItem[], small = false): HTMLElement {
  const kids = childrenOf(item, items).filter((k) => k.status !== "dropped");
  const done = kids.filter((k) => k.status === "done").length;
  const ratio = item.status === "done" ? 1 : kids.length === 0 ? 0 : done / kids.length;
  const size = small ? 18 : 22;
  const o = 2;
  const w = size - o * 2;
  const pad = 2.5;
  const inner = w - pad * 2;
  const fill = inner * ratio;
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });
  svg.append(svgEl("rect", { x: o, y: o, width: w, height: w, rx: 4, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }));
  if (fill > 0) {
    svg.append(svgEl("rect", { x: o + pad, y: o + pad + inner - fill, width: inner, height: fill, rx: 1.5, fill: "currentColor" }));
  }
  const tone = item.status === "done" ? "done" : item.status === "in-progress" ? "in-progress" : "open";
  const el = h("span", {
    class: small ? "story-mark small" : "story-mark",
    attrs: { role: "img", "aria-label": `ストーリー・タスク ${kids.length} 件のうち ${done} 件終わった` },
    data: { testid: "backlog-story-mark", tone, ratio: String(Math.round(ratio * 100)) },
  });
  el.append(svg);
  return el;
}

export function itemMark(item: BacklogItem, items: readonly BacklogItem[], small = false): HTMLElement {
  return item.kind === "story" ? storyMark(item, items, small) : rankMark(rankState(item, items), small);
}

/** バグの札。種類で目立たせるのはバグだけ（ストーリーは字の太さ、タスクは何も付けない） */
export function bugTag(): HTMLElement {
  return h("span", { class: "bug-tag", text: "バグ", data: { testid: "backlog-bug-tag" } });
}

/** 優先は高いときだけ行に出す */
export function priorityMark(priority: BacklogPriority): HTMLElement | null {
  return priority === "high" ? h("span", { class: "prio", text: "優先", data: { testid: "backlog-priority-high" } }) : null;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "日付不明";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "日付不明";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---- 本文の Markdown（段落・見出し・箇条書き・`コード`・**太字** だけ）----
// 中身は人と AI が書いた文字なので、**必ず textContent で入れる**（innerHTML に入れない）

function inline(text: string): Child[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return h("code", { text: part.slice(1, -1) });
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return h("strong", { text: part.slice(2, -2) });
    return part;
  });
}

export function markdownBody(source: string): HTMLElement {
  const root = h("div", { class: "md" });
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      root.append(h("ul", {}, ...lines.map((l) => h("li", {}, ...inline(l.replace(/^\s*[-*] /, ""))))));
      continue;
    }
    // 見出しの次の行から本文が続く形（移した古い項目の「## なぜ\n…」）も読めるように、行ごとに見る
    let paragraph: string[] = [];
    let list: HTMLUListElement | null = null;
    const flush = () => {
      if (paragraph.length > 0) root.append(h("p", {}, ...inline(paragraph.join(" "))));
      paragraph = [];
    };
    for (const l of lines) {
      if (/^\s*[-*] /.test(l)) {
        flush();
        if (!list) {
          list = h("ul");
          root.append(list);
        }
        list.append(h("li", {}, ...inline(l.replace(/^\s*[-*] /, ""))));
        continue;
      }
      list = null;
      if (/^#{1,6} /.test(l)) {
        flush();
        root.append(h("p", { class: "h" }, ...inline(l.replace(/^#{1,6} /, ""))));
      } else {
        paragraph.push(l);
      }
    }
    flush();
  }
  return root;
}
