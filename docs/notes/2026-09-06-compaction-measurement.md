# 圧縮（auto-compaction）を実際に起こして数えた——F1 の要否もこれで決まった

2026-09-06。`docs/tasks.json` の `phase0-compaction-count`。
Phase 0 の完了条件「F2 の観測が実際に走り、文脈サイズと**圧縮の発火回数**を
数値で返す」のうち、発火回数だけが「記録はしているが、動いた実績が無い」
状態だった（実測でずっと 0）。ここを潰した。

## 結論

**圧縮は動く。banto は正しく数えている。**
そして **F1（しきい値の警報）は Phase 0 では要らない**——文脈は単調に増え続けない。

## 何を測ったか

隔離ホスト（ポート 4199・`BANTO_DATA_DIR` 別）に、1ターンあたり
およそ 4 万トークンの詰め物を送る台本（`/tmp/banto-measure/compact3.mjs`）を回した。

### 1. 素の構成（既定のモデル、1M 窓）——56% まで一度も発火しなかった

```
 1: total= 43,244 ( 4%) compactionCount=0
 5: total=202,140 (20%) compactionCount=0
10: total=400,760 (40%) compactionCount=0
14: total=559,670 (56%) compactionCount=0
```

毎ターンきれいに約 4 万トークンずつ増える。**200K を越えても発火しない**
（SDK の型に「1M 窓のモデルでは 200K が圧縮の境界になることがある」と
書かれていたが、そうはならなかった）。90% 近くまで押すには更に 9 ターン
必要で、確かめたいのは「発火するのか」であって「1M のときの正確な発火点」
ではないので、窓の小さいモデルに替えて測り直した。

### 2. 200K 窓のモデル（`model: "claude-haiku-4-5"` を一時的に渡した）——83% で発火した

```
1: total= 44,059 (22%) compactionCount=0
2: total= 85,288 (43%) compactionCount=0
3: total=125,927 (63%) compactionCount=0
4: total=165,891 (83%) compactionCount=0
5: total= 45,342 (23%) compactionCount=1  ★compact_boundary
     {"trigger":"auto","pre_tokens":175840,"post_tokens":10796,
      "cumulative_dropped_tokens":165044,"duration_ms":25108}
```

**窓の 8 割強で自動的に発火し、17.6 万トークンが 1.1 万まで落ちた。**
Event Store 側の記録も確認した（規則1——SSE に出たことで済ませない）：

```
seq=18 usage.recorded compactionCount=0 total=165891
seq=22 usage.recorded compactionCount=1 total=45342
```

計測用に入れた `model` の指定は測定後に戻した（`git diff` で確認済み、
`npm test` 53 件通過）。

## 効かなかった道（次に同じことをやる人へ）

「圧縮を意図的に起こす」ために先に試して、**効かなかった**もの：

- **`Options.settings` に `autoCompactWindow: 20_000` を渡す**——効かない。
  `autoCompactEnabled: true` を併記しても効かない。`maxTokens` は 1,000,000 の
  ままで、8.7 万トークンまで発火しなかった。SDK の型では「flag settings 層
  （ユーザー設定の中で最優先）に載る」と説明されているが、`settingSources: []`
  と併用しているためか反映されなかった（原因は詰めていない）。
- **環境変数でホストに窓を渡す**——プロセスに届いていなかった
  （`/proc/PID/environ` が空だった）。
- **プロンプトとして `/compact` を送る**——ただの発言として扱われる。
  文脈は 87,022 → 87,682 と増え、`compact_boundary` は出ない。
- SDK の `Query` に圧縮を起こす制御メソッドは無い
  （`interrupt` / `setModel` / `applyFlagSettings` / `getContextUsage` などはある）。

**確実なのは「窓の小さいモデルで実際に窓を埋める」**。設定で窓を縮めようと
しない。

## F1（しきい値検知）をどうするか

`docs/tasks.json` の `phase0-f1-threshold` は「圧縮が効くところを一度も
見ていないので、効かなかったとき用の保険を先に作るのは順番が逆」として
`undecided` で止めていた。その材料が出た。

- 圧縮は **自動で・窓の 8 割強で・実際に文脈を落とす**。
  つまり **文脈は単調に増え続けない**——F1 が要件になった経緯
  （前の実装で文脈が十数倍に膨らんだ）の状況は、いまの構成では再現しない。
- よって警報は「**圧縮という機構が壊れたときの保険**」であって、
  いま無いと困るものではない。Phase 0 の完了条件にも入っていない。
- **Phase 2（人が見ていない長時間の自動実行）まで待つ**ことにする。
  そこで初めて「誰も画面を見ていない間に詰まる」が現実の危険になる。
- 閾値を決めるなら、いま測った数字が土台になる：
  **自動圧縮は 83〜88% で発火する**ので、警報を出すならそれより手前
  （例：圧縮が起きるはずの水準を越えても `compactionCount` が増えない、
  という**壊れの検知**の形）。単なる「◯% を越えた」では、正常な動作にも
  鳴ってしまう。
