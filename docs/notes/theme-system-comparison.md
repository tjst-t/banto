# 世の中のテーマ機構と、banto の「形の層」の比較

> 2026-08-06。ADR-0012（家は形の層を持てる／面のクラス名を契約とする）を決めた直後に、
> PO の指示で調べたもの。**決定を覆すための調査ではなく、どこに立っているかを知るための調査。**

## 世の中はどうやっているか

調べた範囲では、テーマに何を許すかは大きく3段に分かれる。

### ① 名前つきの値だけを許す（セレクタを書かせない）

**VS Code** がこれ。テーマは `statusBar.background` や `editor.background` のような
**色ID の登録簿**に値を入れるだけで、セレクタは1行も書かない。アイコンのテーマも
「1色のグリフ」に限られ、色は色テーマ側が決める。

- 利点：**内部の DOM をいくら組み替えてもテーマは壊れない**。themable な場所が登録簿として
  明示されているので、どこが変えられるかも読める
- 代償：**アプリ側が themable な場所を全部あらかじめ宣言しないといけない**。
  登録簿に無いものは、どうやっても変えられない

### ② 変数を本筋にし、セレクタは逃げ道として残す

**Obsidian** がこれ。v1.0 で 400 以上の CSS 変数を足し、**セレクタで書く方式から明示的に
移行**した。移行の理由がそのままこの方式の教訓になっている：

> テーマを保守するときの最も多い問題は、Obsidian の新しい版でクラス名や入れ子が変わった
> 結果としてセレクタが壊れることである。（Theme guidelines）

いまも複雑なセレクタを書けるが、公式の指針は「常に組み込みの変数を優先せよ」。
`obsidian-style-settings` のように、変数を UI として露出する仕組みまで生えている。

### ③ 公開する部分を明示して、そこだけ触らせる

Web Components の **`::part()`**。部品の作者が `part="..."` を付けたところだけ、外から
名指しできる。仕様の狙いがはっきり書かれている——「使う側に、部品の内部を知らせない・
知る必要のない**安定した見た目のAPI**を出す」。

> 露出した part はすべて、あなたが支え続けると約束した API である。だから意図して選べ。

同じ発想は別の畑にもある。**Shopify** はアプリがテーマのファイルへスニペットを貼り込む
やり方（＝ホストのコードを直に触る）から、**theme app extension**（ホスト側が用意した
差し込み口）へ移した。理由は同じで「テーマが更新されると壊れるから」。

### 値の組み方（どの段でも共通の定石）

トークンは **primitive（`--blue-600`）→ semantic（`--color-interactive`）→
component（`--button-background`）** の3層に分ける。部品は semantic か component だけを
参照し、primitive を直に見ない。**component トークンは「どうしても部品ごとの上書きが要る
細い一部」にだけ足す**——増やすと、テーマを増やしたときに追随しなくなる。

## banto はどこに立っているか

| 観点 | 世の中の定石 | いまの banto |
|---|---|---|
| 値の層 | primitive → semantic → component の3段 | **1段**（`--ai` `--paper-1` は既に semantic。primitive が無い） |
| 家が触る先 | 名前（色ID／変数／part） | **面のクラス名（セレクタ）** |
| 内部構造を組み替える自由 | 保たれる | **失われる**（決定52 で意図的に手放した） |
| 壊れたときの検知 | 基本できない（Obsidian の一番の苦情がこれ） | **試験で検知できる**（`tests/theme-shape.spec.ts`） |
| 部品ごとの上書き口 | component トークン／`::part()` | 無い（層が直にセレクタを書く） |

**結論：banto はいま ② の「セレクタ」側に立っている。**
Obsidian が明示的に離れた場所であり、`::part()` が置き換えるために作られた場所でもある。

ただし、素朴な ② よりは手当てがしてある：

- 家の層は `:root[data-theme^="…"]` の下に閉じ、**他の家へ漏れていないことを試験で見ている**
- **値は層に書かない**（`--bar-*` のようにトークンへ置く）。層は組み方だけを持つ
- **契約の一覧を層そのものから導く**ので、表とコードがずれない。名前が消えれば名指しで落ちる
  ——これは①②③のどれもやっていない（世の中は「壊れたら直す」で回している）

そして実装中に、**期せずして定石に合流した箇所**がある。状態行の色を層に直書きしていたのを
`--bar-bg` / `--bar-ink` / `--bar-on` / `--bar-raise` としてトークンへ出した件で、これは
まさに **component トークン**（「部品ごとの上書きが要る細い一部」）である。出した結果、
層からは色が消え、**暗色で状態行が白く反転する不具合まで一緒に直った**。

## ここから何をするか（案）

決定52（クラス名を契約とする）を覆さずに、リスクだけ削れるものから並べた。
**1〜3 は PO 裁定（2026-08-06）により実施済み**。

1. ✅ **`--bar-*` の成功を一般化した。** 層に繰り返し出ていた形を部品トークンへ昇格
   （`--h-tabbar` / `--h-tab` / `--face-margin` / `--face-radius` / `--bubble-radius` /
   `--banto-mark*` / `--banto-indent` / `--key-size`）。
   結果、`.msg--banto` `.msg--po` `.canvas-body` が契約から外れた
   ——**いちばん traffic の多い名前**が抜けた
2. ✅ **持ち込みの家をトークンのみに絞った**（ADR-0012 決定54）。受け取った CSS を
   ブラウザの構文解析にかけ、`:root` に変数を置く規則以外を落とす。落としたものはログに出す
3. ✅ **契約に版を付けた**（決定55）。`themes.json` の `contract` が画面側の
   `THEME_CONTRACT` と合う家だけを載せる。**版はトークンの名前の版**
   ——持ち込みが当てにしているのは名前だけなので、そこに掛ける
4. （もし ② から離れたくなったら）**面に明示の印を付ける。** `.shell-topbar` のような
   意匠用のクラスではなく、`data-part="topbar"` のような**契約専用の印**を面に打ち、
   層はそれだけを名指しする。`::part()` の考え方を Shadow DOM 無しで真似るもので、
   クラス名の付け替えが自由に戻る。決定52 を差し替える話になるので、やるなら ADR から

### 1〜3 を入れた後の立ち位置

| 観点 | 世の中の定石 | いまの banto |
|---|---|---|
| 値の層 | primitive → semantic → component | semantic ＋ **component**（形の役を名付けた） |
| 家が触る先 | 名前 | **持ち込み＝名前だけ**／組み込み＝名前＋クラス名 |
| 内部構造の自由 | 保たれる | **持ち込みに対しては保たれる**。組み込みに対してだけ縛られる |
| 壊れたときの検知 | 基本できない | **試験で検知**（組み込みの層のみ。持ち込みは縛りが無いので不要） |
| 版 | （VS Code は色IDの追加のみで破壊的変更を避ける） | **`contract` で明示**。合わない家は載せない |

つまり **② の弱点（外の人の家が黙って壊れる）は塞がり、残る結合は
リポジトリの中だけ**——そこには試験がある。

## 出典

- [Obsidian 1.0 theme migration guide](https://obsidian.md/blog/1-0-theme-migration-guide/)
- [Obsidian Theme guidelines](https://docs.obsidian.md/Themes/App+themes/Theme+guidelines)
- [VS Code: Theming（Extension API）](https://code.visualstudio.com/api/extension-capabilities/theming)
- [VS Code: Themes（色のカスタマイズ）](https://code.visualstudio.com/docs/configure/themes)
- [CSS Shadow Parts Module Level 1（W3C）](https://www.w3.org/TR/css-shadow-parts-1/)
- [MDN: CSS shadow parts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Shadow_parts)
- [Shopify: About theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions)
- [The developer's guide to design tokens and CSS variables（Penpot）](https://penpot.app/blog/the-developers-guide-to-design-tokens-and-css-variables/)
- [Design tokens usage guide（GitLab Pajamas）](https://design.gitlab.com/product-foundations/design-tokens-using/)
