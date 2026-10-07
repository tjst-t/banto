# ターンの終わりのまとめ（検討・2026-10-06）

## きっかけ（ユーザー）

Fork を何本も並べて進めると、各 Thread の最後を見ても「何を頼んで、何が出てきたのか」が分からない。
ターンの最後にまとめを出したい。要望：

- 普通の発言と見分けがつく
- 何を頼んだかが一目で分かる——直前の発言が「それでお願い」でも、文脈から具体的に補う
- 結果は、記憶を失っていても分かるように、必要十分・簡潔・簡単に
- 人が判断することを端的に
- 返答の候補を出し、押すと入力欄に入る（直してから送れる）

## 案：AI が core の tool でまとめを渡す

- core の banto-thread に tool `reportTurn`（in-process、remember_decision と同じ置き方）を足す。
  AI は人に返すターンの最後に1回呼ぶ。引数は決まった形（モックの `lib/mock/turn-summary.ts` の `TurnSummaryArgs`）：
  - request：依頼の中身（文脈から書き直したもの）＋元の発言（そのままの言葉と時刻、同じなら省く）
  - outcome：status（終わった／途中まで／できなかった）・1文の結論・要点3つまで・確かめていないこと・できたもの（コミット・ファイル・URL）
  - decisions：人が決めること（問い・背景1〜2文・候補。候補は「ボタンの短い言葉」と「入力欄に入る具体的な文」の組、おすすめは1つまで）
  - nextSuggestions：決めることが無いときの「次に頼めること」
- host が別のモデルで要約する案は採らない方向：会話の全部を知っているのはターンを走らせた AI で、
  「それでお願い」の読み替えもそこでしかできない。別に呼ぶとお金と時間も掛かる。
- 結果の status と「人の番か」は別の軸にした（モックの途中で混ぜて分かりにくかった）。人の番は decisions の有無で表す。

## 画面（モック fork/turn-summary）

- 会話の幅いっぱいの「票」。見出し「このターンのまとめ」と時間帯、3段（頼んだこと／結果／決めること）。
  左の太い線は、決めることがあれば人の番の色（turn、橙）、無ければ緑（ユーザー決定）。
  結果の状態（終わった／途中まで／できなかった）は線の色にせず、「結果」の段の頭の印と文字だけで出す
  ——「できなかった」の赤と人の番の橙が見分けにくかったため。
- tool のカードの折りたたみには入れず、その外に出す（human-tool-card.tsx の SummaryForPart）。
- 候補を押すと入力欄に入り焦点が移る。判断が複数あれば、選んだものを上から1行ずつ並べる。
  人が手で書いた文があれば消さずにその下に足す。もう一度押すと外す。
- まとめの後ろに人の返事があれば、候補は押せなくする。
- 見本：banto Project の Fork「Vault の版（Infisical の環境）」（「それでお願い」の読み替え、判断2つ、
  「反映して」を送ると判断なしのまとめが出る）と「ログインの実装」（途中まで、判断1つ）。

## 決まったこと（2026-10-06、ユーザー）

1. 人に返すターンは全部まとめを出す（短い受け答えも含む）。
2. 呼び忘れは Agent SDK の Stop hook で一度だけ差し戻す。
3. 前の報告文は残し、まとめはそのターンの一番最後に出す。出すのは会話の中だけ。

## 当初の未決（上で決着）

1. どのターンで出すか：毎ターン必ず／仕事をした（tool を使った）ターンと判断を求めるターンだけ（提案）。
2. 呼び忘れの守り：system prompt で頼むだけ／Agent SDK の Stop hook で「tool を使ったのに reportTurn が無い」ときに一度だけ差し戻す（提案）。
3. まとめの前の長い報告文をそのまま残すか、畳むか（提案は残す）。
4. まとめをほかの場所でも使うか：サイドバーの Thread の行・受信箱のレビュー待ち・Fork の一覧に「頼んだこと」と結論の1文を出す（提案、まず会話の中だけ作ってから）。

## 実装（2026-10-06）

仕様は v4-architecture.md §2.2「ターンの終わりのまとめ」・v4-frontend.md §6.35。

### 実測（偽の API、`banto/probes/turn-summary-stop-hook.mjs`、SDK 0.3.281 同梱の CLI）

- Stop hook で `{ decision: "block", reason }` を返すと、CLI は合成の user「Stop hook feedback:\n<reason>」をモデルに見せ、
  同じターンの中で続ける。その中で `report_turn` を呼べた。2回目の Stop では `stop_hook_active: true`
- 毎回 block を返すと終わらない（打ち切りの120秒まで回り続けた）→ `stop_hook_active` なら差し戻さない
- 承認モード default だと `report_turn` も `canUseTool` に来る。`allowedTools` に入れると来ない → 入れる
- 合成の「Stop hook feedback」の user は、host の記録（ReplyRecorder は user の tool_result しか見ない）にも画面
  （applyMessage も tool_result だけ）にも出ない

### 実装で決めたこと（実装者の判断）

- Configuration の鍵は `thread.turnSummary`（Project の層だけ）。設定の節の見出しは「会話」、スイッチは「ターンの終わりにまとめを出す」
- 記録は `message.appended` の `turnSummary {summary, at}`（`recordTurnSummary`）。中継の承認カード（judgmentIds）と同じく、
  fold が同じターンの発言にまとめる
- 画面の「あなたの発言」は会話の記録から取る（host は付けない）。時刻は host が受け付けた時刻、走っている間は最初に描いた時刻
- 上限：points 3・decisions 4・options 2〜4（おすすめ1つまで）・nextSuggestions 4

### 確かめたこと

- core の単体（turn-summary.test.ts 6件・app.test.ts の口1件）、core 全体 581 件で通過 578・失敗 1（落ちた1件は #216 の間欠で、
  flaky-tests の Fork が直している）、画面の単体 33 件
- E2E `turn-summary.spec.ts`：オフでは出ない・設定でオン・一番下に出る（後ろに文が続いても）・default でも承認を聞かない・
  候補が入力欄に入る（2行・外す）・読み込み直し・呼び忘れの差し戻し・返事のあとは押せない
- 関係する E2E 10本（auto-approve-all・inbox・inline-view-followed-turn・judgment-after-reload・judgment-deny・
  module-canvas-inline・relay-cards・thread-messages・turn-stop と本件）：1回目に module-canvas-inline が1件落ち（#222）、
  単独2回・同じ組み合わせの2回目は全部通った
- 確かめていない：本物のモデルが指示どおりに `report_turn` を書くか（質）。コンテナの Shell には Claude のログインが無く、
  サブエージェントからのプローブは権限確認で止められた。稼働中の banto に反映したあと、オンにした Project で見る

## 改訂（2026-10-07、ユーザー）

反映したあと本物のモデル（Opus 5.5）で使ったら、本文を書く前に report_turn を呼び、「呼んだらターンを終える」に従って本文を
書かずに終わり、人の画面に返事が出ないことが2回続いた。指示・tool の説明・Stop hook の差し戻しの文に「人への返事の本文を
書き終えてから、最後に呼ぶ（本文の代わりではない）」とはっきり書いた（ユーザーが選んだ直し方。まとめのあとに本文が無ければ
差し戻す案は採らなかった）。

## 改訂（2026-10-07、ユーザー「おすすめ案で全部直して」）

1. **割り込み**：本文→まとめのあと、本文とまとめの間に文が足された（ユーザーの画面）。原因は CLI：tool の結果のあと AI が
   空の返事で終えると、CLI が合成の user「[Your previous response had no visible output. …]」を足して同じターンで書かせる
   （偽の API で再現）。まとめは発言の一番下に描くので、足された文が間に入る。直し：まとめを受け付けたら PostToolUse で
   `continue: false`（AI をもう一度呼ばない。Stop hook も呼ばれない、実測）
2. **出す場面を絞る**：短い受け答えには出さない。指示は「作業をした（tool を使った）ターン・長い報告のときだけ」。催促
   （Stop hook）は、report_turn・remember_decision 以外の tool を使ったか3分以上かかったターンだけ
