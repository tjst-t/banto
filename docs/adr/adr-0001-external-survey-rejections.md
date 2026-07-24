---
id: adr-0001
type: adr
status: draft
refs: [research-orchestrator-survey, followup-directive-2026-07, vision, principles]
---

# ADR-0001: 外部オーケストレータ調査に基づく不採用判断の記録

## 文脈

既存オーケストレータ(Gas Town / Beads / Operator / Vibe Kanban等)の調査(research-orchestrator-survey)で、採用7件・参考3件のほかに、Bantoの中核設計と衝突するため不採用とした4方式がある。将来同種の提案が再浮上したときの照合先として、判断を記録に固定する。

## 決定

以下4件を不採用とする:

1. **LLMオーケストレータ**(Gas Town "Mayor"): 制御ループにLLMを置く方式。Bantoは「daemonは決定的なコード、制御ループにLLMを置かない」(D2、spec-daemon-core冒頭)を第一原則として意図的に逆を選ぶ。Gas Townの運用報告(テスト失敗のままの自動マージ、暴走監視役、$100/hr)はこの選択の帰結として読める
2. **ワークフローエンジン**(Formula/Molecule型のTOML多段テンプレート): Bantoでは skill(手順知識)+kind+E2Eシナリオで足りる。エンジン内蔵はJIRA化(vision非目的)への道。ただしE2Eシナリオ記述形式の設計時に step+needs 構造は参考にしてよい
3. **SQL DB化**(Dolt等による契約層のDB化): 契約層は「人間がgit diffでレビューできるMarkdown+frontmatter」が要件であり、SQL化はレビュー可能性(統治モデルの根幹)を壊す。イベントログの検索が辛くなった場合も、導出インデックスをSQLiteで持つ(真実はファイル/ログのまま)に留める(D3)
4. **フェデレーション/20-30体スケール**(Wasteland型のタウン間連携): PO一人の帯域を超える世界の話であり、visionの非目的(チーム利用・マルチテナント対象外)と整合

## 帰結

- (+) 同種提案の再浮上時に、この判断と根拠(調査文書A-2〜A-4)へ機械的に照合できる
- (+) 中核設計(決定的daemon・ファイル契約層・PO単独スケール)の境界が明文化される
- (−) 上記領域の外部ツール進化の恩恵は自動では受けない。方針変更はこのADRのsupersedeを要する(変更はADR経由のみ)
