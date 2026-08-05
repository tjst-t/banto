# エージェントの長期記憶・コンテキスト管理の比較調査メモ

**日付**: 2026-08-05
**目的**: banto（記憶を持つAI番頭）の記憶システム改善のインプット。
**背景の論点**: 現在 banto はセッション開始時に保存済み記憶（preference / habit / fact）を**全部システムプロンプトへ全文注入**している。会話が長くなると pi ハーネスの自動コンパクション（LLM要約で置き換え）が働くが、PO は「コンパクションは要約で情報を失うのでイマイチ」と考えている。代替として「会話の中でコンテキストをクリアしつつ、文脈を外部ファイルに置いて段階的開示（progressive disclosure）で引き継ぐ」方法を検討中。本メモはその評価に必要な外部事例の調査記録。

**調査対象**: ①Hermes Agent ②MemGPT/Letta ③Claude Code ④ChatGPT/Claude.ai ⑤段階的開示の実例 ⑥ハンドオフ/引き継ぎノート

---

## 1. Hermes Agent（NousResearch/hermes-agent, MIT）— 三層メモリアーキテクチャ

### 概要

- 自己改善型エージェントフレームワーク。記憶は単一の「覚えろ」フィールドではなく、**3つの実用層**で構成される：
  1. **durable facts（耐久的事実＝セマンティック記憶）** — 安定した事実・好み・環境の癖
  2. **procedural skills（手続き記憶）** — 再利用可能な手順（SKILL.md）
  3. **session search（エピソード記憶）** — 過去セッションの検索
- 加えて **SOUL.md**（人格・運用指針。記憶ではない）、**profiles**（個人/仕事/ボットで文脈を分離）

### 何を覚えるか（記憶の単位）

- durable facts: 「宣言的な事実」のみ保存。例: デプロイ経路、好みの文体、設定ファイルの場所、ユーザーの訂正で繰り返し不要にすべきもの
  - **悪い例として明記**: タスクログ（「今日バグXを直した」「PR Yを開いた」）は保存しない——すぐ期限切れになる情報はセッション履歴かタスクシステムに置く
- skills: 複数ツールにまたがる手順・コマンド・落とし穴・検証方法（ブラウザQAスキル等）。記憶より詳細を持てる（必要なときだけロードされるため）
- session search: 過去の会話全文が検索対象。「前に直した」「前回のやり方で」と言われたときに検索する
- 記憶衛生のチェックリスト: 古い経路の削除、命令形→宣言的事実への書き換え、手順はスキルへ移動、1週間以内に期限切れになるものは保存しない

### どこに置くか（ストア・ファイル形式）

- `~/.hermes/` 配下（HERMES_HOME、profileごとに分離）
  - MEMORY.md / USER.md（平文Markdown。耐久的事実）
  - `skills/` ディレクトリ（SKILL.md、agentskills.io形式）
  - `state.db`（SQLite・WALモード）: sessions / messages / FTS5仮想テーブル
- FTS5は3種: `messages_fts`（通常）/ `messages_fts_trigram`（CJK・部分文字列検索）/ `messages_fts_cjk`（cjk_unicode61トークナイザ）
- セッションの系譜（lineage）: `parent_session_id` で圧縮由来の分割を追跡（in_place圧縮では同一IDのまま soft-archive も可）

### いつ注入するか

- システムプロンプトは **stable → context → volatile の階層**で組み立てられる（`prompt_builder.py`）
  - identity / tool ガイダンス / skills 一覧 → 文脈ファイル → 記憶・profile・タイムスタンプブロック
- durable facts（MEMORY.md）: **プロンプトビルド時に注入**（常時）
- skills: **一覧（名前・説明）は常時、本文は関連時のみ**ロード（skill スラッシュコマンド・自動活性化。後述の段階的開示と同じ思想）
- memory provider を使うと: 各ターン前に**関連記憶を事前フェッチ（バックグラウンド・非ブロッキング）**、応答後に会話ターンを同期、セッション終了時に記憶抽出（provider依存）、組み込み記憶への書き込みを外部へミラー

### どう検索・抽出するか

- **FTS5全文検索**: `search_messages()` が FTS5 クエリ構文（AND/OR/NOT/フレーズ/プレフィックス）で全セッション横断検索。スニペット＋前後1メッセージの文脈付きで返す。`session_search` ツールとしてエージェントから呼べる
- **記憶の抽出**: memory provider（Hindsight 等）が会話から耐久的事実を自動抽出。組み込みでは抽出は限定的（MEMORY.md は自己書き込み）
- **スキル自動蒸留**: タスク完了後の成功したマルチツールワークフローを SKILL.md として `~/.hermes/skills/` へ書き出し、次回以降はチャット履歴から再導出せず手順をロードする。`/learn` コマンドでディレクトリ・URL・会話を検証可能な SKILL.md に蒸留する実装もある
- プロファイル分離により「仕事のデプロイ設定が個人アシスタントに漏れる」等の文脈衝突を防止

### コンパクションとの関係・得失

- **二重圧縮システム**:
  - Agent ContextCompressor（本命・デフォルト50%閾値）: 中間ターンを構造化要約（Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Relevant Files / Next Steps / Critical Context）に置換
  - Gateway Session Hygiene（安全網・85%閾値）: エージェントの圧縮を逃れた巨大セッションを処理
- 要約は**損失あり**だが、圧縮前ターンは削除せず soft-archive（`active=0, compacted=1`）——**session_search で検索可能・復元可能**なまま残す
- 再圧縮時は前回要約をLLMに渡して**更新**する（ゼロから要約し直さない）。`protect_last_n`（末尾20メッセージ保護）等のテール保護あり
- 要約モデルのコンテキストが主モデルより小さいと要約失敗→黙って中間を**要約なしで破棄**する既知の失敗モードがある
- 得失: 耐久記憶を小さく保ち、古い作業は検索で発見可能にする構造。つまり「**全文を要約で潰す代わりに、検索で正確に取り出す**」という選択肢を提供している

### 参照

- 公式ブログ: https://hermes-agent.ai/blog/hermes-agent-memory-system
- 公式ドキュメント（Architecture）: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/
- ソース（architecture.md）: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md
- ソース（session-storage.md・FTS5/系譜）: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md
- ソース（context-compression-and-caching.md）: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md
- Memory Providers（抽出タイミング）: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/
- DeepWiki（アーキテクチャ概要）: https://deepwiki.com/NousResearch/hermes-agent/1.1-architecture-overview

---

## 2. MemGPT / Letta — 仮想コンテキスト管理（OS式ページング）

### 概要

- MemGPT（論文: "MemGPT: Towards LLMs as Operating Systems", arXiv 2310.08560）は、**コンテキスト窓をRAM、外部ストレージをディスクに見立てた仮想メモリ方式**。LLM自身が関数呼び出しでデータを窓と外部の間でページングする。後継フレームワークが Letta（旧MemGPT）
- 「無限コンテキストの幻想」を、階層メモリ＋OS関数＋イベント駆動制御フローで実現

### 何を覚えるか（記憶の単位・階層）

- **main context（＝プロンプトトークン、RAM相当）**: 3区画
  - system instructions（読み取り専用）
  - **working context**（固定サイズの読み書きブロック）: ユーザーとペルソナの重要事実・好み
  - **FIFO queue**: メッセージのローリング履歴。先頭に**再帰的要約**（evictされたメッセージの要約）を常置
- **recall storage（会話履歴DB）**: 全メッセージの完全な履歴。関数呼び出しで検索・復元
- **archival storage（文書パッセージDB）**: 任意長のテキストオブジェクト（ドキュメント等）。ベクトル検索
- Letta実装では **memory blocks**（ラベル付きテキストコンテナ）が中核。既定ブロックは `persona`（エージェントの人格・役割）と `human`（ユーザー情報）。各ブロックに文字数上限（limit）・read_only フラグ・変更履歴（audit trail）

### どこに置くか（ストア・ファイル形式）

- archival: PostgreSQL + pgvector（HNSWインデックス、ベクトル検索）等
- recall: メッセージDB
- core memory blocks: DBに永続化（ブロック間は多対多、エージェント毎にラベルを変えて共有可）
- 全て**エージェントが関数（tool）で読み書き**する。システムプロンプトのテンプレートに `{CORE_MEMORY}` プレースホルダがあり、毎ステップブロックをコンパイルして注入

### いつ注入するか

- **core memory blocks: 毎エージェントステップのシステムプロンプトへ常時コンパイル注入**
- archival / recall: **オンデマンド**。エージェントが関数呼び出し（`archival_memory_search` / `conversation_search` 等）で検索し、結果をページングして窓へ持ち込む
- コンテキスト圧迫時: 70%で **memory pressure 警告**（エージェントが自ら保存・退避を判断）、100%で queue を flush（50%分を退避＋再帰的要約を生成）

### どう検索・取り出すか

- **エージェント自己管理（self-directed）**: システム命令にメモリ階層の説明と関数スキーマを記載し、LLMが自分で「何を読み・書き・退避するか」を決める
- 検索結果はページング（コンテキスト溢れ防止）。関数連鎖（`request_heartbeat=true`）で複数回検索→照合するマルチホップ参照を可能に
- 評価（DMRタスク）: GPT-4 + MemGPT 92.5% vs ベースライン32.1%——「過去会話の要約だけ渡す方式」より「全文を検索で引く方式」が記憶整合性で大幅優位

### コンパクションとの関係・得失

- コンパクション＝要約は**最終手段**ではなく、FIFO flush時の再帰的要約が主。要約で潰す前に「必要なものを先に外部へ保存する」機会をエージェントに与える設計
- Lettaの要約モード: sliding window（古いメッセージを%指定で退避＋要約）/ all messages（全体を一括要約）/ **self-compaction**（Claude Code風・エージェント自身が自分の履歴を要約。品質が高いとされる）
- 得失:
  - 利点: 要約に頼らず正確な参照が可能（検索が要約より勝る実証データ）。コンテキストの「何を保つか」を状況に応じて動的に決められる
  - 欠点: **毎ターンのオーバーヘッド**（heartbeat・内省ループ・関数呼び出しの調整コスト）。モデルの関数呼び出し品質に依存（GPT-3.5では性能劣化）。自己管理の品質はモデル次第で不安定

### 参照

- 論文: https://arxiv.org/abs/2310.08560 （HTML版: https://ar5iv.labs.arxiv.org/html/2310.08560 ）
- Letta公式: https://github.com/letta-ai/letta
- DeepWiki（Agent Memory System）: https://deepwiki.com/letta-ai/letta/2.3-agent-memory-system
- DeepWiki（Context Window Management and Summarization）: https://deepwiki.com/letta-ai/letta/2.4-archival-memory-and-passages

---

## 3. Claude Code（Anthropic）— CLAUDE.md / 自動記憶 / コンパクション

### 概要

- コーディングエージェント。セッションを跨ぐ知識の伝達は**CLAUDE.md（人が書く指示）＋ auto memory（Claude自身が書く学習）**の2系統。どちらも**セッション開始時にロードされるファイル**であり、強制設定（hook等）ではない
- 「毎セッション新しいコンテキスト窓から始まる」ことを前提に設計されている

### 何を覚えるか（記憶の単位）

- CLAUDE.md: 指示・ルール（コーディング規約、ビルドコマンド、プロジェクト構造、ワークフロー）
  - 「何をCLAUDE.mdに足すか」の判断基準: 同じ間違いを二度したとき / レビューで指摘されたとき / 毎セッション同じ説明を打っているとき / 新メンバーが同じ文脈を必要とするとき
  - マルチステップ手順や一部のコードベースだけに関わることは **skill か path-scoped rule に移す**（常時ロードすべきでない）
- auto memory: 学習とパターン（ビルドコマンド、デバッグ知見、アーキテクチャメモ、コードスタイル選好、ワークフロー習慣）。**毎セッション保存するわけではなく**「将来の会話で役立つか」で判断

### どこに置くか（ストア・ファイル形式）

- CLAUDE.md は4スコープ（load order順）:
  1. managed policy（OS全体）: `/Library/Application Support/ClaudeCode/CLAUDE.md` 等
  2. user: `~/.claude/CLAUDE.md`
  3. project: `./CLAUDE.md` または `./.claude/CLAUDE.md`
  4. local: `./CLAUDE.local.md`（gitignore推奨）
- ディレクトリツリーを上って検出。起動ディレクトリより上のファイルは**起動時に全文ロード**、**サブディレクトリのCLAUDE.mdは該当ディレクトリのファイルを読むときにオンデマンドロード**
- `.claude/rules/` 配下にトピック別ルールを分割可。**pathフィールド（glob）で特定ファイル操作時にのみロード**
- auto memory: `~/.claude/projects/<project>/memory/` 配下に **MEMORY.md（インデックス）＋トピックファイル**（debugging.md 等）

### いつ注入するか

- CLAUDE.md: 起動時・毎セッション（ディレクトリツリーの親側から順に連結）。サブディレクトリ・path-scoped はオンデマンド
- auto memory: **MEMORY.md の先頭200行 or 25KB を毎セッション開始時にロード**。超過分はロードされない。詳細はトピックファイルへ移動し**オンデマンドで読む**（= MEMORY.md は「何がどこに保存されているか」の索引として機能）
- ガイドライン: CLAUDE.md は1ファイル200行未満を目標。長いとコンテキスト消費＋指示遵守率が下がる。`@path` import は整理のためで**コンテキスト削減にはならない**（起動時に展開される）

### どう検索・取り出すか

- 基本的に**検索エンジンではなくファイル読み取り**。トピックファイルは標準ファイルツールで必要時に読む
- `/memory` コマンドで全メモリファイル一覧・閲覧・編集（auto memoryのON/OFFも）。`/context` で今ロードされているメモリファイルを確認
- auto memory のメンテナンス: MEMORY.md が上限近くになるとClaude Codeが「1行1エントリに、詳細はトピックファイルへ、陳腐化した項目を統合」するようリマインド。超過書き込みはエラーで索引の書き直しを要求
- 人間が「このことを覚えて」と言うと auto memory へ保存、「CLAUDE.mdに足して」と言うと CLAUDE.md へ書く

### コンパクションとの関係・得失

- `/compact` と自動コンパクション: 文脈窓が満杯に近づくと古いターンを要約に置換。**コンパクション後もファイルから復元される**:
  - プロジェクト直下 CLAUDE.md: コンパクション後にディスクから再読込・再注入される
  - サブディレクトリのCLAUDE.md: 自動再注入されず、次にそのディレクトリのファイルを読んだときに再ロード
  - 会話中だけに与えた指示: コンパクションで消える → CLAUDE.md に書けば永続
- 得失:
  - 利点: 記憶が**平文Markdownファイル**で可視・編集・削除可能（ブラックボックスDBではない）。インデックス＋トピックファイルが段階的開示の実例。コンパクションの情報損失を「ファイルに書けば残る」で回避できる
  - 欠点: 全文注入方式（200行制限付き）なので量に限界。遵守は「指示」であって強制ではない（厳格適用はhook）。衝突する指示があると任意に解釈されうる

### 参照

- 公式ドキュメント（Memory）: https://code.claude.com/docs/en/memory
- 公式ドキュメント（.claudeディレクトリ）: https://code.claude.com/docs/en/claude-directory
- 公式ドキュメント（Compaction）: https://platform.claude.com/docs/en/build-with-claude/compaction
- 公式ブログ（CLAUDE.md活用法）: https://claude.com/blog/using-claude-md-files

---

## 4. ChatGPT / Claude.ai のメモリ機能（消費者向け永続記憶）

### ChatGPT（OpenAI）

- 概要: 会話を跨ぐパーソナライズ機能。既定ON。**逆解析記事（Manthan Guptaの実験、2025-12）によるとRAGもベクトルDBも使っておらず、4層の構造化コンテキスト**で実現している

**4層構成**（毎メッセージ時にこの順で注入される）:
1. **Session Metadata**: 現在の環境スナップショット（端末・ブラウザ・タイムゾーン・サブスク層・モデル利用傾向）。セッション終了で消える
2. **User Memory（保存済み事実）**: 名前・年齢・経歴・プロジェクト・選好などの永続ファクト。実験では33件保存されていた。**保存は明示的**——ユーザーが「覚えて」と言うか、重要な情報を検出して確認を経て保存。**毎メッセージ・全件注入**
3. **Recent Conversations Summary**: 最近の会話（実験では約15件）の**短い要約リスト**（「何に興味があったか」程度）。**事前計算して注入**——検索せずに毎回注入する。RAGを避けた設計
4. **Current Session Messages**: 今のセッションの全文。トークン上限で古いメッセージが先に切られる（保存済みファクトと要約は残る）

- 注入の優先順位が明確: **永続ファクト＞最近の要約＞セッション履歴**。スペースが足りなくなったらセッション履歴から切る
- 2025-04更新: 参照可能な範囲を保存済みファクトから**全チャット履歴**へ拡大。2026年の **Dreaming** 更新: バックグラウンドプロセスが複数会話から学習し**記憶状態を統合・合成**して常に新鮮な文脈を提供（保存ファクトのリストとは別系統）
- ユーザーは記憶の閲覧・削除・無効化が可能（メモリ概要表示、チャットで質問すれば確認できる）

### Claude.ai（Anthropic）

- 消費者向けチャットのメモリ: 会話を跨ぐ選好・プロジェクトの記憶。**逐次自動要約**——「生の事実リスト」ではなく、**定期的に会話を要約して要点を蒸留**する方式（ChatGPTの明示保存と対照的）
- プロジェクトスコープのメモリ（Team/Enterprise）: プロジェクトごとに独立したメモリ。閲覧・編集・インコグニートチャット（メモリに保存しない）が可能
- チャット検索: 過去の会話を検索して参照できる機能も提供（要約記憶とは別系統）
- 記憶ファイル機能（試験中報道）: 構造化された長期文脈の保持を試行

### コンパクションとの関係・得失

- コンパクション（会話中の要約）とは別に、**セッション境界で記憶が要約される**設計（特にClaude.ai）。ChatGPTはセッション履歴を「最近の会話要約」として事前計算
- 得失:
  - 利点: 全件注入でも件数が少なければ機能する（33件程度）＝**bantoの現行方式（全文注入）と同型**で、スケールしないことを示す実例。優先順位（ファクト＞要約＞履歴）の考え方が参考になる
  - 欠点: 要約はやはり損失あり（Claude.ai方式）。ChatGPTの「検索しない」設計は、事前計算した要約リストの範囲内でしか過去を参照できない。ユーザー記憶の管理は要約・削除が主で、構造化された索引や検索は弱い

### 参照

- OpenAI公式（Memory発表）: https://openai.com/index/memory-and-new-controls-for-chatgpt/
- OpenAI公式（Memory FAQ）: https://help.openai.com/en/articles/8590148-memory-in-chatgpt-remembering-what-you-chat-about
- OpenAI公式（Dreaming）: https://openai.com/index/chatgpt-memory-dreaming/
- 逆解析記事（4層構造）: https://llmrefs.com/blog/reverse-engineering-chatgpt-memory
- Anthropic公式（Claude memory blog）: https://claude.com/blog/memory
- Claudeサポート（チャット検索とメモリ）: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context

---

## 5. 段階的開示（Progressive Disclosure）をエージェントのコンテキスト管理に使う実例

### パターンの本質

- 前提: 「コンテキスト窓は有限だが、知識ベースは有限ではない」。全知識を常時入れると **context rot（文脈腐敗）**——注意の希釈・トークン浪費・類似パターンの混同・推論遅延——が起きる
- 解法: 情報を**階層でロード**する。常時見せるのは索引・メタデータのみ、詳細はオンデマンド。人間の認知になぞらえれば「百科事典を暗記せず、目次を覚える」

### 実例1: microsoft/agent-skills（三層ロード）

- **Tier 1（起動時・メタデータ）**: 全スキル（132+）のYAML frontmatter（名前・説明・トリガーフレーズ）だけをロード。**スキル1件あたり50〜100トークン、132件で約6.6k〜13kトークン**
- **Tier 2（活性化時・本体）**: ユーザー要求がトリガーフレーズに一致したら SKILL.md 本文をロード（500〜2kトークン）
- **Tier 3（オンデマンド・リソース）**: さらに深い文脈が必要なら `references/*.md`（受入基準・ツール連携・高度なパターン等）を個別にロード
- 効果: 全部フルロードすると100k+トークンかかるところを、メタデータ＋必要なスキルのみで約13kに収める（~90kトークン節約）
- 実装形態はプラットフォーム非依存: CLIエージェントはファイルツールで `cat SKILL.md`、APIエージェントはGitHub APIで取得、など

### 実例2: HAAL Skills

- 起動時に**全スキルのYAML frontmatter（名前・説明）をシステムプロンプトへプレロード**し、本体はエージェントがファイル読み取りツール（bash read 等）で**オンデマンドに読む**。実行環境がファイルシステムアクセスを持つことを前提にした段階的開示

### 実例3: Anthropic Agent Skills

- エージェントは**スキル名・説明だけを持って起動**し、タスクに応じて SKILL.md（＋参照ファイル）をプログレッシブにロード。「コンテキスト窓を小さく保ち、必要なときだけ追加ロード」を明示的な設計パターンとして提示

### 実例4: 各所の実践（ardalis / mindstudio 等）

- AGENTS.md・CLAUDE.md を短く保ち、詳細は別ファイルへのリンクにする
- MCPサーバーの説明を簡潔にし、詳細は起動後に取得
- スキルの説明文（description）が検索・活性化の品質を決める——**メタデータの書き方が段階的開示の成否を左右する**

### banto との関係

- **banto は既にSKILLでこの方式を実装済み**: `renderSkillsForPrompt()` が一覧（名前・説明）だけをプロンプトに載せ、本体は `skill.read` で読む。調査対象の中で段階的開示を記憶に拡張する場合の踏み台が既にある

### 得失

- 利点: コンテキストの節約（1〜2桁）。全資産への「気づき」を維持しつつ負荷を抑える。ファイルベースなのでスケール
- 欠点: トリガー/メタデータの品質が活性化の精度を決める（説明が悪いと必要なスキルに気づかない）。エージェントが「読むべきタイミング」を判断できる必要がある（ツール規律）。遅延が1往復増える

### 参照

- microsoft/agent-skills DeepWiki（Progressive Disclosure）: https://deepwiki.com/microsoft/agent-skills/3.3-progressive-disclosure
- HAAL Skills（Progressive Disclosure）: https://haal-ai.github.io/haal-skills/how-to-build-skills/progressive-disclosure/
- Agentic Engineering（パターン解説）: https://www.jayminwest.com/agentic-engineering-book/7-patterns/7-progressive-disclosure
- 実践解説（ardalis）: https://ardalis.com/optimizing-ai-agents-with-progressive-disclosure/
- 実践解説（MindStudio）: https://www.mindstudio.ai/blog/progressive-disclosure-ai-agents-context-management

---

## 6. ハンドオフ / 引き継ぎノート方式

### パターンの本質

- 長い会話・作業の文脈を、**セッション終了（またはコンテキスト枯渇）前に外部ファイル（handoff note / context file）へ書き出し、次セッションの先頭で読み込む**方式。要約に頼らず、書き手（エージェント自身 or チーム）が**構造化された決定・状態・次アクションをそのまま残す**
- 「ハンドオフは日記ではない」——ゴール・現在地・触ったファイル・検証済みの証拠・残リスク・次のプロンプト、を簡潔に残す操作メモ

### 実例1: session-handoff スキル（agentskills.me / softaworks）

- トリガー: ユーザーがハンドオフ要求 / **コンテキスト窓が容量に近づいた** / 主要マイルストーン完了 / セッション終了 /「保存して」「pause」/ 再開時は「load handoff」「resume from」
- 内容: 完全な文脈・決定・状態をハンドオフ文書化し、新しいエージェントがゼロ曖昧で続行できるようにする。**「長期エージェントのコンテキスト枯渇問題を解決する」**ことが明示的な目的
- コミュニティ版 `/handoff`（veritas501/agent-handoff）: Claude Codeで長セッションがコンテキスト上限に達し、応答劣化・自動圧縮・重要詳細の喪失が起きたとき、**構造化された文脈要約を生成して新セッションへ貼って続行**

### 実例2: リポジトリ内での永続化（HANDOFF.md + セッションログ）

- `.agents/HANDOFF.md`（リポジトリ直下の継続点）＋ `.agents/sessions/*.json`（セッション毎ログ）の併用
- 設計原則: **リポジトリが継続点（routing bundle・ハンドオフ要約・信頼レポート・変更ファイル・現在の真実のルール）を保持する**。次のエージェントは**チャットの要約を参考情報として扱い、重要な挙動はソースを読み直す**（チャットの言い回しを真実としない）
- 現状の真実はファイル側に置く（bantoのD3「状態の真実は一箇所」と同型の発想）

### 実例3: 開発チームのハンドオフ文化

- クラウドの破棄可能な環境・非同期チーム（squad rotation 等）では、**次に作業する人が不明でも動作する**ハンドオフメモが必須。構成要素は共通: 目的 / 現在の状態 / 変更ファイル / 検証方法（コマンド） / ブロッカー / 次の一手
- Claude Codeコミュニティのテンプレートも同型（goal・current state・files touched・verification evidence・remaining risks・next prompt）

### banto との関係

- **banto は既にこの文化を持っている**: `docs/notes/handoff.md`（「セッションを跨ぐときはここから」）と `packages/banto-host/skills/work-handoff/SKILL.md`（ADR/spec確定時の work/ 起票＋定期棚卸し）が実装済み。職人のスコープでは `worker__report` が同型の機能（完了報告＝検証へ回す合図）
- 番頭のターンループのコンテキストクリア（POの仮説）は、まさにこの「セッション境界で何を残すか」をどう自動化するかの問題

### コンパクションとの関係・得失

- コンパクション＝LLMによる**損失あり圧縮**（要約）に対し、ハンドオフノートは**決定論的な書き出し**（エージェントが構造化テンプレートに記入）——書いた情報はそのまま残り、要約の情報損失がない
- 得失:
  - 利点: 情報の完全性・監査可能性（何を残したか可視）。要約の品質・要約モデルに依存しない。チーム/エージェント間の協業がゼロ曖昧になる
  - 欠点: **メンテナンス規律が要る**（書かなければ消える＝トリガーの設計が命）。書き忘れ・陳腐化（時間が経って内容が古くなる）のリスク。P3でいう「静かに劣化する」性質——棚卸し（bantoの work-handoff 手順2）で検出する仕組みが要る

### 参照

- session-handoff スキル（agentskills.me）: https://agentskills.me/skill/session-handoff
- softaworks/agent-toolkit（session-handoff README）: https://github.com/softaworks/agent-toolkit/blob/main/skills/session-handoff/README.md
- veritas501/agent-handoff（Claude Code用 /handoff）: https://github.com/veritas501/agent-handoff
- リポジトリ内ハンドオフの設計メモ: https://pro2pilot.com/knowledge/technical-notes/agent-handoff-between-coding-sessions/
- Session Logs and HANDOFF.md（DeepWiki）: https://deepwiki.com/rjmurillo/ai-agents/4.6-session-logs-and-handoff.md
- Claude Codeハンドオフテンプレート解説: https://claudecode-lab.com/en/blog/claude-code-session-handoff-template/

---

## 7. banto への示唆

### 7.1 POの仮説（外部ファイル＋段階的開示＋コンテキストクリア）は既存のどの方式に近いか

POの仮説は、次の方式の**合成**に最も近い:

- **Claude Code の auto memory（MEMORY.md 索引＋トピックファイル）**にほぼ一致する。外部の平文ファイルに記憶を置き、**索引だけ常時・詳細はオンデマンド**という構造はそのまま同じ。200行/25KBの索引上限は「常時注入量の上限を設計で決める」実践的な先例
- **段階的開示（§5）**の三層ロード（メタデータ→本体→リソース）は、banto が**SKILLで既に実装済み**の方式——これを記憶（好み・習慣・事実）と「引き継ぎ文脈」へ拡張するのが仮説の正体
- **ハンドオフ方式（§6）**が「コンテキストクリアのときに何を残すか」の運用手順を与える。banto は `docs/notes/handoff.md` と work-handoff SKILL という基盤を既に持つ

### 7.2 各方式が仮説の弱点をどう補うか

| 弱点（仮説の穴） | 補う方式 | 補い方 |
|---|---|---|
| 外部ファイルに**書かなかった情報は消える**（会話の詳細・経緯・過去の失敗） | Hermes の session search（FTS5全文検索） | 会話全文を検索可能な形で残し、必要なとき正確に引く。「要約で潰す」代わりに「検索で取り出す」が、コンパクション回避の主候補。CJK対応（trigram/cjkトークナイザ）も参考になる |
| ファイルの**陳腐化・書き忘れ**（メンテ規律がないと静かに劣化） | Hermes の記憶衛生ルール＋banto の work-handoff 棚卸し | 「1週間以内に期限切れになるものは保存しない」「宣言的事実に書き換える」「手順はスキルへ」等の保存規律。棚卸しで古い文脈を検出（banto は既にP3で incident 化する仕組みを持つ） |
| **索引が大きくなると常時注入量が再び膨らむ** | Claude Code の MEMORY.md 運用 | 索引の上限（200行/25KB）を明示し、超過時は書き直しを要求する強制力。索引を「1行1エントリ＋詳細はトピックファイル」に保つ規律 |
| **コンパクションが起きても情報を失わない**保証 | Claude Code の「コンパクション後にファイルから再注入」 | ファイルに置いた記憶・文脈はコンパクションを生き残る（要約に巻き込まれない）。プロジェクト直下の記憶ファイルは再読込される実例 |
| 全文注入方式の**スケール限界** | ChatGPT の実例 | 現行 banto（全文注入）は ChatGPT の User Memory 全件注入と同型。33件程度なら機能するが増えると破綻する、という上限の実証例。「ファクト＞要約＞履歴」の注入優先順位は参考 |
| **検索と段階的開示の中間**（何を常時載せるかの判断） | MemGPT の自己管理＋圧迫警告 | エージェントが自ら「今コンテキストに何を保つか」を決める（working context の書き換え、memory pressure での退避判断）。banto の「番頭が skill.read で自分で読む」自己管理はこの思想に近い。ただし自前検索API・heartbeat ループは過剰設計の恐れ——**banto では「ファイル読み」で十分というのが仮説の立場** |
| クリア後の**引き継ぎの質** | ハンドオフ方式（§6） | クリア時に「ゴール・現在地・決定・未決・次の一手」を構造化テンプレートで書いてからクリアする。要約より損失が少ない（決定論的書き出し）。既存の `docs/notes/handoff.md`・work-handoff SKILL・`worker__report` と同型の規律 |
| 保存対象の**分類の安定性** | Hermes の三層分類 | durable facts / skills / session search の分離は、banto の MemoryKind（fact / preference / habit）＋ SKILL（手続き）＋ セッションログ（エピソード）の3分類と**構造的に一致**している（ADR-0010 決定10 が「設計のみ踏襲」とした理由が今回の調査で裏付けられた） |

### 7.3 結論としての整理（PO裁定待ちの論点）

- **外部ファイル＋段階的開示＋コンテキストクリアの仮説は、業界の複数実装が既に取っている方向と一致**しており、新奇な設計ではない。特に Claude Code の auto memory と Hermes の三層が最も近い先例
- 仮説を成立させるには次の3点の設計判断が要る（本メモは調査のみで決定しない）:
  1. **常時注入する索引の形式と上限**（Claude Code 式の「索引＋トピックファイル・200行上限」を採るか）
  2. **クリア対象の会話をどう残すか**（捨てる・要約する・全文を検索可能な形で保存する——Hermes の FTS5 方式が唯一「損失なく検索可能」を実現している）
  3. **コンテキストクリアのトリガーと、クリア時に書くハンドオフのテンプレート**（ハンドオフ方式の規律を work-handoff SKILL へどう組み込むか）
- 注意点: Hermes の実運用報告では「要約モデルより小さいコンテキストで要約失敗→黙って破棄」のような失敗モードもあり、**要約経路を完全に無くすか、検索可能な保存を併用するか**は、po の「コンパクションはイマイチ」への回答の分かれ目になる

---

## 付録: 調査時の情報源の信頼性

- 公式ドキュメント・GitHub リポジトリ・実装ソースを一次情報として使用（Hermes の architecture.md / session-storage.md / context-compression-and-caching.md はリポジトリの生ソースを取得して確認）
- Letta は DeepWiki（リポジトリ自動解析）を使用。論文（arXiv）は一次資料
- ChatGPT の4層構造は公式発表ではなく**逆解析記事**（llmrefs.com）に基づく。公式発表（Memory FAQ・Dreaming）と整合する範囲で記述した。実装の詳細（件数・順序）は逆解析の推定であり確定情報ではない
- ハンドオフ・段階的開示は複数の独立した実装（agentskills.me・microsoft/agent-skills・コミュニティ記事）で確認し、共通パターンとして記述
