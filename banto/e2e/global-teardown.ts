// **この回が作ったコンテナを消す**（追加・2026-09-25）。
// 札（`user.banto.owner`＝この回のデータの置き場）で引く——人の banto や、別のセッションの E2E のものは消さない。
//
// ここは Playwright が自分で終わるとき（成功・失敗）だけ走り、host もまだ止まっていない（webServer はこのあとで
// 止まる）ので、触っている最中のものは断られる。**消し切るのは片づけ役（`run-reaper.ts`）の仕事**——Playwright が
// 居なくなったのを見届けてから、core を止めて残りを全部消す。ここでは消せるものだけ先に消す（1回ずつ、待たない）
import { DATA_DIR } from "./config.ts";
import { listOwnedContainers, removeContainers } from "./containers.ts";

export default function globalTeardown(): void {
  let mine: string[];
  try {
    mine = listOwnedContainers().filter((c) => c.owner === DATA_DIR).map((c) => c.name);
  } catch (err) {
    console.warn(`[e2e] コンテナの一覧を読めませんでした：${(err as Error).message}（片づけ役が消す）`);
    return;
  }
  const failed = removeContainers(mine, () => {}, 1);
  if (mine.length > 0) {
    console.log(
      `[e2e] この回のコンテナ ${mine.length - failed.length} 台を消した` +
        (failed.length ? `（${failed.length} 台は host が触っているので、終わったあと片づけ役が消す）` : ""),
    );
  }
}
