"use client";

// Module 自身の設定画面（MCP Apps の設定 Canvas、§6.2、決定・2026-09-07）。
//
// **iOS でアプリの設定が OS の設定アプリに出てくるのと同じ形。**
// banto は値を持たない——読み書きはその Module 自身の tool で、
// banto がやるのは「どこに出すか」を決めることだけ。
//
// **在るかもしれない、を試さない**（規則2）。Module が
// `dev.banto/canvas: "config"` と名乗った資源だけを出す。
// 1つも無ければ、その旨をはっきり出す——空の枠を残さない（規則13）。

import { useEffect, useState, useSyncExternalStore } from "react";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { listRealUiSettings, type RealCanvasOwner } from "@/lib/backend/client";

export type SettingsCanvas = { server: string; resourceUri: string; name?: string };

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; canvases: SettingsCanvas[] };

/**
 * その相手の Module が名乗っている設定 Canvas の一覧を取る。
 * **左メニューに並べるのにも、右側を描くのにも同じものを使う**（規則3）。
 */
/**
 * **Module が増えたり減ったりしたら、設定画面の一覧も追う**（追加・2026-09-20）。
 *
 * 実際に踏んだ：目録から1本入れても、**左の一覧にその Module の設定画面が出ない**
 * ——開き直すまで気付けない。入れた目的は「そこに接続先を入れる」ことなので、
 * 出ていないと次の一歩が踏めない（規則13——見えているものは繋がっている、の裏返し）。
 *
 * 一覧を持っているのは設定画面の枠、入れるのは Module の表——別の部品なので、
 * **変わったことだけを知らせる**細い口を1つ置く。
 */
const listeners = new Set<() => void>();
/** Module の増減が何回あったか。走っている取得がそれより前に出たものかを見分けるのに使う */
let moduleSetChanges = 0;
export function notifyModuleSetChanged(): void {
  moduleSetChanges++;
  for (const listener of listeners) listener();
}

/**
 * **一覧の控えは部品の外に1つ**（改訂・2026-09-26、実測）。
 *
 * 以前は呼んだ部品ごとに取りに行っていたので、設定画面を開くと同じ一覧を
 * **2回ずつ**取っていた（左メニューと中身が別々に呼ぶ）。host 側で一覧1回が
 * 1.4 秒かかっていた頃は、2回目が1回目の後ろに詰まって 3.5 秒になった。
 *
 * - 同時に欲しがったら**1本の要求を分け合う**
 * - 前に取ったものがあれば**すぐ出し、裏で取り直す**（stale-while-revalidate）
 *   ——開くたびに空の左メニューから始まらない。Module の増減は取り直しで追う
 *
 * 取れなかったときは今までどおり「無い」と混同しない（規則2）——控えは捨てて理由を出す。
 */
type CanvasList = { canvases: SettingsCanvas[]; error: string | null };
const EMPTY_LIST: CanvasList = { canvases: [], error: null };
const canvasLists = new Map<string, CanvasList>();
const canvasFetches = new Map<string, Promise<void>>();
const storeListeners = new Set<() => void>();
let storeVersion = 0;

/**
 * **増減より前に出た取得に相乗りしない**（修正・2026-10-03、E2E で実測）。
 * 同時に欲しがったら1本を分け合う、だけだと、**Module を足す前に出た取得**に足した後の頼みが相乗りし、
 * 足した Module の無い一覧で止まっていた（その後は誰も取り直さない）。host の一覧が遅いとき
 * （起動に手間取る Module があると 10 秒を超えた）に、足した Module の設定画面が左に出なかった。
 * 走っている取得が最後の増減より前に出たものなら、終わったあとにもう1回だけ取る
 * （同じときに開いた左メニューと中身は、今までどおり1本を分け合う）
 */
const canvasFetchStartedAt = new Map<string, number>();
const refetchAfter = new Set<string>();

function refreshCanvasList(owner: RealCanvasOwner, key: string): Promise<void> {
  const inFlight = canvasFetches.get(key);
  if (inFlight) {
    if ((canvasFetchStartedAt.get(key) ?? 0) < moduleSetChanges) refetchAfter.add(key);
    return inFlight;
  }
  canvasFetchStartedAt.set(key, moduleSetChanges);
  const pending: Promise<void> = listRealUiSettings(owner)
    .then(
      (canvases) => {
        canvasLists.set(key, { canvases, error: null });
      },
      (err: unknown) => {
        canvasLists.set(key, { canvases: [], error: err instanceof Error ? err.message : String(err) });
      },
    )
    .finally(() => {
      canvasFetches.delete(key);
      storeVersion++;
      for (const listener of storeListeners) listener();
      if (refetchAfter.delete(key)) void refreshCanvasList(owner, key);
    });
  canvasFetches.set(key, pending);
  return pending;
}

function subscribeCanvasLists(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

export function useModuleSettingsCanvases(owner: RealCanvasOwner): {
  canvases: SettingsCanvas[];
  error: string | null;
} {
  const key = owner.kind === "instance" ? "instance" : owner.id;
  // **相手が決まっていないうちは聞かない**（修正・2026-09-20）。
  // 設定画面は「どの Project の層を出すか」を URL で持つので、Project を選ばずに
  // `/settings` を開くと id が空のまま渡ってくる。以前はそのまま
  // `/api/projects//ui-settings` を叩いて 404 を貰っていた——**通らないと
  // 分かっている要求を出さない**（規則2——本物の失敗と見分けが付かなくなる）。
  const ready = owner.kind === "instance" || owner.id !== "";
  const [version, setVersion] = useState(0);
  useSyncExternalStore(subscribeCanvasLists, () => storeVersion, () => 0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshCanvasList(owner, key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, key, ready, version]);

  return (ready ? canvasLists.get(key) : undefined) ?? EMPTY_LIST;
}

/**
 * **1つの Module の設定を、右側いっぱいに出す**（決定・2026-09-07、ユーザー指摘）。
 * モックが決めた形——左メニューに Module が並び、選んだものを右側で開く。
 * 以前は全部を縦に積んでいて、モックと違っていた。
 */
export function ModuleSettingsPanel({
  owner,
  canvas,
}: {
  /** どちらの設定画面か。instance に1本の Module は全体、Project ごとの
   *  Module は Project——**置き場はその Module の scope が決める**（§6.2）。 */
  owner: RealCanvasOwner;
  canvas: SettingsCanvas;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="module-settings-panel">
      <div className="shrink-0">
        <h1 className="text-lg font-semibold text-foreground">{canvas.name ?? canvas.server}</h1>
        <p className="mt-0.5 mb-4 text-xs text-ink-3">
          {canvas.server} の設定。<strong>値は Module が持つ</strong>
          ——banto は場所を用意するだけで、変更はその Module に届く。
        </p>
      </div>
      <div
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border"
        data-testid="module-settings-canvas"
        data-module={canvas.server}
      >
        {/**
         * **別の Module を選んだら、画面を作り直す**（訂正・2026-09-14、
         * ユーザー報告「先に開いたほうの中身が残る」）。
         *
         * Module の HTML は、**サンドボックスの iframe が立ち上がったと
         * 言ってきたとき（`sandboxready`）にだけ**流し込まれる。React は
         * 位置で照合するので、`server` が変わっても iframe は同じものが残り、
         * **`sandboxready` はもう来ない**——だから中身が前のままだった。
         *
         * 見出しだけ新しい Module の名前になるので、**違う Module の設定を
         * 見ていることに気づけない**（規則13——見えているものは繋がっている）。
         */}
        <ModuleCanvas
          key={`${canvas.server}:${canvas.resourceUri}`}
          owner={owner}
          server={canvas.server}
          resourceUri={canvas.resourceUri}
          displayMode="fullscreen"
        />
      </div>
    </div>
  );
}
