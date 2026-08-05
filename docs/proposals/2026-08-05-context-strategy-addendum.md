---
id: proposal-2026-08-05-context-addendum
type: proposal
status: draft
refs: [adr-0003, adr-0010, epic-0012, task-0007, task-0017, task-0022, task-0023, task-0056]
---

# 追補: コンテキスト戦略の補強と、既存提案の訂正

**日付**: 2026-08-05
**位置づけ**: 既存2件（`2026-08-05-context-memory-survey.md` 調査メモ・`2026-08-05-memory-progressive-disclosure.md` 提案）の**独立レビューと補強**。前提と方向（コンパクションに頼らない／外部ファイル＋段階的開示）には同意する。本書はその上に、**既存提案が扱っていない3点**と、**訂正が必要な2点**を足す。

既存提案を差し替えるものではない。読む順は、調査メモ → 既存提案 → 本追補。

---

## 0. 要旨

| # | 種別 | 内容 |
|---|---|---|
| A | **補強** | 文脈を膨らませている主犯は会話ではなく**ツール出力**。要約せず「参照に置き換える」退避を入れる（可逆・情報を失わない） |
| B | **補強** | スレッド切替ではなく**章立て**（同一スレッドを `parentSession` で連結）。キャッシュと記憶注入の観点で有利 |
| C | **補強** | 記憶の**蒸留にゲート**をかける。既存記憶をLLMに書き直させない（実証された劣化への対処） |
| D | **訂正** | `node:sqlite` は **FTS5 を含まない**。既存提案 P3 と決定10(c) の前提が崩れている |
| E | **訂正** | **ADR-0003 の二層（人の記憶／プロジェクトの記憶）が実装されていない**（P3案件） |
| F | **追加** | 記憶の質を測る受け皿（評価セット）が無い |
| G | **解決** | 既存提案が「実装時に確認」とした pi 側の2点に、いま答えを入れる（確認済み） |
| H | **確認** | **既に正しい形になっているもの**——作り直す必要がない箇所を明示する |

---

## 1. 補強A: ツール出力を「参照」に置き換える（構造的退避）

既存提案は「会話をどう畳むか」に集中しているが、番頭の文脈を実際に膨らませているのは会話ではなく**ツール出力**である——`file.read`・`git.*`・職人の報告。ADR-0010 を1本読ませれば4万字が文脈に入る。ここに手を入れないと、章立ても handoff も、増え続ける観測の後追いになる。

### 提案

- ホスト側で、一定サイズを超えたツール結果は `BANTO_DATA_DIR/artifacts/<threadId>/<id>.md` へ書き、**文脈には栞だけ返す**

  ```
  file.read(docs/adr/adr-0010-pluggable-harness.md) → 41,832字 / artifact a-0031
  見出し: 決定1〜47（ハーネス差し替え・Tool/SKILL I/F・記憶方針 …）
  全文・部分読み: artifact.read("a-0031", { grep | offset, limit })
  ```

- `artifact.read` Tool を1本足す。番頭に汎用のファイル読みを与えずに済むので、決定1（結合はTool/SKILLの公開I/Fのみ）と整合する
- **必ず挿入時に行う。過去のメッセージを後から書き換えない**——プレフィックスキャッシュが飛ぶ

### なぜ要約より良いか

これは**要約ではないので情報を失わない**。文脈からは外れるが、全文はいつでも取り戻せる（Manus の「ファイルシステムを究極の文脈とする」＝可逆な圧縮）。Anthropic が context editing API でサーバ側から tool_use/tool_result を落としているのと同じ発想を、pi/OpenAI互換の経路では「そもそも大きいものを入れない」で達成する。

D3 とも整合する——真実はファイル、文脈にあるのは参照。

**この1点だけでも、コンパクションの発動頻度は大きく下がる。** 既存提案の P1〜P4 に対して、本項は**先に効く**（会話設計を一切変えないため）。

---

## 2. 補強B: 「スレッド切替」ではなく「章立て」

既存提案 4.2 は「handoff 資料の書き出し＋**スレッド切替**」を主経路とする。方向は正しいが、スレッドを切ると PO から見て会話の連続性が切れる（履歴が「別の会話」として並ぶ）。文脈の都合が UI の単位を壊している。

### 提案

**スレッドは維持したまま、内部を「章」に切る。**

- 文脈が閾値（例: 60%）に達したら、**番頭自身がターン境界で「章を閉じる」判断をする**。95%で強制的に走るのではなく、余力のあるうちに、区切りのいい所で閉じる
- 閉じるとき: 詳細な handoff 資料を書き出す（task-0056 a1 のまま）
- 次の章の文脈 = 記憶（L1）＋ handoff の見出し20行 ＋ `handoff.read(章ID)` ＋ artifact の栞は生きたまま
- 章は pi の `SessionHeader.parentSession` で連結する（**pi が既に持っているフィールド**。`session-manager.d.ts`）。ThreadStore はスレッド＝章の列として持ち、履歴UIは「スレッド ＞ 章」の2階層になる

### コンパクションとの違い

| | コンパクション | 章立て |
|---|---|---|
| タイミング | 文脈95%、タスクの中断点 | 番頭が選んだ区切り |
| 元の会話 | 文脈から消える | **トランスクリプトは真実として残る**（D3）。資料は再生成可能 |
| キャッシュ | 途中で無効化、以後も不安定 | 新しい章＝新しい小さなプレフィックス。**章の間ずっと効く** |
| 記憶の注入 | できない（決定28: 途中の注入はキャッシュを壊す） | **章の頭は合法的な注入点** |

最後の行が地味に効く。決定28 は「注入は次のセッション開始時のみ」と制約したが、章立てにすると**注入の機会が会話中に何度も現れる**——長い会話でも記憶が新鮮になる。

### 決定28 への影響（P3）

決定28 は抽出の契機に「pi の圧縮境界（`compaction_end`）」を挙げている。コンパクションを既定で切るなら、**この契機は章境界に読み替える必要があり、ADR-0010 への追記が要る**。黙って寄せない。

---

## 3. 補強C: 蒸留にゲートをかける（task-0022 の設計変更）

既存提案は task-0022（自動抽出）を「決定28で設計済み」としてそのまま P2 に置いているが、**このまま作ると既知の失敗モードに正面から突っ込む**。

### 根拠

- **ACE 論文**（arXiv 2510.04618）が **brevity bias**（簡潔さのために有用な詳細を捨てる）と **context collapse**（反復書き換えで知識が浸食される）を定式化
- **「Useful Memories Become Faulty When Continuously Updated by LLMs」**（arXiv 2605.12978, 2026-05）は、LLMが記憶を繰り返し統合すると**有用性が上がったあと下がり、記憶なしのベースラインを下回る**ことを示した。正解の軌跡から統合しても、GPT-5.4 が以前は解けた ARC-AGI 問題の **54%** に失敗する。結論は「**生のエピソードを一級の証拠として保持し、統合は毎回発火させず明示的にゲートせよ**」——生エピソードを既定で保存したエージェントは、強制統合版の **2倍** の精度だった

これは D3（真実はイベントログ、記憶は導出）を外部の実証が支持しているという意味でも重要である。

### 提案（task-0022 の受け入れ条件に足す）

- **既存の記憶を LLM に書き直させない。** 抽出器の出力は「新規追加」か「supersede提案（旧ID + 新文）」の**差分だけ**（ACE の delta 更新）。記憶全体をまとめ直すプロンプトは作らない
- **毎回発火させない。** 決定28 の「区切りで」は正しい。さらに、**番頭が章を閉じるときに明示的に発火**させる＝論文のいう explicit gate
- 生エピソード（トランスクリプト・handoff）は消さない＝一級の証拠。記憶が疑わしくなったら遡れる
- `origin`（`explicit` / `extracted`、決定28）に加え、**`validFrom` を任意フィールドで**持つ（Zep の valid time / ingestion time の二重時間の最小版）。「2026-08から番頭ホストは Node 22 前提」のような、いつから真かが意味を持つ fact が破綻しなくなる

### 併せて: L1 注入の予算化

既存提案 論点3 は「現状の件数では問題ないので閾値は移行時」としているが、**task-0022 が入った瞬間に記憶は数百件規模になる**。`renderMemoryForPrompt` は active な記憶を**全件**入れ、`memory.recall` の絞り込みは `kind` だけで検索が無い。順序が逆である——**予算を先に入れてから抽出を作る**。

- 合計トークン上限（例: 1,500）と kind ごとの件数上限
- 溢れたものは注入せず `memory.search` へ回す。**溢れていることをプロンプトに明示する**（黙って落とすのは I2 違反）
- 何を残すかは最終参照時刻＋出所（`explicit` > `extracted`）で決める。**LLMに要約させて詰めない**（上記の劣化）

---

## 4. 訂正D: `node:sqlite` に FTS5 は入っていない

既存提案 P3 は「実装は SQLite+FTS5（Node 22.5+ の `node:sqlite`）」とし、決定10(c) も「FTS5全文検索」を挙げ、task-0007 は「Node 20 では `node:sqlite` が使えないので JSONL、第三層で再検討」としている。**この前提は2つとも崩れている。**

- **Node 20 は 2026-04-30 に EOL。** 現在（2026-08）は既にサポート外。README の「Node.js 20 以上」は実質 22 以上に上げる判断が要る
- **Node 22+ の `node:sqlite` は FTS5 を組み込まずにビルドされている。** つまり Node を上げても FTS5 は素では手に入らず、`better-sqlite3` 等の**ネイティブ依存追加**（D1・D6）になる

### 提案: 第三層の検索は全文スキャンでよい。索引を作らない

PO一人・章が数千件でも handoff 資料は合計数MBである。Node で読んで絞るだけで一瞬で終わる。**FTS5 も SQLite も要らない**（D6: 依存追加より標準ライブラリ）。

遅くなったら、**ADR-0001 §3 が既に許している**「導出インデックスをSQLiteで持つ（真実はファイル/ログのまま）」に進めばよい。そのときも真実はファイルのままで、判断は既に固定されている。

いずれにせよ**決定10(c) の「FTS5」は追記で訂正が要る**（P3）。

---

## 5. 訂正E: ADR-0003 の二層が実装されていない

**ADR-0003（status: accepted）** は記憶を二層で持つと決めている:

1. あなた（人）の記憶＝全プロジェクト横断・共有
2. **プロジェクトの記憶＝各リポジトリに閉じる・横断させない**（統治の単位はプロジェクトなので混ぜない）

**実装は `BANTO_DATA_DIR/memory.jsonl` の単一グローバルストアのみ**（`bin.ts` の `memoryPath()`、`JsonlMemoryStore` 1インスタンスを全スレッドで共有）。第二層は存在しない。

決定36 で番頭は複数プロジェクトを扱うと決まっているので、放置するとプロジェクト知識が混ざる。既存の調査メモ・提案はいずれもこの齟齬に触れていない。

### 提案

- `MemoryStore` を「人の記憶」と「プロジェクトの記憶（Place ごと）」に分ける
- `renderMemoryForPrompt` は **人の記憶 ＋ いま作業中のPlaceの記憶**だけを合成する
- 新機能というより**齟齬の解消**なので、P3 に従い incident を積んでから着手する

---

## 6. 追加F: 記憶の質を測る受け皿が無い

`spec-improvement-loop` §1 が「層A資産は壊れると静かに劣化する」と書いているとおり、**記憶の質は測らないと静かに腐る**。既存提案には評価の話が無い。

LongMemEval の6分類に倣って、20〜30問の受け入れテストを作ることを提案する:

1. 単一セッション想起
2. 選好想起
3. **知識更新**（supersede が効いているか）
4. 時間推論（`validFrom` が効いているか）
5. 複数セッション想起（章をまたげるか）
6. **注入予算を超えたとき検索へ落ちるか**

安いモデルで回して `tests/acceptance` に入れる。

---

## 7. 解決G: 既存提案が「実装時に確認」とした2点の答え

既存提案は pi 側の可否を2箇所で保留している。`node_modules/@mariozechner/pi-coding-agent/dist/` の型定義を読んで確認したので、ここで答えを入れる。**どちらも可能**であり、保留を理由に着手を遅らせる必要はない。

### 保留1: 「自動コンパクションの無効化、SDK モードでの渡し方は実装時に確認」（既存提案 4.2）

**`AgentSession` にそのままのAPIがある。**

```
setAutoCompactionEnabled(enabled: boolean): void
get autoCompactionEnabled(): boolean
compact(customInstructions?: string): Promise<CompactionResult>   // 手動発火
abortCompaction(): void
```

閾値の側も `CompactionSettings { enabled, reserveTokens, keepRecentTokens }` と `DEFAULT_COMPACTION_SETTINGS` が公開されている。`settings.json` を経由せず、`createBantoHostSession` が組み立てたセッションに対して直接切れる。

### 保留2: 「`session_before_compact` フックが SDK モードで使えるかは実装時に確認」（既存提案 P4）

**その名前のフックは無いが、目的は別の経路で達成できる。**

- `AgentSession` は `compaction_start` / `compaction_end` をイベントとして出す（`server.ts` が既に `compaction_end` を notice として使っている）。ただし **`before` に相当するものは無い**ので、「圧縮の直前に割り込んで handoff を書く」という形は取れない
- 代わりに、**圧縮を既定オフにして、番頭が章を閉じる側から能動的に発火させる**（補強B）。`estimateContextTokens` / `shouldCompact` / `calculateContextTokens` が公開されているので、閾値判定は自前でできる
- 章の連結は `SessionHeader.parentSession`（`session-manager.d.ts`）がそのまま使える

**さらに、既存提案が想定していなかった機構がある。** pi のセッションはツリー構造で、拡張が自分のエントリを差し込める:

| 型 | 用途 | LLM文脈に入るか |
|---|---|---|
| `CustomMessageEntry` | 拡張が**文脈へ内容を注入**する（user メッセージに変換される） | **入る** |
| `CustomEntry` | 拡張の状態をセッションに永続化する（リロード時に再構築） | 入らない |
| `BranchSummaryEntry` | 枝を離れるときの要約（`fromHook` で拡張生成を区別できる） | 入る |
| `CompactionEntry` | `details` に拡張固有データを持てる | 要約のみ |

つまり **handoff 資料の見出しを `CustomMessageEntry` として章の先頭に差し込み、資料IDを `CustomEntry` として残す**、という形が pi の機構の中で素直に書ける。段階的開示の受け皿を新設する必要はない。

---

## 8. 確認H: 既に正しい形になっているもの（作り直さない）

補強・訂正が並ぶと全面的な作り直しに見えるが、**banto は既に業界の主流解を3つ持っている**。ここは触らない。

- **サブエージェントによる文脈隔離＝D10 / D11。** 長文脈エージェントの最も堅い構造解は「探索は使い捨ての文脈でやらせ、結論だけ返させる」ことで、Anthropic の multi-agent research system は各サブエージェントに独立した文脈窓を与え1,000〜2,000トークンの要約だけを返させている。banto は「番頭は細かい仕事をしない・職人は記憶を持たない」を**原則として**持っており、他所が後から足している構造を最初から備えている。**これが banto の最大の資産**であり、記憶の議論で見落とされやすい
- **段階的開示＝`skill.read`。** 一覧だけ常時・本体はオンデマンド、という形を既に自前実装している（`skills.ts`）。補強A（`artifact.read`）と補強B（`handoff.read`）は、この実績ある形を横展開するだけで、新しい発明ではない
- **オフラインでの記憶整理＝決定28。** Letta の sleep-time compute（アイドル時に、応答用とは別のモデルで記憶を整理する）は、決定28 の「抽出は会話の区切りで／安いモデルで／注入は次のセッション開始時」と**同じ形**である。ここは既に合っている。本追補が変えるのは**発火の契機（圧縮境界→章境界）と、蒸留の作法（全体の書き直し禁止・差分のみ）**だけで、決定28 の骨格は正しい

### サーベイ上、既存の調査メモが扱っていない2系統

調査メモは実装（Hermes / MemGPT / Claude Code / ChatGPT）を軸に整理しており、以下2つは系統として現れていない。本追補の補強A・Cはそれぞれこの2系統に対応する。

- **構造的退避（structured eviction）**: 要約せず、意味のある単位ごと文脈から外す。Anthropic の context editing API（tool_use / tool_result をサーバ側で削除。キャッシュのプレフィックスを壊さない順序で実行）、"Beyond Compaction: Structured Context Eviction for Long-Horizon Agents"。→ **補強A**
- **時間つき知識グラフ（bi-temporal）**: fact を削除せず無効化し、valid time（世界で真だった期間）と ingestion time（記録した時刻）を分けて持つ。Zep / Graphiti。banto の `supersedes` は既にこの半分であり、足りないのは valid time の軸だけ。→ **補強C の `validFrom`**

---

## 9. 実装順序（既存提案 4.4 への対案）

| | 既存提案 | 本追補 |
|---|---|---|
| 1 | task-0056（会話の引き継ぎ） | **L1 の注入予算＋`memory.search`**（小さい。task-0022 の前提。いま最も壊れやすい） |
| 2 | task-0023 ＋ task-0022 | **ツール出力の artifact 退避＋`artifact.read`**（効果が最大。会話設計を変えない） |
| 3 | トランスクリプト全文検索 | **章立て引き継ぎ**（task-0056 を昇格。auto-compaction オフ、`parentSession` で連結） |
| 4 | 自動トリガー | **task-0022 抽出**（差分のみ・章境界でゲート・`origin`＋`validFrom`） |
| 5 | — | ADR-0003 二層の実装（P3） |
| 6 | — | 評価セット → task-0017 SKILL学習層 |

理由: 既存提案の順序は「引き継ぎ（L4）が先、記憶（L1）の整理が後」だが、**L1 の無制限注入と抽出（task-0022）の組み合わせが最も早く壊れる**。また artifact 退避は会話設計に触らないので、引き継ぎより先に安全に入れられる。

1〜3 だけで「コンパクションをやめる」は達成できる。4以降は記憶の質の話。

---

## 10. 既存提案と一致している点（争点ではない）

- コンパクションを主経路から外す
- 外部ファイル＋段階的開示（SKILL の実装が既に踏み台になっている）
- handoff 資料は導出値、真実はトランスクリプト（D3）
- MemGPT 式の自己管理ページングは不採用
- mem0 / Zep / Letta / Hermes **本体**の組み込みは不採用（決定10 と同じ理由——フルスタックを持ち込むとハーネス差し替え可能性と競合する）。設計だけ借りる
- ベクトルDB・グラフDBは不要（ADR-0001 §3 が既に線を引いている）

---

## 11. ADR への反映（着手前に必要）

本追補の採用時、ADR-0010 に**追記**が要る（本文は書き換えない。`spec-schemas` §3）:

- 決定28 の抽出契機「圧縮境界（`compaction_end`）」→ 章境界に読み替え
- 決定28 に「既存記憶の再蒸留を禁止し、差分追記のみとする」を追加
- 決定10(c) の「FTS5全文検索」→ 前提の訂正（`node:sqlite` に FTS5 なし）と、全文スキャン＋必要時の導出インデックスへの変更
- 章立てを文脈管理の既定戦略とする決定（auto-compaction を既定オフにすること）
- ADR-0003 の二層が未実装である incident

---

## 12. 参照

### リポジトリ内

- 調査メモ: `docs/proposals/2026-08-05-context-memory-survey.md`
- 既存提案: `docs/proposals/2026-08-05-memory-progressive-disclosure.md`
- ADR-0003（記憶の二層・accepted）/ ADR-0010 決定10・28・31 / ADR-0001 §3（SQL DB化の不採用と導出インデックスの許容）
- task-0007（第一層・done）/ task-0017 / task-0022 / task-0023 / task-0056 / epic-0012
- pi の型定義（§7 の確認元）: `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts`（`setAutoCompactionEnabled` / `compact` / `compaction_start` / `compaction_end`）・`core/session-manager.d.ts`（`SessionHeader.parentSession` / `CustomMessageEntry` / `CustomEntry` / `BranchSummaryEntry`）・`core/compaction/compaction.d.ts`（`CompactionSettings` / `shouldCompact` / `estimateContextTokens`）

### 外部

- Manus, "Context Engineering for AI Agents" — ファイルシステムを究極の文脈とする（可逆な圧縮）
  https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- "Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models"（brevity bias / context collapse / delta更新）
  https://arxiv.org/abs/2510.04618
- "Useful Memories Become Faulty When Continuously Updated by LLMs"（統合の劣化・explicit gate・生エピソード保持で2倍）
  https://arxiv.org/abs/2605.12978
- "Beyond Compaction: Structured Context Eviction for Long-Horizon Agents"
  https://arxiv.org/pdf/2606.11213
- Anthropic, Context editing / Memory tool（tool_use/result のサーバ側削除。100ターンのタスクでトークン84%減・性能39%向上と報告）
  https://platform.claude.com/docs/en/build-with-claude/context-editing
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory（valid time / ingestion time の二重時間、削除せず無効化）
  https://arxiv.org/abs/2501.13956
- Letta, Memory Blocks / Sleep-time Compute（アイドル時の記憶整理を別モデルで）
  https://www.letta.com/blog/sleep-time-compute/
- Mem0, AI Memory Benchmarks 2026（LoCoMo / LongMemEval / BEAM）
  https://mem0.ai/blog/ai-memory-benchmarks-in-2026
- サブエージェントによる文脈隔離（各サブエージェントに独立した文脈窓、1,000〜2,000トークンの要約だけを返す）——§8 の D10/D11 の裏づけ
  https://www.anthropic.com/engineering/multi-agent-research-system
- Node.js EOL スケジュール（Node 20 は 2026-04-30 EOL）
  https://endoflife.date/nodejs

## 状態

**draft。PO 裁定待ち。** 既存提案2件と併せて読むこと。
