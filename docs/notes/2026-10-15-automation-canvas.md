# 自動化の画面の実装で決めた細部（2026-10-15、Backlog #318 `automation-canvas`）

v4-frontend.md §6.42「自動化の画面」と §6.2 の例外（core の画面）を実装したときに、仕様に書かれていない細部を決めた。
§6.42・§6.2 の例外・アーキ仕様 §4.3 はこのブランチの履歴には無く、`origin/main` の abafa075 にある（このブランチの
`main` とは分かれている）。見本のモック（`mock/components/banto/canvas/triggers-view.tsx` ほか）も同じ。仕様書と
モックの取り込みは、両方を合わせるときに人が判断する（規則8）。§6.42 の状態「未実装」は、取り込むときに
「実装・2026-10-15、Backlog #318」へ直す。

## 決めたこと

- **置き場**：画面は `apps/frontend/components/banto/automation/`（一覧とフォーム `automations-view.tsx`、専用の Fork の帯
  `automation-band.tsx`）。写しは `lib/backend/automations.ts`。`renderCanvas`（project-panels.tsx）と `/canvas-window` は、
  `canvas=banto:triggers` を tool の結果・入口の `ui://` より前ではなく**モックの落ち先（CanvasContent）より前**で見る。
  別タブは `project` が無ければ「どの Project の自動化かが指定されていません」と出して描かない
- **写しの取り直し**：host に出来事 `automations.changed { projectId }` を足した（台帳の `AutomationStore.onChange`）。中身は
  流さず、写しを持っている画面が GET で取り直す。繋ぎ直した（`hello`）ら写しを持っている Project を全部取り直す。
  ポーリングはしない。写しを取るのは、その Project の自動化を見る面が描かれたとき（サイドバーは目次を開いている
  Project だけ・Command Palette は開いている間だけ）
- **「次は」**：GET・POST・PATCH の応答に `nextFireAt` を添える。保存しない（規則3）——`schedule.ts` の `nextFireOf` が
  数え始め（`clockFrom`）と今の遅いほうから毎回計算する。一時停止中は無い。同時本数でずらしている回は数えない
  （ずらしは時計の手元にしか無い）
- **時刻の出し方**：その自動化のタイムゾーンで「今日 9:00」「明日 9:00」「10/16(金) 9:00」。タイムゾーンの呼び名は
  ブラウザが知っている名前（「日本標準時」「協定世界時」）——仕様の例「東京時間」に寄せる表を持たない
- **作った直後の専用の Fork**：host が立てた Fork は、最初のターンの `turn.started` まで画面の一覧に無かった
  （#315 の残し）。写しに知らない専用の Fork があれば、その Project の Fork の一覧を取り直して足す
  （`registerNewRealForks`）——作った直後から「会話を開く」・サイドバーの稲妻が使える
- **乗り換えで閉じた古い Fork（#315 のレビューの持ち越し）**：`ThreadClosedBy` に `automation` を足し、乗り換えは
  `closeThread(id, { by: "automation", reason })` で閉じ、runner の `announceClosed` で `thread.closed` を流す。人・AI が
  閉じる口（`closeThreadAndTell`）は通さない——通ると「専用の Fork が閉じられた」で一時停止してしまう。履歴の閉じた
  Fork の行には理由（「自動化「…」が新しい Fork に乗り換えました」）を出す
- **今すぐ動かす**：画面では押せなくしない（台帳の `running`・`waiting` は回の終わりの時点のもので、落ちた・答えたあとも
  残る）。host が断った理由（409）・届けなかった理由（skipped）をその場に出す
- **帯の「人の番の色」**：台帳の `waiting` ではなく、受信箱の写しにその会話の判断待ちがあるかで決める（答えたら消える）
- **閉じる確認**：動いている（一時停止していない）自動化の専用の Fork は、裏の仕事が無くても確かめる。一時停止中なら
  今までどおり確かめずに閉じる
- **フォームに出さないもの**：きっかけは「決まった時刻」だけ（Webhook の選び方と欄は `automation-webhook`）。
  「動き方」には、いまの host が実際にそう動くことだけを書いた（Webhook を溜める・外から来たものの印は書いていない）
- **Command Palette**：「操作」の先頭に「自動化」。いまの Project があれば、自動化が無くても出す（ここから作れる）。
  件数は写しが取れていれば添える。「自動化」「きっかけ」「予定」「定期」「cron」「webhook」「schedule」「automation」で引ける

## 残したこと

- 「終わったら受信箱に出す」の欄は台帳に残るが、その効き目（出す／出さない）は `automation-inbox` の仕事
- AI が作ったときのカードの「一覧を開く」は `automation-ai-tools`。開く先は `automationsCanvasHref(projectId, forkId)`
- 「会話を開く」を別タブ（`/canvas-window`）で押すと、そのタブが banto の画面に替わる（別タブには会話の面が無い）

## 確かめたときに見えた、この変更の外の落ち方（規則6・記録だけ）

- `runtime/socket-dir.test.ts` の2件は、TMPDIR が深い環境（パスが 100 文字を超える）では UNIX ソケットの長さの上限で必ず落ちる。
  `TMPDIR=/tmp` では通る。この変更とは関係しない
- `delivery/thread-messages.test.ts` の「送り元の Project が『承認をすべて自動で許可する』なら…」が、テストを全部回したとき
  6回中1回落ちた（「判断待ちが出ない 2 !== 3」、待ちの約1秒で切れた）。単独では15回中0回。この変更は delivery に触っていない。直していない
- E2E の `filesystem-pdf.spec.ts`・`filesystem-comments.spec.ts`（PDF の画面 `pdf-view` が出ない）は、この変更の手前（cbfaa498）に
  戻してビルドしても同じく落ちた。直前の docx の変更（3bd4b5dc・#303）のまわりと思われるが、測っていない。この変更の外なので直していない
- `browser-view.spec.ts` はフルの1周で返事が来ずに落ち、単独で回し直したら通った（1回中1回の落ち）。混んでいた機械で回した
- `subagent-from-module.spec.ts` は、HOME が深い環境で incus のマウントの置き場の名前が長すぎて（file name too long）Module が
  立ち上がらず落ちた。環境の側の落ち方で、この変更とは関係しない
