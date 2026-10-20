# 任務と見回り——Dots の「会話をやめても進む」「自分から調べる」を banto に（2026-10-20）

仕様はアーキ仕様 §4.4・v4-frontend.md §6.47。ここは経緯。

## きっかけ

ChatGPT の Dots（2026-09-29 の OpenAI DevDay で発表。GPT-6 Astra で動く常時稼働の個人エージェント）を調べ、banto の今の機能と比べた
（Fork「Dots の比較」）。banto が既に持つもの：定期実行（自動化）・専用の計算機（Project のコンテナ・別のサーバ・Browser）・
複数のエージェント（Fork・サブエージェント・Factory・判断役）・使用量の管理（複数の Claude アカウント）・取り消せる Memory。
足りないもののうち、ユーザーが気にしたのが次の2つ：

- **会話をやめても進む**：Dots は目標を持ち続け、次の確認を自分で組む。banto の AI はターンが終わると、人・裏の仕事の返事・
  自動化でしか起きない。自動化は繰り返しの仕組みで、作るたびに必ず人に聞くので、終わりのある仕事には重い
- **自分から調べる**：Dots は人が使っていない間に、つないだアプリを読むだけの形で見て、急ぎのことを知らせる（Proactive research。
  その間は送信・編集・操作ができない）

Dots の権限の仕組み（操作ごとの4段の Custom Rules・オフにできない Auto-review）も比べたが、今回の範囲には入れない。読むだけの印は
その土台になる。

## 決めたこと（ユーザー・2026-10-20）

- 土台・任務・見回りをまとめて仕様に書く
- 任務を始めるときに1回承認すれば、枠（回数・期限・最短の間隔）の中の `schedule_followup` は聞かずに通す

## 仕様を書くときに選んだこと（レビューで見てほしい）

- **`start_mission` は「承認をすべて自動で許可する」がオンでも聞く**——自動化を作るのと同じ線（人が見ていない時間に繰り返し動く）
- **読むだけの根拠は、同梱の Module の宣言か、人が tool ごとに許したものだけ**——第三者の `readOnlyHint` は使わない（§5.3）
- **宛先を AI が選べる tool は読むだけではない**——WebFetch・WebSearch・`browserOpen` は URL や検索語に中身を載せて外へ運べる。
  見回りが外の文に操られても、外へ運べないようにするため
- **断るのは agent-proxy**——`allowedTools` に入れた tool は `canUseTool` を通らないので、SDK の設定だけでは守れない
- **読むだけの回では人に聞かずに断る**——人が見ていない回で判断待ちを積まない
- **見回りから任務へは必ず人を挟む**（お知らせの「やって」「任務にする」）
- **任務の回は受信箱に出さない**（何も起きなかった回）——15分ごとに受信箱が埋まるのを防ぐ
- **見回りの手帳は Memory に入れない**——Memory は決まったことだけ

## Fable のレビュー1回目（直せば入れてよい）で直したこと

- 守りを4か所に：SDK の `allowedTools` は狭めても何も禁止しない（聞かずに通す一覧）、既定の `auto` は分類器が `canUseTool` を呼ばずに
  許しうる——組み込みは `tools` で置き換え、core の in-process のサーバ（代理を通らない）は読むだけの tool だけで組み、Module は代理で、
  最後に PreToolUse
- 見回りの Fork はどの起こし方でも読むだけ。まとめと `banto.turn-decisions` を出さない（判断役の答えが外の文を読んだ文脈のまま
  制限なしで動く道があった）
- 読むだけの回が書いた URL は、banto が知っている場所だけリンクに（人に押させて外へ運ぶ道）
- 読むだけの回の中継先も読むだけに限る（host が宛先の印を見る）
- 印の候補の直し：`listServices`（毎回 reconcile で systemctl を打ちうる）・`listPublished`（Caddy の経路を書きうる）・`getNetworkRequest`
  （見出しを伏せない）を外し、Browser の読む tool はブラウザを起こさない形を条件に、`readDocument` は PDF と docx だけ
- 受信箱の新しい種類は既存の「お知らせ」（仕組みの異常）と名前が重なるので「気づき」に。§2.4・§6.41・§6.0 を更新、バッジには数えない
- 任務：`report_turn` が `continue: false` でターンを終えるので、任務の状態が悪ければ `report_turn` が断る。Stop hook は1本にまとめる。
  起こすかは `deliver` の手前で判断し、空いていなければ次の刻み。出来事の待ちは段2の照合と `awaitedModules` に乗せる。`start_mission` は
  tool の中でカードを出す（`canUseTool` の自動の許可を通らない）
- Repositories の GitHub の tool は、呼んだ Project のリポジトリだけ・決まった欄だけ

## Fable のレビュー2回目（直せば入れてよい）で直したこと

- `readDocument` の読むだけは PDF の文字だけ（docx も変換役を通る。`asImage` も変換役に中継する）
- 見回りの Fork の読むだけの印は `thread.created` に刻み、見回りを消しても残す（消すと外の文を読んだ Fork がふつうの会話に戻る穴）。`mode` は作ったあと変えない
- `decisions` のあるまとめは予約が無くても受け付ける（枠の外で人に聞く道が、まとめの断りと衝突していた）
- 時計で期限を過ぎたときは、ターンの外からレビュー待ちを出す／更新する
- 見回りの会話にはまとめの prompt と Stop hook を付けない
- 「答えていない決めこと」は判断役の `movedOnReason` と同じ手がかりで判定する
- 「やって」の引用は外から来たものと同じ囲み、`start_mission` のカードは form の部品、人の「今すぐ起こす」は最短の間隔に縛られない

## 参考

- [OpenAI launches Dots（TechCrunch）](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)
- [OpenAI Dots: Always-On Agents in ChatGPT, Explained（DataCamp）](https://www.datacamp.com/blog/openai-dots)
