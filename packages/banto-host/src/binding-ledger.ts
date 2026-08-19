/**
 * モデル束縛の変更を記録する追記ログ（決定 ledger・ADR-0021 の続き・2026-08-19 提案）。
 *
 * 「誰が・いつ・どの役に・何を当てたか」を追記する。設定の変更は PO の画面操作と、コード
 * （`setRoleAssignments` 等）の両方から起きる。監査・履歴・時点比較はこの追記ログから導出する
 * （D3：現在の束縛は各モジュールの台帳が持ち、これはその「変更の記録」）。
 *
 * D6: node:fs のみ。追記は append で、壊した行があっても既存分を失わない。
 * I2: 書けないことは投げる（黙って記録を落とさない）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** モデル束縛の変更1件。 */
export interface BindingDecisionEntry {
  /** 変更時刻（ISO-8601）。 */
  at: string;
  /** 役。核なら `steward` / `worker.<tier>`、モジュールならその役の id（例 `executor`）。 */
  role: string;
  /** 束縛の持ち主。`core` かモジュール名（例 `kobo`）。 */
  origin: string;
  /** 当てたモデル（`backend|provider|model`）。空なら割り当て解除。 */
  model: string;
}

/** モデル束縛の変更を追記ログへ1行付ける（なければ作る）。 */
export function appendBindingDecision(filePath: string, entry: BindingDecisionEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}
