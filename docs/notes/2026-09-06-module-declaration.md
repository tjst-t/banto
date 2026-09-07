# Module を「宣言」で足せるようにした（Phase 1・1件目）

2026-09-06。`docs/tasks.json` の `phase1-module-contract`。
Phase 1 の完了条件「**契約が確定し、その契約で3つ書けた**」のうち、
**契約側**が欠けていた。

## 何が問題だったか

3本（Vault・Shell・FileSystem）は書けていた。足りなかったのは
**「どう足すか」のルールが banto 本体のコードに溶けていた**こと。具体的には
`cli.ts` に3つの直書きがあった：

1. Vault の起動が `packages/modules/vault/dist/server.js` の**パス直書き**
2. Project 単位の Module が `"shell" | "filesystem"` の**リテラル union**
   ——型のレベルで3つ目が存在できない
3. 起動が **node 固定**（`process.execPath` ＋ `dist/server.js`）
   ——**Python の Module はそもそも表現できない**

つまり4本目を足すには本体を書き換えてビルドし直す必要があった。

## 決めたこと

### 受け入れる起動の形は1種類だけ（未決「どの package type を受け入れるか」の決着）

**「このプログラムを、この引数で、この環境変数で起動する」**。それだけ。
パッケージ名からの解決・自動インストール・レジストリ取得は入れない（規則10）。
この1種類で Python も Ruby も Go も同じ書き方で載る。

### 置き場は Configuration（Event Store）

Module 集合は Project 単位（§2.2）で、instance 既定＋Project 上書きの仕組みは
既にある。新しい置き場を発明しない（規則12）。

### 差し込み語は host が確定させる値だけ

`${nodeExec}` / `${monorepoRoot}` / `${dataDir}` / `${hostRelayUrl}` /
`${hostRelayToken}` と、Project 単位の Module だけが使える `${projectRoot}`。
**知らない語が書かれていたら起動する前に落とす**——黙って空文字で起動しない（規則2）。
`scope: "instance"` の Module が `${projectRoot}` を使おうとするのも、その場で落とす。

### 閉じ込め（Landlock）も宣言から

以前は「shell なら実行を許す、それ以外は読み書きだけ」とコードで場合分けしていた。
新しい Module を足したとき、**その閉じ込めを書く場所が無かった**——
＝何も制限されないか、本体をまた書き換えることになる。

## 実測（完了条件）

**banto のコードを1行も変えず、宣言を1本足すだけで Python の Module が繋がった。**

隔離ホスト（ポート4198・専用データ）で：

1. まず既定の3本が宣言経由で繋がることを確認
   （AI に聞くと `banto-memory / filesystem / shell / vault` と答える）
2. Configuration に python-demo の宣言を1本追記（コードは触らない）
3. host を再起動 → ログに `[host] python-demo connected`
4. AI に `echo` tool を呼ばせる → **`echo: 宣言だけで繋がった`** が返った

回帰：core 単体 67件（宣言の単体テスト8件を含む）・**E2E 11 spec を3回連続で全通過**。

### 途中で踏んだこと

E2E が1回だけ落ちた。原因は**私が前の作業で足した検証の書き方**
——「承認した tool の結果に目印のファイル名が出る」を厳密一致で見ていたため、
AI が本文でもファイル名に触れたときに2箇所一致して strict mode 違反になった。
どちらの出現でも「tool が実際に走った」証明になるので、最初の一致を見る形に直した
（3回連続で緑を確認）。

## 残したこと（別タスク）

**Module 自身の自己申告と、宣言の突き合わせが本番で走っていない。**
突き合わせるコード（`reconcileModuleMeta`——spawn の形を左右する項目が食い違ったら
再起動を要求する）は実装済みだが、**Module 側が `dev.banto/module` を自己申告して
いない**ので、呼ぶ相手がいない。今日の見直しで見つけた「有るのに動いていない」と
同じ形なので、`docs/tasks.json` に `phase1-module-selfreport` として起票した。

**人が宣言を書く画面もまだ無い**（いまは Event Store に直接書くしかない）。
`phase1-project-modules-ui`（backlog、§10 の D 群＝画面を見ないと決まらない）。

---

## 追記：自己申告との突き合わせも入れた（2026-09-06、`phase1-module-selfreport`）

宣言を外から書けるようにした＝**人が手で書く**ようになったので、書き間違いを
機械で捕まえる必要が出た。上で「残したこと」と書いた分をそのまま続けて実装した。

### どこで名乗るかは、実測で決めた

最初は `initialize` の応答（serverInfo）に `_meta` を載せる形を考えたが、
**SDK のクライアントがスキーマで削って host まで届かない**ことを実測で確認した
（`{"name":"probe","version":"0.1.0"}` しか返らない）。仕様 §5.4 の
「`resources/list` に出てくる資源の `_meta` を banto が読む」に合わせ、
**資源の `_meta["dev.banto/module"]`** で名乗る形にした。URI は Module の自由。
AI には見せない（`visibility: "admin"`）。

4本すべてに入れた：Vault・Shell・FileSystem（TypeScript）と python-demo（Python、
公式SDKの `resource(meta=...)` にそのまま乗る）。**banto 専用のファイルは1つも要らない。**

### 方向で分ける

- **Module のほうが厳しい** → Config を直して起動し直す
- **Module のほうが緩い** → 繋がずに止める（隔離を申告で緩めさせない）
- 起動の形に関わらない差分 → 記録して続行

### 実測

隔離ホスト（4197）で両方向を確かめた。

**厳しい方向**：filesystem を「閉じ込め無し・instance に1本」という緩い宣言で置く
→ Module が「Project ごとに閉じ込めて」と名乗る → host が
`Module の申告のほうが厳しかったので宣言を直して起動し直します（scope, confinement）`
→ 正しい形で接続 → **AI が listDirectory を呼んで結果が返る**。
Event Store を見ると宣言が実際に書き換わっている
（`scope: "project"`・`confinement` 入り）——読み替えただけで済ませていない。

**緩い方向**：宣言は「Project ごとに閉じ込める」、Module は「in-process・instance で
よい」と名乗る偽物を用意 → **繋がずにエラー**：
`Module が宣言より緩い形を申告しました（scope, isolation, confinement）。
banto の隔離を Module の申告で緩めることはできません。`

### 途中で踏んだこと

最初の実装では、申告に合わせて宣言を直したあとの**起動し直しで Project を渡して
いなかった**。安全側には倒れた（無防備で起動せず止まった）が、
「閉じ込めを宣言した Module は Project 単位でしか起動できません」という
見当違いのエラーになった。**Project は常に渡し、scope の判断は宣言に任せる**形に直した。

### 測った結果

core 単体 73件（自己申告の実測5件を含む——**4本の Module を実際に起動して
名乗りを読み、同梱の宣言と一致することまで見ている**）、E2E 11 spec 全通過。

### 伝え方は別途（起票・2026-09-06）

突き合わせで繋がらなかったとき、いまは**ターンのエラー**として会話に出る
（host のログにも出る）。安全側には倒れているが、**人が発言するたびに毎回出る**し、
**1本でもその Project の会話が丸ごと止まる**。設定の問題なのに、直す場所と
見える場所も離れている。`docs/tasks.json` の `module-connect-failure-surface`
として起票した（ユーザー指摘・2026-09-06）。
