---
name: work-handoff
description: ADR/specをacceptedにした際に対応するwork/epic・taskをrefs付きで起票し、accepted文書とwork/の紐付けを定期的に棚卸しして、紐付けの無いものをP3に従いincidentとして積む手順。ADR/specのstatusをacceptedへ遷移させた直後、および新しいセッション開始時・Sprint境界での棚卸しタイミングで使う。
metadata:
  decision: adr-0010#15
---

# Work Handoff（ADR/spec確定時のwork/起票）

## 前提

Kobo は `docs/`（ADR/spec置き場）を監視しない（`spec-document-system` §1）。したがって ADR／spec を `accepted` にしただけでは、Kobo は何も拾わない。この分離を技術的に強制する仕組みは持たない（ADR-0010 決定15で不採用と決定済み）ため、番頭の自己規律（本SKILL）と、定期棚卸し＋P3のincident起票の二段構えで担保する。

このSKILL自体の起票（task-0005）が、決定15が要求する「引き継ぎ」の最初の実践例。

## 手順1：ADR/specをacceptedにした際の起票

ADR または spec の frontmatter `status` を `accepted` に変更したら、**その場で**（自分の裁定・PO裁定を問わない）以下を行う。

1. その決定が要求する実装単位を洗い出す。1決定＝1タスクとは限らない——粒度が大きければ複数の `work/tasks` に分解してよい。
2. 既存の `work/epics/epic-NNNN-<slug>.md` の範囲に収まるか確認する。収まらなければ新しいepicを起票する（`status: draft`、`refs` に起点のADR/spec IDを含める。本文見出し `## 目的` `## ユースケース` `## スコープ外`。→ `spec-schemas` §2）。
3. 各実装単位を `work/tasks/task-NNNN-<slug>.md` として起票する。
   - `parent` に所属epicのID
   - `refs` の先頭に起点のADR/spec IDを**必ず**含める（discovered-from規約。→ `spec-schemas` §1）
   - `scope.paths` と `acceptance`（受け入れ条件、可能なら機械検証できる形で。→ I1）を具体的に書く
   - 本文の必須見出し：`## 背景` `## スコープ外`
4. 起票したepic/taskがfrontmatterスキーマを満たすことを確認する（`@banto/core` の task-frontmatter検証相当。手書きした場合は特に、必須フィールド漏れがないか読み返す）。

**やってはいけないこと**：ADR/specを`accepted`にしたセッション内で起票を後回しにする。「後で書く」は本SKILLが防ごうとしている紐付け漏れそのものであり、手順2で拾われる前提で怠らない。

## 手順2：定期棚卸し（紐付け漏れの検出とincident起票）

**トリガー**：新しいセッションの開始時、またはSprint境界（棚卸しの正確な頻度・自動トリガーはADR-0010決定15で実装フェーズに委ねられた未決事項。本SKILLでは「新規セッション開始時」を既定のタイミングとする）。

1. `docs/adr/*.md` と `docs/spec/*.md` の frontmatter を確認し、`status: accepted` の文書を列挙する。
2. `work/epics/*.md` と `work/tasks/*.md` の `refs` フィールドを走査し、手順1で列挙した各ADR/specのIDが、少なくとも1件のepic/taskの `refs` から参照されているか確認する。
3. 参照が1件も無いADR/specを見つけたら、**黙ってどちらかに合わせず**（P3）、`work/inbox/improvement/` にincidentを起票する：
   - ファイル名：`imp-NNNN-<slug>.md`（`work/inbox/improvement/` 内の既存最大番号+1。現状は手動採番——採番ツールが未実装のため）
   - frontmatter：`type: improvement` / `kind: incident` / `origin: agent` / `class: missing-work-handoff`（本SKILLが定義する初期語彙。→ `spec-improvement-loop` §1のclass語彙に合流させる） / `status: open` / `refs: [<紐付けの無いADR/spec ID>]`
   - 本文：`## 内容`（何がaccepted済みで、何にも紐付いていないか）／`## 選択肢（検討レイヤーで判断）`（起票すべきepic/taskの案。判断はPO/検討レイヤーに委ね、番頭が単独で決めない）。実例：`work/inbox/improvement/imp-0001-watcher-ignores-draft-status.md`
4. 棚卸しで紐付け漏れが無かった場合は何もしない（毎回incidentを積む必要はない。P3は矛盾を見つけたときに積む規則であり、正常時に埋め草を作る規則ではない）。

## 参照

- `docs/adr/adr-0010-pluggable-harness.md` 決定15（本SKILLの起点となった決定）
- `docs/spec/document-system.md` §1・§4（`docs/`/`work/`分離、typeごとの役割）
- `docs/spec/schemas.md` §1・§2・§5（task/epic/improvementのfrontmatter、discovered-from規約）
- `docs/principles.md` P3（Specと実態の矛盾はincidentを積む）
