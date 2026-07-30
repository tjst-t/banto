---
id: task-0015
type: task
kind: feature
title: 店（Provider）登録機構——接続情報・Tool・GUIを1単位で登録する
status: draft
parent: epic-0002
depends: [task-0012]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "packages/banto-web/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "店の登録単位が型として定義され、①接続情報 ②番頭へ提供するTool ③キャンバスへ提供するGUIカタログエントリ を1つにまとめて登録できる" }
  - { id: a2, text: "登録された店のToolが番頭のセッションへ、GUIエントリがキャンバスカタログへ、それぞれ自動で反映される（登録の口が1つで済む）" }
  - { id: a3, text: "UIは各GUIエントリについて、その店の接続情報を取得できる。コンポーネント側にエンドポイントを直書きしない" }
  - { id: a4, text: "同一kind・同一Tool名を複数の店が登録した場合、黙って上書きせずエラーになる（I2）" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定25 より。店（Kobo・将来の他領域の店・基本GUIセット）は「接続情報＋Tool＋GUI」を1つの登録単位として Banto に登録する。基本GUIセットもこの同じ仕組みに乗る組み込みの店であり、特別扱いの経路を持たない（標準ライブラリと同じ位置づけ）。

現状は、Tool（`createCanvasTools` / `createFileTools` / `createGitTools`）とカタログ（`demoCanvasViews`）を `bin.ts` がそれぞれ直に組み立てており、店という単位が存在しない。このままでは店が増えるたび `bin.ts` に配線が積み上がり、決定25 の「Banto 中核は店を登録する機構だけを持つ」が成立しない。

決定25 は「人が GUI でできることは番頭にもできる。ただし経路が異なる」とも定めている。UI は店のデータAPIへ、番頭は店の Tool へ向かう。**UI が番頭の Tool を呼ぶ構図は採らない**ため、本タスクで UI 向けの Tool 呼び出し経路は作らない。

## スコープ外

- 基本GUIセットを組み込み店として実装し直すこと（task-0016）
- Kobo を店として登録すること（Kobo接続後）
- 店の動的な追加・削除（起動時の登録で足りる。必要になってから）
- 認証（現状ローカル前提。決定19・§8の未決事項のまま）
