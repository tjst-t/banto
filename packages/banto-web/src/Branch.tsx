/**
 * 幹に立つ2つの行（ADR-0017 決定77）。
 *
 * - **枝の札**（`BranchCard`）：その枝を**指す参照**。題も状態も生きている
 * - **還った1行**（`BranchResultRow`）：畳んだときの**記録**。凍る
 *
 * 記録と参照を混ぜない（決定81(c)）——札は生きているので、開いている枝の状態が
 * 幹を読むだけで分かる。幹の行そのものは書き換わらない（追記のみ・D3）。
 *
 * **幹に載るのは、開いた1行と還った1行だけ。** 枝の中身（職人のおしゃべり・調査・往復）は
 * 幹に流さない——これで幹はプロジェクトの意思決定の帯として端から端まで読める。
 *
 * D5: 判断は無い。渡された枝をそう見えるように描くだけ。
 */

import React, { useState } from "react";
import type { ThreadView } from "@banto/host/protocol";
import { Icon } from "./icons.js";
import { formatRelative } from "./views/ui.js";

/** 枝がいまどうなっているか（画面の言葉）。 */
function branchState(branch: ThreadView, hasTurn: boolean): { cls: string; label: string } {
  if (branch.state === "closed") return { cls: "done", label: "畳みました" };
  if (hasTurn) return { cls: "turn", label: "あなたの判断を待っています" };
  return { cls: "run", label: "動いています" };
}

/**
 * 枝の札。**参照なので状態は生きている。**
 *
 * 還す条件と、開いた理由を必ず出す——書けないなら枝にしない、が歯止めなので、
 * 書いたものは読める場所に出す（決定77）。
 */
export function BranchCard({
  branch,
  active,
  hasTurn = false,
  onOpen,
}: {
  /** 指している枝。帳簿から引けなければ渡さない（`BranchMissing` が出る）。 */
  branch: ThreadView | undefined;
  /** いまこの枝を見ているか。 */
  active?: boolean;
  /** この枝に判断待ちがあるか（横断の通知から導く）。 */
  hasTurn?: boolean;
  onOpen?(threadId: string): void;
}): React.ReactElement {
  // I2: 指し先の無い札を黙って消さない——消すと幹の行が虫食いになる（追記のみ・D3）
  if (!branch) {
    return (
      <div className="bcard is-missing">
        <Icon name="warn" size={14} />
        <span>この枝は帳簿から引けませんでした（記録は残っています）</span>
      </div>
    );
  }
  const st = branchState(branch, hasTurn);
  return (
    <button
      className={`bcard is-${st.cls} ${active ? "is-active" : ""}`}
      type="button"
      onClick={() => onOpen?.(branch.threadId)}
      title={`${branch.title} を開く`}
    >
      <div className="bc-top">
        <span className="bc-tag">枝</span>
        <span className="bc-by">{branch.openedBy === "po" ? "あなたの指示で" : "番頭の判断で"}</span>
        <span className="bc-sp" />
      </div>
      <h3 className="bc-title">{branch.title}</h3>
      {branch.returnCondition && (
        <div className="bc-cond">還す条件：{branch.returnCondition}</div>
      )}
      {branch.openReason && <div className="bc-reason">{branch.openReason}</div>}
      <div className="bc-foot">
        <span className={`u-dot is-${st.cls}`} aria-hidden="true" />
        {st.label}
        <span className="bc-sp" />
        <span className="bc-go">{active ? "この間を見ています" : "隣の間で開く →"}</span>
      </div>
    </button>
  );
}

/**
 * 枝が幹へ還った1行（決定77）。**記録なので凍る。**
 *
 * 幹に残るのはこれだけ——結論が読めれば、枝の中身を遡らずに済む。
 */
export function BranchResultRow({
  branchId,
  title,
  conclusion,
  at,
  onOpen,
}: {
  branchId: string;
  title: string;
  conclusion: string;
  at: string;
  onOpen?(threadId: string): void;
}): React.ReactElement {
  return (
    <div className="bresult">
      <span className="bres-mark" aria-hidden="true">
        <Icon name="check" size={11} />
      </span>
      <div className="bres-body">
        <div className="bres-head">
          枝「<b>{title}</b>」を幹に回収しました
          <span className="bres-when" title={at}>
            {formatRelative(at)}
          </span>
        </div>
        <div className="bres-conc">
          <span className="bres-label">結論：</span>
          {conclusion}
        </div>
        {onOpen && (
          <button className="bres-go" type="button" onClick={() => onOpen(branchId)}>
            中身をひらく
            <Icon name="arrow-right" size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 枝を開くときに書かせるもの（決定77）。
 *
 * **還す条件と理由が無いと開けない。** 帳簿も拒むが、画面でも「書けないなら枝にしない」が
 * 分かる形にする——押してからエラーで跳ね返されるのは、書かせ方として不親切。
 */
export function NewBranchForm({
  onOpen,
  onCancel,
}: {
  onOpen(spec: { title: string; returnCondition: string; reason: string }): void;
  onCancel(): void;
}): React.ReactElement {
  const [title, setTitle] = useState("");
  const [cond, setCond] = useState("");
  const [reason, setReason] = useState("");
  const ready = title.trim() !== "" && cond.trim() !== "" && reason.trim() !== "";
  return (
    <form
      className="nb"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onOpen({ title: title.trim(), returnCondition: cond.trim(), reason: reason.trim() });
      }}
    >
      <div className="nb-head">
        <b>枝を開く</b>
        <span className="bc-sp" />
        <button className="btn btn--ghost btn--small" type="button" onClick={onCancel}>
          やめる
        </button>
      </div>
      <label className="nb-field">
        <span>何の話か</span>
        <input
          className="cv-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="間欠的に落ちる試験"
          autoFocus
        />
      </label>
      <label className="nb-field">
        <span>還す条件</span>
        <input
          className="cv-input"
          value={cond}
          onChange={(e) => setCond(e.target.value)}
          placeholder="再現条件が特定できたら"
        />
      </label>
      <label className="nb-field">
        <span>なぜ幹ではなくここで話すか</span>
        <input
          className="cv-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="往復が続くので幹が読めなくなる"
        />
      </label>
      <p className="nb-note">
        <b>還す条件を書けないものは枝にしません。</b>幹で話してください——枝が埋没するのは、
        畳む条件が無いときだけです。
      </p>
      <div className="nb-actions">
        <button className="btn btn--primary" type="submit" disabled={!ready}>
          この条件で開く
        </button>
      </div>
    </form>
  );
}

/**
 * 枝を畳むときに書かせるもの（決定77）。
 *
 * **出口は「結論」であって「実装」ではない。保留も結論の一種。**
 */
export function MergeBranchForm({
  branch,
  onMerge,
  onCancel,
}: {
  branch: ThreadView;
  onMerge(conclusion: string): void;
  onCancel(): void;
}): React.ReactElement {
  const [conclusion, setConclusion] = useState("");
  const ready = conclusion.trim() !== "";
  return (
    <form
      className="nb"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onMerge(conclusion.trim());
      }}
    >
      <div className="nb-head">
        <b>畳んで幹に回収する</b>
        <span className="bc-sp" />
        <button className="btn btn--ghost btn--small" type="button" onClick={onCancel}>
          やめる
        </button>
      </div>
      {branch.returnCondition && (
        <p className="nb-note">還す条件：{branch.returnCondition}</p>
      )}
      <label className="nb-field">
        <span>結論（幹に残る1行）</span>
        <input
          className="cv-input"
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          placeholder="inc-0048 を起票し task-0091 を積んだ"
          autoFocus
        />
      </label>
      <p className="nb-note">
        決めきれないなら「<b>保留：理由</b>」で畳んでください。開き直せます——開いたままにすると、
        抱えているものの一覧が信用できなくなります。
      </p>
      <div className="nb-actions">
        <button className="btn btn--primary" type="submit" disabled={!ready}>
          畳んで幹に回収
        </button>
      </div>
    </form>
  );
}
