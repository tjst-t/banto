# Canvas から banto の別の面を開く口（`dev.banto/open-surface`）——2026-10-07

Backlog のタスク #227（module-banto-module-project）。仕様は `docs/specs/v4-frontend.md` §6.2
「画面から『同じ Project の別の面を開いて』」。ここには決めた理由と、採らなかった案を残す。

## 何が要ったか

- Factory の入口（モック a5aefc0d）の「経過を見る」（Subagent の画面でその仕事を選んで開く）と「設定を開く」
  （Project の設定の Factory の節）。本物には口が無くて置けず、仕事の id を文字で出していた（f90a7b64）
- Backlog の「取り組んだ Thread」・Repositories の「既にある Project を開く」も同じ問い（後者は 2026-10-04 に
  `dev.banto/open-project` で先に解いた）

## 決めたこと・理由

- **1本の request で3つの先**（入口の画面・設定の節・Thread）。`open-project` と同じく確かめの画面を出さずに移る
  ——移るのは軽く戻れる。代わりに**どの面からでも押した直後だけ**（会話の中だけに絞らない。入口・設定の面からも
  押した直後でなければ移らない——確かめが無いので、押したことが確かめの代わり）
- **選ぶもの（`select`）は「見ている場所」（`dev.banto/view-state`）として渡す。** 既に、開き直したときに画面へ返す
  道（URL の `canvasView` → `hostContext["dev.banto/view-state"]`）がある。新しい受け渡しの道を作らずに済み、
  開いた先でリロード・別タブにしても同じものが選ばれたまま残る。Subagent の入口は人が選んだ仕事も同じ形
  （`{ runId }`）で預けるようにした——預けないと、人が別の仕事を選んでも URL には開いたときの仕事が残る
- **設定の節は `server` を省ける（頼んだ Module 自身）。** Module は自分がこの Project にどの名前で入れられたかを
  知らない（目録から入れるとき人が名前を付ける）。他の Module を指すときは名前が要る（Factory は Subagent を
  `subagent` の名前で呼ぶ、という前提を既に持っている——`engine.ts` の `call("subagent", …)`）
- **設定は、いまの画面の上に重ねる**（`settingsOpenHref` と同じ）——閉じると Factory の入口に戻る
- **入口・設定の節が在るかは、移る前に host に聞き直す**——Command Palette を一度も開いていないと入口の控えは空
- 同じ Project の中だけ。畳んだ Fork・別の Project の Thread は断る（`open-project` が閉じた Project を断るのと同じ理由）

## 採らなかった案

- **tool の入出力（`ui/notifications/tool-input`・`tool-result`）に乗せる**——Subagent の入口は会話のカードから
  開かれたとき、これで仕事を選ぶ口を既に持っている。だが仕様の tool-input は「この画面を起こした tool 呼び出し」で、
  人が別の画面から開いたときには無い。無い呼び出しを作ると、画面は「AI の tool から開かれた」と誤って受け取る
  （`toolInfo` を付けないことで「人が直接開いた」と分かる、という §6.2 の約束が崩れる）
- **`open-new-project` と同じ、確かめの画面を挟む形**——移るだけで何も作らない・壊さないので、確かめは二度手間
- **Module ごとに別の request（`open-launcher`・`open-settings`・`open-thread`）**——決まり（押した直後・同じ Project・
  移っている間）が同じなので1本にまとめた

## まだやっていないこと

- Backlog の「取り組んだ Thread」のボタン（口はできた。E2E と一緒に足す）
