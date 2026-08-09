---
id: inc-0040
type: incident
kind: incident
origin: agent
class: spec-drift
status: open
refs: [spec-canvas-ui, spec-file-browser, spec-design, adr-0010]
---

## 内容

**狭い画面の規約が、共通部品を使わない当たりには一度も効いていなかった。**（P3）

`spec-canvas-ui` §3 は「狭いときは押せるものを 38px 以上に広げる」と決めている。
実体の `views.css` はその通り書かれているが、**列挙してあるのは `.cv-*`（共通部品）だけ**。

```css
@container canvas (max-width: 760px) {
  .cv-btn { min-height: 38px; }
  .cv-iconbtn { width: 38px; height: 38px; }
  .cv-row { min-height: 42px; }
  .cv-input, .cv-select, .cv-search-input { min-height: 38px; font-size: var(--t-head); }
  ...
}
```

面が自分で組んだクラスはこの列挙に入らない。ファイル閲覧（`file.browser`）を 390×780 で
実測したところ：

| もの | クラス | 規約 | 実測 |
|---|---|---|---|
| 一覧の行（この面で最も押すもの） | `.fb-entry` | 38px 以上 | **32px** |
| 「隠しファイルも表示」 | `.cv-toggle` | 38px 以上 | **21px**（中の枡は 15px） |
| `[整形\|原文]` の各片 | `.cv-seg-opt` | 38px 以上 | **32px** |
| パンくずの各段 | `.fb-crumb` | 38px 以上 | **34px** |

`.fb-entry` は `views.css` 全体で**どの container query にも一度も現れない**。
`.cv-toggle` は狭いとき「字を小さくし、枡を 18px にする」規則だけがあり、当たり自体は広げていない。

## なぜ気づかなかったか

- **規約が「値」ではなく「列挙」で書かれている。** 新しい面がクラスを1つ足すたびに、
  列挙側にも足さないと漏れる。足し忘れても何も落ちない
- **機械の見張りが無い。** `tests/mobile-layout.spec.ts` が見ているのは
  「タブ列が居座るか」「面ごと横へずれないか」の2点で、**当たりの大きさは誰も測っていない**
- 広い画面では 32px でも押せてしまうので、開発中に踏まない

## 併せて見つかった同種の漏れ

同じ「共通規約が面には届いていない」型のもの。

- **`spec-design` が `PlacePicker` で禁じた `direction: rtl`** が `.fb-file-path` /
  `.fb-hit-path` に残っている（`.place-row-sub` だけ直っていた）
- **トークンに無い色**：選択行の末尾を消す `rgba(128, 128, 128, 0.22)` が
  `cv-row` / `fb-entry` / `gv-*` / `rm-*` の 6 箇所。強調行の地 `rgba(224, 169, 90, 0.2)` が 1 箇所

## どう直すか

`spec-file-browser` §10 に是正の一覧、`spec-canvas-ui` §3 / §5.1 に共通側の決めを書いた。
**この incident が閉じる条件は、面の CSS を直すことではなく、次に同じことが起きないこと**：

1. 狭いときの当たりの大きさを**測るテスト**を置く（`tests/mobile-layout.spec.ts` の隣）。
   キャンバスに開ける面を順に開き、押せる要素の高さを実測して 38px 未満を落とす
2. 列挙をやめられるところは値へ寄せる（面が独自クラスを足しても既定で満たすように）

1 が入るまでは、面を足すたびに手で測ることになる——それは仕組みではないので、open のままにする。

## 2026-08-08 時点（半分だけ入った）

**面の側は直した。** `.fb-entry` 44px・`.cv-chip` / `.cv-seg-opt` 38px・`.cv-search-input` の
余白詰め（19px の字に 8px の余白で 51px になっていた）・`direction: rtl` の除去・
トークンに無い色 6 箇所の置き換え。

**測るテストも置いた**が、いま開くのは**ファイル閲覧の1面だけ**
（`tests/mobile-file-browser.spec.ts`「一覧の行は 44px、そのほかの当たりは 38px 以上」）。

```
.cv .cv-btn:not(.is-small), .cv .cv-chip, .cv .cv-seg-opt,
.cv .cv-iconbtn, .cv .cv-search-input, .fb-crumb, .place-btn
```

**残っているのは、これを全部の面に回すこと。** カタログに並ぶ面を順に開いて同じ物差しを
当てれば、面が増えても足し忘れが落ちる。それが入るまでは open のまま
——1面だけ測っているのは仕組みではなく、その面を直した記録でしかない。
