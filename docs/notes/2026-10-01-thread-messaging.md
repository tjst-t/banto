# Thread 間・Project 間のメッセージ——仕様の案（2026-10-01）

きっかけ：Base Thread で起動したサブエージェントの完了通知を、リポジトリ実装の Fork に回したかったが、
送る口が無かった（ユーザー「まだ Thread 間の通信はできないのか」→「Thread 間、Project 間の通信ができるように仕様」）。

**この文書は案であって、まだ決まっていない。** 決まったら `docs/specs/v4-architecture.md` §4.2 の
「まだ決めていない > Thread 間の送り方」と §10 item 24、`v4-modules.md` の `list_threads`／`send_message` を直す。

## すでにあるもの（作らなくてよい）

- **届ける口**：`ThreadDeliveries.deliver`（§4.2「Thread に届ける」）。記録してから起こす・人の発言と区別する・
  ホップ 10／1時間 20 回で止める・受信箱に「お知らせ」1件。サブエージェントの `runInBackground` と
  AI が立てる Fork の最初の指示が、もう乗っている
- **返信用の札**：`reply-handles.ts`（推測できない印・24時間・5回・渡した相手しか使えない）
- **core 自身の tool の置き場**：`banto-thread`（`start_forks`、in-process の MCP サーバ）

足りないのは「**AI が宛先を選んで送る口**」と「**Project をまたぐときの許し方**」だけ。

## 案

### 1. 宛先は Thread 単位

- 同じ Project の Fork・Base も、別の Project の Thread も、同じ形で指す（§4.2 で「Thread 単位にしておけば両方覆える」
  としていたもの）
- 別の Project の「どの Thread か」を AI が知らないときのために、**Project を指したら その Base Thread に届く**を許す

### 2. 送る口は core の tool（`banto-thread` に足す）

Thread・Project は core の持ち物なので Module にしない（`start_forks` と同じ理由）。足す tool は3本：

| tool | 何をするか |
|---|---|
| `list_threads` | 宛先の一覧。**id・題・Project 名・Base か Fork か・状態（空き／走っている／人の返事待ち）だけ。中身は読まない**。既定は同じ Project、`allProjects: true` で他の Project も |
| `send_message` | 宛先（Thread の id か Project の id）・題・本文を送る。届いた側の AI が起きる |
| `reply` | 届いたメッセージに返す。宛先は**届いたものに付いた返信用の札**で指す（下の4） |

- tool は Base でも Fork でも同じものを見せる（一覧を変えるとキャッシュを引き継げない、§3）。足した最初の1回だけ
  全 Thread のキャッシュが外れる
- 自分自身には送れない

### 3. Project をまたぐときの許し方

同じ Project の中は同じ信頼の境界なので**自由に送れる**（承認なし。その Thread の承認モードに従う）。

Project をまたぐのは、**片方の AI がもう片方の AI（別の Module・別の鍵を持つ）を起こして仕事をさせられる**ことになる
（v4-security.md §3 の表で `relayDeliverToThread` の宛先を札に縛った理由と同じ）。候補：

- **案A（推し）：送るたびに人が承認**——会話の中の承認画面（Publish と同じ形）に「どの Project のどの Thread へ、何を」
  を出す。承認モードが「全部許す」でも、**Project をまたぐ送信だけは必ず聞く**
- 案B：受け取る側の Project 設定に「メッセージを受け取ってよい Project」の一覧を持ち、そこに載っていれば承認なし
- 案C：案A ＋ 承認画面に「この組（送り元 Project → 宛先 Project）は以後聞かない」を付け、案B の一覧に足す

### 4. 返事は返信用の札で

- `send_message` で届いたものには、**送り元の Thread に結びついた札**が付く（既存の札をそのまま使う。24時間・5回）
- 受け取った AI は `reply` で札を指して返す——**返事は Project をまたいでも承認なし**（送り手が先に許された会話への返事なので）
- これで「Fork の結果を親に返す口」（§2.2 で後回しにしたもの）もこの上に乗る：Fork は `reply`（最初の指示に札を付ける）か
  `send_message` で親に返す

### 5. ほかの決めごと

- **ループ防止はいまのものをそのまま**：ホップは送ったターンのホップ＋1、10 を超えたら起こさず溜める。速度は宛先ごとに 1時間 20 回
- **人への知らせ**：届くたびに受信箱の「お知らせ」1件（いまと同じ）。画面では送り元（Project 名・Thread 名）を出す
- **起こさずに置くだけ**の送り方は作らない（届いたら起こす、で統一。必要になったら足す）
- **今回のきっかけへの答え**：サブエージェントの完了が Base に届いたら、Base の AI が `send_message` で Fork に回す
  （札そのものを別の Thread に付け替える口は作らない）

## ユーザーの答え（2026-10-01）——仕様 §4.2「Thread 間・Project 間の送り方」に移した

- 許し方は**案C**
- 宛先は Project と Thread を指せる。**Thread を指さないときは新しい Fork に届ける**（Base ではない）。理由：Fork から
  別の Project に送ったとき、返事が新しい Fork に来ても困る——だから受け取った側には送り元の Project・Thread が分かる
  ようにして、そこへ送り返せるようにする
- 上の案の `reply`（札で返す専用の tool）は、「送り元へ send_message で返す」で足りるので仕様には入れていない。
  残った問い：Project をまたぐ返事にも承認が要るか → **要らない**（受け取ってから 24時間以内の送り元への返事は承認なし。
  もう一つの案「返事も普通の送信と同じに承認」は、A→B を許したのに B の返事でまた聞かれるので採らなかった）
- 新しい Fork は Base の会話を引き継がず、まっさらな会話で始める（Memory は効く）

## 最初に聞いたこと

1. Project をまたぐ許し方：案A・B・C のどれか
2. 返事を札で返し、またぐ返事は承認なし、でよいか
3. 「Project を指したら Base に届く」を入れるか

## 実装（2026-10-01）

- 仕様 §4.2 の「実装の形」のとおり。core は `delivery/thread-messages.ts`（宛先・承認・新しい Fork）と `http/fork-tool.ts`
  （`banto-thread` に `list_threads`・`send_message` を足した）。画面は承認カードの選択肢・届いたものの送り元・Project 設定の
  「メッセージを受け取ってよい Project」（外すだけ。足すのは承認画面で、何が届くかを見てから決める）
- 試験：core の単体（`thread-messages.test.ts`、8本）と E2E `thread-messages.spec.ts`（Project だけ指して送る→承認で
  「以後聞かない」→新しい Fork に届く→返事は承認なしで送り元へ→設定に出る）
- 関係する既存の E2E 40 本のうち `frontend-interaction.spec.ts:19`（Escape と Command Palette）だけ落ちる——変更前の HEAD でも
  同じに落ちる（別の作業ツリーで確かめた）。この変更とは無関係
- このコンテナで E2E を回すには、`sudo -u ubuntu`（incus グループを効かせる）と、偽の資格情報
  （`CLAUDE_SECURESTORAGE_CONFIG_DIR` に空の `.credentials.json`——偽 Runner の spec だけなら本物は要らない）が要った
