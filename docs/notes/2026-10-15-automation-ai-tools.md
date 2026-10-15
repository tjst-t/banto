# AI が自動化を作る tool の実装で決めた細部（2026-10-15、Backlog #319 `automation-ai-tools`）

アーキ仕様 §4.3「人と AI の作り方」・frontend §6.42「AI が作るときのカード」を実装したときに、仕様に書かれていない細部を
決めた。仕様 §4.3・§6.42 はこのブランチには無く `main` にある（abafa075）——仕様書への反映は取り込むときに人が判断する（規則8）。

## 決めたこと

- **置き場**：中身（確かめ・カード・台帳への書き込み）は `automation/tools.ts`（`AutomationTools`）、tool の形は
  `http/fork-tool.ts`（`banto-thread`）。入力の確かめは台帳（`store.ts`）の `parseAutomationFields`・`parseAutomationChanges`
  を画面の口と共有する。届け先が既存の Thread のときの「この Project の開いているものか」は `app.ts` と同じ決まりを tools にも持つ
- **カードの出し方**：Project をまたぐメッセージの確認（`delivery/thread-messages.ts` の `ask`）と同じ形——受信箱に判断待ちを出し、
  走っているターンへ `judgment` を流し、`PendingApprovalRegistry` で答えを待つ。止められたら待つのをやめて判断待ちを畳む。
  発生源（`JudgmentSource`）に `automation` を足した。`serverName` は `banto`。**`autoApproveAll` を渡さない**——自動許可を見る道が無い
- **2回聞かない**：5つの tool は `allowedTools` に載せ、Runner の承認（canUseTool）を通さない。承認モードが default のとき、
  tool の承認と自動化の確認の2枚が出るのを避ける。作る・変える・再開するは tool の中で必ず聞くので、緩めたことにはならない
- **聞く前に確かめる**：入力が決まりに合わない（cron が15分より短い・届け先が無い等）ものは、カードを出さずに断る
  ——人が許したあとで「入力が違う」と断らない
- **選択肢の言葉**：作る「作る／作らない」・変える「変える／変えない」・再開する「再開する／再開しない」。画面は「作る」「変える」
  「再開する」を許可に写す（`adapter.ts` の `ALLOW_ANSWERS`）。カードの「回答：…」は、**選択肢の先頭を許可の言葉**とみなして
  それを出す（`judgmentAnswerText(answer, choices)`）——以前は許したものを一律「許可する」と出しており、「作る」を押したカードが
  会話を組み直したあと「回答：許可する」になった（E2E で発覚）
- **変えるときのカード**は、変わる欄だけを「前 → 後」で出す（指示は新しい全文）
- **AI に返す形は欄を選んで組む**（`automationForAi`）。台帳の形をそのまま渡さない——Webhook の印のような AI に渡さない欄を
  後から足しても、黙って漏れない。直近の回は1件だけ添える
- **触れるのは呼んだ Thread の Project の自動化だけ**。ほかの Project の id を渡されたら「この Project に無い」と返す（あるかを漏らさない）
- 一時停止の理由は「AI が一時停止しました」（人が押したときは「人が一時停止しました」）

## 残したこと

- カードの「作ったら『一覧を開く』」は出していない——自動化の画面（`automation-canvas`）がまだ無く、繋がっていないボタンになる
  （規則13）。画面ができたら、答え済みのカードに足す
- 一覧の画面での「作った人（AI が作ったものは頼まれた会話と『あなたが許可しました』）」は `automation-canvas` で出す。台帳には
  `createdBy: { kind: "ai", threadId }` が入っている
