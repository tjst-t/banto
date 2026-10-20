"use client";

// **見回りで使ってよい tool**（決定・2026-10-20、ユーザー。v4-frontend.md §6.47「Project の設定」、アーキ仕様 §4.4「土台：読むだけの印」）。
//
// 読むだけの回（見回り）で使える Module の tool は2通り：
// - 同梱の Module の読むだけの tool——banto が確かめたもの。一覧で見せるだけ（外せない）
// - 入れてある第三者の Module の tool と「資源を読む」——人がチェックで1つずつ許す。Module の名乗り（readOnlyHint・
//   openWorldHint）は判断の材料として薄く出すだけで、**既定でチェックは入れない**（名乗りは根拠にならない）
//
// **押したらすぐ保存する**（他の Project の設定と同じ）。失敗したら言い、表示を元に戻す（規則2）。
import { useEffect, useState } from "react";
import { fetchRealPatrolTools, setRealPatrolTools, type RealPatrolTools } from "@/lib/backend/client";
import { reportFailure } from "@/lib/report-failure";

type Loaded = { projectId: string } & ({ data: RealPatrolTools } | { error: string });

const RESOURCES = "resources";

/** 許す一覧を差し替えた表示（host の答えが来るまでの間に使う） */
function withAllowed(data: RealPatrolTools, allowed: string[]): RealPatrolTools {
  return {
    allowed,
    modules: data.modules.map((m) =>
      "tools" in m
        ? {
            ...m,
            tools: m.tools.map((t) => ({ ...t, allowed: allowed.includes(`${m.name}/${t.name}`) })),
            resourcesAllowed: allowed.includes(`${m.name}/${RESOURCES}`),
          }
        : m,
    ),
  };
}

export function ProjectPatrolToolsSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchRealPatrolTools(projectId)
      .then((data) => !cancelled && setLoaded({ projectId, data }))
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const data = current && "data" in current ? current.data : null;
  const error = current && "error" in current ? current.error : null;

  async function toggle(entry: string, next: boolean) {
    if (!data || saving) return;
    const allowed = next ? [...data.allowed, entry] : data.allowed.filter((e) => e !== entry);
    setSaving(true);
    // 押したらすぐ表示を変える（保存の返事を待つ間もチェックが戻らないように）。失敗したら元に戻す
    setLoaded({ projectId, data: withAllowed(data, allowed) });
    try {
      setLoaded({ projectId, data: await setRealPatrolTools(projectId, allowed) });
    } catch (err) {
      setLoaded({ projectId, data });
      reportFailure("見回りで使ってよい tool を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  const bundled = data?.modules.filter((m): m is Extract<typeof m, { verified: string[] }> => "verified" in m && m.verified.length > 0) ?? [];
  const thirdParty = data?.modules.filter((m): m is Extract<typeof m, { tools: unknown[] }> => "tools" in m) ?? [];
  const failed = data?.modules.filter((m): m is Extract<typeof m, { error: string }> => "error" in m) ?? [];

  return (
    <section data-testid="project-patrol-tools-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">見回りで使ってよい tool</h2>
      {/* 文を JSX の中で折り返さない——改行が空白になり、日本語の途中に隙間が出る */}
      <p className="mb-3 text-xs text-ink-3">
        {"見回りの回は、読むだけの tool しか使えません。banto が確かめた同梱の Module の tool はいつでも使えます。" +
          "入れてある Module の tool は、ここで許したものだけ使えます（Module が「読むだけ」と名乗っていても、許すまでは使いません）。"}
      </p>
      {error ? (
        <p data-testid="project-patrol-tools-error" className="text-xs text-stop">
          一覧を読めませんでした：{error}
        </p>
      ) : !data ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div data-testid="patrol-tools-bundled" className="rounded-md border border-border p-3">
            <p className="mb-1 text-xs font-medium text-foreground">banto が確かめた読むだけの tool</p>
            {bundled.length === 0 ? (
              <p className="text-xs text-ink-3">この Project で動いている同梱の Module に、読むだけの tool はありません。</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-xs text-ink-2">
                {bundled.map((m) => (
                  <li key={m.name} data-testid={`patrol-tools-bundled-${m.name}`}>
                    <span className="font-medium text-foreground">{m.name}</span>：{m.verified.join("・")}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {thirdParty.length === 0 ? (
            <p data-testid="patrol-tools-no-third-party" className="text-xs text-ink-3">
              入れてある Module はありません。
            </p>
          ) : (
            thirdParty.map((m) => (
              <div key={m.name} data-testid={`patrol-tools-module-${m.name}`} className="rounded-md border border-border p-3">
                <p className="mb-1 text-xs font-medium text-foreground">{m.name}</p>
                <ul className="flex flex-col gap-1">
                  {m.tools.map((t) => {
                    const entry = `${m.name}/${t.name}`;
                    const hints = [
                      t.readOnlyHint === true ? "読むだけと名乗っています" : t.readOnlyHint === false ? "書くと名乗っています" : undefined,
                      t.openWorldHint === true ? "外と通信すると名乗っています" : t.openWorldHint === false ? "外と通信しないと名乗っています" : undefined,
                    ].filter((h): h is string => h !== undefined);
                    return (
                      <li key={t.name}>
                        <label className="flex items-start gap-2 text-xs text-foreground">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={t.allowed}
                            disabled={saving}
                            onChange={(e) => void toggle(entry, e.target.checked)}
                            data-testid={`patrol-tool-${m.name}-${t.name}`}
                          />
                          <span className="flex flex-col">
                            <span>{t.name}</span>
                            {t.description ? <span className="text-ink-3">{t.description}</span> : null}
                            {hints.length > 0 ? (
                              <span className="text-ink-3" data-testid={`patrol-tool-hints-${m.name}-${t.name}`}>
                                Module の名乗り：{hints.join("・")}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  <li>
                    <label className="flex items-start gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={m.resourcesAllowed}
                        disabled={saving}
                        onChange={(e) => void toggle(`${m.name}/${RESOURCES}`, e.target.checked)}
                        data-testid={`patrol-tool-${m.name}-${RESOURCES}`}
                      />
                      <span>資源を読む</span>
                    </label>
                  </li>
                </ul>
              </div>
            ))
          )}
          {failed.map((m) => (
            <p key={m.name} data-testid={`patrol-tools-failed-${m.name}`} className="text-xs text-stop">
              {m.name} の tool を読めませんでした：{m.error}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
