/**
 * SKILLビューア（studio モジュール提供・ADR-0010 決定25・26）。
 *
 * 番頭の手続き記憶を見せる。どんな手順を知っていて、それがどこから来たか（**番頭が学んだ
 * ものか**、番頭核か、どのモジュールか＝決定26 の3層）が分かる。
 *
 * **学習層は同名の既定を上書きする**（決定26）。ここに出るのが実際に効いている版で、
 * 隠れている既定があることも分かるようにする——オーバーライドが既定の改良を黙って隠すのが
 * 決定26 の名指しした事故なので、画面がそれを見えなくしてはいけない。
 *
 * **閲覧専用。** 学習層への書き込みは番頭の `skill.learn` が行う（task-0017）。
 */

import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "../links.js";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SearchField,
  SplitView,
  ViewBar,
  ViewShell,
  ViewTitle,
} from "./ui.js";

interface SkillEntry {
  name: string;
  description: string;
  /** 決定26 の層。番頭が学んだものなら learned、番頭核なら core、モジュール提供ならモジュール名 */
  origin: string;
  body?: string;
  error?: string;
}
interface SkillList {
  skills: SkillEntry[];
}

function originLabel(origin: string): string {
  if (origin === "learned") return "番頭が学んだ";
  return origin === "core" ? "番頭核" : origin;
}

/** 学んだものを目立たせる。既定と同じ見え方だと、上書きされていることに気づけない。 */
function originTone(origin: string): "accent" | "ok" | "neutral" {
  if (origin === "learned") return "ok";
  return origin === "core" ? "accent" : "neutral";
}

/**
 * 先頭の frontmatter を落とす。
 *
 * SKILL.md（agentskills.io 形式）は `---` で囲んだ name / description を持つ。Markdown と
 * しては意味を持たないので、そのまま描くと**見出しに化けて本文の頭に居座る**——しかも
 * 中身は上の説明と同じものを繰り返している。
 */
function withoutFrontmatter(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  return match ? body.slice(match[0].length) : body;
}

export function SkillViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initial = typeof params["name"] === "string" ? params["name"] : undefined;
  const [selected, setSelected] = useState<string | undefined>(initial);
  const [showBody, setShowBody] = useState(initial !== undefined);
  const [filter, setFilter] = useState("");

  const list = useModuleTool<SkillList>(endpoint, "studio.skills", {});
  const skills = list.data?.skills ?? [];
  const current = skills.find((s) => s.name === selected) ?? skills[0];

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return skills;
    return skills.filter((s) => `${s.name} ${s.description} ${s.origin}`.toLowerCase().includes(q));
  }, [skills, filter]);

  const listPane = (
    <>
      <ViewBar>
        <ViewTitle icon="skill" count={skills.length}>
          SKILL
        </ViewTitle>
      </ViewBar>
      <ViewBar>
        <SearchField value={filter} onChange={setFilter} placeholder="名前・説明で絞る" />
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}

      <Scroll pad={false}>
        {list.loading && !list.data ? (
          <Loading rows={4} />
        ) : shown.length === 0 ? (
          <EmptyState icon="skill" title={filter ? "当てはまる SKILL はありません" : "SKILL はありません"}>
            {filter
              ? "絞り込みを外すと全部出ます。"
              : "番頭核とモジュールが出す手順、番頭が学んだ手順がここに並びます。"}
          </EmptyState>
        ) : (
          <ul className="cv-list">
            {shown.map((s) => (
              <li key={s.name}>
                <button
                  className={`cv-row ${s.name === current?.name ? "is-selected" : ""}`}
                  onClick={() => {
                    setSelected(s.name);
                    setShowBody(true);
                  }}
                  title={s.description}
                >
                  <span className="cv-row-main">
                    <span className="cv-row-name">{s.name}</span>
                    <span className="cv-row-sub">{originLabel(s.origin)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Scroll>
    </>
  );

  const detailPane = !current ? (
    <EmptyState icon="skill" title="SKILL を選ぶと中身が見えます">
      番頭がどんな手順を知っているかを、そのまま読めます。
    </EmptyState>
  ) : (
    <>
      <div className="cv-head">
        <span className="cv-head-title">{current.name}</span>
        <Badge
          tone={originTone(current.origin)}
          title={
            current.origin === "learned"
              ? "番頭が実務の中で学んだ版。同名の既定があれば、それを上書きしている（決定26）"
              : undefined
          }
        >
          {originLabel(current.origin)}
        </Badge>
      </div>
      {current.description && <p className="st-desc">{current.description}</p>}
      {current.error && <ErrorNote title="この SKILL を読めません">{current.error}</ErrorNote>}
      {current.body !== undefined && (
        <div className="cv-scroll st-body">
          <div className="markdown">
            {/* 外に出るリンクは別タブへ（links.tsx）。SKILL.md は参照リンクを持つ */}
            <Markdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
              {withoutFrontmatter(current.body)}
            </Markdown>
          </div>
        </div>
      )}
    </>
  );

  return (
    <ViewShell className="st">
      <SplitView
        size="md"
        list={listPane}
        detail={detailPane}
        showDetail={showBody}
        onBack={() => setShowBody(false)}
        backLabel="SKILL 一覧"
      />
    </ViewShell>
  );
}
