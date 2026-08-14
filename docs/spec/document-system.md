---
id: spec-document-system
type: spec
status: draft
refs: [vision, principles]
---

# Spec: ドキュメント体系（Document System)

プロジェクト内のドキュメントの種類・フォルダ構造・フォーマット・参照規則の定義。

設計原理：ドキュメント分類は人間向けの整理ではなく、**「エージェントがどの瞬間に何の判断で参照するか」から逆算**する。各役割のコンテキストに何を積むかのマップとして設計する。

## 1. フォルダ構造

```
docs/                      # 散文ゾーン（人とLLMが読む。Koboは監視しない）
  vision.md                # 不変層：目的・非目的・価値の優先順位
  principles.md            # 判断規則集（ID付き）
  roadmap.md               # 方向層：Now/Next/Laterの物語版
  spec/                    # 仕様：現在形の真実（living document）
    <domain>.md
  adr/
    adr-NNNN-<slug>.md     # 判断記録：追記のみ
work/                      # 機械ゾーン（Koboが監視し、分岐に使う）
  epics/epic-NNNN-<slug>.md
  tasks/task-NNNN-<slug>.md
  inbox/design/            # design-inbox
  inbox/improvement/       # improvement-inbox（incident/friction/改善提案）
skills/                    # 手順知識（層A）。監査チェックリスト等もここ
meta/                      # 層B＋形式定義
  schemas/                 # 各typeのJSON Schema
  templates/               # 生成ツールが使う雛形
  drivers/                 # 環境ドライバ（→ spec-environment）
  environments.yaml
  config.yaml              # 閾値・マージポリシー・ケイデンス間隔等
```

- `docs/` と `work/` の分離が第一の骨格。Koboがwatchするのは `work/` のみで、散文の編集にオーケストレータは反応しない
- 共有資産（プロダクト既定のskills・スキーマ・config既定値）はプロダクト側にあり、プロジェクトはオーバーライドのみ持つ（→ spec-multi-project §1）
- **`skills/`（トップレベル）と `packages/banto-host/skills/` は役割が異なる。** トップレベル `skills/` は Kobo が spawn する職人・監査セッション向けのプロンプト資産（`loadPromptAsset()` で読む層A）。`packages/banto-host/skills/` は番頭核ホスト自身の手続き記憶（SKILL.md、agentskills.io形式。→ ADR-0010 決定3・9）で、pi Agent SDK がパッケージの `skills/` として発見する。最初のSKILLは `packages/banto-host/skills/work-handoff/SKILL.md`（ADR-0010 決定15：ADR/spec確定時のwork/起票手順＋定期棚卸し）。

## 2. フォーマット：YAML frontmatter ＋ Markdown本文

全ドキュメントは frontmatter（機械の契約）＋ Markdown本文（人とLLMの散文）の2層とする。

### frontmatterの規律
- **Koboが実際に分岐に使うフィールドだけを置く**。機械的に読まれないフィールドをスキーマに入れない。散文の情報は、コードが必要とし始めた時点で初めてfrontmatterに昇格させる（スキーマの進化は改善ループの対象）
- frontmatterの重さはゾーンで差をつける：`work/` は検証必須のフル契約、`docs/` は `id / type / status / refs` 程度の最小限
- **ファイルは意図、イベントログは実行時状態**（→ D3）。Koboが速い状態（フェーズ等）をfrontmatterに書き戻すことを禁止する。frontmatterのstatusは遅い状態のみ（例：draft / accepted / superseded）

### 全体構造化（YAML/JSON化）をしない理由（規範）
- 機械が読む要素は定義上frontmatterに揃うため、本文の構造化に受益者がいない
- Markdownの行単位diffはコミットレビューの機能要件。YAMLブロックスカラー/JSONエスケープはレビューを壊す
- 本文の一部を機械が読みたい場合の解は2つのみ：①分岐に使うなら**frontmatterへ昇格**（例：checklistは `items:` の構造化リスト）、②位置だけ知りたいなら**構造化Markdown規約**（テンプレートで見出し構成を固定し、必要ならmdastでパース。検証ツールで必須見出しの存在チェック）
- 散文が主でないファイル（config、スキーマ、ドライバ定義）は最初からYAML/JSONとする。境界は「散文が主か、データが主か」。あるtypeの本文が形骸化したらYAMLへの改宗を検討する

### 生成と検証
- ドキュメントは手書きせずツール経由で生成する（`/adr` 等が雛形から生成）。書式の揺れは生成で防ぐ
- **`work/tasks/*.md` は Kobo が書く**（`kobo.enqueue` の入力から生成。第4便 → spec-daemon-core §1.3）。人もエージェントもここへ直接書かない——書いても読まれない

## 3. ID・命名・参照

- stable ID＋slug：`task-0042-inline-backlinks.md`。IDは採番ツールが振る
- 参照は frontmatter の `refs:` に張る（片方向）。逆リンクは維持せずインデックスを生成する
- プロジェクト間参照は `<project>/<id>` 形式（→ spec-multi-project §2）

## 4. 主要ドキュメントの役割

| type | 時制・性質 | 更新規則 |
|---|---|---|
| vision / principles | 憲法。全セッション注入。**合わせて2ページ以内厳守** | 変更はADR経由のみ。溢れたら詳細をspec/skillsへ追い出す |
| roadmap | 方向。Now/Next/Laterの物語版 | 検討セッションで更新 |
| **spec** | **「いま何がどうなっているか」の現在形**。living document | 実装タスクで変更されたら更新（監査チェックリスト項目）。ただしドリフトで実害が出るドメインに絞り、書きすぎない |
| **adr** | **「なぜそうしたか」の過去形**。追記のみ | 覆すときは新ADRでsupersede。書き換え禁止 |
| epic | 方向の構造物。実行キューに載らない | ローリング分解。状態管理を持たせない |
| task | 実行契約（スコープ、scope paths、受け入れ条件、監査基準、environment、hypothesis等） | 生成ツール経由 |
| inbox | エージェント→検討レイヤーへの永続メッセージ | `request_design` / `report_friction` / `/incident` 等が生成 |
| skill | 手順知識（層A） | 改善ループで更新。コミット＝レビュー対象 |

エージェントの使い分け：実装時に読むのはspec、判断に迷ったとき遡るのがADR。この分業の曖昧化を最も警戒する。

### principlesの記述規則
- 判断規則の形式（タイブレーク）で書く。スローガン禁止。反例が想像できること、違反時の行き先（escalate / request_design / incident）を含むこと
- 各規則にID（D/I/P + 番号）。監査指摘・escalate理由・却下ログから参照され、集計の単位になる

## 5. 役割ごとのコンテキスト注入マップ

「必要なドキュメント」の定義＝「各役割が自律判断するのに足りる最小セット」。

| 役割 | 注入内容 |
|---|---|
| 検討エージェント | vision＋principles＋roadmap＋ADR索引（全アクセス権） |
| 実行者 | vision＋principles＋自タスク定義＋タスクの`refs`が指すspec/ADRのみ |
| 同期QA | vision＋principles＋roadmap＋関連ADR |
| 監査 | principles＋タスク定義＋監査チェックリスト（skills） |
| レビューセッション | タスク定義＋差分＋起動方法 |

実行者に全量を注入しない理由はコスト以上に、**判断根拠をタスク定義とrefsに閉じ込めることで失敗の原因追跡を可能にする**ため。

## 6. 未決事項

- 各typeのfrontmatterフィールド表（スキーマ初版）
- インデックス生成（逆リンク・ADR索引）の実装タイミング
- roadmap.mdとバックログGUI（Now/Next/Laterレーン）の同期規則
