# 03-item1-backend-interface

**捨てる。本実装に流れ込ませない。**

## 問い

`docs/specs/v4-architecture.md` §10 item 1——backend Module のインタフェースの
具体形。ユーザー判断（2026-08-30）で、別ベンダの実装を1本入れて実測することに
なった。このマシンには別ベンダの Agent CLI が入っていなかったので `opencode-ai`
（npm、TypeScript製、Claude Agent SDK を一切使わない独立実装）を新規に入れた。

**目的は「core が前提にしている7項目のうち、どれが別実装でも成立するか」を
実際に確かめること**——教訓6（`prompt(): Promise<void>` は型が同じでも
「積んだ」と「終わった」で意味が違った）が正面から効く場所。

## 偽物を本物に寄せた点

- `opencode run --format json`（headless 実行、raw JSON イベント出力）を使う。
  対話 TUI ではなく、banto の host が実際に呼ぶであろう非対話の口
- モデルは `opencode/mimo-v2.5-free`（OpenCode 自身がホストする無料枠）を使った
  ——このマシンには OpenRouter の認証情報もあったが**クレジット不足で使えなかった**
  （実測：`AI_APICallError: Insufficient credits`）。モデル自体が Claude か
  どうかは本質ではない——見たいのは CLI 実装（ツールとしての契約）の違い

## 結果——core が前提にしている7項目の可否表

| core が前提にしていること | opencode（実測） |
|---|---|
| 完了前の差分 streaming | **未対応と判断**。`--format json` はプロセス実行中、標準出力へのリダイレクト先に何も書き込まれず（12秒間 0 行を確認）、**プロセス終了時にまとめて出力される**。パイプ越しの短い応答では複数行が来るが、真のトークンレベル delta かは確認できていない（**未確認**、教訓1——推測で埋めない） |
| ターン途中の割り込み（§2.3 A-2/A-3） | **未対応（少なくとも単純な OS シグナルでは）**。実行中のプロセスに `SIGINT` を送ると、標準出力は**空のまま**プロセスが終了した（exit 130）。Claude Agent SDK の `interrupt()` に相当する明示的な API は CLI 引数に見当たらなかった。`opencode serve`（HTTP API）側に別の口がある可能性は**未確認** |
| session id での resume（§2.3 A-1） | **対応**。`--session <id>` で会話を継続でき、過去の発言を正しく覚えていた。**プロンプトキャッシュも引き継がれた**（`cache.read` が前回の 11,776 → 11,904 と増加、Claude 系の `resume` と同じ傾向） |
| ターンごとのトークン・費用・キャッシュ（§2.8 A-9） | **対応**。`step_finish` イベントに `tokens: {total, input, output, reasoning, cache: {write, read}}` と `cost` が入る——Claude Agent SDK の `usage` と同形の情報が取れる |
| tool 呼び出しが host から見えるか | **対応、しかも詳細**。`tool_use` イベントに `tool` 名・`callID`・`state.input`・`state.output` が全部載る |
| elicitation / 人に聞く経路 | **非対応、明示的エラー**。`poc/02-item13-parked-elicitation/module.mjs` を MCP として繋ぎ、同じ `ask_name`（form elicitation を使う tool）を呼ばせたところ、**`"Client does not support form elicitation."` という明示的なエラーが Module 側に返った**（サーバー側のログで確認、教訓13の逆——ここは沈黙ではなく、はっきり断っていた） |
| 文脈の内訳（§10.2 の「観測の材料 済」） | **未対応と判断**。`opencode stats` はセッション履歴の集計（トークン数・費用のヒストリ）であり、Claude Agent SDK の `getContextUsage()` に相当する「いまの1ターンの内訳（system prompt/tools/messages/MCP tools 別）」を返す口は見当たらなかった |

**欠けた行（streaming・interrupt・文脈内訳）は「未対応」という明示的な値にした**
（規則2・教訓13）——「たぶん動く」で埋めない。

## §10.2「観測の材料 済」の訂正

この記述は **Claude backend（Claude Agent SDK 経由）限定の事実**であり、
core 全体の事実として書かれていたのは誤り。opencode では同等の口が無い。
**backend ごとに `getContextUsage()` 相当が「無い」ことをはっきり返せる形に
しておく必要がある**——観測できないことを、観測できているかのように見せない。

## 仕様書のどの行を更新したか

- `docs/specs/v4-architecture.md` §4.1（backend Module が core に何を渡せて
  何を渡せないかの実例）
- `docs/specs/v4-architecture.md` §10.2（「観測の材料 済」を Claude backend
  限定と明記）

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。
