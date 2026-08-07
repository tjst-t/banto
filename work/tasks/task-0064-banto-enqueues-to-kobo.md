---
id: task-0064
type: task
kind: feature
title: 番頭が Kobo にタスクを積む（入口。origin と起点参照つき・決定58/62a）
status: done
parent: epic-0010
depends: [task-0048]
refs: [adr-0013, adr-0010]
scope:
  paths: ["packages/banto-daemon/**", "packages/banto-host/src/**", "packages/banto-core/src/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "番頭が会話の中から Kobo へタスクを積める。積むと Kobo の状態機械に載り、ゲートを通って自動で着手される（PO は何も操作しない）" }
  - { id: a2, text: "積むとき origin（積んだスレッド）が一緒に残る。決定35 の機構をそのまま使い、新しい通知系を作らない（決定29b）" }
  - { id: a3, text: "起点参照（そのタスクの元になった PO の指示）が一緒に残り、後から辿れる（D8）。これが無いと取次の一通が「起きたこと」しか書けない（決定58）" }
  - { id: a4, text: "積んだ結果（受理・拒否）が番頭に返る。ゲートで止まっているタスクは、止まっている理由が読める（I2）" }
  - { id: a5, text: "コードの変更は Kobo のタスクになる（決定62a）。番頭が自分で書くのは ADR・work/ の起票・引き継ぎメモまで、という線引きが SKILL に書かれている" }
  - { id: a6, text: "Kobo へ到達できないとき、黙って成功にしない。番頭に理由が返る（I2）" }
  - { id: a7, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

ADR-0013 決定58・62a。epic-0010 の2段目「入口と出口」の**入口**。

工場（Kobo）は task-0058〜0061 で回るようになったが、**番頭から積む口がまだ無い**。
いま Kobo にタスクが入るのは `work/tasks/*.md` を watcher が拾う経路だけで、会話の中で
決まったことを積むには PO がファイルを置くしかない。

## 要点

- **積むのは番頭、積まれたものを回すのは Kobo**（決定56）。番頭は進められるが飛ばせない（決定62c）
- **宛先はスレッド**（決定58）。`origin` は決定35 の機構をそのまま使う——`worker-notice.ts` が
  職人のイベントでやっているのと同じ形（`after_event_id` で取りこぼさない）を Kobo にも当てる
- **起点参照を積むときに渡す**（D8）。Kobo は経緯を知らない——積んだのは番頭だからである。
  これを怠ると、PO に届く札が「起きたこと」しか書けない

## スコープ外

- 判断を PO へ出す経路（出口）— task-0065
- ボード・レビュー面 — Phase 4（task-0049）
- 積んだ後の訂正 — task-0062（決定64）
