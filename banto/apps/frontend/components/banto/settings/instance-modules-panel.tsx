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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { notifyModuleSetChanged } from "./module-settings-panel";

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

/**
 * **並べる順は役割で**（改訂・2026-09-18）。テーブル1枚にしたので、役割の箱は
 * 無くなったが、**同じ役割の実装が隣り合う**という読みは残す
 * （同じ役割を複数の実装が名乗ってよい——`v4-frontend.md` §6.1）。
 */
function sortedForTable(modules: readonly RealInstanceModule[]): RealInstanceModule[] {
  const roleOf = (m: RealInstanceModule) => m.satisfies[0] ?? "\uffff"; // 役割なしは最後
  return [...modules].sort(
    (a, b) => roleOf(a).localeCompare(roleOf(b)) || a.name.localeCompare(b.name),
  );
}

/**
 * **ログインが要るだけなのか、本当に壊れているのか**（追加・2026-09-18）。
 *
 * 一緒くたに「繋がりません」と出すと、**押すべきボタンがあることに気付けない**
 * ——host は、そうと分かる形で理由を返している（規則2）。
 */
function needsLogin(m: RealInstanceModule): boolean {
  return !!m.error && m.error.includes("ログインが要ります");
}

/**
 * **状態の語は、運用でふつうに使うものにする**（改訂・2026-09-19、ユーザー指摘
 * 「使うとき が謎すぎる」）。
 *
 * 前は自分で考えた日本語（「使うとき」「止めてある」）を並べていて、
 * **初見で何を指すのか分からなかった**（規則11——独自の呼び名を作らない）。
 * プロセスの生き死にを言うだけなので、systemd や docker と同じ語でよい。
 *
 * **「止めた」と「立っていない」を混ぜない**（規則2）——混ぜると、直すべきか
 * どうかが分からなくなる。だから `Stopped`（人が止めた）と `Not running`
 * （動かす設定だが立っていない）は別の語にしてある。
 *
 * 語だけでは足りないので、**意味は hint に持たせて hover で出す**。
 */
function stateOf(m: RealInstanceModule): { label: string; hint: string; tone: "ok" | "warn" | "off" } {
  if (!m.enabled) return { label: "Stopped", hint: "止めてあります（人が止めた）", tone: "off" };
  if (needsLogin(m)) {
    return { label: "Auth required", hint: "相手へのログインが要ります", tone: "warn" };
  }
  if (m.error) return { label: "Failed", hint: "繋がりませんでした", tone: "warn" };
  if (m.connected) return { label: "Running", hint: "立っていて、いま呼べます", tone: "ok" };
  if (m.scope === "project") {
    // Project ごとに立つものは、使う Project が開かれるまで立たない
    return {
      label: "On demand",
      hint: "Project ごとに立ちます——その Project が使われたときに立ち上がります",
      tone: "off",
    };
  }
  return { label: "Not running", hint: "動かす設定ですが、まだ立っていません", tone: "off" };
}

export function InstanceModulesPanel() {
  const [modules, setModules] = useState<RealInstanceModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RealInstanceModule | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // **手元の下書き**——保存するまで、動かす／止めるはここにだけある
  // （改訂・2026-09-19、ユーザー要望。Project の面と同じ進め方に揃えた）
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await listRealInstanceModules();
      setModules(list);
      setDraft(new Set(list.filter((m) => m.enabled).map((m) => m.name)));
      setError(null);
      // **増えた／減った Module の設定画面も、左の一覧に追わせる**（規則13）
      notifyModuleSetChanged();
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

  const savedEnabled = useMemo(
    () => new Set((modules ?? []).filter((m) => m.enabled).map((m) => m.name)),
    [modules],
  );
  const turningOn = (modules ?? []).filter((m) => draft?.has(m.name) && !savedEnabled.has(m.name));
  const turningOff = (modules ?? []).filter((m) => !draft?.has(m.name) && savedEnabled.has(m.name));
  const dirty = turningOn.length + turningOff.length > 0;

  /**
   * 無効にすると使えなくなる Module（**下書きの上で**見る）。
   *
   * **見るのは名前ではなく役割**（修正・2026-09-19、ユーザー報告）。
   * 以前は host が返す `breaksIfDisabled`（「私が名乗る役割に依存している
   * Module」の一覧）をそのまま出していたので、**同じ役割の実装がまだ他に
   * 残っていても警告していた**——`vault` は3本あるのに `vault-local` を
   * 無効にしただけで「shell が使えなくなります」と出ていた（誤報）。
   *
   * 正しくは「**その役割を供給する Module が、下書きの上で1本も無くなるか**」。
   * Project 側の面は最初からこう見ているので、両方の見方が揃う（規則3）。
   */
  function breaksInDraft(m: RealInstanceModule): string[] {
    // これを無効にすると、供給が絶える役割
    const lost = m.satisfies.filter(
      (role) =>
        !(modules ?? []).some(
          (x) => x.name !== m.name && draft?.has(x.name) && x.satisfies.includes(role),
        ),
    );
    if (lost.length === 0) return [];
    return (modules ?? [])
      .filter((x) => x.name !== m.name && draft?.has(x.name))
      .filter((x) => x.dependsOn.some((d) => d.required && lost.includes(d.role)))
      .map((x) => x.name);
  }
  /** 保存したら動かなくなるもの（要るものを止めようとしている） */
  const breaking = turningOff.filter((m) => breaksInDraft(m).length > 0);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      // **1本ずつ届ける**（口が1本ずつなので）。途中で落ちたら、そこで止めて理由を出す
      for (const m of turningOn) await setRealInstanceModuleEnabled(m.name, true);
      for (const m of turningOff) await setRealInstanceModuleEnabled(m.name, false);
      setConfirming(false);
      await reload();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (error && modules === null) {
    return (
      <div className="rounded-lg border border-danger/40 p-3 text-sm text-danger" data-testid="instance-modules-error">
        Module の一覧を取得できませんでした：{error}
      </div>
    );
  }
  if (modules === null) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-ink-3">
        <Loader2 className="size-4 animate-spin" /> 読み込み中…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="instance-modules">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-3">
          ここで有効にした Module を、<strong>Project ごとに選んで</strong>使います
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

      {/* **1枚のテーブルにまとめる**（改訂・2026-09-18、ユーザー指摘「冗長」）。
          以前は役割ごとの箱＋1行あたり4〜5個の札で、同じ語が何度も出ていた。
          **並べて比べるものは、並べて比べられる形にする**——列の見出しが1回
          出れば、各行は値だけで済む。

          役割は列に落とす（同じ役割を複数の実装が名乗ってよい、という読みは
          並び順で残す）。**危ないほうは列の中で色で立てる**（外へ出る・閉じ込め
          なし）——札を増やさずに、目が止まる */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-ink-3">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Module</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">役割</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">実行場所</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">サンドボックス</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">状態</th>
              <th className="px-3 py-2 font-medium sr-only">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedForTable(modules).map((m) => {
              const on = draft?.has(m.name) ?? m.enabled;
              const turningOnHere = on && !savedEnabled.has(m.name);
              const turningOffHere = !on && savedEnabled.has(m.name);
              const state = stateOf(m);
              const host = remoteHostOf(m);
              const willBreak = turningOffHere ? breaksInDraft(m) : [];
              return (
                <tr
                  key={m.name}
                  data-testid="module-row"
                  data-module={m.name}
                  data-state={
                    turningOnHere ? "enabling" : turningOffHere ? "disabling" : on ? "on" : "off"
                  }
                  className={
                    "align-middle" +
                    (turningOnHere ? " bg-accent-soft/40" : "") +
                    (turningOffHere ? " bg-turn-soft/40" : "")
                  }
                >
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{m.name}</span>
                    {/* **「自分で足したもの」は `removable` で見る**（改訂・2026-09-19）。
                        `origin` は「走るコードが banto のものか」を言う値で、
                        **同梱と同じコードを別名でもう1本立てた場合も bundled**
                        になる（Infisical の2本目など）。人が知りたいのは
                        「これは自分が足した行か＝消せる行か」のほう */}
                    {m.removable ? (
                      <span className="ml-1.5 whitespace-nowrap text-xs text-ink-3">ユーザー追加</span>
                    ) : null}
                    {/* **未保存の変更は、その行で分かる**（帯の件数と対になる） */}
                    {turningOnHere ? (
                      <span className="ml-1.5 text-xs text-accent-ink">有効にする（未保存）</span>
                    ) : null}
                    {turningOffHere ? (
                      <span className="ml-1.5 text-xs text-foreground">無効にする（未保存）</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-3">{m.satisfies.join("・") || "—"}</td>
                  {/* **列名が言っていることを、値で繰り返さない**（改訂・2026-09-18、
                      ユーザー指摘「値が無駄に冗長」）。見出しが「どこで動くか」なら、
                      値は場所だけでよい——「この banto（1本）」ではなく「banto」 */}
                  <td className="px-3 py-2">
                    {host ? (
                      // **外へ出るものだけ色が変わる**（判断材料はここ）
                      <span className="text-danger">{host}</span>
                    ) : m.scope === "instance" ? (
                      <span className="text-ink-3">Global</span>
                    ) : (
                      <span className="text-ink-3">Project ごと</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {host ? (
                      <span className="text-danger">なし</span>
                    ) : m.confinement ? (
                      <span className="text-ink-3">
                        {m.confinement.root === "project" ? "Project" : "Global"}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td
                    className={
                      state.tone === "warn" || willBreak.length > 0
                        ? "px-3 py-2 text-danger"
                        : "px-3 py-2 text-ink-3"
                    }
                    data-testid={`module-state-${m.name}`}
                    title={m.error ?? state.hint}
                  >
                    {willBreak.length > 0 ? (
                      // **止める前に、何が断るようになるかを出す**（§6.1・規則2）
                      // ——以前は押した瞬間のダイアログで出していた。まとめて保存に
                      // 変えたので、**押した先ではなく行の中**で出す
                      <span className="flex items-center gap-1">
                        <TriangleAlert className="size-3.5 shrink-0" />
                        {willBreak.join("・")} が使えなくなります
                      </span>
                    ) : (
                      state.label
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {/* **ログインだけは行に出す**（改訂・2026-09-20）
                          ——押すべきものが隠れていると、繋がらない理由に気付けない */}
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
                          ログイン
                        </Button>
                      ) : null}
                      {/* **押すたびに確認を出さない**（改訂・2026-09-19）
                          ——確認は保存のときに1回、何がどう変わるかを差分で見せる
                          （Project の面と同じ進め方・`v4-frontend.md` §6.15） */}
                      <Switch
                        checked={on}
                        disabled={busy || saving}
                        aria-label={on ? `${m.name} を無効にする` : `${m.name} を有効にする`}
                        onCheckedChange={(next) =>
                          setDraft((prev) => {
                            const set = new Set(prev ?? []);
                            if (next) set.add(m.name);
                            else set.delete(m.name);
                            return set;
                          })
                        }
                      />
                      {/* **その行への操作は1箇所にまとめる**（決定・2026-09-20、
                          ユーザー要望）。行ごとにボタンが増えると表が散らかるし、
                          「この行に何ができるか」が場所によって変わってしまう
                          ——サイドバーの「…」と同じ形（規則3・規則10） */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            disabled={busy || saving}
                            aria-label={`${m.name} の操作`}
                            data-testid={`module-menu-${m.name}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {needsLogin(m) ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                void run(async () => {
                                  const { url } = await startRealModuleOAuth(m.name);
                                  window.open(url, "_blank", "noopener,noreferrer");
                                })
                              }
                            >
                              <KeyRound className="size-3.5" /> ログイン
                            </DropdownMenuItem>
                          ) : null}
                          {/* **既定には消すものが無い**（無効にはできる） */}
                          {m.removable ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setRemoveTarget(m)}
                              >
                                <Trash2 className="size-3.5" /> 削除
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* **繋がらなかった理由は、行に詰め込まない**（1行1件に保つ）。
          出るのは困っているものだけなので、たいてい空 */}
      {modules.filter((m) => m.error).length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-ink-3">
          {modules
            .filter((m) => m.error)
            .map((m) => (
              <p key={m.name}>
                <strong className="text-foreground">{m.name}</strong>：{m.error}
              </p>
            ))}
        </div>
      ) : null}

      {/* **変えている間だけ出る帯**——何件変えたかと、保存／捨てる
          （Project の面と同じ部品・改訂 2026-09-19） */}
      {dirty ? (
        <div
          data-testid="module-draft-bar"
          className="sticky bottom-0 -mx-1 flex items-center justify-between gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
        >
          <p className="text-xs text-ink-2">
            未保存の変更 {turningOn.length + turningOff.length} 件
            {turningOn.length > 0 ? `（有効 ${turningOn.length}）` : ""}
            {turningOff.length > 0 ? `（無効 ${turningOff.length}）` : ""}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setDraft(new Set(savedEnabled))}
            >
              <RotateCcw className="size-3.5" /> 取り消す
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={() => setConfirming(true)}>
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {/* 保存——**変わるものを差分で**見せてから確定する */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="module-save-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Module の設定を保存しますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm text-ink-2">
                <ul className="flex flex-col gap-1.5">
                  {turningOn.map((m) => (
                    <li key={m.name} className="flex items-start gap-2">
                      <Plus className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
                      <span>
                        <span className="text-foreground">{m.name}</span> を有効にする
                      </span>
                    </li>
                  ))}
                  {turningOff.map((m) => (
                    <li key={m.name} className="flex items-start gap-2">
                      <Minus className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                      <span>
                        <span className="text-foreground">{m.name}</span> を無効にする
                        <span className="block text-xs text-ink-3">
                          {breaksInDraft(m).length > 0
                            ? `${breaksInDraft(m).join("・")} が使えなくなります`
                            : "依存している Module はありません"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {breaking.length > 0 ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      依存している Module は黙って壊れず、呼び出されたときにエラーを返します
                      （{breaking.map((b) => b.name).join("・")}）。
                    </span>
                  </p>
                ) : null}
                <p className="text-xs text-ink-3">変更は次の会話のターンから反映されます。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {saving ? "保存中…" : "保存"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* **消してもデータは消さない**——そう言ってから消す */}
      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removeTarget?.name} を削除しますか</AlertDialogTitle>
            <AlertDialogDescription>
              接続設定を削除します。<strong>Module のデータと、Vault に保存した認証情報は削除されません</strong>
              ——必要なら個別に削除してください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (target) void run(() => removeRealInstanceModule(target.name));
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddInstanceModuleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingNames={modules.map((m) => m.name)}
        onInstalled={reload}
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
