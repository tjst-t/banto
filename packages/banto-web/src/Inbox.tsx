/**
 * 取次の面 — 番頭に用があるものを、出所を問わず受ける（spec-design §0④）。
 *
 * **常に見えているのは上段のボタンと数字だけ**で、開くまで画面を取らない
 * （PO報告 2026-08-05「画面をとりすぎる」）。押すと履歴・設定と同じ一級の面が
 * 会話に被さる（決定41）。
 *
 * 札は spec-ui §3 の三部構成——経緯／起きたこと／求める判断。**画面を遡らず、
 * その札だけで判断できること**が要件なので、どれか欠けたら札として成立しない。
 *
 * D3: 中身の真実はホスト。ここは配られた状態を描き、押されたことを投げ返すだけ。
 * D5: 並び順も選択肢もホストが決める。ここに判断は無い。
 */

import React, { useState } from "react";
import type { InboxItemView } from "@banto/host/protocol";
import { Icon, type IconName } from "./icons.js";

/** 出所 → 絵。知らない出所は無地の札で描く（黙って消さない）。 */
const SOURCE_ICONS: Record<string, IconName> = {
  banto: "chat",
  worker: "worker",
  kobo: "graph",
  env: "environment",
  github: "branch",
  place: "place",
  memory: "memory",
  skill: "skill",
};

function sourceIcon(id: string): IconName {
  return SOURCE_ICONS[id] ?? "inbox";
}

/** 滞留の長さ。**導出できる値なので保存しない**（D3）——毎回ここで数える。 */
function ageOf(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}時間`;
  return `${Math.round(hour / 24)}日`;
}

export interface InboxFaceProps {
  items: InboxItemView[];
  /** 一通に答える（会話と面はホストが同時に開く）。 */
  onAnswer(itemId: string, actionId: string): void;
  /** 答えずに、その件の会話と面だけ開く。 */
  onOpen(itemId: string): void;
  /** 会話へ戻る。 */
  onBack(): void;
}

export function InboxFace({ items, onAnswer, onOpen, onBack }: InboxFaceProps): React.ReactElement {
  /** 出所での絞り込み。undefined は「すべて」。 */
  const [only, setOnly] = useState<string>();

  const pending = items.filter((i) => !i.resolvedAt);
  const done = items.filter((i) => i.resolvedAt);
  // 出所は**届いているものから作る**——固定の一覧を持つと、新しい出所が増えたときに
  // 絞り込めない面が出る（モジュールは増える前提）
  const sources = [...new Map(pending.map((i) => [i.source.id, i.source])).values()];
  const shown = only ? pending.filter((i) => i.source.id === only) : pending;

  return (
    <div className="ib">
      <div className="ib-head">
        <div className="ib-inner">
          <div className="ib-title-row">
            <h1 className="ib-title">取次</h1>
            <span className="ib-spacer" />
            <button className="btn btn--ghost" type="button" onClick={onBack}>
              <Icon name="chevron-left" size={14} />
              会話へ戻る
            </button>
          </div>
          <p className="ib-lede">
            番頭に用があるものが、出所を問わずここに集まります。<b>押すと、その件の会話と面が同時に開きます。</b>
          </p>
          {pending.length > 0 && (
            <div className="ib-filters">
              <button
                className={`cv-chip ${only === undefined ? "is-on" : ""}`}
                type="button"
                onClick={() => setOnly(undefined)}
              >
                すべて<span className="ib-c">{pending.length}</span>
              </button>
              {sources.map((s) => (
                <button
                  key={s.id}
                  className={`cv-chip ${only === s.id ? "is-on" : ""}`}
                  type="button"
                  onClick={() => setOnly(s.id)}
                >
                  {s.label}
                  <span className="ib-c">{pending.filter((i) => i.source.id === s.id).length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ib-scroll">
        <div className="ib-inner">
          {pending.length === 0 ? (
            /* 空の姿。**この列が何かは、0 件のときの姿がいちばん語る** */
            <div className="ib-empty">
              <Icon name="inbox" size={30} stroke={1.2} className="ib-empty-icon" />
              <b>取り次ぐものはありません</b>
              <p>
                職人は動いていますが、いま出ている判断は番頭が全部引き受けました。
                <br />
                手が空いたら、番頭に次の相談をしてください。
              </p>
            </div>
          ) : (
            shown.map((item) => (
              <Letter key={item.id} item={item} onAnswer={onAnswer} onOpen={onOpen} />
            ))
          )}

          {done.length > 0 && (
            <>
              <div className="ib-sep">これより下は、答えが出たもの</div>
              {done.map((item) => (
                <Letter key={item.id} item={item} onAnswer={onAnswer} onOpen={onOpen} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 一通。三部構成をそのまま組む。 */
function Letter({
  item,
  onAnswer,
  onOpen,
}: {
  item: InboxItemView;
  onAnswer(itemId: string, actionId: string): void;
  onOpen(itemId: string): void;
}): React.ReactElement {
  const answered = item.resolvedAt !== undefined;
  const chosen = item.actions.find((a) => a.id === item.resolution);
  return (
    <article className={`ib-letter ${answered ? "is-answered" : ""}`}>
      <div className="ib-top">
        {/* 出所は一番上。**誰が言っているかを、読む前に出す** */}
        <span className="ib-from">
          <Icon name={sourceIcon(item.source.id)} size={13} />
          {item.source.label}
        </span>
        <span className="ib-kind">
          {item.kind}
          {item.rule && <span className="ib-rule">{item.rule}</span>}
        </span>
        <span className="ib-spacer" />
        <span className="ib-age">
          {ageOf(item.createdAt)}
          {item.blocking ? ` · 後続${item.blocking}件` : ""}
        </span>
      </div>

      <h2 className="ib-h">{item.title}</h2>

      <dl className="ib-dl">
        {item.why && (
          <>
            <dt>経緯</dt>
            <dd>{item.why}</dd>
          </>
        )}
        <dt>起きたこと</dt>
        <dd>{item.what}</dd>
        <dt>求める判断</dt>
        <dd>{item.ask}</dd>
      </dl>

      {answered ? (
        <div className="ib-answered">
          <Icon name="check" size={14} />
          <b>{chosen?.label ?? item.resolution}</b> で答えました
        </div>
      ) : (
        <div className="ib-actions">
          {item.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`btn ${a.tone === "call" ? "btn--call" : a.tone === "quiet" ? "btn--ghost" : ""}`}
              onClick={() => onAnswer(item.id, a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* 押した先を**先に見せる**。押してから「どこへ飛んだ？」にしない */}
      {item.opens && (
        <button className="ib-go" type="button" onClick={() => onOpen(item.id)}>
          <Icon name="arrow-right" size={13} />
          {[
            item.opens.threadId ? "この件の会話を開く" : undefined,
            item.opens.canvas ? `キャンバスに ${item.opens.canvas.title ?? item.opens.canvas.kind} を開く` : undefined,
          ]
            .filter(Boolean)
            .join(" ／ ")}
        </button>
      )}
    </article>
  );
}

/**
 * いま開いている面に関わる判断待ちを、面の中にも出す。
 *
 * 取次を開かないと気づけない、では判断が滞る——**見ているものに用があるなら、
 * 見ているところに出す**。押した結果は取次と同じ（真実は一箇所・D3）。
 *
 * 器（App）の側で出すので、個々の面は取次を知らなくてよい（D5）。
 */
export function PendingDecisions({
  items,
  onAnswer,
}: {
  items: InboxItemView[];
  onAnswer(itemId: string, actionId: string): void;
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="pend">
      {items.map((item) => (
        <div className="pend-card" key={item.id}>
          <div className="pend-h">
            {/* 落款。朱はここと取次の数字にしか出ない */}
            <span className="pend-seal">断</span>
            <b>あなたの判断を待っています</b>
            <span className="pend-from">
              {item.source.label}
              {item.rule && <span className="ib-rule">{item.rule}</span>}
            </span>
          </div>
          <p className="pend-ask">
            <b>{item.title}</b>
            {item.ask ? ` — ${item.ask}` : ""}
          </p>
          <div className="pend-actions">
            {item.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`btn ${a.tone === "call" ? "btn--call" : a.tone === "quiet" ? "btn--ghost" : ""}`}
                onClick={() => onAnswer(item.id, a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
