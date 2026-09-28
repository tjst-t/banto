# 会話の面が作り直されると、最新・書きかけ・位置が消える（2026-09-28）

ユーザー報告：設定で Escape が「戻る」になる／Thread を開くと上のほうに出る／最新が消える（リロードで直る）
／Canvas・Fork を閉じると位置が飛ぶ／書きかけが消える。「Thread 周りの仕組みは怪しい」ので Fable
（claude-fable-5-1）のサブエージェントにコードを読ませてレビューさせた。

## 測ったこと（`e2e/specs/thread-view-persist.spec.ts`、コンテナの中で E2E を回した）

- 直す前：最後まで流した会話で設定へ行って戻ると、**会話が空**（返事0件）。原因は `latest-state.ts` の
  `shownThrough` が長さだけを覚え、面の作り直しをまたいで生き残ること——新しい面は古い写しから作られ、
  「もう最新を見せた」扱いで取り直さない。Fable もコードから同じ結論（独立に）
- Fork＋Canvas を開いて閉じると Base は作り直され、4887px 下へ飛んだ。scrollTop で覚えると、Canvas で
  細くなったときの値を元の幅で当てて 720px ずれた → メッセージとその中の比率で覚える形にした
- 走っている Thread を開くと、最新のターンの頭（人の発言が上端）で止まり、返事が伸びても追いかけない
  （8秒後に一番下から 1138px 上）。`turnAnchor="top"` の設計どおり。**「開くと上のほう」はこれ**

## 直したもの

仕様は `docs/specs/v4-frontend.md` §6.8・§6.9・§6.28。コミット 38cb0346・14622825。

- 写しを見せている記録に揃える（面が閉じる・開くとき）
- 書きかけを Thread ごとに localStorage へ
- 読んでいた場所を Thread ごとに覚える（Project の画面を離れたら忘れる）
- 設定の Escape は入る前の画面へ
- Fable 指摘：`showLatestOnce` の TOCTOU（取りに行く間に人が送ると、送ったターンを捨てる）

## Fable の指摘で、まだ手を付けていないもの

- **組み直し＝作り直し（key 変更で remount）をやめ、同じランタイムへ差分を import する**——composer・
  展開状態・スクロールが残り、捨てられた run の後片づけ漏れも消える。根本対策だが大きい
- 写しを唯一の入力にするなら常に最新にし、`shownThrough` をやめる（目印の置き場は runtime の messages から引く）
- パネルの木の形が構成で変わる（`ThreeLayerStack` と `ResizablePanelGroup`）——見えない層は捨てずに隠す。
  携帯で Fork の上に Canvas を開くと Fork は作り直される（書きかけ・位置は今回の仕組みで戻る）
- ターンが終わっても top-anchor の余白（reserve）が残る
- `KeepScrollPositionOnResize` の初期 `lastScrollTop` が 0 のまま高さ変化を受けうる（携帯、推測）
- `scroll-smooth` と smooth スクロールの重なり、remount ごとの autoFocus（携帯でキーボードが開く）
