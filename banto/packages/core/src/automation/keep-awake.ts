// アーキ仕様 §4.3「段2」の「待たれている出どころを眠らせない」（Backlog #346）。その Project に、ある Module の出来事を待つ
// 自動化（一時停止していないもの）がある間は、core がその Module を起こしておく。ここは「どの Module が待たれているか」だけを
// 決める——起こすのは host（`cli.ts` の `connectDeclaredModule`）。スリープ（§2.2）も、止めない Module はここから引く

import type { Automation } from "./fold.js";

/** 待たれている Module と、それを待っている自動化（名前つき。眠っている Project の行・眠らせるときの確かめが見せる） */
export interface AwaitedModule {
  module: string;
  automations: Array<{ id: string; name: string }>;
}

/**
 * **その Project で待たれている Module と、待っている自動化**（`moduleNames` のうち、その並び）。出来事の名前は
 * `<出どころ>.<名前>` で、出どころは名乗った Module の宣言の名前（`parseEventDeclarations` が確かめる）なので、名前の頭で引く。
 * 「起こしておく」（§4.3）とスリープの例外（§2.2）がこの1つを使う
 */
export function awaitingAutomations(
  automations: readonly Automation[],
  projectId: string,
  moduleNames: readonly string[],
  /**
   * **出来事を待っている任務の予約**（追加・2026-10-20、アーキ仕様 §4.4「予約」——`awaitedModules` が自動化の台帳に加えて引く）。
   * 待っているものの名前は「任務「…」」
   */
  missionWaits: ReadonlyArray<{ missionId: string; label: string; event: string }> = [],
): AwaitedModule[] {
  const waiting = automations.filter((a) => a.projectId === projectId && !a.paused && a.source.kind === "event");
  if (waiting.length === 0 && missionWaits.length === 0) return [];
  return moduleNames.flatMap((m) => {
    const by = waiting.filter((a) => a.source.kind === "event" && a.source.event.startsWith(`${m}.`)).map((a) => ({ id: a.id, name: a.name }));
    const missions = missionWaits.filter((w) => w.event.startsWith(`${m}.`)).map((w) => ({ id: w.missionId, name: w.label }));
    const all = [...by, ...missions];
    return all.length > 0 ? [{ module: m, automations: all }] : [];
  });
}

/** **その Project で待たれている Module の名前**（`awaitingAutomations` の名前だけ） */
export function awaitedModules(automations: readonly Automation[], projectId: string, moduleNames: readonly string[]): string[] {
  return awaitingAutomations(automations, projectId, moduleNames).map((a) => a.module);
}
