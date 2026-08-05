---
id: proposal-2026-08-05-context-strategy
type: proposal
status: accepted
refs: [adr-0001, adr-0003, adr-0010, epic-0012, task-0007, task-0017, task-0022, task-0023, task-0056]
---

# 提案: コンパクションをやめ、「退避」と「章立て」で文脈を管理する

**日付**: 2026-08-05
**立場**: 番頭の提案 → **採用・実装済み**（ADR-0010 決定47。詳細は末尾「状態」）
**発端**: PO の提起——「コンパクション（文脈が埋まったらLLM要約で置き換える方式）は情報を失うのでいまいち。別の解決策を探したい。banto はセッション間で記憶を共有したい。会話の中で文脈をクリアしつつ、外部ファイルに置いて段階的開示で引き継ぐ方法も考えている」

**結論から**: PO の仮説は正しい。しかも banto はその部品を**既に全部持っている**（`skill.read` の段階的開示、handoff 資料の設計合意、pi の `parentSession`）。本提案の中身は、バラバラに存在しているものを**文脈管理の主戦略として組み直す**ことである。新しい発明はほとんど要らない。

---

## 0. 要旨

- コンパクションが筋悪いことには実証的な根拠が揃っている。**タイミングが最悪**（余力を失った時点で走る）、**要約は情報を壊す**（brevity bias / context collapse）、そして **LLMに記憶を繰り返し書き直させると記憶なしより悪くなる**
- 代わりに2つを入れる。**退避**（ツール出力を要約せず参照に置き換える。可逆）と、**章立て**（会話を番頭が選んだ区切りで閉じ、handoff 資料へ書き出して次の章へ渡す）
- 記憶は4層に整理し、**常時注入する層には予算をつける**。いまは無制限に全件注入していて、自動抽出（task-0022）を入れた瞬間に破綻する
- 蒸留（自動抽出）には**ゲート**をかける。既存の記憶をLLMに書き直させない
- 実装前に片づける齟齬が2つある：**ADR-0003 の二層が未実装**、**決定10(c) の FTS5 は前提が崩れている**

---

## 1. いまの banto の記憶

### 1.1 実装済み

| | 中身 | 実装 | 文脈での扱い |
|---|---|---|---|
| 第一層 | 永続記憶（`fact` / `preference` / `habit`） | `JsonlMemoryStore`（追記のみ、`supersedes` で訂正、active/superseded は読み出し時に導出＝D3） | **セッション開始時に全件**システムプロンプトへ焼き込み（`renderMemoryForPrompt`） |
| 第二層 | 手続き記憶（SKILL） | `skills.ts` / `skill-tools.ts` | **一覧だけ常時**、本体は `skill.read`（段階的開示を自前実装） |

加えて、**職人は記憶を持たない**（D11）——サブエージェントによる文脈隔離が原則として入っている。

### 1.2 未実装

- SKILL 学習層（task-0017、draft）
- 記憶の自動抽出（task-0022、draft。決定28 で設計済み）
- 記憶ビューア（task-0023、draft）
- 第三層＝セッション横断検索（未起票）
- 会話の引き継ぎ（task-0056 / epic-0012。**2026-08-02 に設計合意済み・未実装**）

### 1.3 いまある3つの穴

**(a) 注入が無制限。** `renderMemoryForPrompt` は active な記憶を**全件**プロンプトに入れる。件数上限もトークン予算もない。`memory.recall` の絞り込みは `kind` だけで、検索がない。自動抽出（task-0022）が入れば記憶は数百件規模になり、システムプロンプトが際限なく膨らむ。**task-0022 の前に予算を入れないと確実に壊れる。**

**(b) ADR-0003 の二層が実装されていない。** ADR-0003（status: accepted）は「人の記憶＝全プロジェクト横断／**プロジェクトの記憶＝各リポジトリに閉じる・横断させない**」と決めているが、実装は `BANTO_DATA_DIR/memory.jsonl` の**単一グローバルストア**（`bin.ts` の `memoryPath()`、`JsonlMemoryStore` 1インスタンスを全スレッドで共有）。第二層は存在しない。決定36 で番頭は複数プロジェクトを扱うと決まっているので、放置すればプロジェクト知識が混ざる。**P3案件**（Specと実態の齟齬は黙って寄せずincidentを積む）。

**(c) 決定10(c) の「FTS5全文検索」は前提が崩れている。** task-0007 は「Node 20 では `node:sqlite` が使えないので JSONL、第三層着手時に SQLite を再検討」としているが、

- **Node 20 は 2026-04-30 に EOL**。現在（2026-08）は既にサポート外。README の「Node.js 20 以上」も実質的な見直し対象
- **Node 22+ の `node:sqlite` は FTS5 を組み込まずにビルドされている**。Node を上げても FTS5 は素では手に入らず、`better-sqlite3` 等の**ネイティブ依存追加**（D1・D6）になる

→ 第三層の設計は、この前提で立て直す必要がある（§3.3）。

---

## 2. サーベイ

### 2.1 「コンパクションはいまいち」は正しい

PO の直感を裏づける材料が、この1年でかなり出ている。

**① タイミングが最悪。** 圧縮は文脈が95%埋まった瞬間、タスクの真ん中で走る。巨大な文脈に対するLLM1回分の遅延とコストを、**エージェントが誤りを検出する余力を最も失った時点**で払う。しかも圧縮はその時点で新しい誤りを文脈に混入させる。

**② 要約は情報を壊す。** ACE 論文（Agentic Context Engineering, arXiv 2510.04618）が2つの失敗として定式化した：

- **brevity bias** — 簡潔さのために有用な詳細（ツールの使い方の機微、否定的な証拠）を捨てる
- **context collapse** — 反復的な書き換えで詳細な知識が浸食される

長さ制約下での要約は、LLMの既知の失敗モードである。

**③ もっと重要な発見: 記憶を書き直し続けると、記憶なしより悪くなる。** 「Useful Memories Become Faulty When Continuously Updated by LLMs」（arXiv 2605.12978, 2026-05, UIUC / 清華）は、LLMがエピソードを繰り返し統合すると**有用性が上がったあと下がり、記憶なしのベースラインを下回る**ことを示した。正解の軌跡から統合しても、GPT-5.4 が以前は記憶なしで解けた ARC-AGI 問題の **54%** に失敗する。劣化の原因はエピソードそのものではなく**統合ステップ**にあり、同じ軌跡でも更新スケジュールが違えば質的に別の記憶になる。

結論は明快で、**「生のエピソードを一級の証拠として保持し、統合は毎回発火させず明示的にゲートせよ」**。生エピソードを既定で保持したエージェントは、強制統合版の **2倍** の精度だった。

これは banto の **D3（真実はイベントログ、記憶はそこから蒸留した導出）を外部の実証が支持している**という意味でも重要である。同時に、task-0022 を「毎回まとめ直す」形で作ると、この劣化に正面から突っ込む。

### 2.2 主流の5系統

| 系統 | 中身 | 代表 |
|---|---|---|
| **① 構造的退避（eviction / offload）** | 要約せず、**意味のある単位ごと文脈から外す**。ツール結果を消し、参照だけ残す | Anthropic の context editing API（`tool_use`/`tool_result` をサーバ側で削除。**キャッシュのプレフィックスを壊さない順序**で実行）、"Beyond Compaction: Structured Context Eviction"（arXiv 2606.11213） |
| **② ファイルシステム＝文脈** | 観測をファイルに書き、文脈にはパスだけ置く。**可逆な圧縮**（100:1でも復元可能）。`todo.md` を書き直して注意を目標に引き戻す | Manus |
| **③ サブエージェント隔離** | 探索は使い捨ての文脈でやらせ、1,000〜2,000トークンの結論だけ返させる | Anthropic multi-agent research system |
| **④ エージェント管理のメモリファイル／ブロック** | `/memory` ディレクトリをLLMが CRUD、または常時文脈に載る memory block | Anthropic memory tool（context editing 併用で、100ターンのタスクに対しトークン84%減・性能39%向上と報告）、Letta memory blocks |
| **⑤ 時間つき知識グラフ（bi-temporal）** | fact を**削除せず無効化**。valid time（世界で真だった期間）と ingestion time（記録した時刻）を分けて持つ | Zep / Graphiti |

補助として **sleep-time compute**（Letta）——アイドル時に、応答用とは別のモデルで記憶を整理する——という考え方がある。

**評価**は LoCoMo / LongMemEval（単一セッション想起・選好想起・**知識更新**・時間推論・複数セッション想起の6分類）/ BEAM が事実上の標準。

### 2.3 banto が既に持っているもの（作り直さない）

提案が並ぶと全面的な作り直しに見えるので、先に書いておく。**banto は上の主流解を3つ既に持っている。**

- **③ サブエージェント隔離＝D10 / D11。** 「番頭は細かい仕事をしない・職人は記憶を持たない（隠れ状態が無い＝再現可能・監査可能）」を**原則として**持っている。他所が長文脈対策として後から足している構造を、banto は最初から備えている。**これが banto の最大の資産**で、記憶の議論では見落とされやすい
- **段階的開示＝`skill.read`。** 一覧だけ常時・本体はオンデマンド、という形を既に自前実装している（`skills.ts`。pi の SKILL 機構が `read` ツールを前提とするため自前で持った経緯も記録されている）。以降の提案は**この実績ある形の横展開**にすぎない
- **オフラインでの記憶整理＝決定28。** Letta の sleep-time compute は、決定28 の「抽出は会話の区切りで／安いモデルで／注入は次のセッション開始時」と**同じ形**である。ここは既に合っている。本提案が変えるのは**発火の契機と蒸留の作法**だけで、骨格は正しい

さらに **⑤ の半分も持っている**——`supersedes` による「削除せず無効化」。足りないのは valid time の軸だけ（§3.4）。

### 2.4 採らないもの

- **mem0 / Zep / Letta / Hermes の本体組み込み**: 決定10 が Hermes に対して下したのと同じ理由。フルスタックのエージェントを持ち込むと「第一実装は pi」およびハーネス差し替え可能性と競合する。**設計だけ借りる**
- **ベクトルDB・グラフDB**: ADR-0001 §3 が既に線を引いている——「イベントログの検索が辛くなった場合も、導出インデックスをSQLiteで持つ（真実はファイル/ログのまま）に留める（D3）」
- **MemGPT 式の自己管理ページング**（エージェントが毎ターン関数でメモリを出し入れする）: 毎ターンのオーバーヘッドとモデルの関数呼び出し品質への依存が大きい。banto の規模では過剰

---

## 3. 提案

### 3.1 ツール出力を「参照」に置き換える（退避）

**番頭の文脈を膨らませているのは会話ではなくツール出力である。** `file.read`・`git.*`・職人の報告。ADR-0010 を1本読ませれば4万字が文脈に入る。ここに手を入れないと、以降の対策は増え続ける観測の後追いになる。

- ホスト側で、一定サイズを超えたツール結果は `BANTO_DATA_DIR/artifacts/<threadId>/<id>.md` へ書き、**文脈には栞だけ返す**

  ```
  file.read(docs/adr/adr-0010-pluggable-harness.md) → 41,832字 / artifact a-0031
  見出し: 決定1〜47（ハーネス差し替え・Tool/SKILL I/F・記憶方針 …）
  全文・部分読み: artifact.read("a-0031", { grep | offset, limit })
  ```

- `artifact.read` Tool を1本足す。番頭に汎用のファイル読みを与えずに済むので、決定1（結合は Tool/SKILL の公開I/Fのみ）と整合する
- **必ず挿入時に行い、過去のメッセージを後から書き換えない。** 遡って消すとプレフィックスキャッシュが飛ぶ。Anthropic が context editing API でサーバ側から `tool_use`/`tool_result` を落としているのと同じ発想を、pi / OpenAI互換の経路では「そもそも大きいものを入れない」で達成する

**これは要約ではないので情報を失わない。** 文脈からは外れるが、全文はいつでも取り戻せる（Manus の可逆な圧縮）。D3 とも整合する——真実はファイル、文脈にあるのは参照。

**この1点だけでコンパクションの発動頻度は大きく下がる。** しかも会話設計に一切触らないので、最も安全に先行導入できる。

### 3.2 会話を「章」に切る

**pi の自動コンパクションを既定オフにする。** 代わりに：

- 文脈が閾値（例: 60%）に達したら、**番頭自身がターン境界で「章を閉じる」判断をする**。95%で強制的に走るのではなく、余力のあるうちに、区切りのいい所で閉じる
- 閉じるとき、詳細な handoff 資料を `BANTO_DATA_DIR/handoffs/<章ID>.md` に書き出す（task-0056 の設計合意そのまま）
- 次の章の文脈 ＝ **記憶（L1）＋ handoff の見出し20行 ＋ `handoff.read(章ID)`**。artifact の栞は生きたまま引き継がれる
- 章はスレッドを**切らずに**連結する。pi の `SessionHeader.parentSession` がそのまま使える。ThreadStore はスレッド＝章の列として持ち、履歴UIは「スレッド ＞ 章」の2階層になる

スレッドごと切り替える案も考えられるが、PO から見て会話の連続性が切れる（履歴に「別の会話」として並ぶ）。文脈の都合で UI の単位を壊すべきではない。

**コンパクションとの違い**：

| | コンパクション | 章立て |
|---|---|---|
| タイミング | 文脈95%、タスクの中断点 | 番頭が選んだ区切り |
| 元の会話 | 文脈から消える | **トランスクリプトは真実として残る**（D3）。資料は再生成可能 |
| キャッシュ | 途中で無効化、以後も不安定 | 新しい章＝新しい小さなプレフィックス。**章の間ずっと効く** |
| 記憶の注入 | できない（決定28: 途中の注入はキャッシュを壊す） | **章の頭は合法的な注入点** |

最後の行が地味に効く。決定28 は「注入は次のセッション開始時のみ」と制約したが、章立てにすると**注入の機会が会話中に何度も現れる**——長い会話でも記憶が新鮮になる。

**決定28 への影響（P3）**: 決定28 は抽出の契機に「pi の圧縮境界（`compaction_end`）」を挙げている。圧縮を既定オフにするなら、この契機は章境界に読み替える必要があり、**ADR-0010 への追記が要る**。黙って寄せない。

### 3.3 記憶を4層に整理し、常時注入する層に予算をつける

| 層 | 中身 | 文脈での扱い |
|---|---|---|
| **L0 生の記録** | トランスクリプト / イベントログ | 注入しない。**真実。消さない** |
| **L1 名指しの記憶** | `memory.jsonl`（fact / preference / habit） | **常時注入。ただし予算つき** |
| **L2 手続き記憶** | SKILL（＋学習層 task-0017） | 一覧だけ注入、本体は `skill.read`（実装済み） |
| **L3 エピソード** | 章の handoff 資料 | 注入しない。`memory.search` で引く |

**L1 の予算化（最優先）**:

- 合計トークン上限（例: 1,500）と kind ごとの件数上限を入れる
- 溢れたものは注入せず `memory.search` へ回す。**溢れていることをプロンプトに明示する**（「他に N 件。`memory.search` で引ける」）——黙って落とすのは I2 違反
- 何を残すかは最終参照時刻＋出所（`explicit` > `extracted`）で決める。**LLMに要約させて詰めない**（§2.1 ③ の劣化）

**L3 の検索は全文スキャンでよい。索引を作らない**:

PO一人・章が数千件でも handoff 資料は合計数MBである。Node で読んで絞るだけで一瞬で終わる。**FTS5 も SQLite も要らない**（D6: 依存追加より標準ライブラリと既存資産）。§1.3(c) のとおり `node:sqlite` に FTS5 が無い以上、FTS5 を採るならネイティブ依存の追加＝D1 の escalate 案件になるが、そこまでする必要がない。

遅くなったら、**ADR-0001 §3 が既に許している**「導出インデックスをSQLiteで持つ（真実はファイル/ログのまま）」に進めばよい。判断は既に固定されている。

いずれにせよ**決定10(c) の「FTS5」は追記で訂正が要る**（P3）。

### 3.4 蒸留にゲートをかける（task-0022 の設計変更）

§2.1 ③ の実証を、task-0022 の受け入れ条件に反映する。

- **既存の記憶を LLM に書き直させない。** 抽出器の出力は「新規追加」か「supersede提案（旧ID + 新文）」の**差分だけ**（ACE の delta 更新）。記憶全体をまとめ直すプロンプトは作らない
- **毎回発火させない。** 決定28 の「区切りで」は正しい。さらに、**番頭が章を閉じるときに明示的に発火**させる＝論文のいう explicit gate
- **生エピソード（L0）は消さない**＝一級の証拠。記憶が疑わしくなったら遡れる
- `origin`（`explicit` / `extracted`、決定28）に加え、**`validFrom` を任意フィールドで**持つ（Zep の valid time の最小版）。「2026-08から番頭ホストは Node 22 前提」のような、いつから真かが意味を持つ fact が破綻しなくなる

### 3.5 ADR-0003 の二層を実装する（P3）

§1.3(b) の齟齬の解消。

- `MemoryStore` を「人の記憶」と「プロジェクトの記憶（Place ごと）」に分ける
- `renderMemoryForPrompt` は **人の記憶 ＋ いま作業中の Place の記憶**だけを合成する
- 新機能ではなく齟齬の解消なので、P3 に従い **incident を積んでから**着手する

### 3.6 記憶の質を測る受け皿を持つ

`spec-improvement-loop` §1 が「層A資産は壊れると静かに劣化する」と書いている当の対象が記憶である。**測らなければ静かに腐る。**

LongMemEval の6分類に倣って、20〜30問の受け入れテストを作る:

1. 単一セッション想起
2. 選好想起
3. **知識更新**（`supersedes` が効いているか）
4. 時間推論（`validFrom` が効いているか）
5. 複数セッション想起（章をまたげるか）
6. **注入予算を超えたとき検索へ落ちるか**

安いモデルで回して `tests/acceptance` に入れる。

---

## 4. pi 側の実現可能性（型定義で確認済み）

`node_modules/@mariozechner/pi-coding-agent/dist/` を読んで確認した。**本提案に必要なものは全て揃っている。**

### 自動コンパクションの制御

```
AgentSession.setAutoCompactionEnabled(enabled: boolean): void
AgentSession.autoCompactionEnabled: boolean          // getter
AgentSession.compact(customInstructions?: string)    // 手動発火
AgentSession.abortCompaction(): void
```

閾値側も `CompactionSettings { enabled, reserveTokens, keepRecentTokens }` と `DEFAULT_COMPACTION_SETTINGS` が公開されている。`settings.json` を経由せず、`createBantoHostSession` が組み立てたセッションに対して直接切れる。

### 章の閾値判定

`estimateContextTokens` / `calculateContextTokens` / `shouldCompact` がいずれも公開関数。自前で判定できる。

### 章の連結と、文脈への注入

- `SessionHeader.parentSession` — 章の親子関係にそのまま使える
- pi のセッションは**ツリー構造**で、拡張が自分のエントリを差し込める:

| 型 | 用途 | LLM文脈に入るか |
|---|---|---|
| `CustomMessageEntry` | 拡張が**文脈へ内容を注入**する（user メッセージに変換される） | **入る** |
| `CustomEntry` | 拡張の状態をセッションに永続化する（リロード時に再構築） | 入らない |
| `BranchSummaryEntry` | 枝を離れるときの要約（`fromHook` で拡張生成と区別できる） | 入る |
| `CompactionEntry` | `details` に拡張固有データを持てる | 要約のみ |

つまり **handoff の見出しを `CustomMessageEntry` として章の先頭に差し込み、資料IDを `CustomEntry` として残す**、という形が pi の機構の中で素直に書ける。**段階的開示の受け皿を新設する必要はない。**

### 注意

**「圧縮の直前」に相当するフックは無い**（`compaction_start` / `compaction_end` イベントはあるが、before は無い）。したがって「圧縮の直前に割り込んで handoff を書く」形は取れず、§3.2 のとおり**圧縮を切って番頭側から能動的に発火させる**設計が必要になる。これは制約ではなく、むしろ §2.1 ① の理由から望ましい。

---

## 5. 実装順序

| | 内容 | 理由 |
|---|---|---|
| **1** | **L1 の注入予算 ＋ `memory.search`** | 小さい。task-0022 の前提。いま最も壊れやすい所（§1.3 a） |
| **2** | **ツール出力の artifact 退避 ＋ `artifact.read`** | 効果が最大。会話設計に触らないので安全に先行できる |
| **3** | **章立て引き継ぎ**（task-0056 を昇格。auto-compaction オフ、`parentSession` で連結） | 「コンパクションをやめる」の本体 |
| **4** | **task-0022 抽出**（差分のみ・章境界でゲート・`origin` ＋ `validFrom`） | 記憶の質。1〜3 が前提 |
| **5** | ADR-0003 二層の実装（P3） | 齟齬の解消。複数プロジェクトを扱う以上、遅らせるほど混ざる |
| **6** | 評価セット → task-0017 SKILL学習層 | 測る受け皿を作ってから学習層を積む |

**1〜3 だけで「コンパクションをやめる」は達成できる。** 4以降は記憶の質の話。

---

## 6. 論点（PO 裁定が要るもの）

1. **章を閉じる判断を誰がするか。** 番頭が自律的に閉じる（提案）／ PO が明示的に閉じる／両方。自律で閉じると PO の知らないところで文脈が切り替わる
2. **章を閉じる閾値。** 60% は目安。低すぎると章が増えて handoff のコストが嵩み、高すぎると余力がなくなる
3. **L1 の注入予算の値。** 1,500トークンは目安。溢れたときの落とし方（最終参照時刻＋出所）でよいか
4. **artifact 退避の閾値。** 何字を超えたら栞に置き換えるか。小さすぎると番頭が毎回読み直して往復が増える
5. **Node の下限を上げるか。** Node 20 は EOL 済み。上げる場合は README・CI・デプロイ手順に波及する（本提案は FTS5 を採らないので、記憶のためだけには必要ない）

---

## 7. ADR への反映（着手前に必要）

採用時、ADR-0010 に**追記**が要る（本文は書き換えない。`spec-schemas` §3）:

- 決定28 の抽出契機「圧縮境界（`compaction_end`）」→ 章境界に読み替え
- 決定28 に「既存記憶の再蒸留を禁止し、差分追記のみとする」を追加
- 決定10(c) の「FTS5全文検索」→ 前提の訂正（`node:sqlite` に FTS5 なし）と、全文スキャン＋必要時の導出インデックスへの変更
- 章立てを文脈管理の既定戦略とする決定（auto-compaction を既定オフにすること）
- ADR-0003 の二層が未実装である incident（§1.3 b）

---

## 8. 参照

### リポジトリ内

- ADR-0003（記憶の二層・accepted）/ ADR-0010 決定10・28・31 / ADR-0001 §3（SQL DB化の不採用と導出インデックスの許容）
- `packages/banto-core/src/memory.ts` / `packages/banto-host/src/memory-tools.ts` / `host-session.ts` / `skills.ts` / `bin.ts`
- task-0007（第一層・done）/ task-0017 / task-0022 / task-0023 / task-0056 / epic-0012
- pi の型定義（§4 の確認元）: `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` ・ `core/session-manager.d.ts` ・ `core/compaction/compaction.d.ts`
- 同日の関連文書: `docs/proposals/2026-08-05-context-memory-survey.md`（調査メモ）・`docs/proposals/2026-08-05-memory-progressive-disclosure.md`（提案）・`docs/proposals/2026-08-05-context-strategy-addendum.md`（本提案を後者2件への追補として整理したもの）

### 外部

- Manus, "Context Engineering for AI Agents"——ファイルシステムを究極の文脈とする（可逆な圧縮）
  https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- "Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models"（brevity bias / context collapse / delta 更新）
  https://arxiv.org/abs/2510.04618
- "Useful Memories Become Faulty When Continuously Updated by LLMs"（統合による劣化・explicit gate・生エピソード保持で2倍）
  https://arxiv.org/abs/2605.12978
- "Beyond Compaction: Structured Context Eviction for Long-Horizon Agents"
  https://arxiv.org/pdf/2606.11213
- Anthropic, Context editing / Memory tool（`tool_use`/`tool_result` のサーバ側削除。100ターンのタスクでトークン84%減・性能39%向上と報告）
  https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic, Multi-agent research system（サブエージェントに独立した文脈窓、1,000〜2,000トークンの要約だけを返す）
  https://www.anthropic.com/engineering/multi-agent-research-system
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory（valid time / ingestion time、削除せず無効化）
  https://arxiv.org/abs/2501.13956
- Letta, Memory Blocks / Sleep-time Compute（アイドル時の記憶整理を別モデルで）
  https://www.letta.com/blog/sleep-time-compute/
- Mem0, AI Memory Benchmarks 2026（LoCoMo / LongMemEval / BEAM）
  https://mem0.ai/blog/ai-memory-benchmarks-in-2026
- Node.js EOL スケジュール（Node 20 は 2026-04-30 EOL）
  https://endoflife.date/nodejs

## 状態

**採用・実装済み（2026-08-05）。** ADR-0010 決定47 として記録した。

| 提案 | 実装 | 検証 |
|---|---|---|
| §3.1 ツール出力の退避 | `artifacts.ts` / `artifact-tools.ts` | `tests/acceptance/artifact-offload.spec.ts`（21件） |
| §3.2 章立て | `chapters.ts` / `handoffs.ts` / `handoff-tools.ts` / `chapter-summarizer.ts` | `tests/acceptance/chapters.spec.ts`（23件） |
| §3.3 4層と予算 | `banto-core/src/memory.ts` / `memory-tools.ts` | `tests/acceptance/memory-budget-and-layers.spec.ts`（29件） |
| §3.4 蒸留のゲート | `memory-extraction.ts` | `tests/acceptance/memory-extraction.spec.ts`（13件） |
| §3.5 ADR-0003 二層 | `ScopedMemory`（banto-core） | 同上（memory-budget-and-layers） |
| §3.6 評価セット | `memory-eval.ts` | `tests/acceptance/memory-eval.spec.ts`（4件） |
| §5-6 SKILL学習層 | `skill-learning.ts` | `tests/acceptance/skill-learning.spec.ts`（23件） |

**§6 の論点は既定値を置いて実装し、環境変数で変えられるようにした**（章の閾値 `BANTO_CHAPTER_THRESHOLD`＝0.6、退避の閾値 `BANTO_ARTIFACT_THRESHOLD`＝2000字、要約器 `BANTO_CHAPTER_MODEL`、注入予算＝1500トークン）。Node の下限は上げていない——§3.3 のとおり FTS5 を採らないので、記憶のためには要らない。

**残り**: task-0056 a6（実ブラウザでの確認）は未実施。章立ての機構は受け入れテストで検証済みだが、LLM を繋いだ状態での動作は画面で確かめていない。
