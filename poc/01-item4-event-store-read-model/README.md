# 01-item4-event-store-read-model

**捨てる。本実装に流れ込ませない。** 残す価値があるのは規則3のプロパティ試験の
「形」だけ（`rule3.test.mjs`）。

## 問い

`docs/specs/v4-architecture.md` §10 item 4——Event Store の「畳んだ状態を安く得る」
方式。候補は (a) `state()` ＋ 追記時の増分適用、(b) 定期的なスナップショット。
v3 の実測（§9）「読み取り API が全件配列を返すので、状態が欲しい全員が全件 fold
する」を再発させない形を決める。

## 偽物を本物に寄せた点

- `fold`/`apply` は全 arm で完全に同一（toy な State）。arm ごとに fold の出来が
  違うと、read model の比較でなく fold の出来の比較になる
- フィクスチャは v3 実測の実データ分布（p50 310B/p90 743B/p99 3247B）に寄せ、
  `tool.result` だけ 10% の確率で 15–25KB の重い尾を持たせた（件数だけの外挿は
  tool 結果のサイズ分布の変化を隠す）
- cold start は**毎回新しい子プロセス**で測る（`shared/bench-cold-start.mjs`）
  ——同一プロセス内のループは JIT・page cache がウォームで、cold start を測れない

## ガードを外したら通ってしまうことの確認

- **並行 append を直列化しない版で実際に走らせた**——10件では「たまたま通った」
  だけで、200件にしたら `shared/jsonl.mjs` の fd キャッシュがレースし、fd が
  リークすることを実際に確認した（`Warning: Closing file descriptor N on
  garbage collection` が大量発生）。ガードなし（直列化なし）で本当に壊れることを
  見てから、`shared/queue.mjs` の直列化キューを足した
- **`coveredBytesHash` の検証を外した版と入れた版を両方測った**——検証を入れると
  1M件で cold start が 3.4秒（snapshot の意味が消える）、外すと 27ms。
  「速くなった」を鵜呑みにせず、外した版が本当に改竄を見逃すことを
  `rule3.test.mjs` の該当テストで確認した上で、検出方法を
  `verifyIntegrity()`（オプトインの重い検査）に分離した

## 結果（数値、2026-08-30、Node v24.18.1、この機械）

### Gate 判定

| Gate | 閾値 | 実測 | 判定 |
|---|---|---|---|
| **G0** 1リクエストあたりの全件 fold 回数 | = 0 | Arm B/C: 常に0（`open()` で1回のみ、`append` は増分）。Arm A: 呼ぶたびに1回 | **構造で決まる。Arm A（`read(): Event[]`）を落とす** |
| **G1** cold start → 最初の `state()` @10^6 | ≤500ms | Arm C（snapshot あり）: **27ms**。Arm C（snapshot なし）/Arm B: **3.46〜4.47秒** | **snapshot 無しでは大幅に外れる。snapshot は必須** |
| **G2** GC後常駐 @10^6 | ≤256MB | Arm C（snapshot あり）: **53.7MB**。Arm A（全件配列）: **1,437MB** | **Arm C だけで十分満たす。keyed projection（Arm D）は不要** |
| **G3** append→購読者 p95 | ≤16ms | **0.93ms**（n=50） | 余裕を持って満たす |
| **G4** append（fsync込み）p99 | ≤10ms | **≤1.66ms**（n=50, max） | 余裕を持って満たす |
| **G5** 0からの再計算 @10^6 | ≤10s | **3.99秒** | 満たすが、後述の条件が付く |

### 規模別 cold start（予測どおり、888件では差が出ない）

| n | Arm C（snapshot） | Arm A（全件配列） |
|---|---|---|
| 888（今の実態） | 24.6ms / 53.6MB | **21.9ms** / 56.2MB（**Arm A の方が速い**——事前に「差が出ない」と予測していたが、実際には僅差で逆転していた） |
| 1,000 | 25.9ms / 53.3MB | 25.1ms / 56.2MB |
| 10,000 | 26.5ms / 53.3MB | 80.1ms / 92.5MB |
| 100,000 | 32.0ms / 53.6MB | 544.9ms / 297.1MB |
| 1,000,000 | 27.1ms / 53.7MB | 5,365.1ms / 1,437.3MB |

Arm C はスケールに対してほぼ定数（27〜32ms）。Arm A は 10万件を超えたあたりから
線形以上に悪化する。

### 実測で見つかった、設計を訂正した点

**`coveredBytesHash` を起動時の必須検証にすると、スナップショットの効果を
検証コスト自身が食い潰す。** ログの `[0, cursor)` バイト範囲をハッシュするのは
O(n) の I/O で、1M件・1GB で 3.4秒かかった——snapshot が短縮したかった cold
start を、そのまま検証コストが埋め合わせてしまう。**したがって起動時の必須
チェックは `foldVersion` と `cursor` の整合だけに絞り、ハッシュによる改竄検出は
`verifyIntegrity()`（O(n)、明示的に呼ぶ、遅くてよい）に分離した。** トレードオフを
隠さない：軽量な起動では snapshot の `state` フィールドだけの改竄を検出できない
（`rule3.test.mjs` の該当テストがこの制約を検証している）。

## 仕様書のどの行を更新したか

- `docs/specs/v4-architecture.md` §2.1（口の形・スナップショットの可否・起動時
  検証とオプトイン整合性検査の分離・append の直列化）
- `docs/specs/v4-architecture.md` §9（全件配列を返す読み取り API は常駐メモリも壊す、
  を追記）
- `docs/specs/v4-architecture.md` §10 item 4 を打ち消し

## やらなかったこと（省略の理由）

- **node:sqlite との比較（Arm E、物差し）は省略した。** 当初はボトルネックが
  JSONL のパースだと決め打ちしないための対照として計画したが、実測で
  ボトルネックが `coveredBytesHash` の検証コスト（自作コード側）だと特定できた
  時点で、JSONL 自体の読み書き速度を疑う理由が無くなった。省略した、が
  「測らなかった」という事実は隠さない
- **keyed projection（Arm D）は実装しなかった。** G2 が Arm C（単一 State）だけで
  余裕を持って満たされたため、trip 条件（計画時点の想定）に当たらなかった

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。`rule3.test.mjs` の**試験の形**（規則3を
毎操作後に主張する・別プロセスでの再開・並行 append・`at` の逆行・torn レコード・
毒入り snapshot）だけは本実装で再実装する価値がある。
