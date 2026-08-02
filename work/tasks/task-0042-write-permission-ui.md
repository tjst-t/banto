---
id: task-0042
type: task
kind: feature
title: 書き込み許可の要求と承認（番頭が頼み、POが画面で許す）
status: done
parent: epic-0009
depends: [task-0041]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/src/**", "packages/banto-web/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "番頭が書き込み範囲の拡大を要求できる。要求は保留として記録され、番頭は許可を自分で与えられない" }
  - { id: a2, text: "承認・拒否の口は internalTools（GUI から HTTP で叩く）で、番頭には渡さない。番頭が「許可されました」と偽れない" }
  - { id: a3, text: "キャンバスGUI で保留中の要求と現在の許可の一覧が見え、その場で許可・拒否できる" }
  - { id: a4, text: "許可するとホストが設定を書く。番頭は設定に触らない" }
  - { id: a5, text: "番頭が canvas.open でこのGUIを出せる（会話の流れの中で承認できる）" }
  - { id: a6, text: "既存の acceptance / e2e が通り、npm run build・typecheck・test・build:web が通る" }
---

## 背景

ADR-0010 決定38(c)(e)。task-0041 で書き込み自体は動くが、許可は設定ファイルを手で書く必要がある。PO が事前に全リポジトリを設定しておく手間をなくし、**必要になった場面で頼んで、その場で許せる**ようにする。

職人が `worker.ask` で番頭に聞き、番頭が答える（決定29b）のと同じ構図を1段上に適用したもの。**番頭は要求するだけで、書くのはホスト。**

## 実装メモ

- **新しい機構は要らない。** 承認の口は `internalTools`（studio のデータ口・Worker Pool の `worker.report` と同じ枠＝「GUI や別プロセスからは呼べるが番頭には渡さない」）。これにより番頭が承認を自分で呼べないことが機構的に保証される
- 番頭が `canvas.open` でパネルを出せば、**会話の流れの中で承認が起きる**。決定2「キャンバスはその時の相談内容に応じて番頭が出し入れするコンテンツ」の想定どおりの使い方
- **現在の許可の一覧を同じ画面に出す。** 決定38(e) の「じわじわ広がるのを見えるようにする」がこれで片付く

## スコープ外

- 書き込みそのもの（task-0041）
- 許可の有効期限・自動失効。まず出す
