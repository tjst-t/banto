/**
 * いま見ている画面の位置（URL）。
 *
 * D3: 状態の真実は一箇所——**「どこを見ているか」の真実は URL に置く**。会話の中身も
 *     キャンバスのタブの集合もホストが持つ真実のままで、ここが持つのは位置だけ。
 *     位置を URL に置けば、ブラウザの戻る／進むとリロードが**同じ仕組み**で効く。
 *     画面の側に別の記憶（localStorage 等）を作ると、戻る／進むと食い違う。
 *
 * 位置を**動かす**操作（別の会話・別のタブを見る）はこれまで通りホストへ投げる。URL は
 * 「そこを見たい」という意図で、タブの並びや活性の真実はホストが返す `canvas_state`
 * のまま——だから戻るを押したときも、タブを押したときと同じ経路を通る。
 *
 * パスではなくクエリを使う: この画面は中継 URL（`{baseUrl}/env/<envId>/`）の下にも出る
 * ので、パスに意味を持たせると中継のプレフィックスと混ざる。クエリならどこに置かれても
 * そのまま効き、配信側にルーティング設定も要らない。
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 会話・履歴・設定の3面（決定41・プロトタイプ三次改訂）。同時に出るのは1つ。 */
export type ViewFace = "chat" | "history" | "settings";

/** 画面の位置。**ここに無いものは履歴に積まない**（＝戻るで戻らない）。 */
export interface ViewLocation {
  face: ViewFace;
  /** 会話面で見ている会話。未指定＝ホストの既定に従う。 */
  threadId?: string;
  /** その会話のキャンバスで見ているタブ。 */
  tabId?: string;
  /** 設定面で開いている区画。 */
  section?: string;
  /** 履歴面で読んでいる会話。 */
  readThreadId?: string;
}

/** URL に載せるキー。`host=`（接続先の上書き）など他のクエリは触らない。 */
const KEYS = ["view", "thread", "tab", "section", "read"] as const;

export function parseViewLocation(search: string): ViewLocation {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  return {
    face: view === "history" || view === "settings" ? view : "chat",
    ...optional("threadId", params.get("thread")),
    ...optional("tabId", params.get("tab")),
    ...optional("section", params.get("section")),
    ...optional("readThreadId", params.get("read")),
  };
}

/** 空文字は「無い」として扱う（`?thread=` で復元先を騙らせない）。 */
function optional<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

/** いまの URL のクエリを土台に、位置のぶんだけ書き換える。 */
function toSearchParams(location: ViewLocation, base: string): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of KEYS) params.delete(key);
  if (location.face !== "chat") params.set("view", location.face);
  if (location.threadId) params.set("thread", location.threadId);
  if (location.tabId) params.set("tab", location.tabId);
  if (location.section) params.set("section", location.section);
  if (location.readThreadId) params.set("read", location.readThreadId);
  return params;
}

function toUrl(params: URLSearchParams): string {
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

export interface NavigateOptions {
  /**
   * 履歴に積まずに差し替える。**ホストの都合で位置が決まったとき**に使う——番頭が
   * 別のGUIを開いた・見ていた会話が畳まれた、を履歴に積むと、戻るがもう無い場所へ
   * 帰ろうとする。POが自分で押した移動は積む（それが戻るで戻りたいもの）。
   */
  replace?: boolean;
}

export type Navigate = (
  next: ViewLocation | ((prev: ViewLocation) => ViewLocation),
  options?: NavigateOptions
) => void;

/**
 * URL を読み書きするフック。
 *
 * 戻る／進む（popstate）では URL が先に変わっているので、そこから読み直す——
 * `history.state` に積んだ写しを信じると、POが URL を直接いじったときと食い違う。
 */
export function useViewLocation(): [ViewLocation, Navigate] {
  const [location, setLocation] = useState<ViewLocation>(() =>
    parseViewLocation(window.location.search)
  );
  // 更新関数から今の位置を読む。deps に位置を入れると、位置が動くたびに
  // ハンドラの参照が変わって、貼り直しが要らないところまで貼り直される
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const onPop = (): void => setLocation(parseViewLocation(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback<Navigate>((next, options) => {
    const value = typeof next === "function" ? next(locationRef.current) : next;
    const params = toSearchParams(value, window.location.search);
    // 同じ位置なら何もしない。**同じ URL を積み直すと、戻るが1回空振りする**
    if (params.toString() === new URLSearchParams(window.location.search).toString()) return;
    const url = toUrl(params);
    if (options?.replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setLocation(value);
  }, []);

  return [location, navigate];
}
