---
id: task-0087
type: task
kind: fix
title: 別タブでも整形して読めるようにし、整形表示に器の幅を使わせる
status: done
refs: [spec-file-browser, inc-0046]
scope:
  paths:
    [
      "packages/banto-web/src/**",
      "packages/banto-host/src/file-raw.ts",
      "docs/spec/file-browser.md",
      "tests/**",
    ]
acceptance:
  - { id: a1, text: "別タブで開いた markdown が整形で出る（原文に戻らない）" }
  - { id: a2, text: "html / 画像 / バイナリは raw のまま（ブラウザ自身が描ける種別）" }
  - { id: a3, text: "別タブの1枚は会話もキャンバスも立ち上げない" }
  - { id: a4, text: "外を指す到達先は「別タブの位置」として認めない" }
  - { id: a5, text: "整形表示の markdown が器の幅を使い切る" }
  - { id: a6, text: "npm test / npx playwright test が通る", verify: "npm test && npx playwright test" }
---

## 背景

PO報告（2026-08-09）：

> マークダウンとかを別タブで開いたときにソースファイル表示になるけど、別タブでは
> マークダウンに限らずすべてプレビュー表示にしてほしい。
> あとマークダウンのプレビュー表示だけど、謎の空白が右側にできるので全幅使ってほしい。

同じ報告に入っていた「CSS が当たらない」は [inc-0046](../inbox/incident/inc-0046-static-html-had-no-companions.md)。

## 何が起きていたか

### ① 別タブ＝原文

「別タブで開く」は `file.raw` を直に指していた。raw は**バイトをそのまま**返す口で、
md も ts も `text/plain`（§5.8.2）——**ブラウザに出しようがない**。面の中では整形で
読めていたものが、別タブに移した瞬間に原文へ戻る。

§5.8.4 は「ブラウザの別タブは Banto の外でそのファイルを見るためのもの」と書いていた。
決めとしては筋が通っていたが、**POが別タブを使う理由は「広く読みたい」だった**——
外に出したかったわけではない。

### ② 右に余る空白

`.fb-preview .markdown { max-width: 78ch }`。読み物の行長として置いたもの。

この面は**自分で幅を決められない**——キャンバスの1枚として、POが引いた仕切りの中に居る。
広げたのに本文が伸びなければ、余りは「読みやすさ」ではなく**壊れて見える空白**になる。

## 直したこと

**別タブの行き先を種別で分ける**（§5.8.4 に追記）：

| 種別 | 行き先 |
|---|---|
| markdown / mermaid / csv / diff / code / plain | 整形して読む1枚（`FilePage`） |
| html / 画像 / pdf / バイナリ | `file.raw` のまま（ブラウザ自身が既に整形して見せる） |

- `FilePage` は**会話もキャンバスもホストへの接続も持たない**。要るのは `file.read` だけ
- **描き手は面と共通**にした（`FileBody.tsx` へ切り出し）。同じファイルが面と別タブで
  違う姿を持つと、どちらが本物か分からなくなる。`FileBrowser` は 330 行ぶん軽くなった
- 位置は URL（`?file=…&place=…&ep=…`）。**到達先は受け取る側が疑う**——自分のオリジンの
  中を指す経路以外は「別タブの位置ではない」と見なす（`//host` はプロトコル相対＝外）
- 行長上限（`78ch`）は撤回。詰めたいときは仕切りを狭める側で決める

## 確かめたこと

- `tests/file-page.spec.ts`（5本・実際に描いて測る）：整形で出る／原文へ切り替わる／
  外を指す到達先を弾く／面からの行き先が種別で分かれる／**本文が器の幅を使い切る**
- `tests/acceptance/file-page-url.spec.ts`（7本）：位置の組み立てと読み取り（砦）
- 幅の試験は**先に効くことを確かめた**——`max-width: 78ch` を戻すと落ちる（戻して実測）
- `npm test` 1414本・`npx playwright test` 105本とも通る
