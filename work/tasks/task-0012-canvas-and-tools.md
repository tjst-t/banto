---
id: task-0012
type: task
kind: feature
title: キャンバス機構・GUIカタログ・canvas.* Tool（ホスト側）
status: draft
parent: epic-0002
depends: [task-0009]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "GUIカタログが決定17の形（Tool契約＋キャンバス固有フィールド：component参照・kind・category・icon）でエントリを保持し、登録・一覧・参照ができる" }
  - { id: a2, text: "canvas.open / canvas.close / canvas.switch / canvas.query_state / canvas.list_catalog が名前空間規則に従うToolとして実装され、表示状態の変更に閉じている（データ取得をしない）" }
  - { id: a3, text: "カタログに無い kind を canvas.open に渡すと、黙って無視せずエラーになる（決定20のバリデーション方針・I2）" }
  - { id: a4, text: "キャンバスの状態変化がWSイベントとしてクライアントへ配信され、複数クライアントが同じ表示状態を見る" }
  - { id: a5, text: "UIなしで検証でき、npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定5・12・13・17・20 より。番頭のUIはチャット＋キャンバスの2エリアで、キャンバスは番頭が Tool 呼び出しで出し入れするコンテンツ領域。決定17 でカタログのエントリ形式は「Tool契約を土台に、描画する React コンポーネントへの参照などキャンバス固有フィールドを拡張したもの」と決まっている。

決定5・§1 の「キャンバスToolは表示状態の変更に閉じる」という制約に従い、ここで作る Tool は**何を表示するかを変えるだけ**で、表示する中身のデータ取得は行わない（データ側は task-0011 の `file.*` / `git.*` 等が担う）。

決定13 より、番頭は「いまキャンバスに何が開いているか」を自分で照会できる必要がある（`canvas.query_state`）。POの発言が「この画面」等を指すと判断したときに参照する。

React コンポーネント本体と2ペインUIは task-0013。本タスクはホスト側だけを対象とし、UIが無い状態で検証する。

## スコープ外

- React コンポーネント・2ペインUI（task-0013）
- Kobo の Extension Pack が登録するプラガブルGUI（アテンションキュー等。Kobo側）
- 基本GUIセットのデータ側Tool（task-0011）
- カードの「相談する」からの文脈注入（決定13の高精度パス。別タスク）
