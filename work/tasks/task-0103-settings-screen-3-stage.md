---
id: task-0103
type: task
kind: improvement
title: "決定96 の設定画面（3段＋ポリシー・実推論検証）"
status: queued
refs: ["adr-0020", "adr-0019"]
scope:
  paths: ["packages/**", "docs/adr/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "稼働中の banto に反映し、起動ログで確認している" }
review:
  policy: manual
---
## 背景

ADR-0020 決定96 は設定画面の形を「接続の一覧 → プロバイダと資格情報 → 検証してモデル一覧 →
役割へ割り当て（＋ポリシー）」と決め、**検証は Goose 型（実際に推論を1回叩く）**を採るとした
——banto は職人に tool-calling をさせるので、`/models` が通っても tool-calling が通らない
モデルを事前に弾けるため。**未実装で、ADR の段取りにも載っていなかった。**

## やること

- 3段＋ポリシーの画面（`LlmRegistryViewer` の作り直し）
- `llm.check_key` を `/models` を叩くだけ → **実推論1回（tool 付き・最初のチャンクで合格）**へ
- 失敗の扱いの鉄則3つ：検証失敗でも保存と続行を許す／一覧が取れなければ自由入力へ／
  原因の欄が Advanced の裏なら自動で開く
- **束縛の面を1つにする**：`llm.set_role` に `backend` を足し、LLM 登録ビューアから
  役割割り当てを外す（いま backend を知らない面が同じ欄へ書き、番頭が黙って pi に戻る）
- Base URL は最上段（Advanced に入れない・全製品一致）
