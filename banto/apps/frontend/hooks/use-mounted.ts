import { useSyncExternalStore } from "react";

// クライアント側の初回マウントが完了したかどうか——`useState(false)`+
// `useEffect(() => setMounted(true))`と同じ意図だが、effect内で直接
// setStateすると`react-hooks/set-state-in-effect`に引っかかる。
// SSR/クライアント初回hydrateでは常にfalseを返し、hydrate後にのみtrueへ
// 切り替える（Next.js公式でも使われる"isClient"検出の定番パターン）。
function subscribe(): () => void {
  return () => {};
}

function getSnapshot(): boolean {
  return true;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
