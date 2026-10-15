# 受信箱の見直しの本実装（2026-10-15、Backlog #300）

仕様はアーキ §2.4「受信箱は『あなたの番になったもの』だけ」・§2.2「ターンの終わりのまとめ」（report_turn の url）と
v4-frontend.md §6.41。見本はモック（`mock/components/banto/inbox/inbox-page.tsx`）。ここは実装で決めたことと理由だけ。

## host

- **レビュー待ちを出す条件**（`inbox/review-turn.ts` の `reviewDueAfterTurn`）：ターンの終わり（`ThreadTurns` の ended）の時点で、
  その Thread の `awaitingReplies` も `deliveries` も空なら出す。**「途中で切れた・失敗した」は `lastTurn.outcome` が
  `completed` 以外**（`stopped`・`failed`、終わりが書かれていない＝`interrupted`）。人が止めた（`stopped`）も「切れた」に
  入れた——残りがあっても出す。止めた人は会話を開いていることが多く、開いている会話では画面が「見た」にするので、
  余計には出ない。ended の時点で `turn.ended` はもう書かれている（`runThreadTurn` の finally で書いてから鍵を返す）
- **届くたびのお知らせ**：`deliver` の `notify` を外した。held のときだけ出すなら、呼ぶ側が「出さない」を選ぶ場面が
  残らない（held は必ず人に知らせる——それまでも `notify: false` でも held なら出していた）
- **ターンの中身**（`GET /api/inbox` の `turn`）：`reply` は**最後に始めたターンより後ろ**の AI の発言だけ。返事を書く前に
  切れたターンで、前のターンの返事を出さない。`request` の代わり（まとめが無いとき）は、届いたもの（`origin` 付き）を除いた
  人の最後の発言
- **tool の数**：Event Store には tool の呼び出しの記録が無い（画面つきの tool だけ）。形を変えないため、**CLI の会話の記録
  （SDK の `getSessionMessages`）から数える**（`ReviewToolCounter`）。数えるのは `lastTurn.resumePointUpdated`（CLI の側で
  最後まで行った）のときだけ——そうでなければ鎖の末尾は前のターン。最後の人の側の発言より後ろの `tool_use` を数え、
  `report_turn`・`remember_decision` は数えない（Stop hook の作業の数え方と同じ）。受信箱は出来事のたびに読み直されるので、
  同じ resume-point なら数え直さない
  - **確かめていない**：Stop hook の差し戻しが会話の鎖にどう残るか（user の発言として「Stop hook feedback」で始まると
    みなして飛ばしている）。違えば差し戻しより前の tool を数えない
- **コンテナの上限**：`ContainerPressureWatch` は残し、`notify` を `report` にして host はログ（`console.warn`）へ書く。
  設定の「資源」の記録（`resources.ts` の hits）は前からあるので、E2E はそちらで見る

## 画面

- 受信箱の面は app-shell の中身の枠に `absolute inset-0 z-20`（設定の面 z-30 より下）。下の会話は inert・aria-hidden で
  残す。Escape・j/k などのキーは受信箱が自分で聞き、ほかの Dialog（Palette 等）が開いていれば聞かない
  （`isOverlayOpen({ exceptInbox })`）。panel-stack と設定の面は、受信箱を「上に開いているもの」と数える（同じ印）
- **返信を送る口**：`sendRealThreadMessage`——会話と同じ `POST /api/threads/:id/messages` を送り、200 が返ったら本文を
  読まずに閉じる。host はこの口で画面が切れてもターンを最後まで回す（req の close を見ていない）。E2E
  （`inbox-page.spec.ts`）で、閉じたあとにそのターンが `completed` まで行くことを見た。開いている会話には `turn.started` で
  最新が出る（`latest-state.ts`）ので、受信箱から送っても下の会話はずれない
- **判断待ちの答え方**：承認（tool・中継・メッセージ）は全部、受信箱で答えられるようにした（それまでは中継だけ）。答える口は
  同じ（`answerRealJudgment`）。**Elicitation 由来は答えるボタンを出さない**——host に受信箱から答える口が無く（会話の
  カードも答えられない）、出すと押しても 409 になる（規則13）。「会話を開いて答えてください」とだけ出す
- **バッジ**：判断待ち＋「決めることがある」返ってきた会話。お知らせは数えなくなった（§6.41 のとおり。それまでは
  「Module が繋がらないことに気づける場所がここだけ」として数えていた——2026-09-07）
- 「まとめて確認」は見出しの右に残した（モックには無いが、§6.41 は外すとは言っていない。既存の E2E が使っている）
- 返事の本文は会話の Markdown の部品（`MarkdownText`）を `TextMessagePartProvider` で包んで使う（リンクは別タブ）
- 字の大きさはモックの任意値（`text-[13px]` 等）を banto の段（xs 11・sm 12・md 13・lg 15）に置き換えた
  （`check-tokens.mjs` が任意値を落とす）

## 全部のカードから行き先へ（同日追記、ユーザー「全部のイベントから関連する会話にジャンプしたい」）

- それまで：お知らせのカードには口が無く（`NoticeItem` は `projectId` だけ）、判断待ち・返ってきた会話も画面の手元に Thread が
  無い（読み込み前）と口が出なかった
- host：`NoticeItem.threadId`（任意）を足した。**重ならない鍵には入れない**——同じことは会話が違っても1件のまま
  （例：Module を繋げないは、どの会話で気づいたかが本質ではない）。`GET /api/inbox` は返すときに `projectId`・`threadKind` を
  添える（Event Store の形は変えない）
- **Module の `relayRaiseNotice` は、呼び出しの印（`dev.banto/callId`）が付いていて1つの会話を指すときだけ**会話を添える。
  印が無いときに接続で走っている呼び出しから引く（`threadFor` の印なしの選び方）と、裏で起きた失敗に、たまたま同じ Module を
  呼んでいた別の会話を付けてしまう——付けないほうを選んだ。依頼文は「host が刻む Thread の印 dev.banto/thread」と書いて
  いたが、そういう印は無く、host が刻むのは `dev.banto/callId`（台帳がその呼び出しの Thread を知っている）だった
- 付けなかったもの：Module を繋げない（Project ごと・banto 全体）・コンテナを止められない・別の実行場所の注意／移せない
  （Project だけ）・本体の Claude ログイン切れ（banto 全体）
- 画面の行き先：Thread → その会話／Project だけ → その Project／banto 全体の Module のもの → 設定の Module 一覧
  （`/settings?section=roles`。繋がっているかと理由が出る）。**本体の Claude ログイン切れには口を出さない**——依頼は「設定へ」
  だったが、banto の設定に本体の Claude ログインを直す面は無い（直すのは banto を動かしている端末で `claude` を起こすこと。
  Project 設定の「Claude のログイン」は Project ごとの中継のオン／オフと直近の 401 を見せるだけ）。行き先の無い口は出さない（規則13）
- 閉じた Fork：一覧の読み込み（`hydrateRealProjects`）が閉じた Fork も登録しているので、`?fork=` でそのまま開き、「閉じました」の
  帯が出る。別の道は作らなかった
