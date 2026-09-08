# v4 フロントエンド要件

> **これは仕様である。** 決まったことだけを書き、決まったら**この文書を更新する**。
> 検討の経緯は `docs/notes/` に残す。
>
> 全体の構造は `docs/specs/v4-architecture.md`（以下「アーキ仕様」）。
> **この文書は旧 `v4-architecture.md` §6 から分離した**（2026-09-02）。
> 内部の節番号（§6.0〜§6.6）は移動前のまま維持している——他文書からの
> 参照（`v4-modules.md`・`requirements.md` 等）を壊さないため。
>
> 最終更新：2026-09-02

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
   **量と速さが要るもの**はこの経路に載らない
   （`docs/specs/v4-modules.md` §4.1 で3択として未決）。
   **「すべて MCP 経由」が初めて運べないものに当たった箇所である**
3. **tool 呼び出しの汎用フォールバック表示**——`ui://` を宣言していない Module にも
   最低限の表示を保証する。**これは作り込みではなく仕様の要求**（下記）
4. **受信箱のバッジ**（アーキ仕様 §2.4 と同一）——**判断待ちとレビュー待ちの両方**が入る
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
   **数字1つではなく内訳を出す**——**アーキ仕様 §5.7 が要求している「効いている Skill が
   食っているトークン量」と、これは同じ表示である**。Module を繋ぎ、Skill を
   効かせ、Memory を書き足すたびに何が増えたのかが、1箇所で見える

### 6.1 設定画面は2階層

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
  どの Module のものかで決まる（フロントエンドが握る）。画面から banto の API を
  直接叩くこともできない（別オリジン・合言葉を持たない）。
  **残る risk を記録する**：Module 自身の画面が、その Module の危ない tool を
  黙って呼ぶことはできる。**Module を繋ぐこと自体が信頼の線引き**で、その手前は
  閉じ込め（`v4-security.md`）と可視性で守る
- **`hostContext.styles.variables` で host が CSS 変数を View に渡せる**。
  banto の色トークンをここで渡す——Module 側に banto を知らせずに見た目を揃えられる

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
| `POST /api/threads/:id/ui-tool-call` | **画面からの tool 呼び出し**。必ず承認ゲートを通る |

`GET /api/ui-config` が `sandboxUrl` を返す（画面はここから住所を知る）。

**画面つき tool の呼び出しは、会話の記録にも残す**（決定・2026-09-07、ユーザー報告）。
リロードすると会話は host の記録から組み直されるので、記録が文章だけだと
**Module の画面だけが消える**。残すのは表示の復元に要る分
（`toolCallId` / `toolName` / `server` / `resourceUri` / 引数 / 結果）で、
**画面を持つ tool だけ**が対象——実行の再現は resume-point の仕事であり、
画面を持たない tool の結果まで会話の記録に積む理由が無い。

**画面からの呼び出しは、Runner の `canUseTool` と同じ Inbox の判断待ちに載る**
——人から見て「承認する場所」が2つに割れない（規則3）。
承認されるまで Module には届かない。

**tool 結果の受け渡しで踏んだこと**：`ui/notifications/tool-result` の
`params` は **`CallToolResult` そのもの**（`params.result` ではない）。
また会話に載っている結果は文字列・ブロック配列・`{content:[…]}` の
3つの形で来るので、画面へ渡す前に揃える。
- **設定の中身は Module が持つ。** banto の Configuration（アーキ仕様 §2.6）は**core 自身の
  設定**であって、Module の設定を預かる登録簿ではない。Module の設定 UI は、その
  Module 自身の tool を呼んで読み書きする。banto が持つのは「その役割を有効に
  するか」という banto 側の判断だけ（§6.1 階層1）

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
Shell・FileSystem は例外**——Landlock の制約から Project 単位でプロセスを
分ける、`docs/specs/v4-security.md`「Project の根は Module 起動時に確定
させる」）ということ。**つまり Module 自身は「今どの Project のために
描いているか」を、渡されない限り知りようがない**（例外の Shell/FileSystem
も、設定 Canvas はこの一般的な配線に乗るので同じ扱いでよい）。

- **banto がやること**：`ui://<id>/config` を設定画面（階層2、Project の
  overlay から開いたとき）に埋め込む際、**現在の Project の識別子を渡す。**
  新しい仕組みは要らない（規則12）——「Canvas が自分で取りに行く」という既存の形
  （上記「tool 起点でない Canvas を、どう成立させるか」）に乗せるだけ。iframe の
  `ui/initialize` ハンドシェイクの一部として、または Canvas が自分の tool を呼んで
  中身を読み書きするときの引数として、Project 識別子を運べば足りる
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
入口の一覧は Project の Module 集合から導出する——別の一覧を持たない（規則3）。

### 6.3 Command Palette（Ctrl-K）——あらゆるものへの1つの入口

banto は「1本の窓口」を3か所で守る。**host が誰と誰を繋ぐかを1箇所で解決する**
（アーキ仕様 §2.5、配線）、**発生源が違っても配達は1本**（§6-5、SSE）、そして
**探すときの入口も1つ**——それが Command Palette。core UI。

**自分の索引を持たない**（規則3）。出るものは全部、すでにあるところから導出する：

| 出るもの | 出所 |
|---|---|
| Project / Thread | Event Store（`fold`） |
| 受信箱（判断待ち・レビュー待ち） | Event Store（`fold`）。アーキ仕様 §2.4 と同じ源 |
| Module の入口（launcher） | その Project の Module 集合＋マニフェスト（§6.2） |
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
- 受信箱の項目 → 判断待ちはその場で答える（インラインフォーム、または Thread を開いて
  返信する）。レビュー待ちは Thread（純粋完了）または Module の Canvas（Module 発）が開く（アーキ仕様 §2.4）
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
| やり直す（アーキ仕様 §2.2） | メッセージ位置での分岐（`switchToBranch({ position, branchId })`） |
| Fork Thread（アーキ仕様 §1.1） | Thread（`switchToThread` / `switchToNewThread`） |
| 汎用フォールバック表示（§6-3） | `ToolFallback` |
| 添付 | Attachments |

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
  切り替えていない Thread は値を持たない——カスケードから導出する（規則3）

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
  常に初回確認を行う。** 以降は §2.5 で決めた粒度（呼び出し元・宛先・
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

> **これは Claude Agent SDK 固有の機構である。** item 1 の PoC（アーキ仕様 §4.1・アーキ仕様 §10.2）で、別 backend（opencode）は elicitation 自体に非対応など、Runner ごとに機能差があることが実測済み——**Phase 0 が Claude backend 限定であることは既に受け入れている制約**（アーキ仕様 §10.2）なので、承認ゲートをこの機構に委ねる決定もその範囲に乗る。別 Runner を足すときは、この委任がそのまま使えない可能性がある。

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
