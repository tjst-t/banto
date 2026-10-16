// アーキ仕様 §4.3「段2」の「待たれている出どころを眠らせない」（Backlog #346）。その Project に、ある Module の出来事を待つ
// 自動化（一時停止していないもの）がある間は、core がその Module を起こしておく。ここは「どの Module が待たれているか」だけを
// 決める——起こすのは host（`cli.ts` の `connectDeclaredModule`）。スリープを入れるときも、止めない Module はここから引く

import type { Automation } from "./fold.js";

/**
 * **その Project で待たれている Module の名前**（`moduleNames` のうち）。出来事の名前は `<出どころ>.<名前>` で、出どころは
 * 名乗った Module の宣言の名前（`parseEventDeclarations` が確かめる）なので、名前の頭で引く
 */
export function awaitedModules(automations: readonly Automation[], projectId: string, moduleNames: readonly string[]): string[] {
  const events = automations.flatMap((a) =>
    a.projectId === projectId && !a.paused && a.source.kind === "event" ? [a.source.event] : [],
  );
  if (events.length === 0) return [];
  return moduleNames.filter((m) => events.some((e) => e.startsWith(`${m}.`)));
}
