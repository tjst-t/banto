---
id: inc-0085
kind: incident
status: open
severity: major
created: 2026-08-20
refs: [task-0312]
---

# `kobo-cost-ceiling.spec.ts` が HEAD で確定的に落ちている（`npm test` が赤いまま）

## 何が起きたか（2026-08-20・task-0312 の検証中に発見）

task-0312 の変更を確かめるため `npm test` を回したところ、2903件中1件が落ちた。

```
test at tests/acceptance/kobo-cost-ceiling.spec.ts:1:13612
✖ [a2][a3][a4] 一方が上限に達しても他方の ready は進み、見送りはログに残る
  AssertionError: Expected values to be strictly equal:
  + 'failed'
  - 'planning'
  at tests/acceptance/kobo-cost-ceiling.spec.ts:512:12
```

## 自分の変更ではない（計測済み）

P6 に従って「何回中何回落ちるか」を測った。**間欠ではなく確定的**で、
**HEAD でも同じように落ちる**：

| 条件 | 結果 |
|---|---|
| task-0312 の変更あり | 3回中3回 fail |
| 変更を stash して HEAD | 2回中2回 fail |

task-0312 が触るのは `packages/banto-host/`（章立て）で、この spec は
`banto-daemon` 側。経路が交わらない。

## 全体では、これ以外にも揺れがある（別件・未分離）

`npm test` を通しで4回回したところ、**落ちた数は 1 → 2 → 1 → 1 と揺れた**。
確定的に落ちるのは上記の1件だけで、残りは回によって出たり出なかったりする。
1回目には別種の失敗も出ている：

```
errno: -13, code: 'EACCES', syscall: 'open',
path: '/home/ubuntu/ghq/github.com/tjst-t/banto/skills/audit-checklist.md'
```

作業ツリーを工場と共有しているため、**試験が読む先を工場が同時に書いている**のが
疑わしい（imp-0088 と同じ土俵）。ここは inc-0085 の本体とは別の原因なので、
分けて追う必要がある——「既存の不安定さ」で片付けず、回数で測ること（P6）。

## なぜ重いか

- **`npm test` が赤いのが常態になっている。** この状態だと「自分の変更で落ちたのか」を
  毎回 stash して測り直さないと判断できない——I1（自己申告を信じない）を守る費用が
  タスクごとに乗る
- 落ちているのが**費用の上限**の試験である点。トークン費用の調査中に見つかったので
  なおさら、ここが効いていないなら費用側の防波堤が1枚外れている可能性がある

## 未確認

- いつから落ちているか（`git bisect` していない）
- 実装が壊れているのか、試験の期待値が古いのか。`'failed'` が返っている以上、
  上限に達した側だけでなく**もう一方まで失敗している**ように見えるが、未検証
- スコープ外なので触っていない（P1）
