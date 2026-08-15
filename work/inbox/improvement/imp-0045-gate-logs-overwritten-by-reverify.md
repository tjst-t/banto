---
id: imp-0045
type: improvement
kind: observability
origin: banto
status: backlog
resolution: ""
refs: [imp-0043, dentaku-task-0020, dentaku-task-0021, dentaku-task-0023]
---

# 落ちた回のゲートログが reverify で上書きされ、間欠の追跡ができなくなる

## 内容

マージ前ゲートの検証ログは `/var/lib/banto/data/gate-logs/<taskId>/<受け入れ基準id>` に置かれるが、
**タスク id ごとの固定パス**なので、`kobo.reopen` の reverify でゲートを回し直すと
**落ちた回の全文が上書きされて消える**。

いま実際に困っている形（imp-0043 の調査中に判明）：

- 「監査は通ったのにマージ前ゲートだけ落ちる」を追うには、**落ちた回**の exit コードと標準出力が要る
- ところが手当ては reverify（回し直し）なので、**追う材料を消してから通す**ことになる
- 結果、imp-0043 では「setup が走ったか」をログではなく
  `node_modules/.package-lock.json` のバイト数と所有者から逆算する羽目になった

## 直す筋（案）

1. 保存先を **試行ごとに分ける**（`gate-logs/<taskId>/<試行番号 or 環境id>/<acceptance id>`）。
   環境の実体 id は imp-0042 で `merge_gate_evaluated.environmentId` に残るようにしたので、
   **ログの置き場と帳簿の記録を同じ鍵で引ける**形にできる。
2. 古い試行は日数か本数で刈る（環境の成果物と同じ扱い）。

## 併せて

`docker-driver.ts` の `runSetupBeforeUp` は**成功時に setup の stdout/stderr を捨てている**。
imp-0043 の直し c でログを残すようにしている（`/tmp/banto-docker-driver-logs/<task>-setup-*.log`）が、
本来は gate-logs 側と同じ場所・同じ寿命で残るべき。

## 経緯

2026-08-15、imp-0043（マージ前ゲートの検証環境に node_modules が無い件）の調査で職人が指摘。
番頭が起票した。
