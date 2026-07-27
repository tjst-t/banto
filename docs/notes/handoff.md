---
id: handoff
type: note
status: draft
refs: [adr-0009, adr-0010]
---

# 引き継ぎ — ここから読む

**最終更新：2026-07-27。** ブランチ `explore/agent-primary-v2`。前身の `explore/agent-primary` から番頭主体への構造逆転（ADR-0009）は引き継ぎ、自作記憶システム（Quirefold）の設計は撤退した。

## 現在地

- **正式化フェーズは完了。** ADR-0009（番頭主体への構造逆転）・ADR-0010（ハーネス差し替え可能性、Kobo/WorkerAgent・UIのTool/SKILL I/F、記憶システムの採用方針）はいずれも `accepted`。反映先：`docs/vision.md`・`docs/VISION.json`・`docs/principles.md`・`docs/DESIGN_PRINCIPLES.json`・`CLAUDE.md`・`docs/spec/daemon-core.md`（Kobo改称・§3.5のハーネス方針）。
- **Kobo（決定的統治基盤・旧称 daemon）は実装済み**（`packages/banto-daemon` 等、`npm test` 331テスト通過）。今回の構造逆転でも変更なし。
- **番頭核（Banto ホスト）はまだ実装ゼロ。** 次に決めるべきは ADR-0010「未決事項」の4点——Tool/SKILL契約の形状、採用する既存記憶システムの具体名、pi coding agent上でのホスト構成、UI制御Toolの提示範囲。

## 前身ブランチとの関係

`explore/agent-primary` は自作記憶サブシステム（Quirefold）の設計を`docs/spec/memory.md`まで詰めたが、パラメータ空間と実装難易度が過大と判断され撤退した（同ブランチの却下記録・検証プロトコルに詳細）。**構造逆転そのもの（番頭主体）は正しかったため引き継ぎ、記憶とハーネスは自作せず既存技術を採用する前提に書き直した**のが本ブランチ。旧ブランチの`docs/spec/memory.md`・`memory-contracts.md`・ADR-0010（旧・Substrate凍結）・ADR-0011（旧・記憶先行の実装順序）・検証ログ一式は、本ブランチには持ち込んでいない（歴史記録として旧ブランチにのみ残る）。

## 次の一手

ADR-0010の未決事項をSprint化する前に、まず「採用する既存記憶システムの具体名」と「pi coding agent上でのホスト構成」の2点は調査タスクとして先に片付けるのが良さそうだが、これは次セッションのPO判断待ち。
