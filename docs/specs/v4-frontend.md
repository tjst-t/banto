# v4 フロントエンド要件

> **これは仕様である。** 決まったことだけを書き、決まったら**この文書を更新する**。
> 検討の経緯は `docs/notes/` に残す。
>
> 全体の構造は `docs/specs/v4-architecture.md`（以下「アーキ仕様」）。
> **この文書は旧 `v4-architecture.md` §6 から分離した**（2026-09-02）。
> 内部の節番号（§6.0〜§6.6）は移動前のまま維持している——他文書からの
> 参照（`v4-modules.md`・`requirements.md` 等）を壊さないため。
>
> 最終更新：2026-09-10

## フロントエンド側の core

バックエンドで整理した「誰が何を呼ぶか」を、画面側にも対称に当てはめる。

**レイアウトの骨格は、要件E1〜E11 を本物のブラウザで測って通した形をそのまま使う**
（2026-08-29 決定）。**測って通っているものを、作り直す理由が無い。**

**ただしダイアログのデザインは作り直す。** 現状のダイアログは出来が悪い。
**v4 向けのプロトタイプを作って詰める**（設計書の上で決めきらない——画面は
見ないと分からない）。

### 6.0 仕様が課している UI 要件

**tool まわりの画面は「作り込み」ではなく、MCP 仕様の要求である**（2026-08-29
確認）。満たしていないと仕様に反する：

- **人が tool 呼び出しを拒否できる状態を常に保つべき（SHOULD）**
- **どの tool が AI に露出しているかを明示する UI を出すべき**
- **tool が呼ばれたとき、明確な視覚的表示を入れるべき**
- **サーバを呼ぶ前に、tool の入力を人に見せるべき**——悪意ある／偶発的な
  データ持ち出しを防ぐため
- 機微な操作では人に確認を求めるべき。tool の利用は監査のために記録すべき

banto は tool の呼び出しと結果を Event Store に積み、画面に出す（§6-3・§6-5）
——**この設計は要求を満たすためのものであって、装飾ではない。**

1. **会話の器そのもの**——Project / Thread navigation・会話ビュー
2. **MCP Apps の埋め込み機構**——Module の `ui://` リソースを**埋め込む受け皿**は
   Module が提供できない（提供させたら分離の意味が無い）。中身は Module のものだが、
   埋め込む機構自体は core。バックエンドの host の画面版。
   **この1つの受け皿を、会話・Canvas・設定画面のどこにでも置く**（§6.2）。
   **ただし運べないものがある**——MCP Apps の仕様は Canvas の iframe に
   **外部へのネットワーク要求を塞ぐ厳しい CSP** を課すので、
   **Canvas の中から自前の WebSocket を開けない**。ブラウザの生画面のように
   **量と速さが要るもの**はこの経路に載らない。
   **「すべて MCP 経由」が初めて運べないものに当たった箇所である**。
   そのため core に**画面と Module の間の流れの口を1本だけ**持つ（決定・2026-10-08、ユーザー。
   アーキ仕様 §5.8）——画面は札を取って banto の `/api/streams` へ WebSocket を開き、host がコンテナの中の
   Module へ中身を見ずに渡す。Terminal・Browser が最初に乗る。以前は `docs/specs/v4-modules.md` §4.1 で3択として未決だった
3. **tool 呼び出しの汎用フォールバック表示**——`ui://` を宣言していない Module にも
   最低限の表示を保証する。**これは作り込みではなく仕様の要求**（下記）
4. **受信箱のバッジ**（アーキ仕様 §2.4 と同一）——**3種類が入る**（追記・2026-09-10）：
   **判断待ち**（止まっている。答える口は Thread 側のカード1箇所、§2.4.1。**Module 間中継の承認だけは受信箱でも
   答えられる**——行の下に会話のカードと同じ選択肢が出る。改訂・2026-10-05、下の「Module 間中継の承認」）・
   **お知らせ**（許可/拒否を求めない。最初の用途は「Module を繋げなかった」。
   Project 単位で、同じ鍵のものは積み増さない。決定・2026-09-07。起こし直しのたびに切れるので自動で続けるのをやめた
   会話のお知らせは、「確認した」の左に**「続ける」**を出す——押すと host がそのターンの続きを起こす。返事が来るまで
   ボタンは押せない（二重に頼まない）。断られたら理由をその行に出す。押さずにその会話で次を送っても続きを引き継ぎ、
   お知らせは消える。2026-10-05、アーキ仕様 §2.5「上限」）・
   **レビュー待ち**（**ターンが終わった Thread**、2026-09-27〜。開いて見ている Thread のものは出さない。
   バッジには数えない。アーキ仕様 §2.4「レビュー待ち」）。
   並びは**止まっているものが先**——判断待ち → お知らせ → レビュー待ち。
   お知らせかレビュー待ちが1件でもあれば、受信箱の**見出しの右（閉じるボタンの左）に「まとめて確認」**を出し、
   その2種類を一度に「見た」にする（追加・2026-10-02、ユーザー要望。最初は一覧の頭に1行足したが、
   同日に見出しの右へ改めた——通知の一覧によくある形：見出しの右端に一括の操作、片づけるものが無ければ出さない）。
   **判断待ちは対象にしない**——答えないと AI が進まないので、まとめて片づけられるものではない
   （ボタンの説明に「判断待ち N 件は残ります」と出す）
5. **ライブ配信チャネル**——Base Thread・サブエージェント完了・判断解決、すべての
   発生源が同じ1本を通って画面に届く。「1本の窓口」の画面版
6. **Project / Thread のライフサイクル操作 UI**——新規会話・モデル/effort 選択・
   編集・分岐選択。core 自体の状態を直接操作するので UI も core
7. **Project 単位で Module を足す・外す UI**——アーキ仕様 §2.2 の「Module 集合の変更」に
   対応する画面。**「Module 中心」の実用性を左右する**
8. **Command Palette（Ctrl-K）**——Project・Thread・判断待ち・Module の入口と
   資源・core の操作、すべてへの1つの入口（§6.3）
9. **いまの文脈がどれだけ埋まっているかの表示**——**実測で中身を確認済み**
   （2026-08-30）。カテゴリごとにトークン数が返る——例：System tools 19,257 /
   **Skills 1,875** / Messages 2,265 / Autocompact buffer 33,000 /
   Free space 909,163。**`deferred`（窓の外にある tool 定義）が別枠**で出る
   （MCP tools deferred 2,940 / System tools deferred 14,952）。
   Skill は**名前と出所ごと**、MCP は**サーバごと**、Memory は**ファイルごと**に
   内訳が取れる——**アーキ仕様 §5.7 が要求している「効いている Skill が食っている量」は
   そのまま出せる**。
   **`getContextUsage()` が内訳を返す**（system prompt・tools・messages・
   MCP tools・memory files 別のトークン数、アーキ仕様 §2.8）。
   **開いた会話に返すのは最新の1件だけ**（`GET /api/threads/:id`、決定・2026-09-26）——記録
   （`usage.recorded`）は全部残すが、1件が約 30 KB あり、使い込んだ会話では応答の 90% が
   使用量の履歴だった。推移が要るときは別の口に分ける
   **数字1つではなく内訳を出す**——**アーキ仕様 §5.7 が要求している「効いている Skill が
   食っているトークン量」と、これは同じ表示である**。Module を繋ぎ、Skill を
   効かせ、Memory を書き足すたびに何が増えたのかが、1箇所で見える。
   **Skill の行は Messages から切り出して出す**（改訂・2026-09-23）——banto は SDK の
   Skill 機構を使わず、名前と説明を MCP の `instructions` で届けるので、SDK はそれを
   Messages の中の添付として数える（アーキ仕様 §5.7）。Skill ごとの内訳と
   **「この会話で効いている Skill」**（会話の始まりで固定された集合）も同じ面に出す

   **どの Skill を効かせるかは設定画面の両方の層に出す**（2026-09-23）——banto 全体は
   「Skill」（既定で効かせるか、トグル）、Project は「この Project の Skill」（全体の既定に
   従う／この Project で効かせる／外す）。**押したらその場で保存し、確認を挟まない**
   ——効くのは次の新しい会話からで、押した瞬間に何かが壊れることは無い。画面にもそう書く

### 6.1 設定画面は2階層（画面は1つ、層は見出しで分ける——改訂・2026-09-11）

**「実行中の変更が危険」なのではなく「変更が黙って起きると危険」**。解決策は禁止
ではなく、**変更を必ず記録して常に見える形で出す**（規則2・3）。

- **階層1：banto 全体（instance level）**——中心を Module 一覧ではなく**役割
  （role）一覧**にする（同じ役割の複数実装が辞書として共存してよいので）。
  役割ごとに、満たす実装・プロセス境界・無ければ何が断るか・Module 自身の設定を表示。
  **有効/無効の切替はライブでよい**——切替をイベントとして記録し、それに依存する
  tool は次に呼ばれた瞬間はっきり断る。「黙って壊れる」を「はっきり断る」に置き換える
- **階層2：この Project**——今の Project に繋がっている役割/Module の一覧、
  足す・外す。instance 全体の設定とは別の置き場（会話ごとに中身が違う）

共通で持ち越すもの：プロセス境界の常時表示・押す前に何が壊れるかの提示・
Module が自分の設定 Canvas を持てること（§6.2）。

### 6.2 Module の Canvas をどこに出すか

**Canvas とは、Module が MCP Apps（`ui://` 資源）で描く UI コンテンツそのもの**
である（決定・2026-09-02）。会話のカードに埋め込まれるものも、会話の隣いっぱいに
開くものも、設定画面に埋め込まれるものも、launcher から開くものも、**すべて同じ
1つの受け皿（二重 iframe と postMessage の中継）に乗る、1つの概念**である。
`inline` / `fullscreen` / `pip` は、**その Canvas をどれだけの画面でどこに出すか
（display mode）**を表す——Canvas が上位、display mode が下位の関係になる。

**Module は「どんな Canvas か」を宣言する。banto が「どこに出すか」を決める。**
この分担を崩さない——Module に置き場所を指定させると、Module が banto の画面構成を
知っていることになり、独立性（アーキ仕様 §1）がその分だけ削れる。

**軸は2つあり、混ぜない。** display mode は「どれだけ画面をもらうか」、起点は
「誰がその Canvas を開いたか」。仕様が持っているのは前者だけで、**後者は banto が足す**。

**軸1：display mode（仕様の語彙をそのまま使う）**

| mode | banto が出す場所 |
|---|---|
| **`inline`** | 囲んでいる枠の中に埋め込む（会話、設定画面の枠の中） |
| **`fullscreen`** | **会話の隣**——banto が Canvas に渡せる最大の領域 |
| **`pip`** | **当面サポートしない**（下記） |

**Canvas と tool の紐づけ（2026-09-06 に本家仕様で確認、それまで未記載）**

- **tool 側**が `_meta.ui.resourceUri` で自分の `ui://` 資源を指す
  （`_meta.ui.visibility` で `model` / `app` の出し分けもある）
- **資源側**の MIME は **`text/html;profile=mcp-app`**。`_meta.ui` に
  `csp`（`connectDomains` / `resourceDomains` / `frameDomains` / `baseUriDomains`）・
  `permissions`（camera 等）・`prefersBorder` を持てる
- **View からの tool 呼び出しは `tools/call`**（core と同じ名前）。
  仕様は「host が同意を求めてよい」としか言っていない（必須ではない）。
  **banto は、画面が自分の Module を呼ぶときは承認を求めない**
  （改訂・2026-09-07、ユーザー指示。2026-09-06 は「必ず通す」だった）——
  **その画面を開いたのは人**であり、画面の中のボタンがその画面を出している
  Module 自身の tool を呼ぶのは、画面が仕事をしているだけ。設定を見るたびに
  承認を求めるのは、承認の意味を薄めるほうに働く。
  **AI からの tool 呼び出しは今までどおり承認ゲートを通る**（§6.0）
  ——そちらは人が見ていないところで起きるので、性質が違う。
  **他の Module は呼べない**——呼び先は画面が指定するのではなく、その画面が
  どの Module のものかで決まる（フロントエンドが握る）。**加えて host も
  API 境界で可視性を検査する**（決定・2026-09-10：`agent`・`admin` のみ許可、
  `module` 可視性は拒否）——フロントエンドの自制を唯一の境界にしない。
  「自分の Module か」の照合まで host に持たせる形（Canvas ごとの合言葉）は
  将来の強化として Backlog に記録してある。画面から banto の API を
  直接叩くこともできない（別オリジン・合言葉を持たない）。
  **残る risk を記録する**：Module 自身の画面が、その Module の危ない tool を
  黙って呼ぶことはできる。**Module を繋ぐこと自体が信頼の線引き**で、その手前は
  閉じ込め（`v4-security.md`）と可視性で守る
- **`hostContext.styles.variables` で host が CSS 変数を View に渡せる**。
  **banto が色と段の元を持ち、ここで渡す**（§6.27）——Module 側に banto を知らせずに見た目を揃えられる

> **`inline` は tool コールの折りたたみの中に置かない**（決定・2026-09-07、
> ユーザー指摘）。きっかけが AI の tool 呼び出しでも、Canvas は**人が見て
> 操作する面**であって AI の作業ログではない。畳める領域の中に入れると、
> **人が畳んだ瞬間に「出したはずの画面」が消える**。会話の中の、tool コールの
> グループとは**別のブロック**として並べる。
>
> モック（`mock/`）は当初これを tool グループの中に置き、inline があるときは
> 自動で開く形にしていた。**この決定に合わせてモックも直した**——決定は1つ（規則3）。

> **「最初からこの mode で開く」を宣言する場所は、仕様に無い**（確認・2026-09-07
> ——tool の `_meta.ui` にも資源の `_meta.ui` にも無い）。用意されているのは
> `ui/request-display-mode`（画面が頼み、**決めるのは host**）だけ。
> したがって「AI に『フルスクリーンで開いて』と言われたら最初から大きく開く」は、
> **Module が自分の tool の引数として受け取り**、画面が立ち上がった直後に
> その mode を頼む形で実現する。**banto 側に新しい機構は要らない**（規則12）。
> 引数の名前・語彙は仕様に合わせる（`displayMode` / `inline` / `fullscreen`）。

**軸2：起点（banto が足す。仕様に無い）**

| 起点 | 何が開くか | 既定の mode |
|---|---|---|
| **AI の tool 呼び出し** | その tool に紐づいた Canvas | `inline`（`fullscreen` を要求されたら会話の隣に出す） |
| **人が launcher から開く** | Module が宣言した入口の Canvas | `fullscreen` |
| **人が設定画面から開く** | `ui://<id>/config` | `inline`（設定画面の枠の中） |

#### 開いたものは、会話にカードとして残る（決定・2026-09-07）

**自動で開いてよいのは、tool がそれを呼んだその一度だけ。**

会話の記録から画面を組み直すとき（リロード・別の Project から戻ったとき）、
**大きく出した呼び出しは会話に埋め直さない**——埋め直すと、その画面がまた
`ui/request-display-mode` を投げ、**リロードのたびに Canvas が勝手に開く**
（ユーザー報告・2026-09-07）。代わりに、その場所に**入口のカード**を残す。
押すと、**同じ引数で**同じ画面が開き直る。

- **どの面に出したか（`inline` / `fullscreen`）は会話の記録に残す**
  ——「どの tool をどの引数で呼んだか」だけでは、あとで出し直せない。
  決めるのは画面（`ui/request-display-mode`）なので、決まった時点で banto が記録する
- **URL に残っていれば開き直す**（誰が開いたかは問わない）。閉じたら URL からも消え、
  次に開くのは人が押したときだけ

このカードは **Canvas 専用ではない**（規則3・規則11）。会話の途中で開いたもの
——Module の画面・分岐した Fork Thread——は、**開いた場所にカードとして残り、
押せば同じものがまた開く**。種類ごとに変わるのは「何のアイコンで、何と書いて、
押したら何を開くか」だけで、部品は1つ（`components/banto/thread/openable-card.tsx`）。

| 種類 | どこに出るか | 押すと |
|---|---|---|
| Module の画面 | その tool 呼び出しの位置 | 記録した引数で Canvas を開く |
| Fork Thread | **親の会話の、分岐した位置** | その Fork を開く |
| カードだけの tool（下） | その tool 呼び出しの位置（**呼んだ時点から**） | 記録した引数（と結果）で Canvas を開く |

#### 会話にはカードだけを置く tool（決定・2026-10-01、ユーザー）

画面つきの tool は、ふつうは結果が返ったところで会話に画面を埋める。**走っている間も終わってからも様子を
見に行く入口が要るもの**（サブエージェントに頼んだ仕事など）は、画面を埋めずに Fork と同じ形のカードだけを
置きたい。これは **Module が tool の `_meta["dev.banto/card"]` で名乗る**（banto は Module を名指しで知らない）。

- 値は `{ title, description }`。どちらも文で、`{引数名}` をその呼び出しの引数で置き換える
  （例：サブエージェントは `"{agent} に頼んだ仕事"`／`"{prompt}"`）。長ければ畳む。引数に無い名前はそのまま残す
- **代わりの指定 `{a|b}`**（追加・2026-10-08）：左から順に見て、使える最初の引数で置き換える（数・真偽と、空白だけではない
  文字列。どれも無ければそのまま残す）。任意の引数が無いときに別の引数へ戻すため（例：Shell の待たない形は題が
  `"{label|command}"`——AI が付けた呼び名、無ければコマンド）。埋めるのは `module-contract` の `fillCardText`
  （host）と、その写しの `apps/frontend/lib/card-text.ts`（画面）
- **説明が題と同じ文なら、説明を出さない**（追加・2026-10-08）——同じ文を2行並べない（Shell で呼び名を付けなかったとき）
- **呼んだ時点から（結果を待たずに）出す**——待つ形の呼び出しはターンの終わりまで返らないので、結果を
  待ってから出すのでは「走っている間に見に行く」ができない
- 押すと Canvas に開き、画面には**その呼び出しの**引数（と、返っていれば結果）が渡る。画面はそれで
  どの仕事かを引き当てる（サブエージェントは結果の `runId`、まだ返っていなければ頼んだ内容の頭で探す）
- **Canvas を開いたまま別のカードを押したら、画面を作り直す**——同じ Module の同じ画面だと橋が張り直されず、
  新しい呼び出しの引数が届かない（実測・2026-10-01）
- 記録（`uiToolCalls`）にも印を写すので、リロードしてもカードのまま出る
- MCP Apps の仕様には無い、banto が足した拡張（`dev.banto/canvas` と同じ扱い）

> Fork の位置は、分岐イベント自身の seq（`ThreadState.createdSeq`）で表す
> ——Clear の横線と同じ物差しで、別の索引を持たない（規則3）。

> **`fullscreen` を「会話の隣」に割り当てる**のは banto の解釈である。仕様の
> `fullscreen` は「host の全面」だが、banto は会話を消さず、その隣の最大の領域を
> Canvas に渡す。**mode の解釈は host の裁量**（`availableDisplayModes` で
> 何を出せるか決めるのは host）なので仕様には反しないが、真の全面占有を期待した
> Module 作者には意外でありうる。ここで明示しておく。

**この分担は banto の発明ではなく、MCP Apps の交渉モデルそのもの**（規則12。
2026-08-29 に仕様を確認）：

| 誰が | 何を |
|---|---|
| App（Module） | `ui/initialize` の `appCapabilities.availableDisplayModes` で**対応できる mode を申告** |
| Host（banto） | `hostContext.availableDisplayModes` で**出せる mode を提示**、`hostContext.displayMode` で現在の mode を伝える |
| App | `ui/request-display-mode`（`params.mode`）で**変更を requestする**——決めるのは host |
| Host | `ui/notifications/host-context-changed` の `displayMode` で変更を通知 |

- **mode 名は `inline` / `fullscreen` / `pip` の3つ**（仕様どおり。banto 独自の名前を
  作らない）
- **`pip` は当面サポートしない。** 仕様は host が `availableDisplayModes` で
  出せるものだけを提示する形なので、**「対応しない」は構造で表現できる**——
  独自の拒否機構は要らない。会話の隣に Canvas が開く banto の画面で、さらに
  浮遊窓を足す用途が今は見えないため。要るとなったら足す
- **settings / launcher は MCP Apps に存在しない**（確認済み。仕様の UI ライフ
  サイクルは**完全に tool 起点**で、tool 呼び出し以外から開く Canvas という概念が無い）
  ——ここは banto が足す拡張である、と自覚して扱う

#### 設定画面への埋め込み

Module が `ui://<module id>/config` を持てば、banto の設定画面がそれを埋め込む。
**iOS でアプリの設定が OS の設定アプリに出てくるのと同じ形。**

**新しい機構は要らない**（規則12）——§6 の2番目「MCP Apps の埋め込み受け皿」を、
会話ではなく設定画面に置くだけ。受け皿・境界・postMessage の中継は同じものを使う。

決めること：

- **Module は設定 Canvas を持つことを `_meta` で宣言する**（アーキ仕様 §5.4。banto 専用の
  マニフェストファイルは作らない）。banto が全 Module に対して
  `ui://<id>/config` を投機的に読みにいく形にはしない——「在るかもしれない」を毎回
  試す機構は、**無いのか壊れているのかの区別が曖昧になる**（規則2）。
  実装では資源の `_meta` に `dev.banto/canvas: "config"` と書く（決定・2026-09-07）
- **どちらの設定画面に出るかは、その Module の `scope` が決める**
  （決定・2026-09-07、ユーザー指摘）。`scope: "instance"`（banto 全体に1本、
  Vault 等）は**全体の設定**（`/settings`）に、`scope: "project"`（Project ごとに
  立つ、Shell・FileSystem）は**その Project の設定**に出す。
  **置き場の判断を別に持たない**——既にある `scope` から導く（規則3）
- **左メニューに Module ごとに並び、選ぶと右側いっぱいに出る**（モックの形、
  決定・2026-09-07、ユーザー指摘）。設定画面の枠（左メニュー＋右詳細）は
  instance でも Project でも同じ——**渡す Module 一覧が変わるだけ**（§6.1）。
  一覧に並べる名前は、Module が資源に付けた `name` をそのまま使う
- **Module は自分の状態を置く場所を持てる**（決定・2026-09-07）。
  閉じ込めていても**その Module の分だけ**は書ける。Project の中には書かない
  ——人のリポジトリを汚さない。**値は Module が持つ**（banto は預からない）。
  **置き場は host が必ず `BANTO_MODULE_DATA_DIR` で渡す**（改訂・2026-09-07）
  ——宣言に書かせる形にしていたら、**宣言の写しを Config に持っている Project
  だけが古いまま**になり、設定を保存できなかった（規則3——写しはいつか食い違う）。
  **host が作り、閉じ込めの許可も host が出している場所は、host が渡す**
- **設定 Canvas は常に `sandboxed`。** 設定画面は鍵を打ち込む場所なので、`in-page`
  （banto のページの権限で他人の JS が走る）をここでは一切許さない。「プロセスで
  信用していないものを、画面で信用しない」を例外なく適用する

> **改訂（2026-09-06）——公式の受け皿を使う。自作しない。**
>
> MCP Apps は正式な拡張になり（`modelcontextprotocol/ext-apps`、仕様 2026-01-26 版）、
> **host 側の受け皿が公式実装として提供されている**（`@modelcontextprotocol/ext-apps`
> の App Bridge——サンドボックス・postMessage の中継・tool 呼び出しの代理・
> ポリシー適用）。**banto はこれを使う**（規則12）。以下の A2UI 由来の記述は、
> 決定の経緯として残す。核（内側に `allow-same-origin` を与えない構造にする）は
> 公式実装でも同じだが、**実現の仕方が違う**——下の「別オリジン」を参照。
>
> **【重要な訂正】host とサンドボックスは別オリジンでなければならない（MUST）。**
> 当初この節は「**同一**オリジンの中継 iframe」と書いていたが、公式仕様と参照実装は
> **Host と Sandbox が別オリジンであること**を要求する（参照実装は host を 8080、
> sandbox を 8081 で配る）。外側のプロキシは**別オリジンで配られた実ページ**であり、
> そこが内側 iframe（`allow-scripts allow-same-origin allow-forms`）を作る——
> 内側に `allow-same-origin` があっても、**そのオリジンは banto ではない**ので
> banto の cookie・localStorage には届かない。同一オリジンで中継すると、
> この前提が崩れる。
>
> **banto での帰結**：**サンドボックスを配る口を、画面とは別のオリジン（別ポート）で
> 用意する**。プロキシのページは host（banto）が用意し、**CSP は HTTP ヘッダで**
> 与える（`_meta.ui.csp` から組み立てる。meta タグでは中身から改竄されうる）。
> プロキシは埋め込み元（referrer）を検証し、`window.top` に触れないことを
> 自己診断してから動く。
>
> ---
>
> 以下は 2026-08-29 に A2UI のガイドから採った当初の記述（経緯として保存）：
>
> - **単一の iframe で `allow-scripts` と `allow-same-origin` を併用すると
>   サンドボックスは破れる**——親の DOM を触るか、自分の `sandbox` 属性を
>   外して脱出できる
> - そこで、**同一オリジンの中継 iframe**（生の DOM 注入を本体から隔離し、
>   JSON-RPC の経路だけを保つ。ホスト元の検証も行う）の内側に、
>   **`srcdoc` で注入する内側 iframe** を置く
> - 内側は **`allow-same-origin` を含めてはならない（MUST NOT）**——
>   一意なオリジンになるので `localStorage` / `sessionStorage` / IndexedDB /
>   cookie に届かない。**`allow-top-navigation` 系も含めない**——
>   `window.top.location` で親ごと飛ばす攻撃を塞ぐため
>
> **未確認**（規則1）：ガイド本文は内側の `sandbox` 属性の具体値について
> 記述が一貫していない（列挙された属性と、直後の防御の説明が食い違う）。
> **`allow-same-origin` と top-navigation を含めない**という核だけを採り、
> 属性の最終形は参照実装を読んで確かめる。

#### 受け皿の形（実装済み・2026-09-06）

**サンドボックスは core が別ポートで配る。**

| 設定（bootstrap config） | 何を決めるか |
|---|---|
| `sandboxPort` | サンドボックスを配る口（既定 4176） |
| `sandboxPublicUrl` | **画面から見た住所**。画面に推測させない（規則3） |
| `allowedEmbedderOrigins` | 埋め込みを許す相手（`frame-ancestors`）。`*` は使わない |

配るのは `sandbox.html` と `sandbox.js` の2つだけ（他は 404）。
**CSP はリクエストごとに `?csp=` から組み立て、HTTP ヘッダで返す**。
Module が申告できるのは**スキーム付きの素直な origin だけ**——`* 'unsafe-inline'`
のように空白を含む値はディレクティブの注入になるので混ぜない。
壊れた申告は**無視して最も厳しい既定に落とす**（緩い方へ倒れない、規則2）。

外側プロキシは**動く前に自分を検査する**：iframe の外なら止まる、
埋め込み元が許可リストに無ければ止まる、**`window.top` に触れてしまったら
「隔離が壊れている」として止まる**。

**内側の `sandbox` 属性は `allow-scripts allow-same-origin allow-forms`**
（参照実装と同じ）。上の当初記述と食い違って見えるが、**`allow-same-origin` が
指すのはサンドボックスのオリジンであって banto ではない**——別オリジンで
配っていることが、この属性が安全である前提。

**host が中継する3つの口**（いずれも Thread 単位）：

| 口 | 何を返すか |
|---|---|
| `GET /api/threads/:id/ui-tools` | 画面を持つ tool（`_meta.ui.resourceUri`）の一覧 |
| `GET /api/threads/:id/ui-resource?server=&uri=` | 画面の HTML と、Module が申告した `csp` / `permissions` |
| `POST /api/threads/:id/ui-tool-call` | **画面からの tool 呼び出し**。呼べるのは `agent`・`admin` 可視性の tool だけ——**`module` 可視性（部品間専用）は host がこの口で拒否する**（決定・2026-09-10、ユーザー）。自分の Module を呼ぶときは承認を求めない（改訂・2026-09-07、本節冒頭） |

`GET /api/ui-config` が `sandboxUrl` を返す（画面はここから住所を知る）。

**画面つき tool の呼び出しは、会話の記録にも残す**（決定・2026-09-07、ユーザー報告）。
リロードすると会話は host の記録から組み直されるので、記録が文章だけだと
**Module の画面だけが消える**。残すのは表示の復元に要る分
（`toolCallId` / `toolName` / `server` / `resourceUri` / 引数 / 結果）で、
**画面を持つ tool だけ**が対象——実行の再現は resume-point の仕事であり、
画面を持たない tool の結果まで会話の記録に積む理由が無い。

**画面からの呼び出しに承認ゲートは掛けない**（改訂・2026-09-07、本節冒頭の
「画面が自分の Module を呼ぶときは承認を求めない」参照。2026-09-06 時点の
「Inbox の判断待ちに載る」は撤回済み——この段落は消し忘れだった、訂正・2026-09-10）。
**代わりに host がこの口で可視性を検査する**（決定・2026-09-10、ユーザー）：
`agent`・`admin` のみ許可、`module` 可視性は拒否——「部品間専用」の tool
（Vault の `resolveAlias` 等）が画面経由でブラウザに値を返す経路を塞ぐ
（`docs/specs/v4-security.md`「host の中継・可視性の層」）。

**tool 結果の受け渡しで踏んだこと**：`ui/notifications/tool-result` の
`params` は **`CallToolResult` そのもの**（`params.result` ではない）。
また会話に載っている結果は文字列・ブロック配列・`{content:[…]}` の
3つの形で来るので、画面へ渡す前に揃える。

#### 画面からのダウンロード（決定・2026-09-23）

**画面は自分ではファイルを保存させられない**（サンドボックスの中にいて、`allow-downloads`
を渡していない）。MCP Apps はそのための口を持っている——**`ui/download-file`**
（画面が host に頼み、host が保存させる）。banto はこれを受ける（`hostCapabilities.downloadFile`
を名乗る）。`allow-downloads` をサンドボックスに足す形は採らない——どの Module の画面も
黙って保存させられるようになる（規則12：仕様の口を使う）。

- **受けるのは `EmbeddedResource`（中身つき）だけ。** `ResourceLink`（host が取りに行く形）は
  `isError` で断る——どこへ取りに行ってよいかを banto は決めていない
- **確かめるかどうか**：仕様は「host は保存の前に確かめるべき（SHOULD）」と言う。
  **人が画面の中を押した直後なら確かめない**——その押下が保存の意思で、もう一度聞くのは
  二度手間になる。「直後か」はブラウザの**一時的な利用者の操作**（transient user activation、
  約5秒）で見る。入れ子の iframe の中の操作は親の画面にも伝わる（実測・2026-09-23）。
  **そうでない（画面が勝手に頼んできた・準備に5秒以上かかった）ときは、banto の画面で
  「ダウンロードしますか」と確かめる**。やめたら画面には `isError` が返る
- 保存する名前は URI の最後の部分（区切り・制御文字は `_` に置き換える）

使っている面：FileSystem のファイルブラウザ（1件はそのまま、複数は ZIP、`v4-modules.md` §2.2）。

#### 画面の「見ている場所」を預かる（banto の拡張、決定・2026-09-23、ユーザー要望）

**大きく開いた画面は、リロードしても別タブに出しても、見ていた場所のまま開き直す。**
MCP Apps には「画面が自分の状態を host に預け、開き直したときに返してもらう」口が無い
（名前はある——OpenAI Apps SDK の widget state）。無いと、ファイルを開いたまま
「別タブで開く」と、別タブでは最初の画面に戻る。banto の拡張として足す（`dev.banto/project` と
同じ名前空間）：

| 向き | 形 |
|---|---|
| 画面 → banto | 通知 `dev.banto/view-state`（`params.state` に小さな JSON） |
| banto が持つ場所 | **URL の `canvasView`**——リロードでも、URL をそのまま運ぶ別タブでも残る |
| banto → 画面 | 開き直したとき `hostContext["dev.banto/view-state"]` |

- **中身は画面のもの**で、banto は解釈しない。URL に載るので 2000 字まで（超えたら預からない）
- **預かるのは大きく開いた面（会話の隣・別タブ）だけ。** 会話の中のカードは URL を持たない
- **別の面を開く・閉じると捨てる**——次の面に前の面の場所を渡さない
- **履歴には積まない**（`history.replaceState`）——画面の中の移動は banto の移動ではない
- 受けない host では、画面は預けた場所を返してもらえないだけ（最初の画面から開く）
- 開き直した画面では、**預けた場所のほうが tool の引数より新しい**（AI が見せたファイルから
  人が移っていたら、移った先を開く）——どちらを優先するかは画面が決める
- **設定の中身は Module が持つ。** banto の Configuration（アーキ仕様 §2.6）は**core 自身の
  設定**であって、Module の設定を預かる登録簿ではない。Module の設定 UI は、その
  Module 自身の tool を呼んで読み書きする。banto が持つのは「その役割を有効に
  するか」という banto 側の判断だけ（§6.1 階層1）

#### 画面から「新しい Project の画面を、このフォルダで開いて」（banto の拡張、決定・2026-10-02、Repositories 段階3）

MCP Apps には、画面が host の中の別の画面を開かせる口が無い（`ui/open-link` は http/https を別タブで開くだけ）。
Repositories の「Project も作る」（clone・新しいリポジトリのあと）と一覧の「Project を始める」に要るので、最小の形で
足す（`dev.banto/view-state` と同じ名前空間）：

| 向き | 形 |
|---|---|
| 画面 → banto | request `dev.banto/open-new-project`（`params.folder`＝`/` か `~/` から始まるパス、`params.name?`＝200字まで） |
| banto | **core の新しい Project の画面を、Root パスと名前を入れた状態で開くだけ**。どの面（Project・設定・ホーム）からでも |
| banto → 画面 | `{}`。読めない params は JSON-RPC の InvalidParams で断る |

- **Project は作らない**——作るのは人がその画面で「作成する」を押したとき（`v4-modules.md` §2.4「core との境目」：
  core に「Project を作る」口を足さない）。開くのは確かめる画面なので、勝手には何も起きない
- **入口・設定の面からは、人の操作の直後でなくても開く**——clone は何分もかかり、終わったときには押した瞬間（一時的な
  利用者の操作、約5秒）は過ぎている。開いた画面そのものが確かめになる。**会話の中の画面**（AI の tool の結果として
  出たもの——会話のカード・会話の隣・その別タブ）からは、**人がその画面を押した直後でなければ受けない**（AI のターンの
  画面が、人の見ていないところで開かせない。改訂・2026-10-02、レビュー）
- **どの Module からでも同じ**——core は頼んできた Module を名指ししない。ただし**開いた画面に出所を出す**
  （「〈Module〉の画面から頼まれて開きました」）
- **開いている間の頼みは受けない**（人が打ちかけた入力を捨てて開き直さない）。開く場所（外枠）の無い面（別タブの
  Canvas）からの頼みは断る——「開いた」と言って何も出ないことにしない
- Project を「開く」口（既にある Project へ移る）はまだ無い——要るまで足さない

#### 画面から「この Project を開いて」（banto の拡張、決定・2026-10-04、Repositories）

Repositories の一覧の「Project で使っている」の Project 名から、その Project へ移るのに要る。

| 向き | 形 |
|---|---|
| 画面 → banto | request `dev.banto/open-project`（`params.projectId`＝Project の id、`[A-Za-z0-9_-]` 100字まで） |
| banto | **確かめの画面は出さずに、その Project へ移る**（`/p/<id>`）。どの面からでも |
| banto → 画面 | `{}`。読めない params は InvalidParams、受けられないときは -32000 と理由 |

- **確かめの画面を出さない**——移るのは軽く、戻れる操作（作る・閉じるとは違う）
- その代わり、**どの面の画面からでも、人がその画面を押した直後だけ**受ける（既存の2つは確かめの画面が人の目を通すので
  入口・設定の面からは直後でなくても受ける。ここは確かめが無いので、押したことが確かめの代わり）
- **閉じた Project・無い Project は断る**（理由を返す）——黙って再開しない。再開は Module の起動を伴うので、core の画面でも
  「閉じたものの一覧」で人が押したときだけ
- core は頼んできた Module を名指ししない。開く場所（外枠）は要らない（移るだけ）ので、別タブの Canvas からも移る

#### 画面から「同じ Project の別の面を開いて」（banto の拡張、決定・2026-10-07、Factory）

Factory の入口の「経過を見る」（Subagent の画面でその仕事を選んで開く）・「設定を開く」（Project の設定の Factory の節）に要る。
Backlog の「取り組んだ Thread」も同じ口に乗る（ボタンはまだ置いていない）。`lib/backend/canvas-open-surface.ts`。

| 向き | 形 |
|---|---|
| 画面 → banto | request `dev.banto/open-surface`。`params` は次のどれか：<br>`{ surface: "launcher", server, resourceUri?, select? }`——その Module の入口（launcher）の画面。`resourceUri` を省いたら、その Module の入口が1つだけのときそれ<br>`{ surface: "settings", server? }`——Project の設定の、その Module の節。`server` を省いたら頼んできた Module 自身（Module は自分がどの名前で入れられたかを知らない）<br>`{ surface: "thread", threadId }`——その Thread（Base なら Project の会話、Fork ならその Fork） |
| banto | **確かめの画面は出さずに移る**。入口は `/p/<id>?canvas=<server>:<uri>`、設定は**いまの画面の上に重ねる**（閉じると元の画面に戻る）、Thread は `/p/<id>`・`?fork=<id>` |
| banto → 画面 | `{}`。読めない params は InvalidParams、受けられないときは -32000 と理由 |

- **選ぶもの（`select`）は、開いた画面に「見ている場所」として渡す**（`dev.banto/view-state`、下の「見ている場所」）——
  中身は開かれる画面のもので、banto は解釈しない。**どの形で受けるかは開かれる側の Module が決めて書く**
  （Subagent の入口は `{ runId }`。人が仕事を選んだときも同じ形で預けるので、開き直しても同じ仕事に戻る）。
  URL に載るので大きいもの（2000字を超える）は断る。tool の入出力（`ui/notifications/tool-input`）には乗せない——
  あれは「この画面を起こした tool 呼び出し」で、無い呼び出しを作らない
- `dev.banto/open-project` と同じく**どの面の画面からでも、人がその画面を押した直後だけ**受ける（確かめが無いので、
  押したことが確かめの代わり）
- **同じ Project の中だけ**——頼んできた画面が開かれている Project（会話の中なら その Thread の Project）の入口・設定の節・
  Thread だけ。banto 全体の設定の画面（Project が無い）からは断る。**無い Module・無い入口・設定に節の無い Module・
  別の Project の Thread・畳んだ Fork は断る**（黙って別のものを開かない。畳んだ Fork は履歴から人が再度開く）
- 入口と設定の節が在るかは、**移る前に host に聞き直す**（画面の控えが古くて断る、をしない）
- **移っている間の頼みは断る**——聞き直している間に2回押されても、2回移らない
- core は頼んできた Module を名指ししない。開く場所（外枠）は要らない（移るだけ）

#### 画面から「この Project を閉じるかを人に確かめて」（banto の拡張、決定・2026-10-03、Repositories 段階4）

Repositories の「このマシンから削除」で、消したフォルダを Root にしていた Project を閉じるかを人に聞くのに要る。
Module は Project に触らない（v4-modules.md §2.4）ので、**閉じるのは core の確かめで人が押したとき**。上の
`dev.banto/open-new-project` と同じ決まりで足す：

| 向き | 形 |
|---|---|
| 画面 → banto | request `dev.banto/close-projects`（`params.projectIds`＝Project の id の並び。1〜20件、`[A-Za-z0-9_-]` 100字まで、重なりは1つに） |
| banto | **core の「Project を Close しますか」の確かめを開くだけ**（閉じた Project の一覧から再開できる、削除ではない）。どの面からでも |
| banto → 画面 | `{}`。読めない params は InvalidParams で断る |

- **閉じない**——閉じるのは人が「Close する」を押したとき。閉じるのは core の `POST /api/projects/:id/close`
  （画面の「Project を Close」と同じ）。見ていた Project を閉じたら、ほかへ移る
- 出所を出す（「〈Module〉の画面から頼まれて開きました」）。**頼んだ理由は core が言わない**——core は Module の
  都合（「削除したため」）を名指ししない。理由は頼む前に Module の画面が言う
- 会話の中の画面からは人が押した直後だけ・開いている間は断る・開く場所の無い面からは断る——上と同じ
  （`lib/backend/canvas-requests.ts` が2つの頼みの決まりを1か所に持つ）
- **人が断ったら（閉じずに・作らずに閉じたら）、同じ Module の画面からの同じ頼みは 30 秒受けない**——断った直後に
  出し直して、押すまで繰り返す、をさせない（2026-10-03、レビュー）。済んだ（作った・閉じた）あとは縛らない。
  `dev.banto/open-new-project` も同じ
- id が見つからない・もう閉じているものは数だけ言い、閉じるものに入れない

#### 新しい Project の画面に Module が差し出すタブ（決定・2026-10-03、Repositories 段階4）

core の新しい Project の画面は「手元のフォルダ」だけを持ち、**フォルダを用意できる Module の画面**をタブとして並べる
（v4-modules.md §2.4「core との境目」）。

| 向き | 形 |
|---|---|
| Module → banto（名乗り） | 資源（`ui://`、`text/html;profile=mcp-app`）の `_meta["dev.banto/canvas"] = "folder-provider"`。タブの名前・説明・アイコンは資源の `name`・`description`・`icons[0].src`（MCP の標準の欄）。名前は 1〜40 字（外れたら出さず、ログに残す）。core の「手元のフォルダ」と同じ名前なら Module の名前を添える。説明は 200 字で切る |
| banto が集める | `GET /api/ui-folder-providers`——banto 全体（instance）の Module のものだけ。アイコンは `data:image/svg+xml` か `data:image/png` の base64 で 2万字未満のものだけ渡す（画面に外へ読みに行かせない） |
| 画面 → banto（返り） | request `dev.banto/folder-prepared`（`params.path`＝`/` から始まる 4096字まで——`//`・`/./` を畳み末尾の `/` を外して揃える、`..` を含めば断る。`params.summary`＝1〜500字、`params.suggestedName?`＝200字まで） |
| banto → 画面 | `{}`。新しい Project の画面の枠の中に出した画面でなければ断る（-32000）。読めない params は InvalidParams |

- 枠の中の画面は banto 全体の Module の画面（`owner: instance`）として出す。**点線の枠と出所**（「〈Module〉の画面」と
  `ui://…`）を付ける——core の画面の中の「よそ様の画面」
- 返ってきたら core が下の段（Project 名・Advanced）を出して作る。**そのフォルダを Root にした Project が既にあれば、
  新しくは作らずそれを開く**（閉じていれば再開）——core が自分の Project の一覧で調べる（Module に聞かない）。
  Module が言った1行（`summary`）を出所つきで添え、「別のフォルダにする」で Module の画面に戻れる
- **用意されたフォルダにも広い根の警告を出す**（手元のフォルダと同じ `/api/config/root-scope`）——第三者の Module が
  `/` や home を返しうる（2026-10-03、レビュー）
- 名乗る Module が無ければタブを出さない（「手元のフォルダ」だけ）。名乗りが読めなければ理由を出し、手元のフォルダは選べる
- 返す口を MCP Apps の標準（`ui/message`・`ui/update-model-context` 等）にしなかったのは、どれも「会話（モデル）へ
  渡す」意味を持ち、ここは会話の外の画面だから

**iOS との違いを1つ記録**：iOS は宣言（`Settings.bundle`）を OS が描くので、アプリの
コードは設定画面で走らない。banto は Module の HTML を iframe で走らせるので、
表現力は高いが**設定画面に第三者のコードが載る**。上の「常に `sandboxed`」は
その差を埋めるための条件であって、好みではない。

#### 設定 Canvas への Project の文脈（決定・2026-09-02）

Module 自身の設定 Canvas が「role 依存の解決」（アーキ仕様 §2.5）のように **Project ごとに
中身を変えたい**ことがある（例：Repo が「どのリポジトリにどの Vault 接続の
身元を使うか」を Project ごとに持つ）。ここで問題になるのは、**大半の Module
のプロセスは Project に紐づいていない**（アーキ仕様 §10 未決事項の注記、
2026-08-30——MCP 仕様が「接続＝会話ではない」と明言しているため。**ただし
Shell・FileSystem は例外**——閉じ込めの制約から Project 単位でプロセスを
分ける。2026-09-25 からは Project のコンテナの中で起きる、`docs/specs/v4-security.md` §1・
「Project の根は Module 起動時に確定させる」）ということ。**つまり Module 自身は「今どの Project のために
描いているか」を、渡されない限り知りようがない**（例外の Shell/FileSystem
も、設定 Canvas はこの一般的な配線に乗るので同じ扱いでよい）。

- **banto がやること**：Canvas を埋め込む際、**いまどこで開かれているかを渡す。**
  新しい仕組みは要らない（規則12）——`ui/initialize` の `hostContext` に載せる。

  > **実装・2026-09-12**：`hostContext` の `"dev.banto/project"` に
  > `{ id, name }` を入れる。MCP Apps の `McpUiHostContext` は追加の項目を
  > 認めている（index signature、"for forward compatibility"）ので、
  > 受け渡しの道を新しく作らずに済む。**設定 Canvas だけでなく、入口
  > （launcher）から開いた面にも渡す**——対象を選ばせる画面（vault-directory の
  > 「この Project の alias」）は、これが無いと人に UUID を打たせることになる。
  > **名前も渡すのは表示のため**（id だけでは人が選べない）。
  > **渡すのは開かれた場所だけで、Project の一覧は渡さない**——どの Canvas にも
  > 人の Project 名が全部見えることになる。Thread から開いた面には、その
  > Thread の Project を渡す
- **Module がやること（任意）**：Project 識別子を見て中身を出し分けるかどうかは
  Module 次第。**対応しない Module は、今まで通り instance 全体で1枚の設定を
  出すだけでよい**（アーキ仕様 §2.5 冒頭「役割が満たされないときはその機能が使えないでよい」
  と同じ扱い——banto は強制しない）
- **階層1（instance、`/settings`）から開いたときは、Project 識別子を渡さない。**
  Module 側は「instance 全体としての既定」を描く場面だと判断できる

#### tool 起点でない Canvas を、どう成立させるか

MCP Apps は**Canvas が tool 呼び出しの結果として現れる**前提で書かれている
——Canvas は tool の結果を受け取って描く。settings も launcher も tool 呼び出しから来ないので、
**渡すべき「tool の結果」が無い**。

**新しい通り道は作らない**（規則12）。既存の仕組みだけで成立する：

1. banto（host）が `ui://<module id>/config` を読んで、設定画面の中に置く
2. iframe が `ui/initialize` のハンドシェイクをする——ここは tool 起点の Canvas と同じ
3. **中身のデータは、iframe が Module 自身の tool を呼んで読み書きする**
   ——MCP Apps は UI 起点の tool 呼び出しを認めている（host が承認を要求してよい）

つまり「tool の結果を受け取って描く Canvas」ではなく「**自分で取りに行く Canvas**」
になる。**launcher も同じ形**——人が開く、Canvas が自分で必要なものを取りに行く。

この形なら、banto が足すのは**Canvas をどこに置くかの判断だけ**で、Canvas と
Module のあいだの通信は仕様のままになる。

#### launcher——人が、AI を介さずに Canvas を開く

**MCP Apps では、AI が tool を呼ぶまで Canvas が出てこない。** だが「まずファイルを
見たい」「環境の状態を見たい」は、AI に頼む必要のない用事である。**Module が
持ち込んだ Canvas を、人が直接開けるようにする**（要件C3）。

- **宣言は `_meta`**（アーキ仕様 §5.4）——設定 Canvas（上）と**同じ1つの仕組み**を使う。増やさない。
  Module は「入口である」印を、その資源の `_meta` に付ける。人に見せる名前・説明・
  アイコンは**仕様の `title` / `description` / `icons` をそのまま使う**
  （banto 独自のフィールドを足さない）
- **1つの Module が複数の入口を持ってよい。** ファイル Module なら「ファイル」と
  「フォルダ」のように、性質の違う Canvas が複数ありうる
- **指すのは、実在する1つの URI。** 接頭辞やテンプレートではない
  （アーキ仕様 §9：MCP SDK の resource template は末尾スラッシュのみの URI を空文字に
  マッチさせない——「根を指す入口」はテンプレートでは書けない）
- **開くと `fullscreen`（＝会話の隣に Canvas が開く）。** 会話のカードとして出す
  ものではない——tool の結果ではないので、会話に置く理由が無い

**実装（2026-09-07）**：資源の `_meta` に `dev.banto/canvas: "launcher"` と名乗る
（設定 Canvas と同じ鍵、値だけが違う）。host が `GET /api/projects/:id/ui-launchers`
で Module 集合から導出し、Command Palette の「Module の入口」に出す。
**tool 起点でないときは `hostContext.toolInfo` を渡さない**——無いものを作らない。
画面はそれで「人が直接開いた」と分かり、自分で必要なものを取りに行く。

> **モックの入口は `fullscreen=1` を付けていたが、外した**（決定・2026-09-07、規則8）。
> それは banto のパネル状態（会話を隠す全画面）であって、仕様の display mode
> ではない。§6.2 が決めた `fullscreen`＝**会話の隣**に合わせる。

**その Project に繋がっている Module の入口だけを出す。** 繋がっていない Module の
Canvas まで開けるなら、Module 集合を Project ごとに決めている意味（アーキ仕様 §2.2）が薄れる。
**ただし banto 全体に1本の Module（`scope: "instance"`——Repositories・Vault など）の入口は、どの Project にも
出す**（改訂・2026-10-01、ユーザー）。それらは特定の Project のものではなく（例：リポジトリの一覧）、Project を
選ぶ意味が無い。Project に繋ぐかどうかが決めるのは、その Project の AI に tool を見せるかだけで、人が開く画面までは
絞らない。**入口の一覧・開いた画面の中身・画面からの呼び出しの3つが同じ集合を引く**（その Project の Module 集合＋
banto 全体の Module。名前が重なれば Project の側）——入口は出るのに開けない、を作らない（実装・2026-10-01、
`http/app.ts` の `modulesForProjectCanvas`）。
入口の一覧は Module 集合から導出する——別の一覧を持たない（規則3）。

### 6.3 Command Palette（Ctrl-K）——あらゆるものへの1つの入口

**Ctrl-K／⌘K で開き、開いているときにもう一度押すと閉じる**（追加・2026-09-30、ユーザー要望）。閉じたら検索語は残さない。押しっぱなしで開閉を繰り返さない。

banto は「1本の窓口」を3か所で守る。**host が誰と誰を繋ぐかを1箇所で解決する**
（アーキ仕様 §2.5、配線）、**発生源が違っても配達は1本**（§6-5、SSE）、そして
**探すときの入口も1つ**——それが Command Palette。core UI。

**自分の索引を持たない**（規則3）。出るものは全部、すでにあるところから導出する：

| 出るもの | 出所 |
|---|---|
| Project / Thread | Event Store（`fold`） |
| 受信箱（判断待ち・レビュー待ち） | Event Store（`fold`）。アーキ仕様 §2.4 と同じ源 |
| Module の入口（launcher） | その Project の Module 集合＋マニフェスト（§6.2）。**名前・説明・Module の名前のどれかで引ける**（改訂・2026-09-23、ユーザー要望——入口の名前が「ファイル」でも、人は「file」と打つ。Module の名前は項目の下に出す） |
| Module の資源（数えられるもの） | `resources/list` |
| Module の資源（パラメータ付き） | `resources/templates/list` ＋ `completion/complete` |
| core の操作 | Fork する・畳む・新しい Project を作る 等（アーキ仕様 §2.2） |

**Module は「パレットに登録」しない。** 登録のインターフェースを作ると2つ目の一覧ができて、
いつか本体と食い違う。`resources/list` に出ているものが、そのままパレットに出る。

#### 深い検索は仕様の completion API に乗せる（規則12）

ファイルのように数えきれない資源を `resources/list` に並べることはできない。
**仕様はこの問題に既に答えを持っている**（2026-08-29 に確認）：

1. Module は `resources/templates/list` で URI テンプレート（例 `file:///{path}`）を出す
2. **テンプレートの引数の補完は `completion/complete`**——仕様いわく "Arguments may
   be auto-completed through the completion API"
3. banto は打たれた文字をそこへ流し、返ってきた候補を出す

**banto が検索のインターフェースを発明しない。** MCP には資源の検索メソッドが無い（`resources/list`
はページングのみで、クエリ引数を持たない）ので、ここを自前で足したくなるが、
**パラメータ付き資源に限れば completion が正解の場所**である。

#### 見せ方も並び順も、仕様が持っている情報で決める

`resources/list` が返す各項目は `title`（人に見せる名前）・`description`・`icons`・
`annotations.priority`（0.0〜1.0 の重要度）・`annotations.lastModified` を持てる。
**並び順を banto が勝手に決めず、Module が示した `priority` と `lastModified` を
使う**——Module は自分の資源のどれが大事かを知っているが、banto は知らない。

**打鍵のたびに `resources/list` を叩かない。** 応答は `ttlMs` と `cacheScope` を
持ち、`notifications/resources/list_changed` で無効化できる。**キャッシュし、
通知で捨てる**——これも仕様に乗っている（自前のポーリングを書かない）。

#### 範囲

| 出るもの | 範囲 |
|---|---|
| Project / Thread | **banto 全体**（Project を切り替える手段なので） |
| 受信箱 | **banto 全体**（Project の外にある、アーキ仕様 §2.4） |
| Module の入口・資源 | **いまの Project の Module 集合に限る**（§6.2 と同じ理由） |

#### 選んだあと

- Project / Thread → そこへ移動する
- 資源・Module の入口 → §6.2 の起点「人が開く」＝ Module の Canvas を `fullscreen` で開く
- 受信箱の項目 → **その Thread を開く**（訂正・2026-09-10）。**答える口は Thread 側の
  カード**（アーキ仕様 §2.4.1、決定・2026-09-06。Module 間中継の承認だけは受信箱の中でも答えられる——改訂・2026-10-05）
  ——検索から選んだときは Thread を開くだけ。レビュー待ちは Thread（純粋完了）または Module の Canvas（Module 発）が開く
- 操作 → 実行する

> **要件が「まだ無いもの」として挙げている機能である**（`docs/requirements.md`）。
> v4 では
> **core UI として最初から置く**——後から足せる飾りではなく、Module が増えるほど
> 「どこに何があるか」が分からなくなる構造への答えだから。

### 6.4 assistant-ui との境界——何を載せ、何を自分で作るか

会話の器には **assistant-ui** を使う。**どこまでが assistant-ui の仕事で、どこから
banto の仕事か**を、MCP 仕様から出てきた要求（アーキ仕様 §2.4・アーキ仕様 §5.3・§6.0・§6.2）に照らして
線引きする。

> **確認日 2026-08-29**（規則1）。以下の API 名は**その時点の公開ドキュメント**の
> もの。**版によって
> API 名が変わっている**（旧 `makeAssistantToolUI` → 現 `defineToolkit` の
> `render`）。実装前にピン留めする版のドキュメントで確かめ直す。

#### そのまま載るもの

| banto が要るもの | assistant-ui の対応物 |
|---|---|
| tool 呼び出しの表示（§6.0） | tool part の `render`（`args` / `argsText` / `status` / `result` / `isError`） |
| **呼ぶ前に入力を見せ、人が拒否できる**（§6.0） | **承認ゲート**（`approval` / `respondToApproval({ approved })`）＋ `status: "requires-action"` |
| 実行中・失敗・取り消しの表示 | `status`：`running` / `incomplete`（`cancelled` \| `error`）/ `complete` |
| 会話を止める（アーキ仕様 §8 A-2/A-3） | `incomplete` の `cancelled` |
| やり直す（アーキ仕様 §2.2） | メッセージ位置での分岐（`switchToBranch({ position, branchId })`）。**実 Thread にはまだ出さない**——下記 |
| Fork Thread（アーキ仕様 §1.1） | Thread（`switchToThread` / `switchToNewThread`） |
| 汎用フォールバック表示（§6-3） | `ToolFallback` |
| 添付 | Attachments |

> **やり直し（Edit・Reload・BranchPicker）は、実 Thread にはまだ出さない**
> （決定・2026-09-10、`CONNECTED_FEATURES.threadBranching`）。実測：Edit すると
> 画面は分岐に見える（古い枝が隠れ、`1/2` が出る）が、**host には直列に追記される
> だけ**で、リロードすると分岐は消えて4件が並ぶ。人は「前の失敗した指示は無かった
> ことになった」と思うのに、それは次のターンの文脈に残る——見えているものが
> 繋がっていない（規則13）。**本物の分岐は host 側の仕事**（会話の切り詰めと
> resume-point の巻き戻し）で、まだ無い（Backlog の `thread-branching-host`）。
> モックの台本はローカルの分岐で完結しているので、そちらには出す。

> **承認ゲートは、置けば出るものではない。** ドキュメントに明記がある——
> 「approval gate は**それを実装した runtime が必要**」（AI SDK v7 の runtime は
> `toolApproval` で印を付けた tool に対して emit する）。**banto は自前の runtime を
> 持つので、承認待ちを emit するのは banto の責任。** §6.0 の「サーバを呼ぶ前に
> 入力を人に見せるべき」を実際に満たす場所はここ。
> どの tool を既定で承認待ちにするかは `annotations`（アーキ仕様 §5.3）の `destructiveHint` /
> `readOnlyHint` を材料にする——**きつくする方向にだけ使う。**

**承認ゲートの「毎回聞くと承認依頼ストームになり、人が脳死でOKを押すようになる」問題への対処は、Agent SDK に委ねる（決定・2026-08-31）。** banto が独自に「まとめて許可・信頼済み扱い」のポリシーを設計する前に、Claude Agent SDK 自体を確認したところ（`poc/step0-host-mcp-client/node_modules/@anthropic-ai/claude-agent-sdk` v0.3.237、型定義で確認）、この問題への解が既に用意されていた（規則12）：

- **`canUseTool` フック**——tool を呼ぶ直前に host（banto）へ許可判断を委譲するインターフェース。承認ゲートの実装点はここに載せる
- **`permissionMode`** は `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'` の6値。うち `'dontAsk'`（事前承認されていないものは黙って拒否）と `'auto'`（モデル分類器が許可/拒否を自動判定し、人に上げるのは本当に必要なものだけ）が、ストーム対策そのものにあたる

**banto は既定を `auto`（または `dontAsk` ＋ 事前許可リスト）にし、独自のストーム対策ポリシーを設計しない。** 事前許可リストをどこに持たせるか（Configuration か Event Store か）は未決のまま残る。

#### `permissionMode` は Thread 単位で選べる（決定・2026-09-02、改訂・2026-09-03）

**`permissionMode`（本節冒頭の6値）は Configuration の既定値を持ちつつ、
会話の composer から Thread 単位で切り替えられる。** Claude Code 自身が
CLI で持っている「その場でモードを切り替える」操作（Shift+Tab でのモード
循環）と同じ発想——**新しい呼び名・新しい概念は発明しない**（規則11・12）。

**2026-09-02 時点では「全許可トグル」という ON/OFF の Configuration 項目
（`dangerouslySkipPermissions`）として個別に設計していたが、これは
`permissionMode` を `bypassPermissions` に固定するのと**同じことを別の形で
表現しているだけ**だと分かった（規則3「真実は一箇所」違反）。composer から
6値を直接選べるようにすれば、専用の ON/OFF フィールドは要らない——
撤回する。**

**決まっている形：**

- **Configuration（アーキ仕様 §2.6、runtime config）は `defaultPermissionMode`
  を1つ持つ。** 既定値は `auto`（本節冒頭のとおり）。Project 単位で上書き可能
  （既定で開いている——個別のブラックリストには入れない）。**新しい Thread は
  ここから始まる**
- **composer に、現在の Thread の `permissionMode` を示す常設のインジケータ
  兼切り替えボタンを置く**（ドロップダウンまたは循環ボタン、モックで詰める）。
  選べる6値と、人向けの見せ方：

  | 値 | 見せ方（案） | 危険度 |
  |---|---|---|
  | `auto` | 既定——モデル分類器が判定 | 通常 |
  | `default` | 毎回確認 | 通常（より慎重） |
  | `acceptEdits` | 編集は自動承認 | やや緩い |
  | `plan` | プランのみ（実行しない） | 制限的 |
  | `dontAsk` | 未承認は黙って拒否 | 制限的 |
  | `bypassPermissions` | 全部自動承認（`--dangerously-skip-permissions` 相当） | **危険** |

- **切り替えは Thread 単位で効き、その Thread に残る**（改訂・2026-09-06）。
  他の Thread や新しい会話には影響しない——Configuration の既定値から始まる。
  **「いま自分がどのモードで会話しているか」を見失わないよう、composer の
  インジケータは常時表示する**（選んだ後、目立たなくなって忘れる、という事故を避ける）
- **選んだ値は host が持つ**（`ThreadState.permissionMode`、イベントは
  `thread.permission_mode_set`）。ターンを実際に走らせるのは host であり、
  UI 側だけに置くと**リロード1回で既定に戻る**——上の「見失わない」という
  狙いがそこで崩れる（ユーザー報告・2026-09-06 で発覚）。
  切り替えていない Thread は値を持たない——カスケードから導出する（規則3）。
  **解決の順は「このターンの指定 → Thread の選択 → 設定（Project 上書き →
  instance 既定）→ `auto`」**（実装・2026-09-10）。設定に壊れた値が入っていても
  そこで止まらず `auto` に落ちる（設定は人が書き換えうる）。**設定を変える口は
  いま API だけ**（`/api/config/default-permission-mode`）——設定画面はまだ
  実データに繋がっていないので、画面には出さない（規則13）

**`bypassPermissions` が素通りさせるのは `canUseTool`（本節冒頭、AI が
tool を呼ぼうとしたときの確認）だけ。** Module 間中継の承認ゲート（下記
「入れ子の承認」）には**効かない**——`permissionMode`とは別の軸だと分かった
ため（決定・2026-09-03、ユーザー指摘）：

- **`permissionMode` が答える問い**は「このモデルの判断をどこまで信用するか」
  ——**AI に対する信用**の軸
- **Module 間中継の承認ゲートが答える問い**は「あるModule（例：Shell）が、
  別のModule（例：Vault）の内部 tool を呼んでよいか」——**Project の配線
  そのものへの信用**の軸で、モデルの判断とは無関係
- **`bypassPermissions`（モデルへの信用を最大まで緩める）を選んだからといって、
  Project の内部配線（Shell が Vault の秘密取得経路に触れてよいか）まで
  黙認してよいことにはならない。** 通知疲れを解消したいだけの人が、意図せず
  内部配線の承認まで一緒に飛ばしてしまうのは事故のもと
- **したがって Module 間中継の承認ゲートは、`permissionMode` の値に関わらず
  常に初回確認を行う**（例外は Project の「承認をすべて自動で許可する」だけ——下記、決定・2026-10-05）。 以降は §2.5 で決めた粒度（呼び出し元・宛先・
  tool 名の組み合わせごとに1回、Project 内で自動許可）でキャッシュされる
  ——これは元々の設計のままで変更しない

**スコープを限定する**：`bypassPermissions` が素通りさせるのは**承認
（安全確認）だけ**。Elicitation を通じて AI が人に何かを尋ねる判断待ち
（例：Vault の `requestAlias`「このaliasが無いので登録してほしい」）は
対象外——これはセキュリティ確認ではなく、進めるのに人の入力そのものが要る
種類の判断待ちで、スキップすると単に処理が続行できない。**「危険な操作を
黙って許す」と「人にしか出せない答えを待つ」を混同しない。**

**UI**：composer のインジケータ／切り替えは、**`bypassPermissions` を選んだ
ときだけ危険性が一目で分かる見た目にする**（警告色。選ぶ操作自体に軽い
確認を挟んでもよい——具体的な見た目はモックで詰める）。他の5値は通常の
UI でよい——危険なのは `bypassPermissions` だけで、他は単なる作業モードの
切り替え。設定画面側には `defaultPermissionMode` の選択欄を置く（階層1・
階層2どちらでも、既存のカスケード表示に乗る）。

#### 承認をすべて自動で許可する（Project の設定、決定・2026-10-05、ユーザー）

**Project の設定に1つのスイッチ「承認をすべて自動で許可する」を置く（既定はオフ）。** オンの Project では、
banto が人に「許可するか」を聞くものを**全部**、人に聞かずに許可する。`bypassPermissions` が緩めるのは AI への
信用だけ（上記）だが、こちらは**その Project で人が承認の役を降りる**というスイッチで、軸を混ぜずに別に置く。

- **対象**（4つ）：
  1. AI の tool 呼び出しの確認（`canUseTool`）——`permissionMode` の値に関わらず、聞かれたら自動で許可
  2. Module 間中継の承認（下記「入れ子の承認」）——**コンテナからの `resolveAlias` のように秘密を返すもの
     （`scope` 付き）も含めて全部**（案A）
  3. Project をまたぐメッセージの確認（アーキ仕様 §4.2）——**送り元の Project** のスイッチで決める
  4. Publish の公開の承認（v4-modules.md §4.3）——承認画面の既定の値（サブドメインは出し方の既定
     `<サービス名>-<Project id 先頭8>`・認証は既定）で、人を待たずに公開する
- **対象外**（自動にしない）：パスキーの step-up、人が値を入れるもの（Vault の `requestAlias`・ログイン）、
  AI が選択肢で人に問う Elicitation、Skill の取り込み（`import_skill`）——上の「承認（安全確認）」と
  「人にしか出せない答えを待つ」を混同しない、と同じ線
- **自動で通したものは覚えない**：中継の許可（`relay.grant_created`）を残さない。Project をまたぐメッセージの
  「受け取ってよい Project」にも足さない。**スイッチを切れば、また聞く**
- **何を自動で許可したかは会話に残す**：判断待ちは今までどおり出し（受信箱の記録・会話のカード）、**出した
  そばから host が答えて決着させる**。カードは答え済みの形で「回答：自動で許可しました（承認をすべて自動で
  許可する がオン）」と出る。受信箱に未解決は残らない。中継の呼び出しの記録（`relay.call_recorded`）の理由にも
  「自動で許可」と残す。Publish は承認画面が「自動で許可して公開しました」の形で出る
- **置き場は Configuration**（アーキ仕様 §2.6）：鍵 `approvals.autoApproveAll`（真偽値）。**Project にだけ置ける**
  ——instance 既定は読まない（全 Project で一度に人を外す口は作らない）。口は
  `GET/PUT /api/projects/:id/auto-approve`。保存した時点で、走っているターンにも**次の承認から**効く
  （判断のたびに設定を引く）
- **Module はスイッチを知らない**。Publish のように Module の中で人を待つものには、host が呼び出しの `_meta` に
  `dev.banto/autoApprove: true` を刻む（`dev.banto/thread` と同じく host だけが刻む。Module の申告・AI の引数は
  使わない）。刻むのは**スイッチがオンの Project のための、AI のターンから始まった呼び出し**——AI の代理接続からの
  呼び出しと、その処理の中で Module が中継で呼ぶ先（host が自分の台帳で Project と出所を引く）。人の画面からの
  呼び出しには刻まない（人が押している）。Module は**この刻印が立っているときだけ**人を待たずに進める
- **画面**：Project の設定の「一般」に1節（スイッチと説明）。説明には「Vault の秘密の取り出し・公開も含めて、
  この Project の AI が頼んだものは人に聞かずに通る」ことをはっきり書く。オンのとき、入力欄の
  `permissionMode` のメニューの隣に「自動で許可中」の小さな印を出す（警告色）

> **これは Claude Agent SDK 固有の機構である。** item 1 の PoC（アーキ仕様 §4.1・アーキ仕様 §10.2）で、別 backend（opencode）は elicitation 自体に非対応など、Runner ごとに機能差があることが実測済み——**Phase 0 が Claude backend 限定であることは既に受け入れている制約**（アーキ仕様 §10.2）なので、承認ゲートをこの機構に委ねる決定もその範囲に乗る。別 Runner を足すときは、この委任がそのまま使えない可能性がある。

#### モデルと reasoning effort も Thread 単位で選べる（決定・2026-09-23、ユーザー要望）

**入力欄の下、permissionMode の隣に「モデル · effort」を置く。** 選んだ値は host が Thread ごとに
持ち（`thread.model_set`、リロードしても残る）、**次のターンから**効く（1ターン＝1回の `query()`、
アーキ仕様 §2.3 なので、ターンごとに `model`・`effort` を渡すだけで切り替わる）。

- **一覧は持たない**（規則3）——host が CLI に `supportedModels()` で聞いたもの（`GET /api/models`、
  10分覚える。**期限が切れたら前の一覧をすぐ返し、裏で取り直す**。host は起動したら一度取っておく
  ——ターンの前に AI に伝えるモデル名を引くので、取っていないとターンが CLI の起動を待つ。2026-09-26）。effort の段もモデルごとにそこから来る（Haiku のように effort を持たないモデルもある）。
  「Default (recommended)」の行を選ぶことは「選んでいない」と同じ（CLI の既定に付いていく）
- **会話の途中で変えてよい。ただし黙って変えない**——変えた次の1ターンはそれまでの会話を読み直すぶん
  高くつく（キャッシュが効かない。**effort だけを変えても同じ**——実測・2026-09-23：同じ effort なら
  読み取り 8,417、変えると 0）。会話が始まっていたら、変える前にそれを見せて確かめる（アーキ仕様 §3）
- 一覧に無いモデル・そのモデルに無い段は host が断る（次のターンが CLI で落ちるまで分からない、を作らない）
- **Fork は親の選択を引き継ぐ**（黙って既定に戻すと、その Fork の最初のターンでキャッシュが効かない）
- Project・instance の既定モデル（§6.1 階層1・2、アーキ仕様 §2.2 の表）はまだ無い——選んでいない
  Thread は CLI の既定で走る

#### 画像を添えて送る（決定・2026-09-26、ユーザー要望）

**入力欄に画像を貼り付けて（＋ボタン・ドラッグでも）添えて送れる。** AI には画像として届き、
送った発言に付いて出て、リロードしても残る。器は assistant-ui の添付（Attachments）をそのまま使う。

- **形式は PNG・JPEG・GIF・WebP**（Claude が読めるもの）。**1枚 10MB、1回 10 枚まで**。正は host で、
  形式は画面の申告ではなく**中身の先頭から**決める。画面は同じ値を持ち、送る前に知らせるだけ
- **縮めない。** 大きな画像は Runner の CLI が長辺 2000px の JPEG にしてから API へ送る（実測）。
  banto で縮めても同じことを二重にやるだけ
- **貼り付けは、文字があれば文字を貼る。** クリップボードに文字が無いとき（スクリーンショット等）
  だけ画像を添える——Excel・Word のコピーは文字と一緒にその絵も載るので、画像を優先すると表が絵に
  化けて文字が消える（assistant-ui の既定がこれ）。ファイルそのものを添えたいときは ＋ かドラッグで
- 添えられなかったときは**入力欄の中に理由を出す**（黙って何も起きない、を作らない）。
  添えられない会話（モックの台本）には ＋ を出さない（規則13）
- **口**：`POST /api/threads/:id/messages` に `images: [{ data（base64）, name? }]`。host は画像を
  置き場（アーキ仕様 §2.1「大きなバイト列はイベントに入れない」）に置いてからターンを始める。
  **1枚でも駄目なら何も始めず 400**（一部だけ送らない）。AI には `[画像…, 文]` の順で渡す
- **表示の取り直し**：`GET /api/images/:id`（ログインの Cookie と独自のヘッダつき）。`<img>` は独自のヘッダを持てないので、
  画面は取ってから手元の URL（`blob:`）にして出す
- 画像だけの発言も送れる。閉じた Thread の概要では「（画像 N 枚）」と出す
- Fork は分けた時点までの画像を引き継ぐ（発言の記録ごと引き継ぐので、別の仕組みは要らない）

**まだ決まっていないこと**：画像が会話に積もると、API の1回の上限（32MB）に当たりうる。CLI は
画像を 0.5MB 前後の JPEG にするので、60 枚ほどが目安。当たったときは CLI が「/compact するか
新しい会話を」と言う。banto の側で何かするかは、当たってから決める。

#### 承認ゲートの一時停止は「電話を切らずに待つ」モデルで実装する（決定・2026-09-01、実測 `poc/04-canusetool-hold-the-line/`）

**アーキ仕様 §2.3「1ターン＝1回の `query()`」は、ターンとターンの間の話であって、
ターンの途中の一時停止（tool 承認）とは別の階層である。** `canUseTool` は
`onElicitation` と同じ、banto の host が実装するただのローカルなコールバック
（`(toolName, input, options) => Promise<PermissionResult>`）——SDK は
このPromiseが解決するまで、**その turn の `query()` プロセスを内部で
そのまま待たせる**。turn のプロセスを一度終わらせて、あとで新しく作り直す
必要は無い。

**実測で確認した**（`run-hold-the-line.mjs`）：`canUseTool` を90秒
（Elicitation の既定タイムアウト60秒より長く）解決しないまま放置しても、
SDK 側が独自にタイムアウトして自動拒否することはなかった。90秒後に
`allow` を返すと、tool は正しく実行され、結果は同じ `query()` 呼び出し
（同じターン）の会話としてそのまま返ってきた。

> **つまずいた点**：builtin tool（`Bash` 等）で試すと、`canUseTool` を
> 経由せず自動承認された——この検証環境が Claude Code の子セッション
> （`CLAUDE_CODE_CHILD_SESSION=1`）で、親セッションの信任を継承して
> バイパスしていたためとみられる。**banto の本実装は子セッションではない**
> ので無関係のはずだが、記録として残す。MCP tool（`module.mjs`、
> `destructiveHint: true` を宣言）に変えるとバイパスを受けず、正しく
> `canUseTool` が呼ばれた。

**帰結：承認ゲートは「一続きの `run()` の中で、後から結果が自然に出てくる」
モデルA で実装する。** モックで `approval`/`respondToApproval`
（assistant-ui の「provider が結果を出す」前提、`EDGE_CASES.md` A.8）を
試して踏んだ不具合（離散ステップを `return` して作り直す構造と噛み合わず、
二重に再開処理が走ってスタックした）は、**モックの簡易アダプタが
「一時停止のたびに `return` して、あとで新しく呼び直される」モデルB
で作られていたことが原因**——本実装のアダプタを、SDK の `query()` を
そのままラップする一続きの generator として作れば、この不具合は再発しない
見込みで、`approval`/`respondToApproval` が自然に噛み合う可能性が高い。
モック（人が client 側で結果を作る、`unstable_humanToolNames` +
`addResult`）と本実装（SDK が結果を出す、`approval` +
`respondToApproval`）で、見た目は同じでも内部の機構が変わる、という
点は実装時に意識する。

#### 答え方——選択肢は押したら送る・ボタンは右寄せ（決定・2026-10-05、ユーザー要望）

- 判断待ちのカード（tool の承認・Module 間中継の承認・Project をまたぐメッセージの承認・Elicitation の選択肢）は、
  **選択肢を押したらそのまま答えを送る**。「選んでから『この内容で送る』」の2段はやめた。自由記述があるものだけ、
  打ち終わりが分からないので書いた文を送るボタンを残す。受信箱の表示も同じ部品（`ElicitationFormView`）。
- 選択肢のボタンはカードの**右に寄せる**。最初の選択肢（ふつう「許可する」）だけ塗り、ほかは枠だけ。
  送っている間は全部押せなくして二重に答えない。
- 見出しは、答えが無い間だけ「<名前> があなたの判断を待っています」。答え済み（人が答えた・自動で許可した・止めた）は
  「<名前> の確認」にして、下の「回答：…」で何が起きたかを読ませる（2026-10-05、ユーザー。自動で許可したカードが待っているように読めた）。
- **tool のカード（`ToolFallback`）に assistant-ui の「Allow / Deny」を出さない**。判断待ちが出ている間、
  assistant-ui は同じ発言の結果の無い tool 呼び出しを全部 requires-action にし、そこへ Allow / Deny を出していた
  ——押しても host には届かない。承認は判断待ちのカードでだけ聞く。~~自動で開く振る舞いはそのまま。~~
  **改訂・2026-10-06（ユーザー）**：そのような承認と関係のない tool のカードは**自動で開かない**（閉じたまま、押せば開く）。
  開くと承認のカードが埋もれ、開くかどうかが結果の届く順番しだいで揃わなかった（Backlog #215 の試験が時々落ちた原因）。
  承認を求めるカード（判断待ち・中継の承認・Shell）と、それらを包む tool のまとまりは今までどおり開く。

#### Module 間中継の承認（入れ子の承認、決定・2026-09-02）

**アーキ仕様 §2.5「Module 間の呼び出し——host が中継する」の承認ゲートは、`canUseTool`
とは別の階層にある。** `runCommand`（Shell）の実行中に、host 中継経由で
Vault の `resolveAlias` を呼ぶような場面では、**外側の tool 呼び出し
（`runCommand`）は既に `canUseTool` の承認を通過済み**——中継の承認は、
その tool のハンドラが実行されている**内側**で新たに発生する、入れ子の
判断待ちになる。

**新しい機構は作らず、既存の3つを組み合わせる：**

1. **判断待ちとして扱う**（アーキ仕様 §2.4 の一般化）。発生源は会話・Factory・機構だけ
   でなく、**host 自身の中継ロジックも発生源になれる**——「進行が止まって
   いるかどうか」が判定基準であって「Module が関わっているかどうか」では
   ない、という アーキ仕様 §2.4 の軸がそのまま当てはまる
2. **外側の tool 呼び出しは「電話を切らずに待つ」**（`canUseTool` と同じ
   hold-the-line モデル、上記）。ただし今回は `canUseTool` の Promise では
   なく tool ハンドラの実行そのものが待つ形なので、**放置すると MCP の
   既定タイムアウトに掛かるリスクがある**——待っている間、代理サーバ
   （アーキ仕様 §2.5「Runner は実 Module に直接繋がない」）が `notifications/progress`
   を定期送出してクライアント側のタイムアウトを更新する。Shell の長時間
   コマンド対策（`docs/specs/v4-modules.md` §2.3）と**同じ手当てを使い回す**

   > **実装・2026-09-10**：host は承認を待っている間、呼び出し元の Module へ
   > 10秒ごとに「人の承認を待っています」を送り、Module（Shell）はそれを
   > 自分の呼び出し元（＝AI のターン）へそのまま流す。**3ホップとも同じ手当て**
   > ——どこか1つでも黙ると、そこが60秒で切れる。実測：承認を90秒待たせても
   > 外側の `runCommand` は生きていて、許可した直後に秘密の値が届いた。
   > ~~なお答えが遅れても無駄にはならない——host は答えを待ち続けるので、
   > 仮に呼び出し元が諦めても、許可は記録に残り、やり直せば通る~~（改訂・2026-10-04）
   >
   > **改訂・2026-10-04（ユーザー報告「publishService が承認待ちで止まる」）**：進捗を流し直さない
   > Module（publish-directory）では、外側の AI → Module の呼び出しが host の既定60秒で切れていた。
   > 切れたあとも判断待ちは残ったが、答える口（会話のカード）はそのターンの中にしか無く（受信箱は
   > Thread を開くだけ、2026-09-26 に受信箱から描き足す道をやめた）、**次の呼び出しはその判断待ちに
   > 相乗りしてカードが二度と出なかった**。直し方は2つ：
   > - **人の答えを待つ間は、外側の呼び出しの上限を数えない**——上限は host が自分で数え（Module が
   >   進捗も返事も寄こさない60秒）、中継の承認を待っている間（台帳 `ModuleCallTracker.holdForHuman`）
   >   は数えない。Module が進捗を流し直さなくても切れない
   >   - **入れ子でも外側まで数えない**（追加・2026-10-06、本番で「Backlog の書き込みが承認の間もなく時間切れ」）：
   >     AI → Backlog → Repositories → Vault のように中継が2段になると、承認を聞くのは奥の Repositories の呼び出しなのに、
   >     上限を数えているのは外側の AI → Backlog で、そちらが60秒で切れて内側のカードも畳まれた（人には一瞬で消えて見えた）。
   >     台帳は中継で呼んだ側の呼び出しを親として持ち（`beginCall` の `parent`、`host-relay-endpoint.ts` が渡す）、
   >     `holdForHuman` は親をたどって外側の呼び出しにも人待ちを立てる。あわせて Repositories の中継の呼び出しも、
   >     ほかの Module と同じく進捗で上限を数え直す（`resetTimeoutOnProgress`）
   > - **聞いた呼び出しが終わったら判断待ちを畳む**（拒否として決着させ、カードは回答済みにする）。
   >   答えても届く先が無いため。次に呼ばれたら新しく聞き、そのターンにカードが出る
   >
   > **改訂・2026-10-05（本番の Backlog で、承認のカードが畳まれずに残り、以後の書き込みでカードが出なかった）**：
   > 「聞いた呼び出しが終わる」を host が知る経路が足りなかった。Runner（同梱の Claude Code 2.1.281）は、返事も進捗も
   > 来ない MCP の呼び出しを **300秒で諦め、取り消しを送らない**。ターンを止めたときも CLI はプロセスごと終わり、
   > 取り消しもセッションの終わりも送らない（どちらも実測）。60秒の上限は Runner には無い——60秒で切っていたのは host
   > 自身の上限だった。経緯は `docs/notes/2026-10-05-relay-stale-card.md`。次の4つで塞ぐ：
   > - **人を待っている間は、AI の代理サーバが Runner へ進捗を送る**（10秒ごと、「人の承認を待っています」）。
   >   人を待っていることを知っているのは host なので、host が送る——Module に流し直させない（流し直さない Module で
   >   切れたのが 2026-10-04 の症状。上の「3ホップとも同じ手当て」のうち、Runner へのホップは host が持つ）
   > - **同じ Module のほかの呼び出しが人を待っている間も、上限を数えない**（進捗も送る）。Module は中で仕事を1本ずつ
   >   並べることがあり（Backlog の書き込み）、後ろの呼び出しは人を待つ呼び出しの後ろで黙って待つ。どれが列の
   >   どこにいるかは host から見えないので、Module の単位で「いま人を待っている」と見る。待ち終えたら、上限は
   >   そこから数える
   > - **Runner が返事を受け取れなくなったら、その呼び出しを止める**——返事が載る応答の流れ（Streamable HTTP の POST の
   >   応答）が、返事を書き終える前に閉じたら止める。再開のための記録は持たせていないので、閉じた流れの返事はもう
   >   誰にも届かない。止めれば台帳から外れ、上の「聞いた呼び出しが終わったら畳む」が働く
   > - **相乗りした先が「聞いた呼び出しの終わり」で畳まれたら、続いている呼び出しは自分の会話で聞き直す**。人は
   >   何も答えていないので、畳まれた理由をそのまま受け取らない
   >
   > **改訂・2026-10-05（続き、ユーザー指示。`docs/notes/2026-10-05-relay-card-followups.md`）**：画面の側の3つ。
   > - **ターンが先に終わってから畳まれたカードも、開き直さずに答え済みになる**。畳んだことはターンの流れでしか
   >   届かず、終わったターンのカードは答えられるように見えたまま残っていた。host は判断待ちに答えが付くたびに
   >   （人が答えた・host が畳んだ・ターンを止めた、どの道でも）ターンをまたぐ知らせ `judgment.answered`
   >   （`/api/events`、§6.8）も流し、会話のカードはそれでも答え済み（「回答：…」）になる。見た目は答えたカードと同じ
   > - **カードが答えを待っている間も「止める」を出す**。assistant-ui はその間を「走っていない」と数えて停止ボタンを
   >   消していたが、ターンは host で走っている。送るボタンの位置に同じ停止ボタンを出し、押せば停止ボタンと同じ
   >   止め方（§6.31）——ターンが止まり、カードは「止めた」で畳まれる（受信箱からも消える）。出すのは、
   >   画面がそのターンの流れを読み続けているときだけ（台本の会話では出さない）
   >
   > **改訂・2026-10-05（さらに続き、ユーザー決定「止めたことを忘れそうなので残してほしい」。
   > `docs/notes/2026-10-05-relay-card-stop-keep.md`）**：
   > - **中継の承認のカードは、答え済みの形で会話に残る**——止めたとき・開き直したとき（会話を記録から組み直すとき）も。
   >   止める・人が答える・host が畳む（聞いた呼び出しが終わった）・ターンが先に終わる、どの決着でも同じ。見た目は
   >   答えたカードと同じ（「回答：…」、答える口は無い）。以前は記録に載らず、組み直すと消えていた
   > - **止めたときの答えは「人がターンを止めました」**（止めたターンの tool の承認を畳むときの言葉と同じ）。host は
   >   このターンの判断待ちを、CLI を止めるより**先に**この言葉で畳む——先に CLI を止めると、聞いた呼び出しが終わった
   >   として「承認を聞いた呼び出しが、人が答える前に終わりました」で畳まれ、止めたことがカードに残らない
   > - 記録に載せるのはカードの**id だけ**で、中身（宛名と答え）の真実は受信箱（アーキ仕様 §2.5「記録に残るのは宛名だけ」
   >   はそのまま——引数の値はどこにも載らない）。Thread を返すとき host が受信箱から引いて添える（アーキ仕様
   >   「止めたターンの記録」）
   > - 組み直した会話では、答え済みのカードは**ほかの tool 呼び出しと一緒に畳んで出す**（「N tool calls」。下の「乗った流れ」の
   >   決まり——答えを待っているものだけが開いて出る——と同じ）。止めた印（「ここで止めました」）は畳まずに出る
   > - **受信箱でも答えられる**（アーキ仕様 §2.4.1 の例外）。判断待ちの行の下に、会話のカードと同じ部品で
   >   選択肢を出す（「答え方」）。答えはその呼び出しに届き（待っている呼び出しが続く）、会話のカードも答え済みになる
3. **見せ方は既存の承認ゲート UI を再利用する**。会話中のインラインカード
   （承認ゲートと同じ見た目、`runCommand` のカードのそばに表示）と、
   受信箱（アーキ仕様 §2.4）への計上を両方行う——他の判断待ちと同じ二重の出し方

**ストームにはならない。** アーキ仕様 §2.5 の承認キャッシュ粒度（呼び出し元・宛先・
tool 名の組み合わせごとに1回）がそのまま効くため、**初回だけこの入れ子の
待ちが発生し、以降は同じ Project 内で自動承認される。**

**`permissionMode` の値に関わらず、この入れ子の確認は常に行う**（上記
「`permissionMode` は Thread 単位で選べる」節、決定・2026-09-03）——AI への
信用（`permissionMode`）と Project の内部配線への信用（この中継ゲート）は
別の軸であり、`bypassPermissions` を選んでもこちらは省略されない。
**例外は Project の「承認をすべて自動で許可する」がオンのときだけ**（上記「承認をすべて自動で許可する」、
決定・2026-10-05）——カードは答え済みで出し、許可は覚えない。

**宛先の口が「呼び元の Module が持ち主のものだけを書き換える口」（`dev.banto/callerOwned`）を名乗るときも、出所を問わず
カードを出さない**（決定・2026-10-06、アーキ仕様 §2.5）——宛先が同梱で、呼び元が banto 本体で動く同梱の Module のときだけ。
AI のターンの中で Repositories が回った GitHub のログインを Vault に書き戻すと、以前はここでカードが出て、答えが無いまま
切れると Vault に無効な鍵だけが残っていた。記録には理由つきで残る。

**出所が「人の画面」で、宛先が `admin` 可視性のときは聞かない**（決定・
2026-09-12、`docs/notes/2026-09-12-vault-directory.md`）。

- **なぜ**：「画面が自分の Module を呼ぶときは承認を求めない——その画面を
  開いたのは人」（決定・2026-09-07、上記 §6.2）の延長。vault-directory のような
  「依存先を操作するための画面」では、中継の1ホップは**同じ人の操作の続き**で
  あって別の意思ではない。実測（2026-09-12）では**開いた瞬間の読み取りから**
  ゲートに掛かり、画面は無言で止まって答えは別の会話に出た
- **緩める線は「同梱どうしか」**（改訂・2026-09-20、ユーザー決定。以前は
  「`admin` だけ」だった）。出所が画面なら、**両側が同梱の Module のときは
  `module` 可視性（値を返す部品間専用の口）も聞かない**。宛先が `admin` の
  ときは、今までどおり同梱でなくても聞かない
  - **なぜ変えたか**：Vault をまたぐ移動が動かなかった（2026-09-20、ユーザー報告）。
    窓口は移す元で `resolveAlias` を呼ぶので、**人が「移す」を押した瞬間に
    ゲートで止まり、画面は無言のまま**受信箱に承認のお願いだけが積まれていた
    ——この節が 2026-09-12 に「画面は無言で止まり、答えは別の会話に出た」と
    書いた症状が、`module` 可視性でそのまま残っていた
  - **第三者が絡んだら今までどおり聞く。** 「悪意ある Module が自分の画面から
    `admin` tool を1つ生やし、その中で他 Module の秘密を引いてブラウザへ返す」
    という筋書きは、**そこに第三者が居ることが前提**——両側同梱に限れば塞がれたまま
    （`docs/specs/v4-security.md`）
  - **同梱かどうかは `command`＋`args` で決まる**（名前は見ない）。目録から
    入れた公式 Module も同梱扱い——同じコードが走るため
- **聞かないが、記録はする。** Event Store の監査には
  `reason: "人が画面で行った管理操作"` として残る
- **出所は台帳で引く**（推測しない、規則3）——host は `ui-tool-call` を
  処理している間だけ「この Module はいま人の画面の操作を実行中」と記録する。
  **1つでも AI のターン由来の呼び出しが混ざっていたら、ターン扱い**（規則2——
  緩いほうへ倒さない）
- **画面からの呼び出しは人を待つことがある**ので、host → Module の tool 呼び出しの
  上限は MCP の既定（60秒）ではなく10分にする。さもないと、人が答える前に
  切れて「画面にだけ失敗が出て、次に押すと通る」という分かりにくい形になる
- **承認を出す先は、その Project の Base Thread**（Thread の Canvas なら
  その Thread）。Project の Canvas も台帳に載せる——載せないと
  「どのターンからの呼び出しか特定できません」で**構造的に必ず拒否される**
- **banto 全体（instance）の画面には、載せるべき Thread が無い。**
  それでも**出所だけは記録する**（追記・2026-09-12、実機で発覚）——
  「人の画面から来た」は分かるが「どの会話か」は分からない、という状態になる。
  結果：`admin` は聞かずに通り、`module` は「決められないから通さない」で止まる。
  **分からないまま緩めない**（規則2）

#### 載らないので banto が作るもの

| banto が要るもの | なぜ載らないか |
|---|---|
| **Project（入れ物）**（アーキ仕様 §1.1） | assistant-ui の Thread 一覧は**フラット**で、2階層の概念が無い。**Project は banto が持ち、その中の Thread 一覧を assistant-ui に渡す** |
| **MCP Apps の `ui://` 埋め込み**（§6.2） | assistant-ui の MCP 統合は**tools のみ・サーバ側のみ**。`ui://`・iframe・resources・prompts を扱わない。**ただし `render` は任意の React を返せるので、`inline` は tool part の中に iframe を置けば収まる** |
| **A2UI の描画**（§6.5） | assistant-ui に A2UI の実装は無い。**器は使える**——tool part の `render` の中で A2UI の JSON を banto のコンポーネントに描く |
| **Canvas（`fullscreen`）**（§6.2） | 会話の外に開く。守備範囲外 |
| **Elicitation の form / URL**（アーキ仕様 §2.4） | MCP 統合が elicitation を扱わない。**器は使える**——`requires-action` ＋ `interrupt` / `resume(payload)` に載せ、`accept` / `decline` / `cancel` を payload で返す |
| **判断待ち inbox**（アーキ仕様 §2.4） | Thread の外にある常設 UI |
| **Command Palette**（§6.3） | 会話の外 |
| **設定画面**（§6.1） | 会話の外 |
| **Module の launcher**（§6.2） | 会話の外 |

#### 帰結：assistant-ui が担うのは「1つの会話の中」だけ

§6 の core UI 一覧のうち、assistant-ui に載るのは **1番目（会話の器）と
3番目（フォールバック表示）だけ**。Project・受信箱・Canvas・Command Palette・
設定・launcher は**すべて会話の外**にあり、banto の外枠が持つ。

**「assistant-ui に移行したから画面は解決した」ではない。** 解決したのは
会話1本ぶんで、v4 で増える画面（Module の設定・launcher・Canvas・パレット）は
**全部その外側**にある。

#### `branch` と `Fork Thread` を混同しない

assistant-ui の branching は**同じ会話の中で、あるメッセージ位置の代替ルート**を
持つもの（`switchToBranch({ position, branchId })`）。banto の **Fork Thread は
別の会話**（アーキ仕様 §1.1）であり、assistant-ui では**別の Thread** になる。

対応は次のとおり：

| banto | assistant-ui |
|---|---|
| Project | （対応物なし。banto が持つ） |
| Base Thread / Fork Thread | Thread |
| やり直す（過去の resume-point で呼ぶ、アーキ仕様 §2.2） | branch |

### 6.5 A2UI——AI がその場で UI を作る

**§6.2 が扱っていたのは「Module が持ち込む Canvas」だけだった。** 作者は Module の
書き手で、Canvas は事前に用意されている。**「AI がその場で、話の流れに合わせて UI を
作る」は別の軸**であり、v4 ではこれも要る（2026-08-29 決定）。

**そのための仕様がある**（規則12）——**A2UI（Agent to UI）**。Google 発の
オープンな宣言的 UI プロトコルで、**エージェントが JSON で UI を記述し、
クライアントが自分の信頼済みコンポーネントで描く**。

#### MCP Apps と何が違うか

| | MCP Apps（§6.2） | A2UI（§6.5） |
|---|---|---|
| 誰が作るか | **Module の書き手**（事前に用意） | **AI がその場で** |
| 何が流れるか | HTML（`ui://` 資源） | **宣言的な JSON** |
| 誰が描くか | iframe の中で Module の JS | **banto 自身のコンポーネント** |
| 見た目 | Module のもの | **banto のもの** |
| コード実行 | 他人のコードが走る（要 sandbox） | **走らない** |

**競合しない。両方要る。** 実際、A2UI 側に**双方向の統合ガイドがある**
（2026-08-29 確認）——A2UI が描く Canvas の中に MCP App を埋め込む形と、
MCP App の中に A2UI の描画を持つ形の両方。

#### なぜ banto にこれが合うのか

1. **見た目の規律が保たれる。** 要件E9 は「決めた字の段だけを使う」を求め、
   **本物のブラウザで段数を数える試験**がある。**AI に HTML を書かせたら、
   この試験は通らない。** A2UI は banto のコンポーネントで描くので、
   AI が UI を作っても banto の見た目のまま
2. **コードが走らない。** 関数は catalog に事前登録された名前を参照するだけ
   （`"call": "required"` のように）。任意コードは流れない。iframe サンドボックスの
   重さが要らない
3. **catalog が「AI が作れるものの上限」になる。** banto が登録したコンポーネントと
   関数しか使えず、境界は描画側が実行時に強制する。**方針ではなく構造で縛る**
   ——`isolation` に既定値を置かないのと同じ考え

#### 判断待ち（アーキ仕様 §2.4）とそのまま噛み合う

Elicitation の `requestedSchema` はフラットな primitive のみで、**form を実際に
描くのはクライアントの仕事**。A2UI はまさにその form を描く仕組みで、
入力部品（`TextField` / `CheckBox` / `DateTimeInput` / `ChoicePicker` / `Slider`）と
検証関数（`required` / `email` / `regex` / `length` / `numeric`）を標準で持つ。

**したがって、判断待ちの UI と AI が作る UI と Module の Canvas が、同じ1つの
描画機構に乗る。**

#### 決めたこと

- **A2UI を採る。** AI が UI を作るインターフェースは、独自形式を発明せず A2UI に載せる
- **catalog は banto が持つ。** banto のコンポーネントを A2UI の catalog として
  公開する。**AI が使えるのはそこに在るものだけ**
- **運び方は MCP に乗せる**——A2UI は transport 非依存で、**MCP の tool 結果と
  資源で運ぶ形が公式に示されている**（`a2ui://` の資源、A2UI JSON を返す tool）。
  banto は既に MCP を Canvas の運び方にしている（§6.2）ので、経路を増やさない

#### まだ決めていない

- **版**：A2UI は **v0.9.1 が stable、v1.0 は release candidate**（2026-08-29 時点）
  ——**まだ動く仕様**なので、ピン留めと追随のコストを見込む
- **catalog の中身**：標準 catalog（Row・Column・List・Card・Tabs・Modal・Text・
  Button・各種入力）をそのまま使うか、banto のコンポーネントに写すか
- **AI に A2UI を書かせるインターフェース**：core が直接持つ MCP のインターフェースか、Module か

### 6.6 モーダルの形——Dialog か Sheet か（決定・2026-09-02、モック実装から）

**両方 Radix の同じ `Dialog` プリミティブが土台**（shadcn の `Sheet` は `Dialog` を
端寄せのスタイルで包んだだけ）。だから「どちらを使うか」は実装の制約ではなく、
**中身の性質**で決める。基準を明文化する前は「なんとなく」選んでいて、
統一されているか確認できなかった（レビュー指摘、2026-09-02）。

| | 使う場面 | 例 |
|---|---|---|
| **Dialog（中央、モーダル）** | **一度きりの操作**——選ぶ・入力する・確認する→閉じる。背景を参照しながら作業する必要が無い | Command Palette・履歴（Archive）・新規 Project 作成・確認ダイアログ（Disable impact・Project 終了） |
| **Sheet（端から出る、モーダル）** | **読みながら少しずつ触る**、あるいは背景の文脈（開いている Thread 等）を保ったまま長く滞在する | 受信箱・Project 設定（階層2） |

**判断の軸は1つ**：**「開いたら中身を読んで、選んで、閉じる」で完結するか**、
それとも**「開いたまま何度も操作する・長い」か**。前者は Dialog、後者は Sheet。
モバイルでは Sheet が「下から出るフルスクリーン」という馴染みのある形にも
自然に収まる。

### 6.7 Project / Thread のナビゲーション（決定・2026-09-09、モック→本実装）

**§6.0 の1「会話の器そのもの——Project / Thread navigation」の中身を決めた。**
発端はユーザー指摘「幅が狭くてアイコンしか出ないので不便。Project 名が読めたほうが
よい」「モバイルも同じように使いにくい」。**モックで形を決めてから本実装へ入れた。**

#### 目次は1つ——面が変わっても、同じものを見せる

**「どこへ行くか」の面は1つだけ持つ**（`NavPanel`）。デスクトップはサイドバーの中に、
モバイルは左から出る Drawer の中に、**同じ部品**を置く（規則3）——片方だけ直して
食い違う状態を作らない。

中身は上から：受信箱（判断待ちの件数バッジ）／検索（Command Palette）／
**Project 一覧＋その中の Thread の目次**／履歴／設定／テーマ。

| | どう出るか |
|---|---|
| **Project の行** | 頭文字＋**名前**。押すとその Project の Base Thread へ |
| **その下の目次** | **Base Thread と、開いている Fork Thread**。いま見ている行が選択中として出る |
| **閉じた Fork** | 「閉じた Fork（N）」の行から履歴（Archive）へ。**いま開いている Project の行にだけ出す**——履歴はいまの Project の閉じた Fork を見せるので、別 Project の行から開くと中身が食い違う |
| **Close** | Fork の行の「…」から閉じられる（削除ではない）。ヘッダの Close ボタンと**同じ経路**を通る |

**開いている Fork Thread は、常に見えている一覧にする。** 以前はアイコンの角の
3px のバッジ＋ポップオーバーに隠していたが、**Fork は「いま並行して走っている作業」で
あって、探しに行くものではない**。モバイルに至っては Fork へ行く口が無く、
Command Palette で探すしかなかった（規則13 の観点で不備）。

#### デスクトップ——幅は2段階、境界はドラッグできる

| 状態 | 幅 | 何が見えるか |
|---|---|---|
| **展開（既定）** | 256px（200〜480px で可変） | 上記の目次 |
| **畳んだ状態** | 58px | アイコンのみ。名前はツールチップ、Fork はバッジのポップオーバー |

- 切り替えはヘッダのボタンか **⌘B / Ctrl-B**
- **幅は右端の境界を掴んで変える**。200〜480px で止まり、**ダブルクリックで既定に戻る**。
  **矢印キーでも動かせる**——マウスでしか変えられない寸法にしない
- **幅と「畳んだかどうか」は覚える**（要件E7「選択が残る」——明暗切替と同じ扱い）。
  `/settings` と `/p/[id]` はレイアウトが別なので、覚えないと行き来のたびに戻ってしまう
- **覚えた値は、面を移っても最初の1回目の描画からその値で出す**——
  「既定で描いてから直す」をしない。Project を移ると各ルートの器は作り直されるので、
  **この好みは器（React）の外に置く**（改訂・2026-09-09、ユーザー報告：別 Project を
  開くと幅が一度既定に戻ってから変更した幅に直っていた）
- **幅の真実は1箇所**（シェルが持つ `--sidebar-width`）。掴んで動かす部品は値を持たず、
  変更を返すだけ（規則3）

#### モバイル——段は1つ。ナビはヘッダの ≡ に集約する

**モバイル専用の上部バーは持たない。** 以前は上部バー（50px）と各パネルのヘッダ（44px）が
常に積まれ、**履歴・設定は両方の段にあり**、それでいて Fork へ行く口が無かった。

- **ナビはパネルのヘッダ左端の ≡ 1つ**。押すと左から Drawer（右スワイプで閉じられる）。
  中身は上記の `NavPanel` そのもの
- **画面のキーボードが出る端末では、入力欄に勝手に焦点を当てない**（決定・2026-10-02、ユーザー要望）。Thread を
  移るたびにキーボードが出て会話が隠れていた。見分けは幅ではなく端末の性質（`hover: none` かつ `pointer: coarse`、
  `hooks/use-touch-keyboard.ts`）——幅の広いタブレットでも出さず、狭くしたパソコンの窓では今までどおり当てる。
  人が入力欄を押せば当たる。止めて取り消した発言を戻すとき（§6.31）は直すためなので当てる
- **同じ端末では、キーボードの Enter は改行**（決定・2026-10-03、ユーザー要望）。送るのは画面の送信ボタンだけ。
  キーボードの Enter キーの表示も「改行」にする（`enterKeyHint`）。パソコンは今までどおり Enter で送り、Shift+Enter で改行
- **入力欄の下の帯は、狭い幅でも送信ボタンを枠の外へ押し出さない**（2026-10-03、ユーザー報告）。左の群（添付・モデル・
  permissionMode）が縮んで名前を「…」で切り、右の群（送信・停止）は縮めない。モデル名が先に縮む——危ない設定の印
  （bypassPermissions 等）を読めるまま残すため
- **受信箱だけはヘッダに残す**——判断待ちは「止まっている」ので、目次を開かなくても
  件数が見えるべき。急がない履歴は Drawer に置く
- **ナビの入口はどの画面にも置く**——会話（Base・Fork）・Canvas・設定・Project が0件のホーム。
  入ったら戻れない画面を作らない（規則13）。**≡ はどの面でもヘッダの左端の同じ位置**——Fork・Canvas では
  閉じる（← ・×）のさらに左に置く（改訂・2026-10-02、ユーザー要望。以前の Fork には ≡ が無く、別の Thread へ
  行くには ← で Base に戻ってから開くしかなかった）
- **Drawer は外枠（AppShell）に1つだけ持つ**（`MobileNavProvider`）。各面のヘッダは入口のボタン
  （`MobileNavButton`）を置くだけ——面ごとに Drawer を持つと、別 Project へ移ったとき画面ごと作り直されて閉じる
- **別 Project を選んでも、その Project に Fork があれば Drawer を閉じない**（決定・2026-10-02、ユーザー要望）。
  下の画面はその Project の Base Thread に替わり、Drawer はその Project の目次を開いて待つ（人が畳んでいても開く）。
  Fork へはもう1回押すだけ、Base でよければ閉じるだけ。Fork が無い Project・Base・Fork・受信箱などを選んだときは
  今までどおり閉じる。以前は閉じてしまい、別 Project の Fork へ行くのに「開く→Project→また開く→Fork」の4手が要った
- **タップの的はモバイルだけ大きくする**（ヘッダのボタン36px・ヘッダ48px）。
  幅が足りないものは削る前に**帯を落として数値を残す**（文脈使用量メーター）

#### 面の題は、名前だけ（改訂・2026-09-11、ユーザー要望）

**接頭辞は付けない。** その面が何かは、いま開いているもの（アイコン・位置）で
分かる——題の幅は名前に使う。

| 面 | 題 |
|---|---|
| Base Thread | `<Project 名>` |
| Fork Thread | ⑂ アイコン ＋ `<Fork の名前>` |

以前はデスクトップだけ `Base Thread — <Project 名>` にしていたが、**幅で題が
変わる非対称**をやめた（狭い画面のために短くしたものが、そのまま良い形だった）。

**題を右クリックすると、名前を変えられる**（決定・2026-09-11、ユーザー要望）
——サイドバーまで戻らなくても、いま見ている面から直せる。出るのは
「名前を変える…」だけ（並べ替えは一覧の話、Close はヘッダにボタンがある）。

> **回帰試験は共有の手順に持つ**——待ち条件（題・ナビの入口の場所）を
> 各スペックに書き写さない（`banto/e2e/helpers.ts`）。

### 6.8 戻ってきたら、最新の状況をそのまま出す（決定・2026-09-10、改訂・2026-09-26）

**AI の応答に時間がかかっている間に、タブを閉じて開き直す・リロードする・別アプリへ移って戻る——どの
戻り方でも、会話の本文に最新の状況がそのまま出る。** 走っているターンは、**自分がこの画面で送ったときと
同じ描き方で**本文に流れる（途中の文・tool のカード・判断待ちのカード、止めるボタン）。特別な帯や
「繋ぎ直しました」は出さない（改訂・2026-09-26、ユーザー指摘——以前は入力欄の上の帯に要約して出して
いた。人から見ると、いつもと違うものが出て、中身も途中の要約だけだった）。

**最新を出す道は1つ**（規則3）：

1. **host の記録から会話を組み直す**（記録が真実）
2. **host がまだそのターンを走らせていれば、最初から流し直してもらい**、自分で送ったターンと同じ
   ランタイムの run として本文に流す——読む道も判断待ちの答え方も、自分の送信と同じ

**きっかけ**（どれも同じ道を通る。ポーリングはしない）：

| きっかけ | 例 |
|---|---|
| 会話を開いた | リロード・タブを開き直した・別の Project から戻った |
| host の知らせ（`GET /api/events`）の `turn.started`・`turn.ended` | 別の画面・別の端末で送った／届いたもので host がターンを始めた |
| 知らせが繋ぎ直った（`hello`） | 途切れていた間に起きたことを取りこぼさない |
| 流れが途中で切れた | 携帯で別アプリへ移るとブラウザが接続を切る |
| 画面に戻ってきた（3秒以上離れていた）・回線が戻った | `visibilitychange`・`online`・`pageshow`（bfcache） |

取れなかったら（回線がまだ戻っていない）、間をあけて取り直す（1秒から倍々、15秒まで）。

**流れが切れても、人にエラーとしては見せない。** ターンは host で最後まで走っている（host は画面が
切れても止めない）——切れたら途中まで流れた吹き出しを捨て、上の道で組み直す。**送った発言が host に
届いたか分からないとき**（送る瞬間に切れた）だけは失敗として出す（届いていないのに走っていると
見せない、規則2）。

**黙って止まった接続を見切る。** 回線が変わったとき等、接続はエラーにならずに何も届かなくなる
ことがある。host はどの流れ（ターン・流し直し・知らせ）にも15秒ごとに空行を送り、画面は45秒なにも
届かなければ切れたとみなす（見張りは5秒ごと、画面に戻ってきた瞬間にも見る）。

| 口 | 何を返すか |
|---|---|
| `GET /api/threads/:id/stream` | **走行中なら**、`attached`（走り始めた時刻と、そのターンの始まりの seq `startedSeq`）に続けて、そのターンがこれまでに出したイベントを最初から流し直し、続きもそのまま流す（SSE）。**順番の鍵は取られたがまだ走り始めていない**（Module を起こしている等、数秒かかる）ときは、走り始めるまで待ってから流す——`turn.started` の知らせは鍵を取った時点で出るので、ここで `idle` と答えると画面はそのターンを見逃す（実測・2026-09-26）。**走っていなければ** `idle` を1件返して閉じる |

- **覚えるのは走行中の1本だけ。** ターンが終わったら捨てる——**そこから先の真実は Event Store**
  （規則3）。`GET …/stream` は記録の代わりではない
- **記録に入った発言を、流し直しで2回出さない**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに記録する」）。
  host は AI の発言を書き終えるごとに記録に入れるので、走っているターンの発言は記録にも流し直しにもある。乗った画面は
  記録から組み直すとき、そのターンの AI の1件（`startedSeq` より後ろで、人の発言の次。記録の `lastTurn` が後ろに
  あれば、その始まりより前）を外す（`lib/backend/replayed-turn.ts`）。1ターンの AI の発言は、流れているときも記録から
  組み直したときも1つの吹き出し
- **走っている途中に Clear すると、そのターンの後半の発言は Clear の横線より前の吹き出しに入る**（2026-10-05）——Clear が
  切り離すのはそのターンの会話なので、横線より前に出るのが合っている（以前はターンの最後に書いたので横線の後ろに出ていた）
- **判断待ちに答えたことも、そのターンの流れに載る**（`answered`、決定・2026-09-26）。どこで答えても
  （別の画面・受信箱）、流し直しで開き直した画面でも、そのカードは「回答：…」として出る。
  答え済みの判断は、ほかの tool 呼び出しと一緒に畳んで出す（答えを待っているものだけが開いて出る）
- **最後まで読んだ会話は描き直さない。** 自分で送った／乗った流れを最後まで読んだら、その会話はもう
  最新——描き直すと、流れていた tool のカードが消える。画面が持つ記録の写しは**組み直すときにだけ**
  書き換える（会話の中の目印——Fork の入口・Clear の横線——は、組み立てたときの記録の番号で置き場所を
  探すので、写しだけ新しくすると目印が消える。実測・2026-09-26）。**ただし見せている記録そのものは覚えて
  おき、面が作り直されるとき（最後の面が閉じる・新しい面が開く）に写しをそれに揃えて組み直す**（改訂・
  2026-09-28、ユーザー報告「最新のメッセージが消える、リロードで直る」）——以前は長さだけを覚えていたので、
  作り直された面は古い写しから組み立てられ、しかも「もう最新を見せた」扱いで取り直さず、この画面で
  流れたターンが消えたままになっていた（実測：設定へ行って戻ると会話が空になった）
- **流れているときと、記録から組み直したとき（リロード後）で、AI の発言は同じに見える**（決定・2026-09-26）。
  SDK は AI の文を**ブロックごとに別のメッセージ**で届ける。別々に届く文は別々の発言（別の応答・CLI が出す
  「API Error: …」など）なので、**どちらでも段落を分けてつなぐ**（`\n\n`）——以前は流れている吹き出しが
  貼り合わせ（「…です。API Error: …」がくっつく）、記録は改行1つ（Markdown では同じ段落）で、見え方が違った
- **会話が送っている・流している間は、組み直さない**（決定・2026-09-26）。Enter を押してから host に送り
  出すまでの間に組み直すと、送った発言ごと会話が作り直されて送信が消える（実測）。判断待ちのカードも
  流し直しの中でだけ出す——受信箱から拾って描き足す道（2026-09-06〜）は、受信箱が変わるたびに会話を
  作り直してこれを起こしていたのでやめた
- **走っているターンに重ねて送れない**のは、自分で送ったときと同じ（止めるボタンになる）。
  別の画面や API から送ったものは、host が順番を守って待たせる（アーキ仕様 §4.2）

> **向きの違う2本を、混ぜない**（実装時に踏んだ）。host 側の `TurnEventBus` は
> 「ターンの**外から中へ**」（中継ゲートの判断待ち・判断待ちの答え → 走行中のターン）と
> 「ターンの**中から外へ**」（ターンが出したもの → あとから繋いだ画面）を
> 別の口として持つ。1本にまとめたら、ターンが出したイベントが自分自身に
> 戻ってきて無限に回った。


#### host が始めたターンにも乗る（追加・2026-09-25、改訂・2026-09-26）

届いたもの（待たない仕事の完了など）で host が**自分でターンを始める**ので、開いている画面が知らないうちに
始まったターンにも乗る。流れてくる知らせ：

| 口 | 何を返すか |
|---|---|
| `GET /api/events` | host → 画面の出来事の流れ（SSE、独自のヘッダつきの fetch で読む）。`turn.started`・`turn.ended`（どの Thread か）・`inbox.changed`・`auth.device_added`（端末を追加の札が使われた） |

- `turn.started`・`turn.ended` を受けたら、その Thread を開いていれば上の道で最新を出す
- `inbox.changed` で受信箱を取り直す
- 途切れたら繋ぎ直す（数秒おいて）。**繋がっていない間も人は止めない**——戻れば記録から見える

**届いたものは、人の発言に見せない。** 会話の中に「届いたもの」の札として出す：送り手（例：「サブエージェントから」）・
題・本文（長いので畳んで出し、開ける）。人の吹き出しの形は使わない。起こし直しで切れたターンの続き（アーキ仕様 §2.5「起こし直しをまたいで続ける」）も同じ札で出る——送り手は
`banto`（「banto から届きました」）、題は「banto を起こし直したため、直前のターンが途中で切れました」。切れたターンの
吹き出しの最後には「（起こし直しで切れました）」が付く（2026-10-05）。

### 6.9 重なりと Escape、そして外枠（決定・2026-09-10）

**外枠（レール・トップバー）は、面をまたいでも張り替えない。** `/`・`/p/[id]`・
`/settings` は**1つの layout**（ルートグループ）の下にあり、AppShell はそこに
1回だけ置く。以前は面ごとに AppShell を持っていたので、面を移るたびにレールが
**作り直され**、その中で開いていたもの（「新しい Project」のダイアログ）は
**入力ごと消えた**（実測・2026-09-06／回帰試験 `e2e/specs/app-shell-persist.spec.ts`）。

- **いま見ている Project は URL が持つ**（規則3）——外枠は `useParams()` で読む。
  props で配ると、配る側（各面の layout）が要ることになり、外枠が分かれる
- **Canvas の別タブ（`/canvas-window`）はこの外**——banto のクロムを持たない面

**Escape は、いちばん上の1枚だけを閉じる。**

| いま開いているもの | Escape が閉じるもの |
|---|---|
| Dialog / Sheet / Command Palette（前面） | **それだけ**。背面の層には触らない |
| Canvas ＋ Fork | Canvas |
| Fork だけ | Fork |
| 設定の面（いまの画面の上に重ねる、§6.16） | **設定を閉じる**——下の画面がそのまま見える（節をいくつ移っていても一発。改訂・2026-09-28、ユーザー要望）。`/settings` を直接開いていたときは `?project=` の会話、それも無ければホーム |

Escape を聞く場所は2つある（重なった層／設定の面）が、**「上に何か開いているか」の
判断は1箇所**（`lib/overlay-open.ts`）。片方だけが検査していたため、Palette を
開いたまま Escape を押すと**前面は開いたまま、背面の Fork が閉じる**という
壊れ方をしていた（実測・2026-09-10）。

### 6.10 Module の画面（Canvas）と、その持ち主（決定・2026-09-10）

**画面と host を繋ぐ橋（AppBridge）は、画面が別物になったときにだけ張り直す。**
親が再描画されるたびに張り直していた（実測：Canvas を1つ出して Fork を2回開閉
するだけで **9回**）。張り直しの最中に飛んでいる呼び出しは行き場を失う。

**画面の持ち主は「Thread と呼び出しの組」で決まる。** 呼び出し（`toolCallId`）
だけでは決まらない——**Fork は親の履歴をそのまま持つ**ので、同じ `toolCallId` が
2つの Thread に並ぶ。実測（2026-09-10）：Fork を開くと Base に出ている画面が
「自分は Fork のものだ」と言い出し、そこからの tool 呼び出しも Fork の側に
記録されていた。会話の奥で描かれるカードには、**いまどの Thread を描いているか**を
context で渡す。


### 6.11 サイドバーの項目を、並べ替える・名前を変える（決定・2026-09-11、ユーザー要望）

**Project と Fork Thread は、掴んで並べ替えられる。** 対象は左のサイドバー
——開いた状態（`NavPanel`）でも、畳んだレール（58px）でも同じように動く
（幅で操作が変わらない、規則3）。

| 入力 | 掴み始める条件 |
|---|---|
| マウス | 8px 動かしたら（押しただけでは動かない——Project を開く操作と食い合わない） |
| 指 | 250ms 押したままにしたら（距離で見分けると、一覧の縦スクロールと区別できない） |
| キーボード | 掴まない。代わりに下のメニューの「上へ／下へ」 |

- **落としたときに1回だけ記録する。** 動かしている途中の順番は、まだ決まっていない
- **運んでいる間は、その項目の目次を畳む**（改訂・2026-09-11、ユーザー報告）。
  子（Thread の目次）を開いた Project は他の行よりずっと背が高く、そのまま運ぶと
  **行き先の高さに合わせて潰れて見え**、しかも**一番上まで届かない**
  （行き先は真ん中どうしで決まるため、背の高い行の中心は先頭行の中心より上に
  行けない）。運んでいる間だけ高さを揃える——畳んだ／開いたという**人の選択は
  変えない**（落とせば元どおり開いている）
- **運ぶのは位置だけ。大きさは変えない**（同上）
- **運び終わりのクリックは、行き先として扱わない**（実測・2026-09-11：行そのものが
  Link なので、並べ替えただけで落とした先の Project が開いていた）
- **見えていないものは動かさない。** 畳んだ Project は一覧に出ないが、順番の一員
  ——並べ替えの対象から外すと、開き直したときに知らない場所へ移動している

**その項目への操作は、出し方が2つ・中身は1つ**（改訂・2026-09-11、ユーザー要望）。

- **右クリック**（タッチは長押し）——行のどこでも
- **「…」ボタン**——行にマウスを乗せると出る（狭い画面ではいつも出す）。
  右クリックを知らなくても辿り着ける口。**畳んだレール（58px）には置かない**
  ——アイコンと並べる余地が無いので、そこでは右クリック／長押しだけ

| 項目 | 何をするか | どこに出るか |
|---|---|---|
| 名前を変える… | ダイアログが開く。いまの名前から始まり、保存すると host に残る | Project・Fork |
| 上へ移動 / 下へ移動 | 1つ動かす。**端では押せない**（隠さない——端に居ることが分かる） | Project・Fork |
| Close | その Fork を閉じる。**削除ではなく整理**——履歴から開き直せる | Fork |

**行に出しっぱなしの操作は置かない**（改訂・2026-09-11）——Fork の「Close」は
行の右に常設していたが、「…」の中へ移した。操作が増えるたびに行にアイコンが
並ぶのを避ける。「…」の位置は**目次の開閉（chevron）の左**。

「上へ／下へ」を置くのは、**掴めない場面でも並べ替えられるようにする**ため
（キーボード・細いレール・タッチ）。出ている操作が、その場の入力手段で必ず効く（規則13）。

**名前の真実は host**（アーキ仕様 §2.2）。画面は**先に host へ書いてから**手元を直す
——逆にすると、書けなかったときに画面だけ新しい名前になる（規則2）。並べ替えは
先に画面を動かして見せるが、**書けなかったら元に戻して理由を出す**。


### 6.12 発言の下の操作（決定・2026-09-11、ユーザー要望）

AI の発言の下に出る帯（コピー等）は、**本文の左端にそろえる**。本文は左に
32px の余白から始まるので、帯もそこから始まる——実測で合わせる
（`e2e/specs/fork-from-message.spec.ts` がアイコンの左端と本文の左端を比べる）。

| 並び | 何をするか |
|---|---|
| コピー | その発言を写す |
| **ここから Fork** | **その発言の時点から**枝を分けて開く（アーキ仕様 §2.2）。押すと名前を入れるダイアログが出る。会話は必ず引き継ぐ（§6.32） |

- **画面が渡すのは位置（seq）だけ。** どのセッションへ戻すかは host が決める（規則3）
- **位置が分からない発言には出さない**（規則13）。位置は host の物差し（`real-<seq>`）
  で、**記録から組み直した会話だけが持つ**。ただし**会話の最後の発言**は
  「いまの続きから」と同じ意味になるので出す
- **畳んだ（Clear）ら、記録から会話を組み直す**——組み直すと各発言が host の
  物差しを持つので、①横線が**起きた場所**に出る（§6.4 transcriptMarkers）
  ②畳む前の発言から枝を分けられる。**走行中は組み直さない**（流れている表示を壊す）


### 6.13 印の向き——会話が流れる向きに合わせる（決定・2026-09-11、ユーザー要望）

**Fork と Close の印は、上下を反転して使う。** lucide の `git-fork` / `git-merge` は
枝が**上へ**伸びる向きだが、**banto の会話は下へ流れる**——分かれるのも合流するのも
下側に見えるほうが、起きていることに近い。

反転は**1箇所**（`components/banto/thread/thread-icons.tsx`）。使う側は向きを
気にしない——サイドバー・ヘッダ・会話の中・履歴、どこでも同じ向きで出る（規則3）。

> **回帰試験は「効いているか」を測る**（規則1）。Tailwind v4 は `transform` では
> なく `scale` に出すので、`transform` を見ていると**効いていても "none" に見える**
> （実測・2026-09-11）。

### 6.14 3つの「たたむ」を、別の言葉にする（決定・2026-09-11、ユーザー要望）

> 「畳むって用語、ちょっと一般的ではないので Close にしておこう。」

banto には性質の違う3つがあり、**全部「畳む」と呼んでいた**（規則11 の失敗——
初見のエンジニアが機能を想像できない）。画面の言葉を分ける：

| 画面の言葉 | 何をするか | 記録はどうなるか |
|---|---|---|
| **Close** | Fork Thread / Project を閉じる | `thread.closed` / `project.closed`。**削除ではない**——履歴から開き直せる |
| **Clear** | 同じ Thread のまま、次のターンを新しい会話として始める | `thread.cleared`（resume-point を手放す。アーキ仕様 §2.2） |
| **折りたたむ** | サイドバー・Thread の目次・フォルダツリーの表示 | **変わらない**（見た目だけ） |

- 閉じたものの**状態**は「閉じた Fork」「閉じた Project」のまま——`Close` した
  結果が「閉じた」で、言葉としてつながる
- Project の終了も **Close** に揃えた（同じ操作に「終了」「畳む」の2語があった）
- 仕様の中の「会話を畳む」は **Clear** のことで、これは変えていない
  ——`Close` とは別の操作（アーキ仕様 §2.2 の表）

#### Fork を閉じるときの警告（決定・2026-10-08、ユーザー）

**その Fork が頼んだ裏の仕事が残っているとき、人が Close を押したら、閉じる前に警告を出す**（サイドバーの「…」と
ヘッダの Close は同じ経路なので、両方に出る）。裏の仕事はサイドバーのバックグラウンドの印（§6.33）と同じもの——その
Thread の返信用の札がまだ awaiting のもの（待たない形で頼んだサブエージェント・Shell の待たないコマンド・Factory・人を
待っているもの）。

- 小窓に件数と中身（題・Module 名・何分前。バックグラウンドの一覧と同じ出し方）と、「閉じても仕事は止まりません。
  結果はこの Fork に溜まり、開き直すまで AI は読みません」を出す。人を待っているものがあれば、それも分けて示す
- ボタンは「やめる」と「それでも閉じる」。**人は警告を承知で閉じられる**（AI の `close_fork` は断るが、人は断らない）
- 裏の仕事が無ければ今までどおり、確かめずに閉じる
- 裏の仕事を知るのは画面が既に持っているバックグラウンドの一覧（hello の `background` と `background.changed`）。host に
  聞き直さない
- **AI が閉じた Fork**（アーキ仕様 §2.2「AI が自分の Fork を閉じる」）：閉じた Fork の一覧（履歴）の行に「AI が
  閉じました：（理由）」を出す。その Fork を開いている画面は Base へ飛ばさず、会話の上に「この Fork は閉じました
  （理由）」の帯と「開き直す」を出す（入力欄は開き直すまで使えない）


### 6.15 Project の Module を選ぶ（決定・2026-09-11、モックで確認 → 本実装）

**Phase 2（標準 Module を揃える）の入口。** 宣言は banto 全体の既定なので、
Module を1本足すと**全 Project に繋がる**——本数が増えるほど、使わない Project にも
tool が載り、プロセスが増える。**増やす前に、この Project で何を使うかを選べるようにする。**

置き場は **Project 設定の「この Project の Module」**（階層2）。

#### その場で編集し、保存で確認する

**1つ動かすたびに確認を出さない**（モックで1往復して決めた——押すたびの確認は
煩わしく、続けて何本か繋ぎ変える操作と合わない）。手元の**下書き**を編集して、
**保存のときに1回だけ**確認する。繋ぎ変えは Module のプロセスを立てたり落としたり
するので、「押した瞬間に効く」より「まとめて効かせる」ほうが実態にも近い。

| | どう出すか |
|---|---|
| 入り切り | **トグル**（改訂・2026-09-19、ユーザー要望——banto 全体の面と同じ部品にする） |
| 編集中の印 | 行に `有効にする（未保存）`／`無効にする（未保存）`。**無効にするものも一覧から消さない**——消すと何を外したか見えなくなる |
| 変更中の帯 | 画面の下に貼り付く（`未保存の変更 N 件（有効 n・無効 m）`・**取り消す**・**保存**）。変更が無いときは出ない |
| 要るものの扱い | **黙って一緒に足す**（確認は保存のとき）。欠けている行には**その場に**警告——「◯◯ が無効です」 |
| 保存の確認 | **差分**：`＋ 有効にする` / `− 無効にする` を並べ、各行の下に**何が変わるか**（使えるようになる／なくなる役割、プロセスが立つ／落ちる、`scope: instance` のものは止まらない）。要るものが欠けたままなら、**動かなくなるものを名前で** |
| 並び順 | **役割で固定する**（改訂・2026-09-19）。「繋いでいる／いない」で分けると、**トグルを押した行がその場で飛ぶ**（押した先が別の行になる） |

#### 1行に出すもの

**宣言（`_meta["dev.banto/module"]`）から導出できるものだけを出す**（規則3——
画面のための別の一覧を持たない）：

**形は1枚のテーブル**（改訂・2026-09-18、ユーザー指摘「冗長」）。以前は1件ずつの
箱に札を4〜5個並べていたので、**同じ語が縦に何度も出ていた**。列の見出しを1回
出せば、各行は値だけで済む。**banto 全体の面と同じ列にする**（改訂・2026-09-19）。

| 列 | 中身 |
|---|---|
| Module | 名前 |
| 役割 | `satisfies` |
| 実行場所 | `scope` ——`Global` ⇄ `Project ごと`（URL に繋ぐ形は相手の host 名） |
| サンドボックス | **どこで動くか**（host が導いた `placement`。改訂・2026-09-25——宣言の `confinement` は出さない）——`Project のコンテナ` / `全体のコンテナ` / `banto 本体`（同梱の banto 全体の Module）／URL に繋ぐ形は `なし`（banto 全体の面）・`—`（Project の面） |
| 依存 | `dependsOn` の `required`。**満たされていないときだけ赤く**「◯◯ が無効です」 |

> **tool の数は出さない**（本実装で訂正・2026-09-11、規則2）。モックでは
> 「繋ぐと tool が N 個増える」と出していたが、**数えるには起動して聞くしかない**
> ——一覧を見ただけで全部を起こすのは筋が悪いし、繋いでいないものの数は
> 本当に分からない。分からないものを、分かったように見せない。

#### 保存すると、どこに書かれるか（本実装・2026-09-11）

**その Project の差分**として書く（`moduleOverlays` の Project 層）。

- **外す**は「既定から消す」ではなく **`enabled: false`**——他の Project は変わらない
- **その Project 固有の直し（`launch`・`meta` の差分）は残す**——選び直しただけで
  消えてはいけない
- **保存した時点で、外したものは落とす**（次のターンを待たずにプロセスを止める）。
  繋いだものは、次に要るときに立ち上がる（遅延起動のまま）

**外しても Module は消えない。** 他の Project では動いたままで、いつでも繋ぎ直せる
——これは画面の文言としても出す（「消える」と誤解させない）。

#### まだ決めていない

- 繋げる候補の**出どころ**の見せ方（同梱／設定に書いた／将来のレジストリ）
- **繋げられない候補**の出し方（役割が重なる・依存が満たせない）
- 走行中のターンがあるときに繋ぎ変えたら、どう伝えるか（いまは「次のターンから効く」だけ）
- **要るものを黙って戻す**のは親切か驚きか（Vault を外してから Shell を繋ぐと Vault が下書きに戻る）


### 6.16 設定画面は1つ（改訂・2026-09-11、ユーザー指摘）

**設定は、いまの画面の上に重ねて開く**（改訂・2026-09-28、ユーザー要望「設定は上にかぶせる形がいい」、
実装・2026-09-30）。以前は別のページ（`/settings`）で、開くと会話の画面が捨てられ、閉じると作り直されて
いた（入力欄・スクロール・開いていた Fork や Canvas・流れていた返事の読み取りを失う）。いまは URL の印
（`?settings=1`）で外枠（AppShell）が重ねて出し、下の画面は生きたまま触れないようにする（`inert`）だけ。
閉じると下の画面がそのまま見える。サイドバーは覆わない（設定の中で Project を切り替えるのに使う）。
受信箱・Command Palette の印（`overlay`）とは別の印——設定の上でパレットを開いて閉じても設定は閉じない。
`/settings` を直接開いたとき（ブックマーク等）も同じ面が出る——下に何も無いだけ（`lib/settings-link.ts`）。

**階層は2つ（§6.1）だが、画面は1つ。** 以前は banto 全体を普通の面
（`/settings`）、Project をその上に乗る全画面ダイアログにしていた——**同じものを
2通りの出し方**にしていたので、行き来のたびに見え方が変わっていた。

**左メニューを見出しで層に分ける。** VSCode の User / Workspace と同じ考え方（規則12）：

| 見出し | 中身 |
|---|---|
| `banto 全体` | 役割と Module・既定値・資格情報・通知 |
| `全体の Module 設定` | Module 自身が持ち込む設定（instance の文脈） |
| **頭文字＋＜Project 名＞** | **一般**（名前・Root・危険な操作）・この Project の Module・既定値の上書き・セキュリティ境界 |
| `この Project の Module 設定` | 同じ Module の設定を、**この Project の文脈**で（§6.2） |

- **どの Project かは URL が持つ**（`?project=<id>`）。開く節も URL（`?section=<id>`）
  ——押した場所に応じた節が開く（会話ヘッダの歯車は「この Project の Module」）
- **入口は2つのまま。** レールの歯車＝全体の先頭、会話ヘッダの歯車＝この Project
  ——どちらも同じ画面に出る（層が左に並んでいるので、そのまま行き来できる）
- **Project を開いていなければ、Project の層は出ない**（`?project` が無いとき）
- **検索は層をまたぐ**——「Module」で引くと、全体の「役割と Module」と
  「この Project の Module」が両方出る
- **カスケード（全体の既定 → Project で上書き）を、同じ画面で行き来できる**のが
  この形の利点（継承元を見に行くのが1クリック）

#### 層の切れ目は、見えるようにする（改訂・2026-09-11、ユーザー指摘）

見出しを等間隔で並べるだけでは、**どこで層が変わるのか分からない**。

- 層の変わり目に**横線と広めの余白**を入れる
- 層の見出しは**太く**（層の中の小見出しより強く）
- Project の層の見出しは**頭文字＋Project 名**——サイドバーの Project と同じ
  見た目にして、「これはあの Project の設定だ」を繋げる

#### 設定を開いたまま、Project を切り替えられる（決定・2026-09-11、ユーザー要望）

| サイドバーで押したもの | 行き先 |
|---|---|
| **別の** Project | **設定は閉じない**。その Project の層へ切り替え、**下の画面もその Project の会話にする**（改訂・2026-09-30、ユーザー要望——閉じたとき、設定で見ていた Project が出ている。前の Project で開いていた Fork・Canvas の印は連れていかない）。Project の層の節を見ていたなら**同じ節のまま**（見比べられる）、全体の節を見ていたならその Project の先頭の節へ |
| **いま設定で見ている** Project | 設定を閉じて、その会話へ戻る |
| **Thread**（サイドバーの「Base Thread」・Fork の行、レールの Fork 一覧） | **設定を閉じて、その会話を出す**（改訂・2026-10-05、ユーザー要望「Thread を押したら設定を閉じてその Thread を表示」。`threadRowHref`）。~~設定は閉じない。下の画面をその会話にし、設定もその Project の層にする（2026-09-30）~~ |
| **Command Palette の Thread**・Fork を閉じたあとの行き先 | 設定は閉じない。下の画面をその会話にし、設定もその Project の層にする（2026-09-30 のまま。`threadNavHref`） |

**いま開いている節も URL が持つ**（`?section=`）——画面が自分の中に覚えていると、
**外（サイドバー）から節を変えられない**（規則3）。この判断は1箇所に持ち、開いた
サイドバーと畳んだレールが同じ答えを使う。

> **開いている節は、リロードしても開いたまま**（URL が持つので当然の帰結）。
> 狭い画面では節を開いている間は左メニューが出ない（一覧→詳細の1カラム）ので、
> 「開いているのに、もう一度開こうとする」と詰む——回帰試験も**URL で**
> 開いているかを判断する（実測・2026-09-11）。

#### 節の行き来は、履歴に残る（改訂・2026-09-12、ユーザー要望）

節を変えるのを `replace` にしていたので、**携帯の「戻る」が設定ごと飛び越えて
会話まで戻っていた**。狭い画面では節を開くと左メニューが消えるため、いちばん
戻りたい場面で戻れない。

- **節を開くのは `push`**——1つずつ戻れる
- **一覧へ戻る（「設定メニューに戻る」・節を閉じる）のは `back`**——`push` した
  ぶんを戻すだけ。履歴に「節を閉じた」状態を積み増さない（積むと、戻るを
  押すたびに同じ節が開いたり閉じたりする）
- **深い URL を直接開いた**ときは、戻るぶんが無い——そのときだけ `replace`
  （自分で押した `push` の数を画面が数えて分ける）
- リロードしても開いたまま（上）と両立する——どちらも「開いている節は URL」から
  出てくる帰結

> **回帰試験の副作用**：会話から設定へ入って**「戻る」1回で会話へ帰る**ことは、
> もう無い（節の中を1つ戻る）。会話へ戻るときはサイドバーでその Project を押す
> ——人がやる経路と同じ（`module-settings-canvas.spec.ts`）。


### 6.17 Project の「一般」（決定・2026-09-11、ユーザー要望）

**Project の層のいちばん上**に置く——名前と根は「この Project が何者か」なので、
Module の選択や上書きより先に来る。

| 出すもの | 何をするか |
|---|---|
| Project 名 | 直せる（サイドバーの右クリックからも直せる——同じ真実を2つの入口で） |
| Root パス | **打っても選んでもよい**（入力欄＋「選ぶ」でフォルダを辿るダイアログ）。**根は閉じ込めの範囲そのもの**なので、変えたら host はその Project の Module を落とす（次に要るときに新しい根で立つ） |
| **危険な操作**（同じ画面の下） | **Close**（閉じる。削除ではない——履歴から戻せる） |

- **その場で直して、最後に保存する**（§6.15 と同じ形）——名前と根をまとめて1回で
- 広い根を打ったら、**保存する前に**警告が出る（§6.16 の下、`WideRootWarning`）
- 「危険な操作」という**節は持たない**——Close はこの画面の下に置く（節を分けるほどの
  ものではなく、探し回る先を増やさない）

**コンテナ**（追加・2026-09-25、`docs/specs/v4-security.md` §1）——同じ画面の、名前と根の下：

| 出すもの | 何をするか |
|---|---|
| 状態 | この Project のコンテナが「動いている」「止まっている（次に使うときに起こします）」「まだ作られていません（最初に Module を使うときに作ります）」。知らない状態は Incus の語のまま出す（言い換えで隠さない） |
| **中で Docker を使う** | 切り替え（既定は切）。**押したらすぐ保存する**。説明に「有効にすると /proc・/sys への書き込みの制限が外れる」「切り替えると、この Project の Module は立て直しになる」を出す。失敗したら表示を戻し、理由を出す（規則2） |

**Claude のログイン**（追加・2026-10-08、`docs/specs/v4-security.md` §2「banto 本体の Claude ログインは、中継で共有する」）
——同じ画面の、コンテナの下：

| 出すもの | 何をするか |
|---|---|
| **この Project に Claude のログインを使わせる** | 切り替え（既定は入）。**押したらすぐ保存する**。説明に「切るとすぐ使えなくなり、入れ直すと新しい合言葉になる」「立っている Module の環境が変わるのは、次にその Module が起きたとき」を出す。失敗したら表示を戻し、理由を出す（規則2） |
| 本体のログイン | 「ログインしています（契約：…）」か、読めなかった理由（赤） |
| 使った回数・最後に使った時刻・直近の 401 | 中継の数え（banto を起こしてから）。直近の 401 は「本体のログインが期限切れでした」と添えて赤で出す。開いたときに読む |

#### 会話のヘッダに、左と同じ入口を置かない（改訂・2026-09-11、ユーザー指摘）

設定（歯車）と履歴（時計）は**サイドバーの下にある**ので、会話のヘッダからは外した。
**同じ機能への入口を2つ持つと、どちらかが古くなる**（規則3）。
判断待ちのバッジだけはモバイルのヘッダに残す——「止まっている」ものは、
目次を開かなくても件数が見えるべき（§2.4）。


### 6.18 Root パスの呼び名と、選び方（改訂・2026-09-11、ユーザー指摘）

**呼び名は `Root パス` に統一する。** 作る画面が「Base パス」、設定画面が
「Root パス」と分かれていた（規則11——同じものを2つの名前で呼ばない）。
説明の文も揃える：

> Shell・FileSystem などの Module は、この Root パスの中のみアクセス可能

**打っても選んでもよい。** 入力欄はそのまま残し、右に「選ぶ」を置く
——フォルダを辿るダイアログが開き、「ここにする」で決まる。

- **いま入っているパスから始まる**（近くから探せる。打ちかけでもその近くへ）。
  **何も入っていなければ home から**——新しい Project の Root は**空から始める**
  （改訂・2026-09-11、ユーザー指摘。`~/worktrees/` を初期値にしていたが、
  その場所を使うかどうかは人が決めること）
- **例を置かない。** Project 名の入力欄に例（`例：…`）を出していたのをやめた
  ——作る画面は短いほうがよく、例は人の選択を狭める
- **フォルダしか出さない。** 一覧は host が答える（`GET /api/fs/directories`）
  ——画面はファイルの場所を推測しない（規則3）。返すのは**フォルダの名前だけ**で、
  ファイル名も中身も返さない
- **読めない場所は、空のフォルダに見せない**（規則2）——理由をその場に出す


### 6.19 焦点は、箱の中で示す（改訂・2026-09-11、ユーザー指摘）

入力欄の焦点を**外側の青い輪**（`ring-3`）で描いていた。輪は要素の外に出るので、
ダイアログの縁や狭い枠の中では**端が切れて見えた**。

- **輪をやめ、枠の色を変える**（`focus-visible:border-ink-3`）——箱の中で描くので、
  どこに置いても切れない
- **焦点そのものは消さない**（§6.0——キーボードで辿る人に要る）
- 誤り（`aria-invalid`）の示し方は変えない——そちらは**注意を引く**のが目的で、
  はみ出してよい


### 6.20 履歴は、見るときは分かれ、探すときは横断する（改訂・2026-09-12、ユーザー要望）

履歴（Archive）は**閉じた Fork Thread** と**閉じた Project** を縦に積んでいた。
Project を見たいときも Fork の山を越える必要があった。

- **検索欄の直下にタブ**——`Fork Thread`（この Project の）と `Project`（banto 全体）。
  件数を添える
- **見るときは、選んだタブのものだけ。** 見出しは出さない——タブの名前が見出し
- **探すときは横断する。** 検索の文字が入っている間は**どちらのタブも選ばない**で、
  両方から出す（見出しを添えて、どちらのものか分かるようにする）——**探している人は、
  それがどちらにあるか分かっていない**（規則12——ブラウザの履歴も検索は横断する）
- **タブを押すと検索はやめて、その一覧に戻る**——「横断のまま片方だけ選ぶ」という
  中間の状態を作らない（説明できない状態を画面に持たない）
- **Project の外（`/settings` 等）ではタブを出さない**——Fork のタブが無く、
  分けるものが1つしかない
- 空の見せ方も分ける：検索中は「見つからない」、タブを見ているときは
  「閉じた Fork Thread はまだ無い」「閉じた Project はまだ無い」

### 6.21 Module を足す面（改訂・2026-09-20、ユーザー指摘）

「普通の人には使いづらい」という指摘から作り直した。**人が実際にやっているのは、
README や他のクライアントの設定から `mcpServers` の JSON をコピーしてくること**
——それをそのまま受ける。手で書く欄は残すが**二番手**。

**聞かないこと**：「この MCP サーバは Project のフォルダを触りますか」は聞かない。
誤って答えたときの被害が釣り合わない（触らないと答えたのに触るサーバは、閉じ込めで
落ちる／触ると答えたのに触らないサーバは、要らない権限を持つ）。**`${projectRoot}`
を書いたかで決まる**——導出の結果は、押す前に文章で出す。

**API キーの既定は「Vault から」**（決定・2026-09-16）。直接入力も選べるが、
**選んだ瞬間に「この値は banto の記録に残り続けます（後から消せません）」と出す**
——宣言は Event Store に残るので、これは事実そのもの
（`docs/specs/v4-architecture.md`「秘密は `${secret:名前}` で書く」）。
貼り付けた JSON に平文の鍵らしきものが入っていたときも、同じことを言う。

**楽な道が安全なほうに落ちるように置く**——既定をVault にしてあるのはそのため。

#### 面は「何を入れるか」で分ける（改訂・2026-09-20、ユーザー指摘）

以前は「貼り付ける／自分で書く」を横に並べていた。**粒度が違うものを並べていて、
どちらもそれ単体では何のことか分からなかった**（規則11）。

| 段 | 何を選ぶか | 札 |
|---|---|---|
| 1段目 | **何を入れるか** | `公式モジュール`（目録）／`カスタム` |
| 2段目 | **どう入れるか**（カスタムの中） | `JSON を貼り付け`／`手動で入力` |

語は既存ソフトの慣習に合わせる——設定を取り込む（Import）と、項目を手で入れる
（Add manually）は、この種のソフトでほぼ共通の分け方。

**既定は `公式モジュール`。** いちばん楽な道を、いちばん安全なほうに置く。

#### 段が2つあるときは、同じ見た目を重ねない（決定・2026-09-20、ユーザー指摘）

同じ形のタブを縦に2本並べると**壊れているように見える**。形・幅・重さのうち
**2軸以上**を変える。部品は1箇所（`components/banto/shell/segmented-tabs.tsx`）。

| 段 | 部品 | 形 |
|---|---|---|
| 1段目（どの区画に居るか） | `SegmentedTabs` | **全幅**・下線・区画いっぱい |
| 2段目（区画の中のモード） | `PillTabs` | **中身の幅だけ**・角丸・薄い受け皿の中 |

**3段目は作らない。** それ以上分かれるものは、タブではなく**フォームの項目**
（ラベルの付いた1行）に降ろす——`接続方法`（このサーバで起動／URL に接続）と
`API キーの渡し方`（Vault から／直接入力）がこれ。同じ `PillTabs` を使うが、
ラベルが付いて入力欄の列に並ぶことで「選ぶ入力欄」として読める。

あわせて直したもの（同じ日）：

- **面の上の説明文を置かない**——タブを見れば分かることを、上でもう一度言わない
- **塗り潰しの青は1つだけ**。モード切替が `default` の青だったので、右下の `追加`
  と同じ重さで competing していた
- **「こうなります」は1行**。説明の段落を3つ積むと、どれが大事か分からない
- **承知の箱を赤一色にしない**——全部赤いと逆に読み飛ばす。相手のホスト名だけ赤

### 6.22 URL に繋ぐ Module——外へ出ることを、押す前に相手の名前で言う（決定・2026-09-17）

貼り付けた設定に `type: "http"`（または `url`）が入っていたら、また手で書く道で
「URL に繋ぐ」を選んだら、**押す前に次を出す**：

- **どこへ出るか。** 相手の host 名をそのまま出す（「外部サービス」では判断できない）
- **何が出るか。**「呼ぶたびに、会話から来た内容が送られます」
- **閉じ込められないこと。** 「相手のコードは閉じ込められません（こちらで動いて
  いないため）」——他の Module では「必ず閉じ込めます」と出している場所に、
  同じ大きさで逆のことを書く

**承知の印（チェックボックス）を付けるまで「追加する」を押せない。**
既定は未承知（規則2——楽な道が危ない結果に落ちない）。

**一覧にも残す。** その Module の行に「外へ送ります：<host>」を出す
——閉じ込めの札が出ない代わりに、ここが人の判断材料になる（規則13）。

**API キーの置き場は形で変わる。** 起動する形では環境変数、URL に繋ぐ形では
**ヘッダ**（既定の名前は `Authorization`）。どちらも既定は「Vault から」。

### 6.23 ログインが要る Module（決定・2026-09-18）

**「繋がりません」と一緒にしない。** host は「ログインが要る」をそうと分かる形で
返すので、画面は**別の状態として出す**——一緒くたにすると、**人は押すべきボタンが
あることに気付けない**（規則2）。

- 状態は「**ログインが要ります**」
- **その行に「ログインする」を置く。** 押すと新しいタブで相手の認可画面が開く
  （banto はサーバなので、自分でブラウザを開けない）
- 戻ってくると **banto の1枚**が「○○ にログインしました。このタブは閉じて
  かまいません」と出す。**code もトークンも出さない**
- 戻ったあとは**その場で繋ぎ直す**ので、元のタブを更新すれば「動いています」になる

**ログアウトはVault から。** 「Vault の置き場」にその Module のログイン情報が
`ログイン情報（OAuth）` として並ぶ——**消せばログアウト**（規則13——どこにログイン
しているかが見えて、消せる）。

### 6.24 繋がっていないときの面（決定・2026-09-18、ユーザー要望）

**聞いていないのに「無い」と言わない。** 合言葉（`authToken`）がそのブラウザに
無いとき、画面は **API を1回も呼ばずに**「まだ Project がありません」と出していた
——規則2（黙って別の経路へ落ちない）と規則13（見えているものは繋がっている）に
正面から反する。

実際に踏んだ：`http://` と `https://` は**別のオリジン**なので、https で開いた
瞬間に保存済みの合言葉が見えなくなり、**Project が全部消えたように見えた**。
データは無事だったが、画面がそう言わなかったので分からなかった。

**外枠より先に、ログインしているかを見る**（`app/(shell)/layout.tsx`・`components/banto/shell/connect-gate.tsx`）。
**改訂・2026-10-03**（`docs/specs/v4-security.md`「人のログイン」）：合言葉を打つ欄をやめ、端末ごとのセッション
（HttpOnly の Cookie）にした。画面は合言葉を持たない。

- 門は `GET /api/auth/me` で確かめる。入っていなければ「**この端末はまだ banto にログインしていません**」と、
  入り方を出す：「**パスキーで入る**」（名前の住所で開いているときだけ）・「ほかの端末から入る」（設定 →
  ログイン → 端末を追加）・「どの端末にも入っていないとき」（host で `node scripts/login-link.mjs`）
- host に届かなければ「banto に繋がりません（理由）」と「**もう一度試す**」
- **ログインのリンク**（`/#banto-login=<札>`）で来たら、門が札を引き換え、**先に URL から消して**から読み込み直す
  （履歴とブックマークに札を焼き付かせない。失敗しても消す）。使えない札なら「このリンクは使えません（使用済みか、
  10分を過ぎています）」。古い `?bantoToken=` は読まずに URL から消す
- どこかの要求が 401（ログインが切れた・締め出された）なら、門が出直す
- **公開先から回されてきたとき**（`?next=<banto>/api/auth/publish-start?rd=…`）は「入ると、開こうとしていた
  公開先へ戻ります」と出し、入ったらそこへ行く。戻ってよいのは banto 自身の `publish-start` だけ
- API の基点は**画面と同じオリジン**。`?bantoHost=` は localhost・127.0.0.1 でだけ読む（開発・E2E）

#### 設定の「ログイン」（banto 全体の設定の先頭、`components/banto/settings/login-panel.tsx`）

- **この端末**：端末名・入った方法と時刻・「ログアウト」
- **パスキー**：一覧（名前・登録・最後に使った）と「消す」、「この端末のパスキーを登録」。IP アドレスで開いている
  ときは使えないと書く
- **端末を追加**：押すとダイアログに **QR とリンク**（中身は同じ、リンクは選んでコピーできる）と「あと m:ss・
  1回だけ使えます」。使われたら「○○ が入りました」。期限が切れたら QR を薄くし、出し直すよう書く。開くたびに
  新しい札を出す
- **ログイン中の端末**：一覧（端末名・入った方法・最後に使った・この端末の印）と「締め出す」
- 端末を追加・パスキーの追加と削除・締め出しの前は、その場でパスキーを通す（端末が本人を確かめる。パスキーが
  1つも無いうちは求めない）。取り消したら「パスキーの確認が取り消されたか、時間切れになりました」
- 画面は iframe に入れさせない（`frame-ancestors 'none'`・`X-Frame-Options: DENY`・`Cross-Origin-Opener-Policy:
  same-origin`、`next.config.ts`）

### 6.25 本文のリンクは別タブで開く（決定・2026-09-18、ユーザー要望）

同じタブで出ていくと**会話から離れてしまう**——走行中のターンがあれば、そこへ
戻る道も分からなくなる。`target="_blank"` と **`rel="noopener noreferrer"` は対で
付ける**（`noopener` が無いと、開いた先から `window.opener` でこちらのタブを
触れる）。

### 6.26 Module の設定画面の語彙（改訂・2026-09-19、ユーザー指摘）

**「使うとき」「止めてある」「断るようになる」「根」「閉じ込め」「道具」
「合言葉」は、banto の中でしか通じない言い方だった**（規則11——独自の呼び名を
作らない。初見のエンジニアが機能を想像できる語を選ぶ）。

**設定と実行状態を言い分ける。**

| | 語 |
|---|---|
| 設定（トグルが変えるもの） | `有効` / `無効` |
| 実行状態（状態列） | `Running`・`On demand`・`Not running`・`Stopped`・`Failed`・`Auth required` |

- **`Stopped`（人が止めた）と `Not running`（動かす設定だが立っていない）は
  別の語にする**——混ぜると、直すべきかどうかが読めなくなる（規則2）
- 語だけでは足りないので、**意味は `title` に持たせてホバーで出す**
- `On demand` は Project ごとに立つもの（その Project が使われたときに立ち上がる）

**`金庫` は使わない**（改訂・2026-09-20、ユーザー指摘）。**Vault** と書く
——Module の名前も役割名も `vault` なのに、説明文だけ「金庫」と呼んでいて、
**同じものに2つの名前**があった。

**その他の言い換え**：`動く場所`→`実行場所`、`隔離`→`サンドボックス`、
`要るもの`→`依存`、`外から`→`ユーザー追加`、`捨てる/やめる/消す/保存する`→
`取り消す/キャンセル/削除/保存`、`Vault に預けた秘密`→`Vault に保存した認証情報`、
`合言葉`→`アクセストークン`、`この根では閉じ込めが効きません`→
`このフォルダでは、サンドボックスがほぼ機能しません`。

**「ユーザー追加」は `removable` で出す**（`origin` ではない）。同梱と同じコードを
別名でもう1本立てたものは `origin: "bundled"` だが**自分で足した行**なので、
人が知りたいほう（消せる行か）に合わせる。

### 6.27 Canvas の色と段は banto が持ち、渡す（決定・2026-09-25、ユーザー）

**banto が元（マスター）の色を持ち、Canvas に渡す**。Module は banto の値の写しを持たない
（要件E9「Canvas が独自の値を持たない」・規則3）。

- **元は `apps/frontend/app/globals.css` の層A**（`--banto-*`）の1箇所。字の段・角の段・書体も
  層A に置く——Tailwind の `@theme inline` の中だけにあると、ユーティリティに埋め込まれて
  実行時に読めない（確認・2026-09-25、`--text-xs` も `--radius-sm` も `:root` に無かった）。
  `@theme` は層A を参照する
- **渡し方は MCP Apps の標準**（`hostContext.styles.variables`）。**変数の名前は標準のものだけ**
  （`--color-background-primary` など）——banto 独自の名前を足すと、Module が banto を知ることになる。
  SDK の型も、決まった名前の外を認めない
- **host は画面が開くときに今の値を読み**（`getComputedStyle`）、**明暗が変わったら
  `ui/notifications/host-context-changed` で `theme` と一緒に渡し直す**。値は明暗ごとに違うので、
  渡し直さないと開いたままの画面が古い色に残る
- **対応表は `apps/frontend/lib/backend/canvas-host-styles.ts` の1箇所**。判断が要ったもの：
  - `danger` は **`stop`**（紫）——banto は失敗・エラー・差分の削除を `stop` で出している
    （Shell の終了コード、画面のエラー、差分の削除行）。Canvas に出る「危ない」はほとんどがこれ。
    `turn` は「会話の番・注意」の色で、標準の語彙に対応するものが無いので渡さない
  - 字は banto の7段を小さい順に、本文 `text-xs〜lg` ＝ 11・12・13・15、見出し
    `heading-xs〜lg` ＝ 15・17・22・28。banto に無い段（`heading-xl` 以上・`radius-xs`/`xl`/`full`・
    太さ）は渡さない——無い値を作らない
  - `text-inverse` は `on-color`（色の上の字）、`background-inverse` は本文の字の色
  - 余白は標準に名前が無いので渡さない
- **Module 側**：標準の変数を使い、**渡されないとき（banto の外の host）はシステム色**
  （`Canvas`・`CanvasText`・`GrayText`・`LinkText`）と CSS の色の名前・大きさの語（`small` など）で最低限の
  見た目にする。banto の値を既定値として持たない

### 6.28 会話の面が作り直されても、見え方を保つ（決定・2026-09-28、ユーザー要望）

**記録から組み直しても、会話のランタイムは作り直さない**（改訂・2026-09-28、Fable のレビュー→ユーザー
判断）。以前は組み直すたびに key を変えてランタイムごと捨てていたので、そのたびに入力欄・スクロール・
カードの開閉・流れていた run の後片づけを失っていた。いまは組み直した版（`restoredSyncVersion`）が
進んだら、**同じランタイムに記録を流し込む**（`thread.import`——assistant-ui が最初に会話を組み立てる
ときと同じ口）。ランタイムは Thread ごとに1つ。

**開いている層も、組み合わせが変わっても作り直さない**（改訂・2026-09-28、ユーザー要望「基本的に全部
残してほしい」、実装・2026-09-30）。Base・Fork・Canvas の3枚をいつも同じ親の下に同じ key で並べ、
組み合わせ（Fork と Canvas を両方開く・Canvas を全画面にする・携帯で Fork の上に Canvas を開く）で
変えるのは置き場所と、見せるか隠すか（`visibility: hidden`＋`inert`）だけ（`shell/panel-stack.tsx`）。
設定も重ねるだけになった（§6.16）ので、会話の面が消えるのは**別の Project へ行って戻る・読み込み直す**
ときだけ。**そのときも、人から見える3つは失わない。**

| 失わないもの | どう保つか |
|---|---|
| **最新のメッセージ** | §6.8 のとおり、見せている記録に写しを揃えてから組み立てる |
| **書きかけのメッセージ** | Thread ごとにブラウザ（localStorage）へ打つたびに写し、ランタイムが作られたら戻す（`lib/composer-drafts.ts`）。読み込み直しても・タブを開き直しても残る。送ると入力欄が空になり、一緒に消える。添えた画像も残す（2026-10-08、ユーザー要望）——1枚 10MB まであり localStorage に入らないので IndexedDB（`banto-composer-drafts`）に File のまま置き、戻すときは添えるのと同じ `addAttachment(File)` を通す。入力欄にすでに画像があれば戻さず、戻し終わるまでは書かない（半端な並びで上書きしない） |
| **読んでいた場所**（Fork・Canvas を閉じたとき） | Thread ごとに「一番下」か「器の上端にかかっているメッセージと、その中の位置」を覚え、作り直された面をそこへ戻す（`lib/thread-scroll-memory.ts`）。**ピクセルでは覚えない**——Canvas を開くと会話は細くなって折り返しが変わるので、細いときの scrollTop を元の幅で当てると別の場所へ行く（実測：720px ずれた） |

- **返事が伸びたら一番下を追いかける**（`turnAnchor="bottom"`、改訂・2026-09-28、ユーザー判断）。人が上へ
  スクロールしたら追うのをやめ、一番下へ戻したらまた追う。以前は `turnAnchor="top"`（最後の人の発言を
  器の上端に固定し、返事が伸びても追わない）で、走っている Thread を開くと最新ターンの頭で止まり
  「上のほうに出る」と見えていた（実測：8秒で一番下から 1138px 上）。不便なら「開いたとき・外から
  始まったターンだけ下を追い、自分で送ったときは上端に固定」を改めて検討する
- **Thread を開いたら一番下（最新）が基本。** 読んでいた場所を覚えるのは**同じ Project の画面に居る
  あいだだけ**——Project の画面を離れたら忘れる。設定から戻った・別の Project から戻った・読み込み
  直した、はどれも一番下から
- 戻すときは、ライブラリの「最初に一番下へ送る」を止めて戻す。最後のターンの下の余白は数フレーム
  遅れて伸びるので、約0.5秒は戻し続け、人が動かしたら（ホイール・タッチ・キー・つかむ）すぐやめる
- 回帰試験：`e2e/specs/thread-view-persist.spec.ts`（デスクトップ幅。Fork・Canvas・Fork＋Canvas の
  開け閉め、設定の往復、読み込み直し、設定の Escape、外で始まったターンに乗っても器が作り直されず
  一番下を追うこと）

### 6.29 会話は最新の 20 件だけ描く（決定・2026-09-29、ユーザー）

**会話の面が描くのは最新の 20 件だけ。** それより前は、上端の「それより前の 20 件を表示」で 20 件ずつ足す。
スクロールで上端に来ても勝手には足さない（上へ辿ると位置がずれる問題を 2026-09-10 に直した経緯）。
足したときは、見ていた発言の位置を動かさない。面が作り直されて読んでいた場所へ戻すとき（§6.28）は、
その発言が入るところまで広げて描く。会話のランタイムは全件を持ったまま——絞るのは描く所だけ。

**Fork の画面では、分ける前の親の会話は最後の 1 件だけ出す。** 親の分の横線（Clear 等）も出さない。
親の会話は親を開けば読める。host が Fork に親の記録を写して持たせる仕組みはそのまま（§2.2）。
親の会話に置く「この Fork を開く」の件数は、Fork 自身のやり取りだけを数える。

理由：画面の重さは描いている発言の数に比例していた（長い会話の Fork は親の分と合わせて 375 件を描き、
CPU を 4 倍遅くした条件で開くのに 5〜9 秒）。実測と経緯は `docs/notes/2026-09-29-long-thread-render.md`。

### 6.30 URL の「?」より後ろだけを変えるときは、サーバーに問い合わせない（決定・2026-09-30、ユーザー指摘→実測）

開いている Fork・Canvas・パレット・設定などは URL の問い合わせ部分が持つ（規則3）。それを変えるのに
`router.push`／`<Link>` を使うと、Next は同じページでもサーバーへページのデータ（RSC）を取りに行き、届いてから
描き直す。ページはサーバーで問い合わせ部分を読まないので意味が無い。**パスが同じなら `history.pushState`／
`replaceState` で変える**（Next のルーターに繋がっていて、`useSearchParams` はそのまま追う）。関数は
`lib/url-nav.ts` の `navigateUrl`、リンクは `components/banto/url-link.tsx` の `UrlLink`。パスが変わるときは
今までどおり。

あわせて、**ダイアログの背景はぼかさない**（Dialog・Sheet・AlertDialog・Drawer）——ぼかしは中身が動くたびに
下のページ全体を描き直させ、パレットのスクロールがコマ落ちしていた。**Command Palette はモーダルにしない**
——Radix のモーダルは開くたびにスクロール止めの `<style>` を差し込み `<body>` に `pointer-events:none` を付け、
ページ全体のスタイルを計算し直させる。banto の画面はページ自体がスクロールしないので要らない。暗くする背景は
自分で置く（押せば閉じる）。代わりに Tab でパレットの外へ出られる。実測は `docs/notes/2026-09-30-palette-latency.md`。

### 6.31 停止ボタンは押した瞬間に止まる。AI がまだ何も出していなければ、送った発言は入力欄へ戻る（決定・2026-10-01、ユーザー要望）

- **押した瞬間に画面が止まり、host のターンも止める。** 以前は画面が「読むのをやめる」だけで、しかも host から
  次のイベントが届くまで止まらず（AI が考えている間は何も届かない）、host のターンは最後まで走っていた。いまは
  adapter が止める合図を SSE の待ちと競わせ、人の停止（停止ボタン・入力欄の Escape）のときだけ
  `POST /api/threads/:id/stop` で host に止めてもらう。**画面を離れただけ（面を外す・会話を記録から組み直す）では
  host のターンは止めない**（`cancelRunQuietly`）。
- host は走っている・順番を待っているターンを Thread ごとに覚える（`http/turn-stops.ts`）。画面は送るときに
  ターンの名前（`turnId`）を付け、止めるときに同じ名前を渡す——順番待ちの発言は列を抜けて走らない。名前が無ければ
  いま走っているターン（あとから乗った流れ・届いたもので host が始めたターン）。ターンを始める前の下ごしらえ
  （Module を起こす・一覧を取る）の途中でも待たずに終える。止めたターンは `stopped` のイベントで終わる。
- **AI がまだ何も出していない（文も tool の呼び出しも無い）うちに止めたら、発言ごと取り消す。** 会話の記録から
  外し（`message.withdrawn`）、画面は文と画像を入力欄へ戻してカーソルを置く（止めるまでに打っていた文は消さず
  後ろに残す）。tool を呼んでいないので何も起きていない。**次のターンの AI の文脈からも消す**——CLI は応答の前に
  発言をセッションの記録に書くので、最後まで走ったターンの最後のやり取り（SDK のメッセージの uuid、
  `resumeAnchor`）を resume-point と一緒に残し、取り消したら次のターンは SDK の `resumeSessionAt` でそこまでで
  切って続ける。新しいセッション（最初のターン・Clear のあと・Fork の最初のターン）は切らなくてよい。
  **切る位置を覚えていないとき**（この仕組みより前から続く会話・止めたターンが続いた会話）は、止めたあとに CLI の
  会話の記録を SDK の公式の口（`getSessionMessages`）で読み、送った発言の1つ手前を切る位置にする（改訂・2026-10-02、
  ユーザー報告「Fork だと戻らない」——以前は止めるだけにしていたが、止めたターンは位置を残さないので抜けられなかった）。
  読めないときと、届いたものも一緒に積んだターンは取り消さない——止めるだけにする（起こし直しで切れたターンの続き
  を引き継いだ人のターンも同じ。アーキ仕様 §2.5「人が送ったターンが続きを引き継ぐ」）。
- **書き始めてから止めたものは取り消さない。** そこまでに出た分は書き終えるごとに記録してあり（アーキ仕様 §2.5）、
  その後ろに「（ここで止めました）」を足す（アーキ仕様「止めたターンの記録」——SDK は止めたターンの出力を結果に
  載せない）。そのターンが出した判断待ちは
  畳む（拒否で答えたことにする）。
- Memory の差分を「届けた」と記録するのは AI の最初の返事が来たとき（以前は `system/init`）——取り消すと添えた
  差分も AI の文脈から落ちるので、init で記録すると二度と届かない。

経緯と実測は `docs/notes/2026-10-01-stop-button.md`。


### 6.32 Fork を作るときは名前を聞く。ヘッダの Fork だけ「会話を引き継ぐか」を選べる（決定・2026-10-02、ユーザー要望）

Fork を作る口は2つあり、どちらも**押すとダイアログが出て、作る前に名前を聞く**（以前は押した瞬間に「Fork 3」等の
連番で作っていた）。

| 入口 | ダイアログで聞くこと |
|---|---|
| 会話のヘッダの「Fork を開く」 | 名前 ＋ **始め方**：「会話を引き継ぐ」（既定）／「まっさらで始める」 |
| 発言の下の「ここから Fork」（§6.12） | 名前だけ。**会話は必ず引き継ぐ**（その発言の時点から分けるのが目的なので、選ばせない） |

- **名前は空でもよい。** 空のまま作ると今までどおり Project の中の連番（「Fork 3」）になる（説明の文にそう書く。
  連番は分けた位置の順で振り直すので、作る前に番号を見せることはしない）。Enter で作る、Escape・「やめる」で何も作らない
- 作れなかったときはダイアログを開いたまま理由を出す（打ち直せる）
- **「まっさらで始める」は Clear した状態の Fork**——親の会話も resume-point も引き継がず、新しい会話として始まる。
  Memory は Project のものなのでそのまま効く。モデル・effort・承認モードは親にそろえる。Project だけを宛先にした
  send_message が立てる Fork（アーキ仕様 §4.2）と同じもの（host の `forkThread` の `fresh`）
- 「まっさらで始める」で作った Fork も、親の会話の作った位置に「この Fork を開く」のカードが出る（§6.3）
- 名前と始め方は作るときに host へ一緒に渡す（`POST /api/threads/:id/fork` の `title`・`fresh`）——作ってから名前を
  付けると、その間に一覧を取った画面が名前の無い Fork を覚える（AI が Fork を立てるときと同じ理由）
- 名前は作ったあとも今までどおり変えられる（§6.11）



### 6.33 AI が動いている Thread は、サイドバーの行のアイコンが回る／まだ開いていない Thread は太字／バックグラウンドの仕事（決定・2026-10-03、ユーザー要望）

サイドバーの Thread の目次（Base Thread・Fork の行）で、**その Thread のターンが host で走っている間は、行のアイコンを
回る輪に替える**。終われば元のアイコン（Base は吹き出し、Fork は枝分かれ）に戻る。畳んだレールの Fork 一覧（ポップオーバー）も
同じ。携帯の Drawer はサイドバーと同じ目次なので同じく回る。

- **「動いている」は host が決める**——host の `ThreadTurns`（同じ Thread のターンを1本ずつにする鍵）を持っている間。
  人が送ったターンも、届いたもので host が始めたターン（AI が立てた Fork・サブエージェントの完了など）も回る。
  判断待ちで止まっている間も、ターンは終わっていないので回ったまま
- **写しの持ち方**：出来事の流れ（`GET /api/events`）が繋いだときに送る `hello` に、その時点で走っている Thread の一覧
  （`running: [{ threadId, projectId }]`）を載せる。画面はそれで丸ごと置き換え、あとは `turn.started` で足し `turn.ended` で外す
  （`lib/backend/running-threads.ts`）。繋ぎ直すたびに置き換えるので、途切れている間に終わったターンが回り続けない。
  ポーリングはしない（§6.8 と同じ理由）
- 回る輪には「AI が動いています」という読み上げ用の名前を付ける。行の幅・文字の位置は変えない（アイコンと同じ場所）
- **いま開いていない Project の行も回る**（追加・2026-10-03、ユーザー要望）：広いサイドバー（と携帯の Drawer）で、その Project の
  どれかの Thread が走っていれば、Project の行の頭文字を回る輪に替える（同じ大きさ・同じ場所）。いま開いている Project の行は
  回さない（Thread の目次で分かる）。畳んだレールの頭文字は変えない。走っている Thread がどの Project かは hello の `projectId`・
  `turn.started` の `projectId` で持つ（`useProjectRunning`）
- **AI が返したあと、人がまだ開いていない Thread は名前を太字にする**（追加・2026-10-03、ユーザー要望）。「まだ開いていない」は
  **受信箱のレビュー待ちそのもの**（アーキ仕様 §2.4：ターンが終わると host が1件出し、その Thread を開く・そこで送ると「見た」に
  なる）——別の置き場を作らない（規則3）。host が持つので携帯とパソコンで揃う。受信箱で「見た」にしても太字は消える。
  Base・Fork の行（広いサイドバー・Drawer）と畳んだレールの Fork 一覧が対象。**いま開いていない Project は、その Project の開いて
  いる Thread のどれかが未読なら Project 名を太字**にする。いま開いている Project の名前は太字にしない（中の行で分かる）。
  見分けは `data-unread`（`useThreadUnread`・`useAnyThreadUnread`、`lib/backend/real-inbox.ts`）
- **バックグラウンドで動いているものを出す**（追加・2026-10-03、ユーザー。見本 `mock/components/banto/shell/pending-replies.tsx`）：
  AI が「終わったら届ける」tool（`dev.banto/deliversLater`、`runSubagent` の `runInBackground`・Shell の `runCommand` の `runInBackground`（2026-10-07。題はカードの `{label|command}`——AI が付けた呼び名、無ければコマンド。2026-10-08）など）で頼み、Module が
  「あとで届ける」と約束して、まだ届いていないもの（host の返事待ちの札、アーキ仕様 §4.2）。AI が動いている印（回る輪）とは
  別のことなので、**別の場所に置く**——両方が同時に見える。**待つ形の呼び出しは出さない**（その間はターンが走っていて輪が回る）
  - **Thread の行**（Base・Fork、広いサイドバーと Drawer）：名前の下に薄い1行。1件ならカードの題（tool が名乗る
    `dev.banto/card` の題をその呼び出しの引数で埋めたもの。無ければ「<Module> に頼んだ仕事」）、2件以上なら
    「**バックグラウンドで n 件**」。いま開いている Project の Thread の行に出る
  - **いま開いていない Project の行**：頭文字の右下に件数の丸。いま開いている Project の行には出さない（中の行で分かる）
  - **畳んだレールには出さない**（レールの作りを見直すまで）
  - 押すと一覧（見出し「バックグラウンドで動いているもの（n）」、1件ごとに題・頼んだ内容の頭（カードの説明。**題と同じ文なら
    出さない**、2026-10-08）・Module 名・何分前に頼んだか。Project の行から開いたものは Thread ごとに見出しを付ける）。1件を押すと、その Thread へ移り、**会話のカードと同じ画面**
    （その tool の `ui.resourceUri` を、その呼び出しの toolCallId で）を Canvas に開く。画面を持たない tool なら Thread へ移るだけ
  - **起こし直しのあと続けているもの**（追加・2026-10-05、アーキ仕様 §2.5「2.」）：banto を起こし直したあと Module が続けると
    答えた仕事は、一覧の1件に「起こし直しのあと続けています（<何分前>から）」を添える——続けると言ったまま長く届かない
    ものに人が気づけるように
  - **人の答えを待っているものは分けて出す**（追加・2026-10-04、ユーザー）：公開の承認のように、Module が人の答えを
    待っているもの（結果の `_meta["dev.banto/waitingOn"]: { on: "human", title? }` で名乗る）は「バックグラウンド」と
    呼ばない——放っておいてよいものに見える。Thread の行では**人を待つ行を上、裏の仕事の行を下**に、あるほうだけ出す。
    人を待つ行は手のアイコンで**人の番の色**（受信箱のバッジと同じ `turn`）、1件なら Module が名乗った題（例「公開の承認：web:3000」、
    無ければカードの題、それも無ければ「<Module> があなたの答えを待っています」）、2件以上なら「あなたの答えを待っています（n 件）」。
    一覧は「あなたの答えを待っているもの（n）」を先に、「バックグラウンドで動いているもの（n）」を後に分け、人を待つものは
    「<Module>・n分前から待っています」。いま開いていない Project の行の数は、人を待つものが1つでもあれば人の番の色（数は全部）
  - **文言に「〜待ち」を使わない**——「判断待ち」「レビュー待ち」は人の番を指すので、人が返事をする番に読める。
    Claude Code の「background tasks」、VS Code の「バックグラウンド タスク」、tool の `runInBackground` に揃えた
  - **写しの持ち方**：`hello` に `background: [{ threadId, projectId, items }]`（札がある Thread だけ）、札が増えた・済んだら
    `background.changed`（その Thread の分を丸ごと）。画面は置き換えるだけ（`lib/backend/background-work.ts`）。
    1件は `{ module, since, toolName, toolCallId, resourceUri, title, description }`——**札そのもの（`replyTo`）は画面に出さない**
- 回帰試験：`e2e/specs/thread-running-icon.spec.ts`・`e2e/specs/sidebar-unread-running.spec.ts`・`e2e/specs/background-work.spec.ts`・`e2e/specs/shell-background.spec.ts`（Shell の待たない形の印——題は呼び名・説明はコマンド、呼び名が無ければ題がコマンドで説明は出さない）

### 6.34 設定の「更新」——banto 自身を GitHub の新しい版にする（決定・2026-10-04、ユーザー。モックで確認 → 本実装）

設定の「banto 全体」の層の最後に「更新」（`/settings?section=update`）。仕組みはアーキ仕様 §2.5「画面から banto を更新する」、
安全の考え方は `docs/specs/v4-security.md` §2「画面からの更新」。見本は `mock/components/banto/settings/update-panel.tsx`
（人が OK を出したモック）。本物は `components/banto/settings/update-panel.tsx`・`lib/backend/self-update.ts`。
**待つものの文と数え方は 2026-10-05 に本物だけ改めた**（下の「ボタンは2つ」・待つ段）——骨組みはモックのまま、モックの文は
前の「AI が止まるまで待って更新」のまま残っている

- **押す前に何が入るかを読ませる**：「今の版」（題・id の頭7文字・日時）と、最新の `release` までに入る新しいコミット
  （新しい順、**5件まで＋「ほか n 件を見る」**で全部）。見出しは「新しいコミットが n 件あります」「最新の版 <id>（日時）と比べています」。
  release に名前（タグ）は無いので、版は commit の頭7文字で呼ぶ。日時はこの端末の時刻で「10月4日 9:31」。
  見出しの右上に**「もう一度確かめる」（回る矢印のボタン、`POST …/check`）**と、見出しの下に「確かめた時刻 …」——この面を
  開いたあとに release に入ったコミットも一覧に出せるように（追加・2026-10-06、ユーザー要望。以前は「最新です」の面にしか確かめる口が
  無かった）
- **最新のとき**：「最新です」「最後に確かめた時刻 …」と「確かめる」（`POST …/check`、GitHub に取りに行く）。一度も取ってきて
  いなければ「まだ確かめていません」。release が今の版から早送りで辿れない（書き換えられた）ときは、そう言ってボタンを出さない
- **ボタンは2つ**：「実行中の呼び出しを待って更新」（主）と「すぐ更新」（副）。待つのは切れると結果が分からなくなるもの
  （実行中の呼び出し・続けられない仕事）だけ——AI の会話とサブエージェントの仕事は起き直したあと続く（アーキ仕様 §2.5
  「起こし直しをまたいで続ける」の 3.。改訂・2026-10-05、以前は「AI が止まるまで待って更新」で全部を待った）。ボタンの下に
  「組み立てが終わったら、実行中の呼び出しが終わるのを待って起こし直します。AI の会話とサブエージェントの仕事は、起き直した
  あと続きます。「すぐ更新」は待たないので、実行中の呼び出しは途中で切れます。…」。**「すぐ更新」は先に、途中で切れる呼び出し
  （`GET /api/admin/activity` の `blocking` を1件1行——同じ会話の同じ Module の呼び出しは1行：題（会話の無いものは
  「<Module> の操作」・Module が頼んだ仕事は「<Module> が頼んだ仕事」）・Project・何分前から・「<Module> を呼んでいます」／
  「<Module> の仕事の返事を待っています」）を出して「これらは途中で切れ、結果が分からなくなります。」と確かめ、
  「起き直したあと続くもの n 件（会話・サブエージェントなど）」（`continuesAfterRestart` の件数。0 なら出さない）を添える**。
  途中で切れる呼び出しが無ければ確かめない（会話が走っていても）。**待つほうに回した会話**（続けて切れた回数が上限に達する
  ——起き直しても自動では続かない）は、状態の代わりに host の理由（`reason`）を出す。**待つものを分けて返さない古い host**
  （`blocking` が無い）には、動いているもの（ターン・返事待ちの仕事・呼び出し）を全部切れるものとして並べ、続くものの行は
  出さない（`update.mjs` の待つ段と同じ）。**パスキーは最後**——host が本人の確認を求めたとき（`step-up-required`）だけ通し、
  その間はボタンの所に「パスキーを確かめています」。少し前に確かめていれば（host の 5〜10 分）求められない
- **進み具合**：取ってくる → 組み立てる → 呼び出しが終わるのを待つ → 起こし直す（`update.mjs` の確かめる段は起こし直すの続きとして出す）。
  すぐ更新では待つ段を「待ちません（すぐ更新）」として飛ばす。組み立ての間は「今の banto はそのまま使えます」。
  取ってくる・組み立てるの間は「**更新をやめる**」（`POST …/cancel`。`update.mjs` は取ってくる・組み立てる・待つの間に受け、
  作りかけを消す。モックには無いが、効く口なので出す）。`update.mjs` が `state.json` に書く `note`（いま止まっている理由。
  例「host が答えません…答えるまで待ちます」）は、いまの段の下に出す
  - **待つ段**：「あと n 件」と待っている呼び出し（`update.mjs` が `state.json` の `waiting.blocking` に写した activity の
    待つもの。並べ方は上と同じ。無ければ「途中で切れる呼び出しはありません」）と、別の1行で「起き直したあと続くもの n 件
    （会話・サブエージェントなど）」（`waiting.continuing`）。古い host に `update.mjs` が全部を待ったときは、ターンも
    待つものに入る（「AI が動いています」／「人の返事待ち」）。
    「**待たずにすぐ起こし直す**」は、同じ確かめで**その時点でまだ実行中の呼び出しだけ**を並べてから `POST …/force-now`。
    host が本人の確認を求めたときだけパスキーを通す（モックは「再び求めない」としたが、host は force-now に step-up を
    求めるので、確かめてから 5 分を過ぎていれば求められる）。「**待つのをやめる**」は `POST …/cancel`。`update.mjs` が止まって
    `cancelled` を書いたら最初の画面に戻り「更新をやめました。今の版のまま動いています。」
  - **起こし直しの間**は画面全体（左の列も覆う）に「起こし直しています／繋がり直すのを待っています」。**host に繋がらない
    （起こし直しで居ない）ことを失敗にしない**——更新が走っている間に繋がらなくなったら、同じ画面で待ち続け、繋がったら
    `state.json` を読んで結果を出す
- **結果は host の最後の結果（`state.json`）そのもの**——画面は覚えない（規則3）。開き直しても同じものが出る：
  - 終わった（`done` で、今の版がその版）：帯「版 <id> になりました」、今の版が替わり「最新です」
  - 失敗（`failed`・`rolled-back`）：「「<段>」で止まりました」と、取ってくる・組み立てる・待つで止まったなら「今の版のまま
    動いています」、前の版に戻したなら「新しい版が起きなかったので、前の版に戻しました」、起こし直しで止まったなら今動いている
    版。`state.json` の `error` を1行添える。**`failedPhase` の無い失敗**（`update.mjs` が始める前に断った：頼みが無い・読めない・
    設定が無い等）は段を出さずに「**更新を始められませんでした**」
  - **途中で止まった回**（host が `interrupted` を返す：`state.json` が途中の段なのに unit が動いていない）：同じカードで
    「**更新が途中で止まりました**」と host の理由（どの段で・unit の状態・`journalctl -u banto-update`）、`state.json` の
    `error`・`note`（「止まる前：…」）、止まった段
  - どの失敗も「**ログを開く**」は `GET /api/admin/update/log`（この回のログの末尾 64KiB、人のセッションだけ）。「もう一度
    ためす」でこの画面では閉じ、最初の画面に戻る（頼み直しても、閉じた失敗は出し直さない）
- **更新したら画面も新しくする**（追加・2026-10-05、ユーザー報告「更新したけど何も変わってなさそう」）。host が新しい版で
  起き直しても、開いていたページは読み込み直されず古い画面のプログラムのまま動いていた。
  - ページは組み立てたときの印（`NEXT_PUBLIC_BANTO_BUILD`＝commit の頭12文字と組み立てた時刻、`next.config.ts`）を持ち、
    画面のサーバは同じ印を `GET /banto-build`（合言葉なし、印だけ）で返す。違えば「読み込み直せば新しい画面になる」
    （`lib/backend/frontend-build.ts`）。確かめるのは、聞き始めたとき・host に繋ぎ直したとき（hello。画面のサーバは
    host より遅れて起きることがあるので 0・3・10・30・60・120 秒に何度か）・タブに戻ったとき。ポーリングはしない
  - **更新した本人の画面**（この節の面）は、結果が「終わった」で印が違えば**自動で読み込み直す**。1つの版につき1回
    （sessionStorage）——読み込み直しても古いと出るなら繰り返さず帯に任せる
  - **ほかのタブ・端末**は自動では読み込み直さず（書きかけ・開いている画面を知らないうちに捨てない）、画面の上に帯
    「新しい版の画面があります［読み込み直す］」（`new-build-banner.tsx`、外枠 AppShell に1つ）
  - 回帰試験：`e2e/specs/new-build-banner.spec.ts`・`e2e/specs/self-update.spec.ts`（本物の update.mjs の回）
  - **受け取られていない頼み**（host が `staleRequest` を返す：書いてから 60 秒を過ぎても unit が受け取っていない）：
    host の理由（「更新の unit が頼みを受け取っていません。journalctl -u banto-update を見てください」）と、頼んだ人の名前・
    時刻・版。画面が覚えた「頼んだ」から推し量らない（host が真実）
- **準備が済んでいない**（host が `ready: false`：置き場が版ごとのフォルダの形でない・その外から動いている・unit が無い・
  polkit の規則が効いていない）ときは、
  host の理由をそのまま並べ、手順書（`docs/runbooks/release.md` の D）を案内する。**ボタンは出さない**（押しても断られる）
- **読みに行くのは走っている間だけ**（3秒おき）。止まっているときは開いたときに1回だけ——`GET /api/admin/update` は host で git を
  数回打つので、細かく読まない。出来事の流れ（§6.8）には載せていない
- **携帯の幅**：設定の他の節と同じ作り。ボタンは縦に並べ、高さ 40px（広い画面は 32〜36px）。一覧の題は折り返す
- 回帰試験：`e2e/specs/update-wait-restartable.spec.ts`（待つものと続くものの分け方を自前の host で——文を書いている
  ターン＋サブエージェントの待たない仕事の間は `restartable`、tool の呼び出しの間は待つ、起こし直すと両方続く）・
  `e2e/specs/self-update.spec.ts`（本物の systemd・人の置き場は使わない。置き場・systemctl・動いているコードの場所を
  試験の置き場に向け（bootstrap config の `testOnlySelfUpdate`、アーキ仕様 §2.5）、組み立ての失敗・組み立て中にやめる・
  起こし直して今の版が本当に替わるところは本物の `update.mjs --from-request` を通す）

### 6.35 ターンの終わりのまとめ——頼んだこと・結果・決めること（決定・2026-10-06、ユーザー。モックで確認 → 本実装）

AI が `report_turn` で渡したまとめ（アーキ仕様 §2.2「ターンの終わりのまとめ」）を、**そのターンの AI の発言の一番下**に出す。
Project の設定「一般」の節「会話」のスイッチ「ターンの終わりにまとめを出す」（既定はオフ、押したらすぐ保存）でオンにした
Project だけ。出るのは作業をしたターン・長い報告のあと（短い受け答えには出ない、改訂・2026-10-07）。モックは `mock/components/banto/thread/turn-summary-card.tsx`、本物は
`apps/frontend/components/banto/thread/turn-summary-card.tsx`。

- **普通の発言と見分けがつく票**：会話の幅いっぱいの枠に見出し「このターンのまとめ」と時刻。中は3段：
  - **頼んだこと**——AI が文脈から書き直した依頼を大きな太字で。下に薄く「あなたの発言『…』を、前の話から読み替えています」
    （元の発言は会話の記録から取る。依頼と同じ文なら出さない。届いたもので起きたターンは届いたものの題）
  - **結果**——状態の印と文字（終わりました／途中まで／できませんでした）・1文の結論・要点・「確かめていないこと」の欄・
    できたもの（コミット・ファイル・URL）
  - **決めること**——人の番の色の段。問い・背景・返答の候補（おすすめに印）。決めることが無ければ「次に頼めること」
- **左の太い線は2色だけ**（ユーザー決定）：決めることがあれば人の番の色（橙）、無ければ緑。結果の状態は線の色にしない
  ——「できなかった」の赤と人の番の橙が見分けにくかったため
- **候補を押すと入力欄に入る（送らない）**：直してから人が送る。判断が複数なら選んだものを上から1行ずつ並べ、もう一度押すと
  外す。人が手で書いた文は消さずに下へ足す。入力欄に焦点を移す。まとめの後ろに人の返事があれば候補は押せない
  （「このまとめのあとに返事をしています」）
- **置き場所**：tool の折りたたみには出さない（`report_turn` だけの折りたたみは出さない）。発言の中のどこで呼ばれても一番下
  （assistant-ui の Thread に足した口 `AssistantMessageFooter`）。1つの発言に何度呼ばれても、断られていない最後の1つだけ
- **読み込み直し**：記録の発言の `turnSummary` から同じ部品で組み直す（発言の部品の最後に `report_turn` の呼び出しとして置き、
  結果に host が受け付けた時刻）。走っている間は時刻が分からないので、最初に描いた時刻で代える
- 出すのは会話の中だけ（サイドバー・受信箱には今は出さない、ユーザー）

### 6.36 設定の「資源」とサイドバーの混んでいる印（決定・2026-10-09、ユーザー。モックで確認 → 本実装）

見本はモック（`mock/components/banto/settings/resources-panel.tsx`・`mock/lib/mock/resources.ts`）。測り方は
`v4-security.md` §1「資源の逼迫を見せる・共倒れさせない」。

- **banto 全体の設定に「資源」の節**。上に「この機械」：メモリの使い道を1本の帯（Project のコンテナごと・banto 本体・Incus・
  その他）、CPU・メモリ・ディスクの空きを待つ時間（直近10秒、20% 以上は注意の色）、banto 本体が止まった直近の記録
  （「banto 本体が 10:41 に 12.3 秒止まっていました」と、その間の ping の時間切れは数えず確かめ直していること）
- 下に **Project ごと**：混んでいるものを先、次に使っている量の多い順。1行に名前・メモリ（上限に対する帯、濃い＝使っている・
  薄い＝戻せるキャッシュ）・CPU（使った量／上限のコア数）・プロセス数・「空いている／混んでいる」。混んでいる行は最初から開く
- 行を押すと**内訳**：混んでいる理由、何が使っているか（Module／AI の仕事／コマンド／Service／入れ子のコンテナ／その他／
  戻せるキャッシュ）を帯と一覧で、Project ごとの待つ時間、上限に当たった記録（時刻と何が起きたか）、その Project の
  コンテナの設定へのリンク
- 開いている間だけ 10 秒ごとに読み直す
- **サイドバー**：混んでいる Project の名前の右にメーターの印（触れると理由）。いま開いている Project にも出す。この機械
  全体が混んでいるときは Project の一覧の上に帯「この機械が混んでいます」（押すと「資源」）
- 色：帯は灰色。混んでいることは文字と札の注意の色（warn）で出す——面を塗ってよいのは turn だけ（E9）
