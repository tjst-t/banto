---
id: task-0061
type: task
kind: fix
title: Kobo の衛生（モデル・待ち受け・帳簿の保護・bin 衝突）
status: done
parent: epic-0010
refs: [adr-0013, adr-0011, adr-0010]
scope:
  paths: ["packages/banto-daemon/**", "packages/banto-cli/**", "packages/banto-host/src/bin.ts", "packages/banto-host/src/modules/workspace.ts", "deploy/**", "tests/acceptance/**"]
acceptance:
  - { id: a2, text: "Kobo が既定で 127.0.0.1 だけを待ち受ける。広げるには明示を要求し、広げたときは起動ログに警告を出す（決定40）" }
  - { id: a3, text: "Kobo のデータ置き場が番頭ホストの protectedPaths に入り、番頭は file.write でそこへ書けない。場所として登録されているかどうかに依存しない（決定63）" }
  - { id: a4, text: "bin 名 banto の衝突が解消する（banto-cli と banto-host のどちらが起動するか環境依存にならない）" }
  - { id: a5, text: "番頭が Kobo の帳簿へ書けないことを検証するテストがある。砦を外すと本当に書けてしまうことも一度確認する" }
  - { id: a6, text: "npm run build・npm run typecheck・npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

ADR-0013 の衛生項目をまとめたもの。いずれも単独では小さいが、放置すると配線後に効いてくる。

- **待ち受け**：Kobo は `listen(port, "0.0.0.0")` で全インターフェースに出ており、`http-server.ts` には `Authentication: none` と明記されている。決定40 で番頭側を 127.0.0.1 に閉じた隣に無認証の口が開いたままになる
- **帳簿の保護**：番頭が Kobo のデータ置き場へ書けないことが、いま「場所として登録していないから」という**配置任せ**になっている。機構で担保する（決定38b と同じ考え方）
- **bin 衝突**：`bin: "banto"` が banto-cli（Kobo のクライアント）と banto-host（番頭）の両方にある

## モデルについて（ここでは扱わない）

当初この task に「モデルを LlmCatalog から解決する」を入れていたが、**それは Kobo が番頭ホストへ
依存する形**だった（決定27b の依存の逆転）。決定60a のとおり **Kobo は tier だけを渡し、解決は
Worker Pool が行う**ため、この項目は task-0060 へ移した。

## 補足

費用の上限は **ADR-0013 決定67**（PO裁定 2026-08-06）で「Kobo が持ち、積む時点で拒否」と
決まり、**task-0063** として起票した。

`bin` の衝突は `@banto/cli` を **`kobo`** へ改名して解いた（`banto` は番頭のもの——PO が打つのは
番頭で、こちらは Kobo の帳簿を覗く道具）。実測では `node_modules/.bin/banto` が
`@banto/cli` を指しており、**衝突は番頭にとって不利な向きで解決していた**。
