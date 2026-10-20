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

## 参考

- [OpenAI launches Dots（TechCrunch）](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)
- [OpenAI Dots: Always-On Agents in ChatGPT, Explained（DataCamp）](https://www.datacamp.com/blog/openai-dots)
