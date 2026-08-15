---
id: imp-0041
kind: improvement
status: resolved
severity: high
created: 2026-08-15
refs: [gate-evaluator, dentaku/task-0020, dentaku/task-0021]
---

# 依存（depends）が「merging に入った時点」で解決扱いになり、成果が main に無いまま後続が走り出す

## 起きたこと（dentaku で実測・2026-08-15）

| 時刻 | 出来事 |
|---|---|
| 05:00:07 | task-0020 監査 pass → `auditing` → `merging` |
| 05:00:07 | task-0021（`depends: [task-0020]`）の gate_evaluated が**「通過」** → `queued` → `ready` |
| 05:00:59 | task-0020 が **rebase_conflict**（index.html / src/calc.ts / src/calc.test.ts / src/main.ts）で `merging` → `implementing` へ差し戻し |
| 05:01:06 | task-0021 の職人が起動。**main は 28e2bd6 のままで task-0020 の成果は入っていない** |

task-0021 の職人は「前提の実装（sin/cos/tan・angleUnit）が無い」と気づいて質問し
paused になった。**気づかない職人なら前提を自分で再実装し、二重実装＋コンフリクトに
なっていた。**

## 原因

`packages/banto-daemon/src/gate-evaluator.ts:43` の `RESOLVED_STATES` に
`approved` と `merging` が入っている。

```ts
const RESOLVED_STATES = new Set(["approved", "merging", "merged", "evaluating", "closed"]);
```

`merging` は**終端ではない**。マージキューは rebase コンフリクトで `implementing` へ
差し戻すし、マージ前ゲートで落ちれば `failed` になる。`approved` はマージすら
始まっていない。どちらも「成果が main にある」ことを意味しない。

依存の意味は「先に**終わっている**必要がある」＝**その成果を前提にしてよい**であり、
前提にしてよいのは main に入ってからである。

## どう直すか

`RESOLVED_STATES` から `approved` と `merging` を外す。残すのは `merged` /
`evaluating` / `closed`。

後続が止まりっぱなしになる心配は要らない——ゲートは（a）定期掃きと（b）**あらゆる状態遷移の
直後**に回る（daemon.ts `runGateReeval`）ので、依存が `merged` になった瞬間に後続が
`ready` へ上がる。

## 完了の見え方

- 依存が `merging` の間は後続の gate_evaluated が `depends(unresolved:merging)` で止まる試験
- 依存が `merged` になった直後の再評価で後続が `ready` へ上がる試験
- 依存が `merging` → `implementing` へ差し戻されても後続が走り出さない試験（今回踏んだ筋そのもの）
- 全量 `npm test` が失敗0

## 直したもの（2026-08-15・枝 `fix/depends-resolves-at-merged`）

`RESOLVED_STATES` は `merged` / `evaluating` / `closed` の3つになった。外した理由
（`merging` は終端ではない・`approved` はマージすら始まっていない）はコードの注記に残した。

試験（`tests/acceptance/gate-deps.spec.ts`）：

| 試験 | 見るもの |
|---|---|
| AC-Scc9152-2-1d | 依存が `approved` でも後続は `queued` のまま（**「approved で解ける」を前提にしていた既存試験を裏返した**） |
| AC-Scc9152-2-1f | 依存が `merging` の間、後続は `queued`。gate_evaluated の blockedBy に `task-0130(unresolved:merging)` が載る |
| AC-Scc9152-2-1g | 依存が `merged` になった直後、後続が `ready` へ上がる（止まりっぱなしにならない） |
| AC-Scc9152-2-1h | 依存が `merging` → `implementing` へ差し戻されても後続は `queued` のまま。**passed=true の gate_evaluated が一度も無い**（今回踏んだ筋そのもの） |

**直す前のコードでは 2-1d / 2-1f / 2-1h が落ちる**ことを確認（`RESOLVED_STATES` を一時的に
戻して実測：8本中3本 fail）。直したあとは 8/8 通る（3回連続で確認）。

ついでに直した2つ（どちらも同じ試験の中で踏んだ）：

- `gate-deps.spec.ts` の器がマージキューを止めていなかった。`approved` / `merging` は
  まさにマージキューが拾う状態で、置いたそばから動かされる（結果が `/repos/proj-gate` の
  実在有無で変わる）。`disableMergeQueue: true` にした
- 同ファイルの `transitionTask` が `queued`→`ready` を自分で叩いており、**ゲートの自動昇格と
  競って** `invalid_transition` で落ちることがあった。目的の状態に居るなら成功として扱う

`gate-review-fixes.spec.ts` の `[fix2-b]`（部分解決で blockedBy が変わる）は dep-a を
`approved` 止まりにしていた。`approved` では解けなくなったので `merged` まで進めた。

実測：`npm run typecheck` 通過、全量 `npm test` **2181 tests / fail 0**。

## 残る問い（この起票では触らない）

`closed` を解決扱いにしてよいか。`kobo.settle(landed_elsewhere)` なら成果は main に
あるが、`kobo.abandon`（諦めた）でも closed になる。**諦めた依存で後続が走り出す**筋が
残る。畳んだ理由まで見ないと分けられないので、別建てで考える。
