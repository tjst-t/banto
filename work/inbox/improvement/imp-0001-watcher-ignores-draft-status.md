---
id: imp-0001
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: tasked
refs: [followup-directive-2026-07, spec-schemas, spec-daemon-core]
---

## 内容

watcher(task-watcher.ts)は取り込んだタスクを frontmatter の `status` 値に関わらず**常に draft→queued へ遷移**させる。schemas仕様 §1 では `status: draft` はenqueue前の状態であり、「draftで置いてPOレビューに回す」フローが実装上成立しない(フォローアップ指示書 Phase 3 のドラフト設置要件と衝突。現在bantoリポジトリ自体はdaemon未登録のため実害は未発生)。

## 選択肢(検討レイヤーで判断)

1. watcherが `status: draft` のファイルを取り込みつつ queued 遷移をスキップする(draftのままdaemonに登録)
2. watcherは `status: queued` のファイルのみenqueueし、draftは無視(検証のみ)する
3. 仕様側を「work/tasks/に置く=enqueue意思表示」と改め、draft置き場を別に定義する

P3に従い、黙ってどちらかに合わせず incident として積む。

## PO判断(2026-07-24)

**案2を採用**: watcherは `status: queued` のファイルのみenqueueし、draftは検証のみ(取り込まない)。仕様の意図(draft=未enqueue)に忠実。S75f66b のfix-Storyとして実装する。
