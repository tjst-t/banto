"use client";

// **どの Skill を効かせるか**（決定・2026-09-23、アーキ仕様 §5.7）。
//
// 粒度は2つ——banto 全体の既定と、Project ごとの上書き。どちらもこの1つの部品で出す
// （`projectId` があれば Project の層）。**効くのは次の新しい会話から**
// ——効かせる集合は会話の始まりで決まり、続いている会話には届かない（§5.6 の実測）。
//
// 押したらその場で保存する（下書きを持たない）。効くのは新しい会話からなので、
// 押した瞬間に何かが壊れることは無い——確認を挟む理由が無い。
import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { describeFailure, reportFailure } from "@/lib/report-failure";
import { listRealSkills, setRealSkillEnabled, type RealSkill, type RealSkillListing } from "@/lib/backend/client";

type ProjectChoice = "inherit" | "on" | "off";

function projectChoiceOf(skill: RealSkill): ProjectChoice {
  return skill.project === null ? "inherit" : skill.project ? "on" : "off";
}

export function SkillsPanel({ projectId }: { projectId?: string }) {
  const [listing, setListing] = useState<RealSkillListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    listRealSkills(projectId)
      .then((next) => {
        setLoadError(null);
        setListing(next);
      })
      .catch((err: unknown) => {
        // **読めなかったことを出す**（規則2——空の一覧に見せない）
        setLoadError(describeFailure(err));
        setListing({ skills: [], problems: [] });
      });
  }, [projectId]);
  useEffect(load, [load]);

  async function change(skill: RealSkill, enabled: boolean | null) {
    const key = `${skill.module}/${skill.name}`;
    setSaving(key);
    try {
      await setRealSkillEnabled({ module: skill.module, name: skill.name, projectId, enabled });
      load();
    } catch (err) {
      reportFailure(`Skill「${skill.name}」を切り替えられませんでした`, err);
    } finally {
      setSaving(null);
    }
  }

  if (listing === null) return <p className="text-xs text-ink-3">読み込み中…</p>;
  const enabledCount = listing.skills.filter((s) => s.enabled).length;

  return (
    <div data-testid="skills-panel">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">
        {projectId ? "この Project の Skill" : "Skill"}
      </h1>
      <p className="mb-1 text-xs text-ink-3">
        効かせた Skill は、名前と説明が会話の始まりに AI へ渡り、その会話のあいだ毎ターンの文脈を使います。
        効かせていない Skill も、AI が探せば読めます。
      </p>
      <p className="mb-4 text-xs text-ink-3">
        <strong className="text-ink-2">変えると、新しい会話から効きます</strong>
        （続いている会話は、始まったときのまま。Clear すると新しい会話になります）。
      </p>

      {loadError ? (
        <div
          data-testid="skills-error"
          className="mb-3 flex flex-col items-start gap-2 rounded-md border border-border p-3"
        >
          <p className="text-sm text-foreground">Skill の一覧を取得できませんでした</p>
          <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={load}>
            再読み込み
          </Button>
        </div>
      ) : null}

      {listing.skills.length > 0 ? (
        <>
          <p data-testid="skills-enabled-count" className="mb-2 text-xs text-ink-2">
            {projectId ? "この Project で効くもの" : "既定で効かせるもの"}：{enabledCount} / {listing.skills.length}
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-3">
                  <th className="px-3 py-2 font-medium whitespace-nowrap">Skill</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">配っている Module</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    {projectId ? "この Project では" : "既定で効かせる"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {listing.skills.map((skill) => {
                  const key = `${skill.module}/${skill.name}`;
                  return (
                    <tr
                      key={key}
                      data-testid="skill-row"
                      data-skill={key}
                      data-state={skill.enabled ? "on" : "off"}
                      className={cn("align-top", !skill.enabled && "text-ink-3")}
                    >
                      <td className="px-3 py-2">
                        <p className={cn("font-medium", skill.enabled ? "text-foreground" : "text-ink-3")}>
                          {skill.name}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-3">{skill.description}</p>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-3">{skill.module}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end">
                          {projectId ? (
                            <Select
                              value={projectChoiceOf(skill)}
                              disabled={saving === key}
                              onValueChange={(v) =>
                                void change(skill, v === "inherit" ? null : v === "on")
                              }
                            >
                              <SelectTrigger
                                aria-label={`${skill.name} をこの Project で効かせるか`}
                                className="h-7 w-52 text-xs"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">
                                  全体の既定に従う（{skill.instance ? "効かせる" : "効かせない"}）
                                </SelectItem>
                                <SelectItem value="on">この Project で効かせる</SelectItem>
                                <SelectItem value="off">この Project では外す</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Switch
                              checked={skill.enabled}
                              disabled={saving === key}
                              aria-label={skill.enabled ? `${skill.name} を外す` : `${skill.name} を効かせる`}
                              onCheckedChange={(on) => void change(skill, on)}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : !loadError ? (
        <p
          data-testid="skills-empty"
          className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3"
        >
          配られている Skill はありません
        </p>
      ) : null}

      {/* **読めなかったものも出す**——黙って一覧から消さない（規則2） */}
      {listing.problems.length > 0 ? (
        <div data-testid="skills-problems" className="mt-4 rounded-md border border-border p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <TriangleAlert className="size-3.5 shrink-0 text-danger" />
            効かせられない Skill
          </p>
          <ul className="flex flex-col gap-1 text-xs text-ink-3">
            {listing.problems.map((p, i) => (
              <li key={`${p.module}:${i}`}>
                <span className="text-ink-2">{p.module}</span>：{p.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
