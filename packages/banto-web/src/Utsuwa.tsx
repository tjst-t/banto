/**
 * 器 — Tool の戻り値を会話の中に描く（ADR-0017 決定78・81）。
 *
 * **番頭は選ぶが、作らない。** 語彙は中核（`protocol.ts` の `UtsuwaView`）が持ち、ここは
 * その13種をどう見せるかだけを持つ。モジュールは器を作らない——足りない語彙は
 * ADR を通して増やす（`spec-canvas-ui` §10 の延長）。
 *
 * **どの器も「畳んだ姿」を持つ**（決定78）。判定は**コンテナクエリ**——ビューポートでは
 * なく「会話の帯の幅」で決まるので、細い帯でもモバイルでも同じものが効く
 * （`spec-canvas-ui` §3 と同じ規約）。器を1つ足すコストが2倍になるのは歯止めとして望ましい。
 *
 * **器は凍る**（決定81(c)）。ここに書き換える経路は無く、「いつの」を必ず出す。
 * いまの状態が要るなら `open`（面への口）で面へ行く。
 *
 * D5: 判断は無い。渡された器をそう見えるように描くだけ。
 */

import React, { useState } from "react";
import type { UtsuwaState, UtsuwaView } from "@banto/host/protocol";
import Markdown from "react-markdown";
import { Icon, type IconName } from "./icons.js";
import { formatRelative } from "./views/ui.js";

/**
 * 文書の器で描くもの（決定78）。
 *
 * **見出し・段落・箇条書き・強調だけ。** 表も画像もコードも器の外へ出す——マークダウンを
 * 全部描けるようにすると、器が小さなブラウザになる。ここは会話の本文（`messages.tsx` の
 * `StreamingMarkdown`）とは別に持つ：同じ「マークダウンを描く」でも役が違う。
 */
const DOC_ALLOWED = ["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "code", "br"];

/** 器ごとの絵。**選ぶための目印**なので、面の絵とは別に持つ。 */
const UTSUWA_ICONS: Record<UtsuwaView["kind"], IconName> = {
  list: "more",
  facts: "file-text",
  table: "table",
  diff: "branch",
  choice: "inbox",
  stats: "graph",
  meter: "graph",
  spark: "graph",
  timeline: "clock",
  image: "image",
  doc: "file-text",
  quote: "memory",
  open: "canvas",
  broken: "warn",
};

/**
 * 畳んだときの1行（決定78）。
 *
 * **中身を読ませない。** 件数・大きさ・現在値のような「開く値打ちがあるか」だけを言う。
 */
function foldLabel(u: UtsuwaView): string {
  switch (u.kind) {
    case "list":
      return `${u.total ?? u.items.length} 件`;
    case "facts":
      return `${u.facts.length} 件の事実`;
    case "table":
      return `${u.rows.length} 行 × ${u.cols.length} 列`;
    case "diff":
      return [u.added !== undefined ? `+${u.added}` : "", u.removed !== undefined ? `−${u.removed}` : ""]
        .filter(Boolean)
        .join(" ") || u.path;
    case "choice":
      return "あなたの番";
    case "stats":
      return u.stats.map((s) => `${s.label} ${s.value}`).join(" · ");
    case "meter":
      return `${u.value} / ${u.max}${u.unit ?? ""}`;
    case "spark":
      return `いま ${u.points[u.points.length - 1]}${u.unit ?? ""}`;
    case "timeline":
      return `${u.events.length} 件の経過`;
    case "image":
      return "画像 1枚";
    case "doc":
      return "抜粋";
    case "quote":
      return "引用";
    case "open":
      return u.label;
    case "broken":
      return "描けませんでした";
  }
}

/** 器の見出し。**「いつの」は必ず出す**（決定81(c)）。 */
function UtsuwaHead({
  u,
  onToggle,
}: {
  u: UtsuwaView;
  onToggle(): void;
}): React.ReactElement {
  return (
    <div className="u-head">
      <Icon name={UTSUWA_ICONS[u.kind]} size={14} className="u-ico" />
      <b className="u-title">{u.title ?? defaultTitle(u)}</b>
      {u.meta && <span className="u-meta">{u.meta}</span>}
      <span className="u-sp" />
      {/* 器は記録。古い写しなのか いまの状態なのかが読めないと困る */}
      <span className="u-when" title={u.at}>
        {formatRelative(u.at)}時点
      </span>
      <button className="u-fold-btn" type="button" onClick={onToggle} aria-label="開閉">
        <Icon name="chevron-down" size={13} />
      </button>
    </div>
  );
}

/** 見出しが無いときの既定。器の種類が分かる語にする。 */
function defaultTitle(u: UtsuwaView): string {
  switch (u.kind) {
    case "diff":
      return u.path;
    case "meter":
    case "spark":
      return u.label;
    case "quote":
      return "引用";
    case "open":
      return u.label;
    case "broken":
      return "この形は描けませんでした";
    default:
      return u.from.tool;
  }
}

/** 役の点。**5役だけ**（決定78）。 */
function Dot({ state }: { state?: UtsuwaState }): React.ReactElement {
  return <span className={`u-dot is-${state ?? "done"}`} aria-hidden="true" />;
}

/**
 * 器1つ（膳＝器1つ。入れ子は許さない・決定81(b)）。
 *
 * 畳み判定は CSS のコンテナクエリが持つ（`.talk` の幅）。ここが持つのは
 * **POが自分で開いたかどうか**だけ——狭くて畳まれていても、押せば開く。
 */
export function Utsuwa({ u }: { u: UtsuwaView }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`u u--${u.kind} ${open ? "is-open" : ""}`}>
      <UtsuwaHead u={u} onToggle={() => setOpen(!open)} />
      <button className="u-fold" type="button" onClick={() => setOpen(!open)}>
        <span>{foldLabel(u)}</span>
        <span className="u-sp" />
        <span className="u-fold-open">開く</span>
      </button>
      <div className="u-body">
        <UtsuwaBody u={u} />
      </div>
      {u.note && <div className="u-note">{u.note}</div>}
    </div>
  );
}

function UtsuwaBody({ u }: { u: UtsuwaView }): React.ReactElement {
  switch (u.kind) {
    case "list":
      return (
        <div className="u-rows">
          {u.items.map((item, i) => (
            <div className="u-row" key={`${item.label}:${i}`}>
              <Dot state={item.state} />
              <span className="u-row-t">{item.label}</span>
              {item.meta && <em className="u-row-m">{item.meta}</em>}
            </div>
          ))}
        </div>
      );

    case "facts":
      return (
        <dl className="u-kv">
          {u.facts.map(([k, v], i) => (
            <React.Fragment key={`${k}:${i}`}>
              <dt>{k}</dt>
              {/* null は「—」。空文字で埋めたり項目ごと落としたりしない（I1） */}
              <dd>{v ?? "—"}</dd>
            </React.Fragment>
          ))}
        </dl>
      );

    case "table":
      return (
        <div className="u-table-wrap">
          <table className="u-table">
            <thead>
              <tr>
                {u.cols.map((c, i) => (
                  <th key={`${c.label}:${i}`} className={c.align === "num" ? "is-num" : ""}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {u.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={u.cols[c]?.align === "num" ? "is-num" : ""}>
                      {cell ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "diff":
      return (
        <div className="u-diff">
          {u.hunks.map((h, i) => (
            <div className="u-hunk" key={i}>
              {h.header && <div className="u-hunk-h">{h.header}</div>}
              {h.lines.map(([sign, text], j) => (
                <div
                  className={`u-diff-l ${sign === "+" ? "is-add" : sign === "-" ? "is-del" : ""}`}
                  key={j}
                >
                  {sign}
                  {text}
                </div>
              ))}
            </div>
          ))}
          {u.truncated && <div className="u-trunc">先頭のみ（全部は面で読む）</div>}
        </div>
      );

    case "stats":
      return (
        <div className="u-stats">
          {u.stats.map((s, i) => (
            <div className={`u-stat is-${s.state ?? "done"}`} key={`${s.label}:${i}`}>
              <b>{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      );

    case "meter": {
      const ratio = Math.max(0, Math.min(1, u.value / u.max));
      return (
        <div className="u-meter">
          <span className="u-meter-l">{u.label}</span>
          <span className="u-meter-track">
            <span
              className={`u-meter-fill is-${u.state ?? "done"}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </span>
          <span className="u-meter-v">
            {u.value} / {u.max}
            {u.unit ?? ""}
          </span>
        </div>
      );
    }

    case "spark": {
      // 軸も凡例も出さない——**読みたいのは向きと現在値**（決定78）
      const min = Math.min(...u.points);
      const max = Math.max(...u.points);
      const span = max - min || 1;
      const last = u.points[u.points.length - 1]!;
      const points = u.points
        .map((p, i) => {
          const x = (i / (u.points.length - 1)) * 100;
          const y = 28 - ((p - min) / span) * 26 - 1;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      // 色は「どちらへ動けば良いか」で決める。モジュールに「緑にして」と言わせない（D5）
      const rising = last >= u.points[0]!;
      const good = u.good === undefined ? undefined : (u.good === "up") === rising;
      return (
        <div className={`u-spark ${good === false ? "is-bad" : good === true ? "is-good" : ""}`}>
          <div className="u-spark-t">
            <span>{u.label}</span>
            <span className="u-sp" />
            <b>
              {last}
              {u.unit ?? ""}
            </b>
            {u.span && <em>{u.span}</em>}
          </div>
          <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points} />
            <circle cx="100" cy={points.split(" ").pop()!.split(",")[1]} r="2.2" />
          </svg>
        </div>
      );
    }

    case "timeline":
      return (
        <div className="u-time">
          {u.events.map((e, i) => (
            <div className={`u-time-e is-${e.state ?? "done"}`} key={i}>
              <time>{e.at}</time>
              <span className="u-time-l" />
              <span className="u-time-t">{e.label}</span>
            </div>
          ))}
        </div>
      );

    case "image":
      return (
        <a className="u-img" href={u.src} target="_blank" rel="noreferrer" title="押すと原寸">
          {/* alt は必須（I1：見えない人に「画像」とだけ出さない） */}
          <img src={u.src} alt={u.alt} {...(u.w ? { width: u.w } : {})} {...(u.h ? { height: u.h } : {})} />
        </a>
      );

    case "doc":
      return (
        <div className="u-doc markdown">
          {/* 描くのは見出し・段落・箇条書き・強調だけ。全部描けるようにすると
              器が小さなブラウザになる（決定78） */}
          <Markdown allowedElements={DOC_ALLOWED} unwrapDisallowed>
            {u.excerpt}
          </Markdown>
          {u.truncated && <div className="u-trunc">抜粋です。全部は面にあります</div>}
        </div>
      );

    case "quote":
      return (
        <blockquote className="u-quote">
          {u.text}
          {/* 番頭の言葉と、拾ってきた言葉を混ぜない */}
          <cite>{u.source}</cite>
        </blockquote>
      );

    case "open":
      // 押せる本体は `UtsuwaRow` が持つ（器の中に器を作らないため）
      return <div className="u-open-meta">{u.meta ?? u.view}</div>;

    case "choice":
      // 判断待ちは取次から描く（`Inbox.tsx` の `PendingDecisions`）。ここへは来ない
      return <div className="u-trunc">判断待ちは取次から出ます</div>;

    case "broken":
      return (
        <div className="u-broken-body">
          <dl className="u-kv">
            <dt>出どころ</dt>
            <dd>
              <code>{u.from.module}</code> / <code>{u.from.tool}</code>
            </dd>
            <dt>頼んだ器</dt>
            <dd>
              <code>{u.wanted}</code>
            </dd>
            <dt>足りないもの</dt>
            <dd>{u.missing}</dd>
          </dl>
          {/* 素の値は畳んで置く。黙って素の JSON を出すと、壊れた見た目が既定になる */}
          {u.raw && <RawValue raw={u.raw} />}
        </div>
      );
  }
}

/** 素の値。**開いたときだけ**出す（決定81(d)）。 */
function RawValue({ raw }: { raw: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="u-raw">
      <button className="btn btn--ghost btn--small" type="button" onClick={() => setOpen(!open)}>
        {open ? "素の値を畳む" : "素の値を見る"}
      </button>
      {open && <pre>{raw}</pre>}
    </div>
  );
}

/**
 * 会話に並ぶ器の1行。
 *
 * `open`（面への口）だけは**器ではなくボタン**として出す——これがあるから他の器が
 * 小さいままでいられる（決定78）。押すと面が開き、会話は細い帯として残る（決定79）。
 */
export function UtsuwaRow({
  u,
  onOpenView,
}: {
  u: UtsuwaView;
  /** 面への口が押されたとき。渡さないと押せない（描けない面は出さない・決定12） */
  onOpenView?: (kind: string, params?: Record<string, unknown>) => void;
}): React.ReactElement {
  if (u.kind === "open") {
    return (
      <button
        className="u-open"
        type="button"
        disabled={!onOpenView}
        onClick={() => onOpenView?.(u.view, u.args)}
        title={onOpenView ? `${u.view} を開く` : "この画面ではこの面を描けません"}
      >
        <Icon name={UTSUWA_ICONS.open} size={16} className="u-open-ico" />
        <span className="u-open-t">
          <b>{u.label}</b>
          <s>{u.meta ?? u.view}</s>
        </span>
        <span className="u-open-go">間を開く →</span>
      </button>
    );
  }
  if (u.kind === "doc" && u.open && onOpenView) {
    return (
      <div className="u-with-open">
        <Utsuwa u={u} />
        <button
          className="btn btn--ghost btn--small u-doc-all"
          type="button"
          onClick={() => onOpenView(u.open!.view, u.open!.args)}
        >
          全部読む →
        </button>
      </div>
    );
  }
  return <Utsuwa u={u} />;
}
