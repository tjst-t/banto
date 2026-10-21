// **結果で名乗った画面を開く URL**（アーキ仕様 §4.2「結果で名乗る画面」、v4-frontend.md §6.33）。その Thread を開き、その Module の
// 入口を `canvasView`＝`select` で開く——`dev.banto/open-surface` の launcher と同じ形（§6.2）。サイドバーの1件と、会話のカードの
// 「画面で見る」（Shell の待たない形、Backlog #492）が同じこの1つで開く
import { serializeViewState, VIEW_STATE_PARAM } from "./canvas-view-state.ts";

export interface BackgroundView {
  resourceUri: string;
  select?: unknown;
}

/** `forkId` はその Thread が Fork のときだけ（Base Thread なら null） */
export function backgroundViewHref(projectId: string, forkId: string | null, module: string, view: BackgroundView): string {
  const params = new URLSearchParams();
  if (forkId) params.set("fork", forkId);
  params.set("canvas", `${module}:${view.resourceUri}`);
  // host が大きさを確かめて写している（上限は同じ）。それでも載らなければ入口の最初の画面を開く
  const select = view.select === undefined ? undefined : serializeViewState(view.select);
  if (select !== undefined) params.set(VIEW_STATE_PARAM, select);
  return `/p/${projectId}?${params.toString()}`;
}
