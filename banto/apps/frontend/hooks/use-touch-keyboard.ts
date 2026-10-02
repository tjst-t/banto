import { useSyncExternalStore } from "react";

// **入力欄に焦点を当てると画面のキーボードが出る端末か**（2026-10-02、ユーザー要望）。
//
// 見るのは幅ではなく「主な指し方が指で、ホバーできない」こと（`hover: none` かつ `pointer: coarse`）
// ——キーボードが出るかどうかは端末の性質で決まる。幅で見ると、幅の広いタブレットではキーボードが出たまま、
// 狭くしたパソコンの窓では焦点が当たらなくなる。
const QUERY = "(hover: none) and (pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useTouchKeyboard(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // 分からない間（サーバ・hydration）は「出る」とみなす——先に焦点を当ててからでは取り消せない
    () => true,
  );
}
