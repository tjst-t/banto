"use client";

// **banto 全体の Module**（追加・2026-09-15、§10 item 14 (a) の決着）。
//
// `v4-frontend.md` §6.1 の決定どおり **役割（role）でまとめる**——同じ役割の
// 複数実装が辞書として共存してよいので、Module のフラットな一覧にしない。
//
// **モックの `role-list.tsx` とは別の部品**にした（規則13）。あちらは
// `lib/mock/settings.ts` の固定データに深く結び付いていて、半分だけ実データに
// 繋ぎ替えると「どこが本物か」が画面から読めなくなる。
//
// ここに出るのは **banto 全体の層**（止める・足す・消す）。
// 「この Project の AI に見せるか」は Project の設定にある別の面。

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  addRealInstanceModule,
  addRealInstanceModulesFromMcpServers,
  listRealInstanceModules,
  removeRealInstanceModule,
  setRealInstanceModuleEnabled,
  startRealModuleOAuth,
  type RealInstanceModule,
} from "@/lib/backend/client";
import { AddInstanceModuleDialog } from "./add-instance-module-dialog";

/** **URL に繋ぐ形なら相手の host**（追加・2026-09-17）。起動する形なら空。 */
function remoteHostOf(m: RealInstanceModule): string {
  const launch = m.launch as { type?: string; url?: string };
  if (launch.type !== "http" || !launch.url) return "";
  try {
    return new URL(launch.url).host;
  } catch {
    return launch.url;
  }
}

/** 役割ごとにまとめる。役割を名乗らない Module は「役割なし」に落とす。 */
function byRole(modules: readonly RealInstanceModule[]): Array<{ role: string; members: RealInstanceModule[] }> {
  const groups = new Map<string, RealInstanceModule[]>();
  for (const m of modules) {
    const roles = m.satisfies.length > 0 ? m.satisfies : ["（役割を名乗っていない）"];
    for (const role of roles) groups.set(role, [...(groups.get(role) ?? []), m]);
  }
  return [...groups.entries()].map(([role, members]) => ({ role, members }));
}

/**
 * **人に見せる状態は3つ**（決定・2026-09-15）。
 * 「立っていない」と「止めてある」を混ぜない——混ぜると、直すべきかどうかが
 * 分からなくなる（規則2）。
 */
/**
 * **ログインが要るだけなのか、本当に壊れているのか**（追加・2026-09-18）。
 *
 * 一緒くたに「繋がりません」と出すと、**押すべきボタンがあることに気付けない**
 * ——host は、そうと分かる形で理由を返している（規則2）。
 */
function needsLogin(m: RealInstanceModule): boolean {
  return !!m.error && m.error.includes("ログインが要ります");
}

function stateOf(m: RealInstanceModule): { label: string; tone: "ok" | "warn" | "off" } {
  if (!m.enabled) return { label: "止めてあります", tone: "off" };
  if (needsLogin(m)) return { label: "ログインが要ります", tone: "warn" };
  if (m.error) return { label: "繋がりません", tone: "warn" };
  if (m.connected) return { label: "動いています", tone: "ok" };
  // Project ごとに立つものは、使う Project が開かれるまで立たない
  return { label: m.scope === "project" ? "使うときに立ちます" : "まだ立っていません", tone: "off" };
}

export function InstanceModulesPanel() {
  const [modules, setModules] = useState<RealInstanceModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disableTarget, setDisableTarget] = useState<RealInstanceModule | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RealInstanceModule | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setModules(await listRealInstanceModules());
      setError(null);
    } catch (err) {
      // **読めなかったことを、空の一覧として見せない**（規則2・規則13）
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && modules === null) {
    return (
      <div className="rounded-lg border border-danger/40 p-3 text-sm text-danger" data-testid="instance-modules-error">
        Module の一覧を読めませんでした：{error}
      </div>
    );
  }
  if (modules === null) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-ink-3">
        <Loader2 className="size-4 animate-spin" /> 読み込んでいます…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="instance-modules">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-3">
          banto 全体で動かす Module。<strong>この Project の AI に見せるか</strong>は Project の設定で選びます
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Module を追加
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/40 p-2 text-xs text-danger" data-testid="instance-modules-error">
          {error}
        </div>
      ) : null}

      {byRole(modules).map(({ role, members }) => (
        <div key={role} className="rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-foreground">{role}</span>
            <Badge variant="outline" className="text-xs">
              {members.length} 実装
            </Badge>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {members.map((m) => {
              const state = stateOf(m);
              return (
                <div key={m.name} className="flex items-center gap-3 px-3 py-2" data-module={m.name}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{m.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {m.origin === "bundled" ? "同梱" : "外から"}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {m.scope === "instance" ? "全体で1本" : "Project ごと"}
                      </Badge>
                      {/* **外へ出るものは、一覧で分かる**（追加・2026-09-17）
                          ——相手の名前まで出す。閉じ込めは効かないので、
                          代わりに「どこへ出るか」が人の判断材料になる */}
                      {remoteHostOf(m) ? (
                        <Badge variant="outline" className="border-danger/50 text-xs text-danger">
                          外へ送ります：{remoteHostOf(m)}
                        </Badge>
                      ) : null}
                      {m.confinement ? (
                        <Badge variant="outline" className="text-xs">
                          閉じ込め：{m.confinement.root === "project" ? "Project の根" : "根なし"}
                        </Badge>
                      ) : null}
                    </div>
                    <p
                      className={
                        state.tone === "warn" ? "mt-0.5 text-xs text-danger" : "mt-0.5 text-xs text-ink-3"
                      }
                      data-testid={`module-state-${m.name}`}
                    >
                      {state.label}
                      {m.error ? `：${m.error}` : ""}
                    </p>
                  </div>
                  {/* **ログインは、押せる場所をその行に置く**（追加・2026-09-18）
                      ——banto はサーバなので自分でブラウザを開けない。
                      押したら新しいタブが開き、戻ってくると繋がる */}
                  {needsLogin(m) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid={`module-login-${m.name}`}
                      onClick={() =>
                        void run(async () => {
                          const { url } = await startRealModuleOAuth(m.name);
                          window.open(url, "_blank", "noopener,noreferrer");
                        })
                      }
                    >
                      ログインする
                    </Button>
                  ) : null}
                  {/* **同梱は消せない**（止めることはできる） */}
                  {m.origin === "external" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRemoveTarget(m)}
                      aria-label={`${m.name} を消す`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                  <Switch
                    checked={m.enabled}
                    disabled={busy}
                    aria-label={m.enabled ? `${m.name} を止める` : `${m.name} を動かす`}
                    onCheckedChange={(next) => {
                      // **止めるときは、押す前に何が断るかを見せる**（§6.1）。
                      // 動かすほうは壊すものが無いので、そのまま
                      if (!next) setDisableTarget(m);
                      else void run(() => setRealInstanceModuleEnabled(m.name, true));
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* **押す前に、何が壊れるかを出す**（§6.1・規則2） */}
      <AlertDialog open={disableTarget !== null} onOpenChange={(o) => !o && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{disableTarget?.name} を止めますか</AlertDialogTitle>
            <AlertDialogDescription>
              {disableTarget && disableTarget.breaksIfDisabled.length > 0 ? (
                <>
                  <strong>{disableTarget.breaksIfDisabled.join("・")}</strong> がこれに依存しています。
                  止めると、その Module は次に呼ばれたときはっきり断ります（黙って壊れはしません）。
                </>
              ) : (
                "これに依存している Module はありません。"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = disableTarget;
                setDisableTarget(null);
                if (target) void run(() => setRealInstanceModuleEnabled(target.name, false));
              }}
            >
              止める
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* **消してもデータは消さない**——そう言ってから消す */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removeTarget?.name} を消しますか</AlertDialogTitle>
            <AlertDialogDescription>
              繋ぎ方の設定を消します。<strong>その Module のデータと、金庫に預けた秘密は消しません</strong>
              ——必要なら別に消してください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) void run(() => removeRealInstanceModule(target.name));
              }}
            >
              消す
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddInstanceModuleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmit={async (declaration, acknowledgeEgress) => {
          await addRealInstanceModule(declaration, acknowledgeEgress);
          await reload();
        }}
        onPaste={async (json, acknowledgeEgress) => {
          const added = await addRealInstanceModulesFromMcpServers(json, acknowledgeEgress);
          await reload();
          return added;
        }}
      />
    </div>
  );
}
