"use client";

// **Shell 専用のホームに写すもの**（決定・2026-09-23、ユーザー）。
//
// banto の Shell は閉じ込めの中で走り、人のホームは読めない。Project ごとに書けるホームを
// 用意し、ここで選んだ設定ファイルだけを写す（Dev Containers と同じ形）。
// **資格情報は写さない**——git の取り出し役（credential helper）と include は外して写し、
// 資格情報の置き場（`.ssh`・`.config/gh` など）はここに足せない。資格情報は Vault から渡す。
//
// 押したらその場で保存し、立っている Shell にも写し直す（コマンドは毎回新しく起こすので、
// 次のコマンドから効く）。
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isImeComposing } from "@/lib/ime";
import { describeFailure } from "@/lib/report-failure";
import { getRealShellHome, setRealShellHomeFiles, type RealShellHome } from "@/lib/backend/client";

export function ShellHomePanel() {
  const [state, setState] = useState<RealShellHome | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getRealShellHome()
      .then((next) => {
        setLoadError(null);
        setState(next);
      })
      .catch((err: unknown) => setLoadError(describeFailure(err)));
  }, []);
  useEffect(load, [load]);

  async function save(files: string[]) {
    setBusy(true);
    setSaveError(null);
    try {
      const next = await setRealShellHomeFiles(files);
      setState((prev) => ({ ...next, defaults: prev?.defaults }));
      setDraft("");
    } catch (err) {
      // **断られた理由をその場に出す**（資格情報の置き場を足そうとした、など）
      setSaveError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div data-testid="shell-home-error" className="flex flex-col items-start gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-foreground">Shell のホームの設定を取得できませんでした</p>
        <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={load}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (!state) return <p className="text-xs text-ink-3">読み込み中…</p>;
  const sync = state.lastSync;

  return (
    <div data-testid="shell-home-panel">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">Shell のホーム</h1>
      <p className="mb-1 text-xs text-ink-3">
        AI が動かすコマンド（Shell）は Project ごとのコンテナの中で走り、あなたのホームは見えません。代わりに Project ごとの
        ホームを用意し、ここで選んだ設定ファイルだけを写します。
      </p>
      <p className="mb-4 text-xs text-ink-3">
        <strong className="text-ink-2">資格情報は写しません。</strong>git の資格情報の取り出し役（credential
        helper）と include は外して写します。SSH の鍵やトークンは Vault から渡します。
      </p>

      <ul data-testid="shell-home-files" className="mb-3 divide-y divide-border rounded-lg border border-border">
        {state.files.length === 0 ? (
          <li className="px-3 py-2 text-xs text-ink-3">何も写していません</li>
        ) : (
          state.files.map((f) => (
            <li key={f} data-file={f} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <code className="text-foreground">~/{f}</code>
              <span className="flex items-center gap-2">
                {sync?.missing.includes(f) ? <span className="text-xs text-ink-3">ホームに無い</span> : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  aria-label={`~/${f} を写すのをやめる`}
                  disabled={busy}
                  onClick={() => void save(state.files.filter((x) => x !== f))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            </li>
          ))
        )}
      </ul>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder="足す（例：.config/starship.toml）"
          className="h-8 text-sm"
          aria-label="写すものを足す"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeComposing(e) && draft.trim()) void save([...state.files, draft.trim()]);
          }}
        />
        <Button
          size="sm"
          className="h-8"
          disabled={busy || !draft.trim()}
          onClick={() => void save([...state.files, draft.trim()])}
        >
          足す
        </Button>
      </div>
      {saveError ? (
        <p data-testid="shell-home-save-error" className="mt-2 text-xs text-danger">
          {saveError}
        </p>
      ) : null}

      {/* **写したときに外したもの**——黙って外さない（規則2） */}
      {sync && (sync.removedGitKeys.length > 0 || sync.rewrittenGitKeys.length > 0) ? (
        <div data-testid="shell-home-sanitized" className="mt-4 rounded-md border border-border p-3 text-xs text-ink-3">
          {sync.removedGitKeys.length > 0 ? (
            <p>
              git の設定から外したもの：<span className="text-ink-2">{sync.removedGitKeys.join("、")}</span>
            </p>
          ) : null}
          {sync.rewrittenGitKeys.length > 0 ? (
            <p>
              あなたのホームを指していたので、Shell のホームへ向け直したもの：
              <span className="text-ink-2">{sync.rewrittenGitKeys.join("、")}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {!sync ? (
        <p className="mt-4 text-xs text-ink-3">まだどの Project の Shell も立っていません（最初のコマンドのときに写します）。</p>
      ) : null}
    </div>
  );
}
