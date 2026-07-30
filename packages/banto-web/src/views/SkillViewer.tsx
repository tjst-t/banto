/**
 * SKILLビューア（studio モジュール提供・ADR-0010 決定25・26）。
 *
 * 番頭の手続き記憶を見せる。どんな手順を知っていて、それがどこから来たか（番頭核か、
 * どのモジュールか＝決定26 の層）が分かる。
 *
 * **閲覧専用。** SKILL の書き込みは決定26 の学習層（task-0017）に属する。
 */

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

interface SkillEntry {
  name: string;
  description: string;
  /** 決定26 の層。番頭核なら core、モジュール提供ならモジュール名 */
  origin: string;
  body?: string;
  error?: string;
}
interface SkillList {
  skills: SkillEntry[];
}

export function SkillViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initial = typeof params["name"] === "string" ? params["name"] : undefined;
  const [selected, setSelected] = useState<string | undefined>(initial);

  const list = useModuleTool<SkillList>(endpoint, "studio.skills", {});
  const skills = list.data?.skills ?? [];
  const current = skills.find((s) => s.name === selected) ?? skills[0];

  return (
    <div className="wv">
      <div className="wv-side">
        <h3 className="gv3-head">
          SKILL
          <span className="gv3-count">{skills.length}</span>
        </h3>
        {list.error && <div className="fb-error">読み込めません: {list.error}</div>}
        {skills.length === 0 ? (
          <p className="fb-muted gv3-empty">
            {list.loading ? "読み込み中…" : "SKILL はありません"}
          </p>
        ) : (
          <ul className="wv-list">
            {skills.map((s) => (
              <li key={s.name}>
                <button
                  className={`wv-item ${s.name === current?.name ? "is-selected" : ""}`}
                  onClick={() => setSelected(s.name)}
                  title={s.description}
                >
                  <span className="wv-body">
                    <span className="wv-task">{s.name}</span>
                    <span className="wv-meta">{s.origin === "core" ? "番頭核" : s.origin}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wv-main">
        <div className="gv3-main-head">
          <span className="gv3-subject">{current?.name ?? "SKILL を選ぶと中身が見えます"}</span>
          {current && (
            <span className="gv3-date">{current.origin === "core" ? "番頭核" : current.origin}</span>
          )}
        </div>
        {current?.description && <p className="st-desc">{current.description}</p>}
        {current?.error && <div className="fb-error">{current.error}</div>}
        {current?.body !== undefined && (
          <div className="markdown st-body">
            <Markdown remarkPlugins={[remarkGfm]}>{current.body}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
