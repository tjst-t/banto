---
id: task-0100
type: task
kind: improvement
title: "道具定義を人が書き直す（短く・例つき・平ら）— ADR-0019 決定84-1/2/3"
status: queued
refs: ["adr-0019", "inc-0057", "inc-0056"]
scope:
  paths:
    - "packages/*/src/**"
    - "docs/adr/adr-0019-inventory-and-presentation.md"
acceptance:
  - { id: a1, text: "番頭に提示する道具（PRESENTED_TOOL_NAMES の56本）の description が、目的1行＋入出力例の形になっている" }
  - { id: a2, text: "道具定義の合計文字数が、着手前より 30% 以上減っている（提示分）" }
  - { id: a3, text: "引数の値を英語/識別子で埋めることが、値を取る道具の説明文に明示されている" }
  - { id: a4, text: "書き直しの前後を、実ログ由来の題材で対比較して測っている（n≥60・McNemar）。悪化していないこと" }
  - { id: a5, text: "npm test / npm run typecheck が通る" }
review:
  policy: manual
---

## 背景

ADR-0019 決定84 は「道具定義は**短く・例つき・平ら**」と決めたが、**1（例を付ける）・
2（短く）・3（スキーマを平ら）は実装を保留**した。理由は実測（2026-08-12・条件C）:

**機械的な圧縮は害があった。** 「説明文を第一文へ切り詰め、入れ子の説明を落とす」を
100個へ一律に掛けたところ、**存在しない道具名の呼び出しが6件**出た（他の条件は0件）。
「何か呼んだ」率も 75.0% にとどまり、散文の一覧だけを足した条件F（100%）に負けた。

短くすること自体の筋は悪くない——arXiv:2602.14878（856道具の実証）は
「説明を全面強化すると成功率は中央値 +5.85pt だが、実行ステップが +67.46% 増え、
16.67% のケースで悪化する」として compact 版を推奨している。**問題はやり方**で、
一律の機械処理ではなく**道具ごとに人（職人）が書き直す**必要がある。

いちばん効きそうなのは**入出力例**（決定84-1）。Anthropic の内部測定で
`tool use examples improved accuracy from 72% to 90% on complex parameter handling`。
API 機能に依存せず説明文に数行足すだけなので、ローカルの DeepSeek でも成立する。

## やること

1. `PRESENTED_TOOL_NAMES` の56本について、description を「**目的1行＋入出力例**」に書き直す
   - 長いものから: `env.verify` 2,060字・`worker.delegate` 1,784字・`inbox.post` 1,768字・
     `env.provision` 1,616字・`memory.save` 1,524字・`memory.search` 1,331字・`canvas.show` 1,271字
   - **盛らない。** 手順は SKILL 側へ逃がす（段階的開示）
2. 値を取る引数に「**英語/識別子で埋める**」を明示（arXiv:2601.05366 の
   `parameter value language mismatch` が dominant failure mode。banto は PO が日本語・
   道具 I/F が英語という、この故障の型そのもの）
3. 入れ子スキーマ・`anyOf`/`oneOf` を平らにできるものは平らにする
   （DeepSeek の `strict` は「全プロパティ required・`additionalProperties: false`」を要求する）
4. **書き直しの前後を測る。** 装置は
   `/tmp/.../scratchpad/harness.py` と同じ形（実ログから機械的に抽出した題材・条件間で対比較）。
   **題材を自分で選ばない。合成データで「直った」と言わない**

## 確かめていないこと

- スキーマの平坦化が効くかは**未測定**。3を独立の条件として測ること
- 56本すべてを書き直す必要があるか。呼び出し上位（`worker.*` 42%・`file.*` 25%）から
  始めて、効き目が頭打ちになる点を見るほうが安い
