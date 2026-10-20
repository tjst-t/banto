# 空いた会話の冷める前の要約（#473 idle-cache-compaction）の実装で決めたこと・人に確かめたいこと

正本は `docs/specs/v4-architecture.md` §3.1「冷める前の要約（host）」と v4-frontend.md §6.52。ここは実装の経緯と、仕様に書かれていない
細部の解釈。温め直し（#472）の細部は `2026-10-20-idle-cache-keepalive-impl.md`。

## 形

- `delivery/idle-compaction.ts`（`IdleCompactions`）：温め直しの様子（`relay.keepAlive.cacheOf`）から予定（最後の本物の要求の開始＋225分）
  を立て、時刻が来たら「当たっているか」を確かめて要約のターンを回す。温め直しの様子が変わるたびに中継が知らせる（`keepAliveOnChange`
  → `refresh`）。取りやめ（`cancel`）・画面への知らせ（`idle_compaction.changed`）・起動時に切れた要約の記録を締める（`start`）
- 要約のターン：`turn-runner.ts` の `idleCompaction`。**tool・system prompt・モデル・effort はふつうのターンと同じに組む**（同じセッションの
  直前のキャッシュに当たるため。tool の一覧と system はキャッシュの前方一致に入る）。prompt は `/compact` だけ（前に文脈を足すと slash
  command として読まれない）。Stop hook・まとめの終わらせ方は渡さない、承認と Elicitation は人に聞かずに断る
- 鍵：`ThreadTurns.tryAcquireForIdleCompaction`。人のターンと同じ鍵なので、人が要約中に送れば終わるまで並び、届いたものは終わってから
  起こす（`ThreadDeliveries` は終わりの知らせで `kick`）。`TurnChange.idleCompaction` を聞き手が見て、画面の「走っている」・受信箱・任務・
  判断役・温め直しの「温めてよい」を飛ばす
- 記録：`turn.started` の cause `idle-compaction` は **`lastTurn` に入れず `ThreadState.idleCompactionTurn` に畳む**（下の解釈 1）。
  `thread.compacted` に `reason: "idle"` を足し、fold が `markers` に `{ kind: "compact", reason: "idle" }` を足す
- 温め直し（keep-alive.ts）に足したもの：`CacheState.baseAt`（予定の基準）・`totalWarms`／`totalWarmTokens`（メーター）・`onChange`。
  200 分の温め直しのあとは本文を捨てずに**250 分まで持つ**（取りやめたら続けるため。取りやめが無ければ 250 分に捨てる）。`extend` で
  4時間を越えて 50 分ごとに続ける
- E2E：`idle-cache-compaction.spec.ts`。帯の5分は `BANTO_TEST_IDLE_COMPACTION_NOTICE_MS`（host が `noticeAt` で渡す）で伸ばす——1分を
  200ms にすると5分が1秒しかなく、画面を操作しきれない

## 解釈（人に確かめたい）

1. **要約のターンを `lastTurn` に入れない**。仕様は「新しい cause のターン」とだけ言う。`lastTurn` は受信箱のレビュー待ちのカードの中身
   （`reviewTurnOf`）・上限の待ちと帯（`rateLimitWaitOf`・`rateLimitStopOf`）・起こし直しで切れたターンの続き・自動化の回のカード
   が読んでいる——要約のターンが入ると、人がまだ見ていない前のターンのカードが空の要約のターンを指し、上限の待ちが消える。なので
   `idleCompactionTurn` に分け、それらに触れないようにした。切れた要約は起動時に `failed` で締める（続けない）
2. **帯の時刻は host が決める**（`noticeAt` を渡す）。仕様の口は `idleCompactionAt` だけだが、画面が「5分」を持つと E2E で縮めた1分と
   合わない。`idleCompactionAt` は会話の中身に載せ、`idleCompaction`（予定・帯の時刻・要約している・回数）も一緒に返す
3. **取りやめたあとの温め直しに終わりを付けていない**（仕様どおり「上限の中で」50 分ごと）。人が帯で取りやめてそのまま戻らないと、
   次の人のターンまで温め続ける（5時間の窓の上限・同時 20 本で止まる）。8時間などで打ち切るなら `keep-alive.ts` の `dueAt`
4. **取りやめの合図**は、帯が出ている間の「入力欄で文字を打つ（1文字・変換・Enter・消す）」と「会話の面の中の click」。click は
   スクロール（ホイール・指で動かす）では来ないので、それで「スクロールを除く」にした。帯が出る前に打っても取りやめない（帯の
   5分前より前に人が戻って送れば、ターンが始まって予定ごと消える）
5. **要約が SDK から返らなかった**（compact_boundary が来ない）ときはターンを failed にしてログに残す。会話に印は出さない
6. **上限で止まったターンの会話も要約しうる**（`lastTurn` に触れないので、待ちはそのまま。続けるときは要約のあとの会話を resume する）。
   上限の待ちがある会話は 4 時間の間に続けることが多いので、ふつうは先に次のターンが始まって予定が消える
7. 画面は、要約が終わった知らせで開いている会話を**記録から組み直す**（印は記録にしか無い）。4時間空いたあとなので、流れたターンの
   tool のカードを組み直しで失ってもよいと判断した（リロードと同じ）
