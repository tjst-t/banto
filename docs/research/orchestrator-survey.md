---
id: research-orchestrator-survey
type: research
status: accepted
refs: []
---

# 付録A: 調査 — 既存オーケストレータからBantoに反映できるもの

対象: Gas Town / Beads(Steve Yegge)、Operator、Vibe Kanban ほか並列エージェントかんばん系OSS。
目的: ①表面機能のコモディティ化への対応方針、②先行実装から盗める設計、の2点をBantoの各仕様に落とす。

結論サマリ: **採用7件(うちv1に3件)、参考3件、不採用4件**。Bantoの中核設計(決定的daemon・契約層・自己改善ループ)を変える発見は無し。ただし「見落としていた実用機能」が3つ見つかった(通知、エージェント健康状態の分類、先行セッションへの質問)。

## A-1. 表面機能のコモディティ化への対応方針(①)

- worktree並列・セッション管理・かんばん表面は、Conductor / Claude Squad / Nimbalyst / Operator / Vibe Kanban 等で既に無料コモディティ。Vibe Kanbanは代表格だったが2026年5月にサンセットしOSS/コミュニティ維持へ移行——この層の製品寿命は短い。
- **方針**: Bantoの表面は**自フローに最適な形で作り込む**。アテンションキューの3部構成カード、選択肢の再掲、経緯引用、健康ビュー、共有ブラウザの指差しなどはBantoの統治モデル(D7/D8、classify、ケイデンス)の上にしか成立しない固有のUIであり、贅沢に磨いてよい。一方、**汎用オーケストレータとしての競争(機能数・対応エージェント数)はしない**。フロー非依存の部品(diffビューア、tmux操作、ペイン転送等)はOSSと既存資産(Palmux2)から借りて時間を節約する。
- 差分レビューUI(side-by-side diff、カードからのレビュー導線)は Vibe Kanban / Nimbalyst がOSSなので、**実装時にUIパターンとコードを参照する**(採用というよりカンニングペーパー)。

## A-2. Gas Town / Beads からの反映

### 採用(v1から)

**A. Ready work の明示化**(Beads `bd ready`)
- 依存グラフから「いま着手可能な仕事」だけを返すクエリが、エージェント・人間双方の基本動線になっている。
- → Bantoの `queued→ready` ゲートは同じ判定を既に持つ。**CLI/APIに `banto ready` を一級クエリとして出す**(検討エージェントの分解判断・ボードのNext表示・実行者spawnがすべて同じクエリを見る)。
- 反映先: daemon-core(API)、ui-spec。

**B. discovered-from リンク**(Beads)
- エージェントが作業中に発見した新規の仕事を「発見元」に自動リンクする。発見文脈が追えることが長期運用の鍵とされる。
- → Bantoでは friction / incident / escalate / request_design がすべて「発見された仕事」。schemasの `refs` に**発見元タスクを必ず含める規約**を明文化し、生成ツール(/escalate, /incident, report_friction)が自動で付ける。
- 反映先: schemas(規約1行)、Extension Pack実装。

**C. OS通知**(Operator)
- Operatorは「エージェントのイベントで macOS/Linux 通知を出し、人間をループに保つ」を基本機能にしている。**Banto仕様の明確な欠落**——アテンションキューは「開けば分かる」が「開くきっかけ」が無かった。
- → daemonからの通知チャネル(ntfy.sh か Pushover 等、自宅サーバから携帯に届くもの)を層B設定で追加。通知対象はカード生成イベントのみ(blocking発生・レビュー待ち・failed・評価カード)。D8に従い通知文にも経緯の一行を含める。
- 反映先: ui-spec に「通知」節を追加、daemon-core API節。

### 採用(v1以降)

**D. エージェント健康状態の分類と介入コマンド**(Gas Town problems view)
- 稼働状態を Working / Stalled / Zombie(セッション死亡) / 無進捗違反 / Idle に分類し、問題のあるエージェントだけを表示するビュー＋介入キー(nudge / handoff=コンテキスト再注入)を持つ。20体規模で「詰まりを見つける」ことが最大の運用課題になるという知見。
- → Bantoの照合ループを拡張し、**健康状態のtaxonomyを状態導出に追加**(進捗判定はイベント間隔とdiff変化から機械的に出せる)。エージェント画面のフィルタと、`nudge` / `handoff` をdaemonの動詞として追加。
- 反映先: daemon-core、ui-spec エージェント画面。

**E. 先行セッションへの質問(Seance)**(Gas Town)
- `.events.jsonl` から過去セッションを発見し、後続エージェントが前任者に「何を見つけた?」と一問一答できる。コードベース全読み込みより安い文脈回復手段。
- → Bantoはセッションを全部JSONLで持つので実装が安い。**status_reporterの姉妹機能 `ask_predecessor`**として、escalate先タスク・conflict解消タスク・handoff後のセッションに提供する(前任セッションログを注入した短命SDKセッション)。特にescalatedタスクは「元タスクの実装者への質問」が頻出するはず。
- 反映先: daemon-core、Extension Pack。

**F. マージキューのバッチ化＋二分探索**(Gas Town Refinery)
- Bors型: 複数MRを束ねて一度に検証し、グリーンなら一括マージ、レッドなら二分して犯人を隔離、良い分だけマージ。直列1件ずつよりゲート実行回数が大幅に減る。
- → Banto v1は仕様通り直列1件ずつでよいが、**ゲート時間がボトルネック化したときの既定の進化先**としてdaemon-coreに追記しておく(設計を縛らないため)。
- 反映先: daemon-core マージ機構に将来拡張として1段落。

**G. テレメトリのOTLP出力**(Gas Town)
- 全エージェント操作を構造化ログ/メトリクスでOTLP互換バックエンドに出す。
- → Bantoのイベントログ＋ロールアップと思想が同じ。**ロールアップのエクスポート形式をOTLP互換にしておく**と、Grafana等の既製ダッシュボードが無料で使え、メタケイデンスの材料にもなる。v1では不要、ロールアップ実装時に形式だけ寄せる。
- 反映先: daemon-core ロールアップ節に注記。

### 参考(設計の裏付けとして確認できたもの)

- **「機械ゾーンには現在の仕事だけ」**(Beadsの設計思想: 未来の曖昧な仕事はreadyクエリを汚しトークンを浪費する。計画はspecに、Beadsは現在進行形のみ)→ Bantoのローリング分解・LaterはEpicのみ・work/とdocs/の分離、と完全に同型。規約の自信を深める裏付け。
- **Git-backedな作業台帳＋エフェメラルセッション/永続ID**(Beads/Gas Town の中核)→ Bantoの「ファイルは意図、イベントログは実行時状態、セッションは使い捨て」と同じ結論に独立に到達している。市場検証として心強い。
- **ID衝突対策**: Beadsはハッシュ型ID(`gt-abc12`)で並行作成の衝突を防ぐ。Bantoは採番がdaemon経由ツールに一元化されているので連番で衝突しないが、**「オフライン・daemon不在時のドキュメント作成をどう扱うか」を未決事項として自覚**しておく(必要になればハッシュサフィックス方式に逃げられる)。

### 不採用(理由つき)

- **Mayor(LLMオーケストレータ)**: Gas Townの中心だが、Bantoは「制御ループにLLMを置かない」を第一原則として意図的に逆を選んでいる。Gas Townの運用報告(テスト失敗のまま自動マージ、暴走監視役、$100/hr)は、まさにこの選択の帰結として読める。不採用の確信を強める材料。
- **Formula/Molecule(TOMLワークフローエンジン)**: 多段ワークフローのテンプレート化。Bantoではskill(手順知識)＋kind＋E2Eシナリオで足り、ワークフローエンジンを内蔵するとJIRA化の道。不採用、ただしE2Eシナリオの記述形式を設計するとき step+needs 構造は参考になる。
- **Dolt(バージョン管理SQL DB)**: Beadsの新バックエンド。Bantoの契約層は「人間がdiffでレビューできるMarkdown+frontmatter」が要件であり、SQL化はレビュー可能性を壊す。不採用(イベントログの検索が辛くなったらインデックスをSQLiteで持つ程度に留める)。
- **Wasteland(タウン間フェデレーション) / 20-30体スケール**: PO一人の帯域を超える世界の話。visionの非目的と整合。

## A-3. Operator からの反映

- **チケット＝Markdownファイル起点**でエージェントを起動し、優先度付きキュー＋定義済み実装ステップでかんばんを流す構成は、Bantoのタスク定義起点spawnとほぼ同型(裏付け)。
- 採用は上記 **C. OS通知**。それ以外(tmux/cmux/Zellijラッパー、複数リポジトリのワークスペースルート方式)はBanto/Palmux2の既存設計で被覆済み。

## A-4. 反映一覧(To-Do)

| # | 項目 | 反映先 | 時期 |
|---|---|---|---|
| A | `ready` を一級クエリに | daemon-core, ui-spec | v1 |
| B | discovered-from規約(refsに発見元必須) | schemas | v1 |
| C | OS/プッシュ通知(カード生成時、経緯1行つき) | ui-spec新節, daemon-core | v1 |
| D | 健康状態taxonomy＋nudge/handoff | daemon-core, ui-spec | v1.x |
| E | ask_predecessor(Seance相当) | Extension Pack, daemon-core | v1.x |
| F | マージキューのバッチ＋bisect | daemon-core(将来拡張の注記のみ) | 注記のみ |
| G | ロールアップのOTLP互換形式 | daemon-core(注記のみ) | 注記のみ |
| — | オフライン採番の扱い | schemas 未決事項に追加 | 未決 |

## A-5. 実装前に読むべきソース

- Gas Town: `docs/design/escalation.md` / `scheduler.md` / `architecture.md`、Refinery実装(Go)— https://github.com/gastownhall/gastown
- Beads: readyクエリとdiscovered-from、JSONL export設計 — https://github.com/steveyegge/beads
- Operator: チケット形式と通知実装 — https://github.com/untra/operator
- Vibe Kanban(OSS化済): 差分レビューUIのパターン
