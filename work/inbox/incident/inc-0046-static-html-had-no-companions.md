---
id: inc-0046
type: incident
kind: incident
origin: po
class: ui-behavior
status: resolved
refs: [spec-file-browser, task-0087]
---

## 内容

PO報告（2026-08-09）：

> GUIのファイルブラウザでHTMLを見たとき、同じフォルダとかから配信するCSSが適用されない。

**「HTML を静的配信扱いにしてほしい」（PO要望 2026-08-08・spec-file-browser §5.8 の要望②）は、
半分しか立っていなかった。** HTML そのものは `text/html` で配れていたが、その HTML が
連れて行く `.css` は `text/plain` で配られていた。

## 原因

型の**許可表**（§5.8.2）に載っていたのは html / 画像 / pdf だけで、**表に無いものは
`text/plain`**。そこへ `X-Content-Type-Options: nosniff` が掛かる。

この2つが噛み合うと、ブラウザは `text/plain` で来た `<link rel="stylesheet">` を
**意匠として使うことを拒む**（nosniff の効き目そのもの）。読み込みは成功していて、
中身も正しく届いていて、当たらない——**開発者コンソールを開かないと理由が見えない**形で
壊れていた。

同じ理由で、外に置いた `.js`・フォント・`.json` も届かない。つまり「静的配信」で
POが期待するもののうち、**HTML 1枚に閉じたものしか動いていなかった**。

`file.raw` を作ったとき（§5.8）に見ていたのは「HTML をどう隔離するか」で、
**HTML が1枚では立たないこと**が抜けていた。表の「そのほか → text/plain」は
「md も ts も生で読ませるならこれで足りる」という**読ませる側の理屈**で、
配信の連れには効かない理屈だった。

## 直したこと

許可表に **HTML の連れ**を足した（css / js / mjs / json / woff2 / woff / ttf / otf）。

**隔離は緩んでいない。** スクリプトが動くのは §5.8.3 の不透明なオリジンの中だけで、
そこでは**元から inline の `<script>` が動く**——外に置いた `.js` を拒む理由が無い。
連れを直に開いても `allow-scripts` は付かない（緩めるのは HTML と PDF だけ）ので、
そこから Banto を触る足場にもならない。

**svg は据え置き。** `<img>` の連れとしてだけでなく**それ自体を文書として開ける**ので、
ここを緩めるのは §5.8.3 の隔離に触る決め＝D1。HTML の中の `<img src="chart.svg">` が
出ないのは、この決めの副作用として残る（PO裁定が要る）。

## 確かめたこと

`tests/acceptance/file-raw.spec.ts` に3本足した（20本）：

- CSS が `text/css` で配られる
- JS・フォント・JSON も型どおり配られる
- **連れは不活性のまま**——`sandbox` が付き `allow-scripts` は付かず、`nosniff` も残る

「表に無い型は素のテキストに落ちる」は `.js` で見ていたので `.rst` に替えた
（`.js` は表に載ったため、あの試験は**表の外を見ていない**状態になっていた）。
