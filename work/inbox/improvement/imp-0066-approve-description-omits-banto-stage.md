---
id: imp-0066
title: kobo.approve の説明文が review へ来る理由から `banto` を落としている——「banto は自動着地する側」と誤読される
status: inbox
kind: improvement
origin: 枝「説明文と設定の訂正」(thread-120)。task-0152（review: banto）が59秒で approved になったのを「機構が自動で通した」と番頭が誤読し、PO にそう報告した。帳簿とコードを当たったところ機構は名前どおりに動いており、誤読の出どころは説明文だった
refs:
  - packages/banto-daemon/src/kobo-tools.ts
  - packages/banto-host/src/kobo-notice.ts
  - packages/banto-daemon/src/review-policy.ts
  - docs/spec/daemon-core.md
  - task-0152
created: 2026-08-16
---

## 何が食い違っているか

`kobo.approve` の説明文は、いまこう言っている：

> **既定は自動着地**（realign 第3便）なので、ここへ来ているのは条件を満たさなかったものだけ
> ——刻みが無い／契約に検査コマンドが1本も無い／**`manual` や `po` を名乗っている**、のいずれか。

**`banto` を名乗っている場合が抜けている。** `review: banto` のタスクは、刻みも検査コマンドも
揃っていても review-ready へ来る（`resolveReviewStage` が宣言をそのまま返し、`autoLandBlockers` は
`stage === "auto"` のときしか呼ばれない）。列挙に無いということは、読んだ側は
**「`banto` は自動着地する側だ」**と受け取る。

`kobo.amend` の説明文は「`review` は `po` > `banto` > `auto` の順に厳しく」と書いており、そちらは
実態と合っている。**2つの説明文が互いに矛盾している**ので、どちらを信じるかで理解が割れる。

判断待ちの札（`kobo-notice.ts`）にも同じ穴がある。「**なぜあなたに来たか**」の節は、自動着地の
条件を満たさなかったとき（遷移理由が `自動着地の条件を満たさない: …`）にしか出ない。
`banto` を名乗って来たタスクには理由が何も書かれず、番頭は「なぜ自分に来たのか」を
自分で調べ直すことになる。

## 実害

番頭（私）が誤読し、**PO に「`review: banto` を指定しても番頭を通らずに通ってしまう」と
報告した**。機構の欠陥ではないものを欠陥として伝えたので、PO の判断材料が汚れた。
訂正は幹から PO へ入れた（2026-08-16）。

## どう直すか

**挙動は変えない。説明文だけを実態に合わせる。**

- `kobo.approve` の説明文の列挙に **`banto` を名乗っている**を加える（`manual` は
  `banto` への読み替えであることも書ける）
- 判断待ちの札に、**`banto` を名乗って来た場合の一行**を足す（「このタスクは
  `review: banto` を名乗っているので、条件に関わらずあなたが一次受けします」）

## この件の判別法（次に同じ疑いが出たときは、帳簿だけで決着が付く）

**「自動着地したのか、人が通したのか」は帳簿の遷移だけで判別できる。**

| 何が起きたか | 帳簿に出るもの |
|---|---|
| **自動着地**（realign 第3便） | `auditing → merging` を理由 **`audit_passed:auto`** で1回。`review_opened` も `task_approved` も**書かない** |
| **人（番頭）が通した** | `auditing → review-ready`（`audit_passed:banto`）→ `review_opened:banto` → `task_approved` → `approved_by:banto` |
| **自動着地の条件を満たさず落ちた** | `auditing → review-ready` を理由 `audit_passed:auto→banto（自動着地の条件を満たさない: …）` で |
| **PO が通した** | `task_approved` の `approvedBy` が `po`、`via`（どの画面から来たか）付き |

**`approved_by:banto` を書ける口は `kobo.approve` 道具ひとつだけ**である
（`by: "banto"` を渡す実装はそこだけ。HTTP の口は `by: "po"` で `via` 必須、
自動承認の実装は存在しない——`autoApprove` の類は grep で0件）。したがって
`approved_by:banto` が帳簿にあるなら、**必ずどれかの番頭セッションが `kobo.approve` を
呼んでいる**。呼んだ覚えが無いなら、疑うべきは機構ではなく**別の枝**である
（task-0152 の実例：観測していた枝 thread-118 ではなく、機構が T3 で自動的に開いた
用件枝 thread-119 が、差分と試験の中身を自分で確かめたうえで通していた）。

`review.policy` の解決順（`resolveReviewStage`）も併せて覚えておく：
`governance: true` → `po_required_paths` に触る → 宣言（`auto` / `po` / `banto` /
旧称 `manual`→`banto`）→ 層B の `review.default_policy` → Kobo の既定（`auto`）。
**厳しい側の上書きが必ず勝つ。**
