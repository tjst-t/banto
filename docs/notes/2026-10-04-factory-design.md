# Factory の設計（2026-10-03〜04）

仕様は `docs/specs/v4-modules.md` §4.5。ここは経緯と、仕様を書くときに調べたこと。

## 経緯

- **2026-10-03**：ユーザー「Backlog に乗せたタスクを SubAgent で worktree で開発して、別の Agent にレビューさせて、問題なければ
  マージする。SubAgent でいいのか、Thread に任せて必要ならその中で SubAgent を呼ぶのでもいいのかも。そうなると Factory の
  必要性も低い気がする」
- 整理：**考える仕事（実装・レビュー・テストを直す）は AI、手順（Backlog から取る・worktree・テストの関門・別の AI のレビュー・
  main への1本ずつの取り込み・Backlog を進める）はコード**。後者を AI の指示に任せると、テストを飛ばす・Backlog の更新を
  忘れる・2本が同時に main に入って競合する。要件 B5（再開）・B6（追える）・B7（順序づけ）は指示では保証できない
  → Factory は「賢いエージェント」ではなく**手順を守らせる薄いレール**として要る
- 人が見たい範囲（ユーザー）：**基本は終わったら知ればよい。長引いたときは中身を覗きたい**
- ユーザー「Claude Code の Dynamic Workflow っぽい感じがいいのかな」→ 調べた（下）→ **形を借りて自前で作る**（決定・10-04）
- 10-04 の追加決定：Project ごとにつけて Subagent の tool を中継で呼ぶ／段はたたき台のまま／流し始めは AI の tool から／
  マージ前に人を待たない

## Claude Code の Dynamic Workflows（2026-10-03 に調べた）

出典：https://code.claude.com/docs/en/workflows

- Claude がその仕事用の JavaScript を書き、runtime が会話と別の場所で背景で動かす。`agent()` で1体、`pipeline()`・
  `parallel()` で並べる、`phase()` で進み具合の画面の段を切る、`log()`
- 次に何をするかを決めるのはスクリプト。途中の結果はスクリプトの変数に入り、会話の文脈に溜まらない
- `agent()` に `schema` を渡すと決まった形の JSON で返させる（形が合わなければ5回までやり直させる）
- スクリプトの中では `Date.now()`・`Math.random()`・引数なしの `new Date()` が投げる——**流し直したとき同じ `agent()` の
  呼び出しが同じ順に起きるように**。流し直すと、終わった agent は保存した結果を返す。プロンプトが前と違う最初の agent
  から後は全部やり直す。失敗した agent から後も全部やり直す
- 進み具合の画面：段ごとの agent 数・トークン・時間、1体ずつ開くと頼んだ内容・最近の tool・結果。止める・1体やり直す・
  一時停止
- 走っている間は人が口を挟めない（止まるのは権限の確認と使用量の上限だけ）。人の承認を挟みたいなら段ごとに別の Workflow
- 同時に 16 体まで、1回で 1,000 体まで

**そのまま使わない理由**：再開できるのは同じ Claude Code のセッションの中だけ（banto の host を起こし直して続くか怪しい）／
起こせるのは Claude だけ（OpenCode 等にレビューさせられない）／実行をまたいで main への入り方を揃える仕組みが無い（B7）／
途中で人を待てない（banto なら判断待ち・Thread への知らせで待てる）。また Factory の流れは毎回同じなので、
「Claude がその場で書く」部分は要ではない。

## 実装役をサブエージェントにした理由

| | サブエージェント | Thread（Fork） |
|---|---|---|
| 人を待たない（B4 の既定） | 合う | 承認のたびに止まりうる |
| 途中で人が口を出す | 止めて、同じセッションに指示を足して頼み直す（`sessionId`） | できる |
| 10件並べたとき | 実行の一覧に収まる | サイドバーに Fork が 10 本 |
| 長引いたとき覗く | Subagent の実行画面（tool の経過がその場で出る）と Factory の画面 | 会話を開く |

「Thread に引き継いで人と会話する」は最初は作らない。止めて指示を足して続けるで足りなくなったら考える。

## 仕様を書くときに調べたこと（2026-10-04）

### Module から Subagent を呼ぶ口（`subagent-from-modules`）の残り

`docs/notes/2026-09-25-thread-delivery.md` の「別の Module から呼ぶための残り2つ」。**Factory がその最初の Module になる**
（09-26 の決定どおり、呼ぶ Module を作るときに一緒にやる）。

- ② 中継の時間の上限：`relayCallTool` が宛先をオプション無しで呼ぶので MCP の既定 60 秒で切れる（コードを読んだ結論。
  直す前に測る）。**Factory は待たない形（`runInBackground`）しか使わない**ので、Factory だけなら当たらない——ただし
  直すのは同じタスクで（他の Module が待つ形で呼ぶとき困る）
- ③ 札の宛先に Module：いまは中継の呼び出しに札が無く、`runInBackground` は「届ける先がありません」で断られる。
  **Factory はこれが無いと動かない**

### Subagent の側に足りないもの（2026-10-04 にコードを読んだ）

`packages/modules/subagent/src/server.ts`・`acp-run.ts`：

- **作業する場所を選べない**：ACP の `session/new` の `cwd` はいつも Project の root。worktree で働かせるには `cwd`
  （root の中だけ）が要る
- **決まった形で返させる口が無い**：最後の返答は文だけ。レビューの判定に要る
- **止める口が Thread からだけ**：`cancelSubagent` は呼び出しの印の Project・Thread と頼んだ記録の両方が一致したときだけ
  止める。中継の呼び出しには Thread の印が無いので Factory からは止められない——呼んだ Module で一致させる形が要る
- サブエージェントが人に確認を求めたら断る（いまの形）。Factory ではこれでよい——承認を求めずに済む道具の範囲で働かせる

### 判断待ちの出し方

Module が受信箱に判断待ちを立てる一般の口はまだ無い（`relayRaiseNotice` は banto 本体で動く同梱の banto 全体の Module だけで、
お知らせ）。Factory は**頼んだ Thread への知らせ**（札）で止まったことを届ける——AI が起きて人に説明し、人の答えを
Factory の tool で渡す。受信箱の判断待ちにしないのは、新しい口を作らずに済むのと、事情を一番知っているのが頼んだ会話だから。

## 本物での受け入れ（2026-10-07、Backlog の factory-acceptance）

稼働中の banto に試験用の Project「Factory 受け入れ」（banto の根の `tmp-factory-accept`、小さな文字列の道具・`npm test`）を作り、
会話の AI（Opus 5.5）に runFactory で3件ずつ流させた。実装役・レビュー役は本物の Claude Code（sonnet）。

| 回 | 版 | 結果 |
|---|---|---|
| 1 | 407bb2c8 | capitalize は止まらず入った。わざと落とした reverse-words（テストのコマンドが worktree の名前で落ちる）は2回落ちて止まり、会話に知らせ、その間ほかは進んだ。slugify は取り込みで**競合して止まった**——同じファイル（src/index.js）の末尾に関数を1つずつ足す2件は、ほぼ必ず競合する。会話の AI が worktree で解いて「続ける」と答え、入った（2／3） |
| 2 | 99958116 | truncate・countWords・isPalindrome を流し、**実装の段の途中で人が banto を起こし直した**。実装役の3本は頼み直さずに続き（Subagent の記録に「起こし直したため途中で切れ、続きから再開しました（1 回目）」）、テスト（`sleep 60 && npm test`）・レビューを通り、2件は取り込みで競合したが**実装役が解いて**（count-words は2回）、人に聞かずに3件とも main に入った。最後に「取り込み 3／3 件」が会話に届いた |

見つけて直したもの：
- **競合したらまず実装役に解かせる**（5605dd9f、`limits.conflictFixes` 既定2）——1回目の slugify
- 止まっていない1件への answerFactory・走っていない1件への cancelFactory が HTTP 500（99958116）
- **REBASE_HEAD は rebase を終えたあとも残る**——実装役が終えた rebase を毎回「途中で残した」と数えて `rebase --abort` していた
  （何もしない abort なので害は無かったが記録が誤り）。rebase-merge・rebase-apply のフォルダで見るように直した
