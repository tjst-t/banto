---
id: inc-0042
type: incident
kind: incident
origin: agent
class: test-harness
status: resolved
refs: [task-0066, task-0075, inc-0034, inc-0035, spec-environment]
---

## 内容

`npm run test:e2e` が 2件中1件落ちていた。**原因は2つあり、直したら別の1件が落ちた。**
どちらも「正しい決めが2つ、噛み合っていない」形だった。

## ① マージ前ゲートに検証環境が無かった（pipeline-merge）

```
task_failed: merge_gate_failed: verify_env_unavailable:test
  （Failed to reach module "environment-pool" at http://127.0.0.1:1/…）
```

正しい決めが2つ、後から食い違った：

- **task-0066（2026-08-07）**：`npm test` / `test:e2e` は `BANTO_ENV_POOL_URL` を
  **届かない先**（`127.0.0.1:1`）に固定する。実機の常駐サービスがテストの相手になると、
  悪くすれば**テストが実機に本物の環境を立てる**
- **task-0075（2026-08-07）**：**Kobo は検証をホストで走らせない。** 環境が無ければ
  `verify_env_unavailable` で止める（「確かめていない」と「落ちた」を別の言葉にする）

`pipeline-merge.e2e` の受け入れ条件は `verify` を持つので、両方が効いた結果
**確かめようがなくなり、ゲートは正しく落とした**。落ちていたのは実装ではなく試験の方。

**直し方**：この試験に**自分の Environment Pool を立てさせた**（`process` ドライバの
プロファイルを一時リポジトリへ置き、`environmentPoolUrl` を明示的に渡す）。
職人（`WorkerPoolService`）は既に同じ形で立てていたので、環境も同じ形に揃えただけ。
`host-uses-pool-services.spec.ts` が「自分のプールが要るテストはハーネスを立てて URL を
明示的に渡す」と書いている作法そのもの。

**採らなかった逃げ道**：受け入れ条件から `verify` を外す。通りはするが、
**「ゲートが受け入れ条件を確かめる」というこの試験の主題**を削ることになる。

## ② 実機の取り合いで、本物のLLMが時間切れになっていた（walking-skeleton）

①を直したら、今度は別の試験が落ちた。

```
Task 'task-0001' must reach 'auditing' within 180s. Current status: implementing
```

`node --test` は**ファイルを並列に走らせる**（既定 = コア数）。e2e は2本とも
**本物の daemon ＋ 本物の pi ＋ 本物のLLM**で、この機械は 4 コア。実測：

| 走らせ方 | walking-skeleton |
|---|---|
| 単体 | **64.7 秒・通る** |
| もう1本と並列 | **182 秒・時間切れ** |

①を直す前は pipeline が 90 秒で早々に落ちていたので、walking-skeleton が CPU を
独り占めできて通っていた。**片方の失敗が、もう片方を通していた。**

**直し方**：`--test-concurrency=1`。e2e だけ直列にする（受け入れ試験は速いままでよい）。
結果、2件とも通り、**suite 全体は 186 秒 → 110 秒**と速くもなった。

## 学び

**inc-0035 と同じ**：「性能を測るときは、測っている機械で他を走らせない」は、
測るときだけの話ではない。**時間で判定する試験は、隣で何が走っているかに結果を握られる。**
本物のLLMを回す試験は、それ自体が重い測定なので直列に置く。

もう1つ。**①を直すまで②は見えていなかった。** 落ちている試験が1件あると、その陰で
別の試験が「たまたま通って」いることがある。1件直して終わりにせず、直したあとに
もう一度全部回す。
