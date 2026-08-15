---
id: imp-0031
type: improvement
kind: correctness
origin: banto
status: backlog
resolution: ""
refs: [imp-0009, imp-0030, task-0004, spec-environment]
---

# 帳簿に保存した公開 URL が、あとから実態とずれる

## 内容

`pool.ts` は provision のときに exposer が返した `exposed.url` を
`ledger.setExposure(envId, exposed.url, …)` で**そのまま帳簿へ保存**し、`env.list` はその
保存値を読んで案内している。だから Caddy の待ち受けが変わっても——あるいは今回のように
**機構側の嘘を直しても**——**既に立っている環境の案内はずれたまま**になる。
imp-0030 の直し（スキームを実測から導く）は「これから公開する分」にしか効かない。

### なぜ同じ形の間違いか

imp-0030 で直したのは「決め打ちをやめて実測から導く」ことだった。ところが帳簿は
**一度決めた値を持ち続ける**ので、見る場所を変えれば嘘に戻る。caddy-exposer の `list` も
`expose` と同じ規則で名乗るよう直した（片方だけでは嘘が残るから）が、**同じ理由が帳簿には
まだ当たっていない**。D3（導出できる値は保存しない）の当て漏れでもある。

### 実測（2026-08-15）

- 稼働中の Caddy: `listen` = `[":80"]` / `tls_connection_policies` = `null`
- 新コード（imp-0030 後）の `caddy-exposer.list()`:
  `http://32776--env-1142455d10.banto.tjstkm.net/` → 実際に叩くと **200**
  （`https://…` は接続不可＝これまで案内していた URL）
- 一方 `env.list`（帳簿）は同じ環境を `https://32776--env-1142455d10.banto.tjstkm.net/` と
  **案内し続けている**（プール再起動後も同じ。保存値だから）

## 直す筋の候補

1. **帳簿にはホスト名と port だけを持ち、URL は読むたびに exposer が組み立てる。**
   スキームの決定を caddy-exposer の1箇所へ閉じる。D3 に素直（導出できる値を保存しない）。
   帳簿の形（`ExposureEntry.url`）を変えるので既存データの読み替えが要る。
2. **`env.list` が exposer の `list()` と突き合わせる。** 帳簿はそのままに、生きている環境は
   実態を優先して案内する。突き合わせの費用（admin API への GET）が list ごとに乗る。

## 優先度

P1。実害は「レビュー環境が開けない」ことだが、imp-0030 で**新規分は直った**ので、
残るのは公開済みの環境が期限まで間違った URL を案内し続ける分。

## 経緯

task-0004（dentaku）の検証環境 env-1142455d10 を PO が開けず発覚した一連（imp-0009 の
「決めること」3番 → imp-0030）の残り。この1件については移行を書かず（期限 09:05Z の1件だけ
のため）、開ける URL は番頭から PO へ直接伝える裁定になっている。
