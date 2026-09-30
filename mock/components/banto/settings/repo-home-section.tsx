"use client";

// Repo の設定の中の「既定の置き場」（2026-09-30、ユーザー決定）——clone・新しく作る
// リポジトリをどこに置くか。1か所だけで、既定は `~/banto`。その下に `<名前>` で置く。
// 変えても、今あるフォルダは動かさない（台帳はパスで覚えているので、一覧はそのまま）。
// 値は「変える」を押したときに入れる——打っている途中の値で、新しい Project の画面の
// Root パスが揺れないように。
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PathPicker } from "@/components/banto/project/path-picker";
import { DEFAULT_REPO_HOME, folderExists, normalizeFolderPath, setRepoHome, useRepoHome } from "@/lib/mock/github";

export function RepoHomeSection() {
  const home = useRepoHome();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? home;
  const next = normalizeFolderPath(value);
  const changed = draft !== null && next !== home;
  const wide = ["~", "/"].includes(next);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!changed || wide) return;
    setRepoHome(next);
    setDraft(null);
  }

  return (
    <form
      id="anchor-repo-home"
      onSubmit={submit}
      data-testid="repo-home-section"
      className="mt-3 flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
    >
      <Label htmlFor="repo-home" className="text-xs">
        既定の置き場
      </Label>
      <PathPicker
        id="repo-home"
        value={value}
        onChange={setDraft}
        pickerDescription="clone・新しく作るリポジトリを、このフォルダの下に置きます。"
      />
      <p className="text-xs text-ink-3">
        clone・新しく作るリポジトリを、この下に <span className="font-mono">{next}/&lt;名前&gt;</span> で置きます。
        変えても、今あるフォルダは動かしません。
        {!folderExists(next) && !wide ? " まだ無いフォルダなら、最初に使うときに作ります。" : null}
      </p>
      {wide ? (
        <p className="text-xs text-turn">ホームや / をそのまま置き場にはできません。その下のフォルダを選んでください。</p>
      ) : null}
      {changed || home !== DEFAULT_REPO_HOME ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {changed ? (
            <>
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={wide} data-testid="repo-home-save">
                変える
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>
                やめる
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setRepoHome(DEFAULT_REPO_HOME)}
            >
              既定（{DEFAULT_REPO_HOME}）に戻す
            </Button>
          )}
        </div>
      ) : null}
    </form>
  );
}
