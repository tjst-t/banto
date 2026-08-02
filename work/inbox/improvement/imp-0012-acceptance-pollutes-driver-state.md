---
id: imp-0012
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: open
refs: [task-0105-ws-error-handler, imp-0010, imp-0011]
---

## 内容

acceptance テスト（tests/acceptance の env 系テスト）が process driver を直接呼ぶため、**本番の process driver state ファイル（`/tmp/banto-process-driver-state.json`）を汚す**。`npm test` を実行するたびに、テスト用の一時プロセス（`sleep 300` / `sleep 60` 等）が state に登録され、環境プールの照合（reconcile）が「台帳に無い実リソース」と誤検出する。

- 2026-08-01 に3回連続で発生: `env-3f300d2f3b-env` / `env-4ef62a00b0-env` / `task-orphan-smoke-*`（いずれも npm test の副産物。プロセスは自動終了するが、state エントリは teardown されない限り残る）
- process driver の state ファイルは固定パス（`os.tmpdir()/banto-process-driver-state.json`）。テストが隔離された state を使わないため、テストの副産物が本番の台帳と混ざる
- 影響: 照合の誤報が毎回出る。本物の孤児（teardown 漏れ）が誤報に埋もれる

## 選択肢（検討レイヤーで判断）

1. process driver に state ファイルのパスを環境変数（例: `BANTO_PROCESS_DRIVER_STATE`）で差し替え可能にし、テストでは隔離パスを使う（本命。D1: 環境変数の追加は公開IFの拡張なので PO 裁定が必要かも）
2. acceptance テスト側で、テスト用の state ファイルを before/after で退避・復元する（テストだけの修正で済む）
3. 照合側で「dead なプロセス」を実リソースとして数えない（部分対症。state エントリ自体は残る）
