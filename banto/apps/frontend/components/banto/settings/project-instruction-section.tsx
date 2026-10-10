"use client";

// **Project ごとの「AI への指示」**（決定・2026-10-09、ユーザー。v4-frontend.md §6.17・アーキ仕様 §2.3）。
//
// 人が書く1枚の文章。この Project のすべての会話で、system prompt の末尾に入る——保存すると次のターンから効く（既存の
// Thread にも）。banto 全体の決まりは Global Memory に書く（全体用の欄は作らない）。
//
// **書いてから「保存」で保存する**（打つたびには保存しない）。失敗したら入力を残したまま理由を出す（規則2）。空で保存すれば
// 無しに戻る。上限は host だけが持ち、超えたら host が理由つきで断る
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchRealProjectInstruction, setRealProjectInstruction } from "@/lib/backend/client";
import { settingsOpenHref } from "@/lib/settings-link";

type Loaded = { projectId: string } & ({ text: string } | { error: string });

export function ProjectInstructionSection({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSaveError(null);
    setJustSaved(false);
    fetchRealProjectInstruction(projectId)
      .then((text) => {
        if (cancelled) return;
        setLoaded({ projectId, text });
        setDraft(text);
      })
      .catch((err: unknown) => !cancelled && setLoaded({ projectId, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const current = loaded?.projectId === projectId ? loaded : null;
  const saved = current && "text" in current ? current.text : null;
  const loadError = current && "error" in current ? current.error : null;
  const dirty = saved !== null && draft !== saved;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const text = await setRealProjectInstruction(projectId, draft);
      setLoaded({ projectId, text });
      setDraft(text);
      setJustSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="project-instruction-section" className="mt-8">
      <h2 className="mb-0.5 text-sm font-semibold text-foreground">AI への指示</h2>
      <p className="mb-3 text-xs text-ink-3">
        この Project のすべての会話で、AI への土台の指示に入ります。保存すると次のターンから効きます。
        banto 全体の決まり（返事の言語など）は{" "}
        <Link
          href={settingsOpenHref(pathname, searchParams, { section: "global-memory" })}
          data-testid="project-instruction-global-memory"
          className="underline"
        >
          Global Memory
        </Link>{" "}
        に書きます。
      </p>
      {loadError ? (
        <p data-testid="project-instruction-load-error" className="text-xs text-stop">
          設定を読めませんでした：{loadError}
        </p>
      ) : saved === null ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-instruction" className="sr-only">
            AI への指示
          </Label>
          <Textarea
            id="project-instruction"
            data-testid="project-instruction"
            value={draft}
            rows={6}
            placeholder="例：コミットのメッセージは日本語で書く。テストは npm test で回す。"
            className="min-h-32 font-mono text-xs"
            onChange={(e) => {
              setDraft(e.target.value);
              setJustSaved(false);
            }}
          />
          {saveError ? (
            <p data-testid="project-instruction-error" className="text-xs text-stop">
              保存できませんでした：{saveError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            {justSaved && !dirty ? (
              <p data-testid="project-instruction-saved" className="mr-auto text-xs text-ink-3">
                保存しました。次のターンから効きます。
              </p>
            ) : null}
            {dirty ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={saving}
                onClick={() => {
                  setDraft(saved);
                  setSaveError(null);
                }}
              >
                捨てる
              </Button>
            ) : null}
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              data-testid="project-instruction-save"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
