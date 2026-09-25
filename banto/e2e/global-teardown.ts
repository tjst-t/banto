// **この回が作った Project のコンテナを消す**（追加・2026-09-25、`BANTO_E2E_CONTAINERS=1` のとき）。
// 札（`user.banto.owner`＝この回のデータの置き場）で引く——人の banto や、別のセッションの E2E のものは消さない。
import { spawnSync } from "node:child_process";
import { DATA_DIR, E2E_CONTAINERS } from "./config.ts";

export default function globalTeardown(): void {
  if (!E2E_CONTAINERS) return;
  const project = spawnSync("incus", ["project", "get-current"], { encoding: "utf8", input: "" }).stdout.trim();
  const listed = spawnSync("incus", ["query", `/1.0/instances?recursion=1&project=${encodeURIComponent(project)}`], { encoding: "utf8", input: "" });
  if (listed.status !== 0) {
    console.warn(`[e2e] コンテナの一覧を読めず、片づけられませんでした：${listed.stderr.trim()}（次の回が片づける）`);
    return;
  }
  const mine = (JSON.parse(listed.stdout) as { name: string; config?: Record<string, string> }[]).filter(
    (c) => c.config?.["user.banto.owner"] === DATA_DIR,
  );
  for (const c of mine) {
    const r = spawnSync("incus", ["delete", "--force", c.name], { encoding: "utf8", input: "" });
    if (r.status !== 0) console.warn(`[e2e] コンテナ ${c.name} を消せませんでした：${r.stderr.trim()}`);
  }
  if (mine.length > 0) console.log(`[e2e] この回のコンテナ ${mine.length} 台を消した`);
}
