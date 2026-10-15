# 自動化の届け方の実装で決めた細部（2026-10-15、Backlog #315 `automation-deliver`）

アーキ仕様 §4.3「判断は届ける口の手前に置く」「専用の Fork」を実装したときに、仕様に書かれていない細部を決めた。
仕様 §4.3 はこのブランチ（`factory/automation-deliver`）には無く `main` にある（abafa075）——仕様書への反映は
取り込むときに人が判断する（規則8）。

## 決めたこと

- **置き場**：`banto/packages/core/src/automation/runner.ts`（`AutomationRunner`）。`deliver` は変えず、`DeliverInput` に
  `kind: "automation"` と `automation: { id, runId }` を足しただけ
- **Clear のための鍵**：`ThreadTurns.tryHold` を足した。`tryAcquire` で鍵を取ると `started`・`ended` が出て、
  受信箱のレビュー待ち（ターンの終わり）・画面の「走り始めた」・届いたものの `kick` まで動く——ターンではない一瞬の
  Clear でそれを起こさないため。押さえている間は `tryAcquire` も取れず、人は並び、返すと鍵がそのまま人に渡る
- **乗り換えの回数**：`AUTOMATION_FORK_RUNS = 48`（1時間ごとなら2日で1本）。仮置き。数えるのは fold の `threadRuns`
  ——`runs` は 50 件で切れるので、そこから数え直さない。飛ばした回・断った回は数えない。前の回を引き継ぐ自動化は、
  古い Fork の会話を引き継いで新しい Fork を立てる
- **閉じた専用の Fork のまま再開したら**、新しい Fork を立てる（閉じた Fork は開き直さない）。一時停止のままでは立てない
- **AI が自分で専用の Fork を閉じた**ときも、人が閉じたときと同じく一時停止して知らせる（閉じる口 `closeThreadAndTell`
  を通るもの全部）。乗り換えで閉じるのは通らない
- **「今すぐ動かす」の応答**：届けなかった（閉じている・移している等）ときも 202 で `{ runId, result: "skipped", reason }`。
  前の回が終わっていないときは今までどおり HTTP の口が 409 で先に断る（台帳には残さない）
- **結末の判定**：ターンの終わり（`ended`）で、その Thread の `running` の回のうち届けたものが積み終わっているものに
  `lastTurn.outcome` を書く。completed で生きた判断待ちが残っていれば `waiting`、stopped・failed は `failed`
- **届けたが起こせなかった**（`deliver` が held——起こし直しの留め・連鎖の上限）ときは `skipped` に理由を書く。
  届けたものは溜まったまま、人が次に送ったターンの頭に積まれる
- 送り手（`from`）は `banto`、題は「自動化「名前」」。AI への前置きは「人が決めた（または確かめた）指示」として従わせる

## 残したこと

- 自動化のターンもホップ 0 で起きるので、`cli.ts` の「人が送ったターン（hop 0）が始まったらレビュー待ちを見たにする」に
  当たる。受信箱の扱い（出す／出さない・置き換えない）は `automation-inbox` で決める
- 画面の送り手の表示は「banto から届きました」のまま。自動化らしい出し方は `automation-canvas`
- 専用の Fork は、作った時点では開いている画面のサイドバーに出ない——host が立てた Fork は最初のターンが始まった
  知らせ（`turn.started`）で一覧に入る（AI が立てた Fork と同じ）。乗り換えで閉じた古い Fork は `thread.closed` を
  流していない（`ThreadClosedBy` が ai／human しか持たない）ので、開いている画面では再読み込みまで開いた一覧に残る。
  どちらも `automation-canvas`（専用の Fork の帯）で扱う

## 追記（2026-10-15、Backlog #318 `automation-canvas`）

- 上の「残したこと」の2つ（作った直後の専用の Fork が一覧に無い・乗り換えで閉じた古い Fork が `thread.closed` を流さない）は
  `automation-canvas` で扱った。中身は `docs/notes/2026-10-15-automation-canvas.md`
