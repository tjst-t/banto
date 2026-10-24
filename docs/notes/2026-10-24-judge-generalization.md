# 判断役の一般化(2026-10-24)

## 背景

番頭(Backlog #505、v4-architecture.md 旧§4.5)は2026-10-24にユーザー決定で廃止した(経緯は
docs/notes/2026-10-24-supervisor-retirement.md)。廃止の理由は、メタ Project(§4.6)との役割重複と、
「banto のコアは実現したいことに対して最小限の機能セットにしたい」というユーザー方針。

番頭の実コードは main・release の両方にまだ残っている。番頭が持っていた機能のうち、既存の判断役
(§4.3「`banto.turn-decisions` と判断役」)に無いものを洗い出し、専用の複合オブジェクトを増やさずに
一般化する設計を、このノートと v4-architecture.md §4.3 の新しい節「判断役の一般化」にまとめた。

## 番頭の実コードが配線されている場所(調査・2026-10-24)

`packages/core/src/supervisor/`(policy.ts・supervisors.ts・instruct.ts・guard.ts・factory.ts、各 test)
だけでなく、以下に配線が広がっている:

- `automation/fold.ts`・`automation/store.ts`・`automation/runner.ts`・`automation/busy.ts`・`automation/tools.ts`
- `http/app.ts`・`http/turn-runner.ts`・`http/patrol-tools.ts`・`http/turn-summary.ts`
- `mission/missions.ts`・`delivery/thread-deliveries.ts`・`inbox/automation-review.ts`
- `project-thread/fold.ts`・`project-thread/store.ts`・`project-thread/types.ts`
- `relay/agent-proxy.ts`・`relay/read-only.ts`
- `cli.ts`
- frontend: `components/banto/supervisor/*`・`lib/supervisor-label.ts`・`lib/backend/supervisors.ts`
- 多数の shell・inbox・project 系コンポーネント(import `supervisor` 由来の型・定数)
- e2e: `supervisor.spec.ts`・`supervisor-ui.spec.ts`

このため「`packages/core/src/supervisor/` ディレクトリを消すだけ」では済まない。一般化の実装(kind制限・
`canAdvanceProject`・tool の移設)と同じ作業の中で、参照を1つずつ置き換えながら削除する必要がある。

## 設計の要点(v4-architecture.md §4.3「判断役の一般化」に詳細)

1. kind 制限(`supervisorMayAnswer` 相当) → 判断役の自動化に任意の `delegateKinds` を持たせる。値が無ければ
   今までどおり制限なし(非破壊)。
2. `instruct_thread`・`list_stalled_threads` → 自動化の台帳の新しい真偽値 `canAdvanceProject`(既定 false)を
   持つ自動化の専用 Fork でだけ使える。判断役かどうかとは独立(見回りのきっかけでも使える)。
3. Factory への流し・止まった件への回答 → 既存の `runFactory`・`answerFactory` tool をそのまま使い、
   `canAdvanceProject` と `delegateKinds` 相当の判断を answerFactory 側に足す(詳細は実装時)。
4. 全体の上限 → `canAdvanceProject` な自動化すべてで合算。鍵は `supervisor.*` → `automation.advance.*` へ
   付け替え。
5. 番頭の「4つの自動化をセットで管理する」専用画面は無くす。画面に「Project の進行を自動化に任せる」
   テンプレートボタンを足し、内部で複数の自動化をまとめて作る体験は画面側の便宜機能として残す。

## release 既定の違いの決着

番頭(release既定「人」)とメタ Project(release既定「任せる」)の違いは、一般化後は同じ `delegate` の
差分の仕組み(全体+Project差分)に収まる1つの軸になる。コア既定は安全側の「人」のまま、メタ Project
のように「任せる」にしたい Project は Project 層の設定で `release` を足せばよい。

## 進め方・残っている判断

- 設計は本ノートと v4-architecture.md §4.3 に書いた(ブランチ fork/judge-generalization、レビュー前)。
- 実装(台帳の欄追加・tool の移設・画面)と番頭の実コード削除は、Backlog のストーリー・タスクに分けて進める。
- 番頭の実コードは、一般化の実装が揃ってから(同じ作業の中で参照を置き換えながら)削除する——先に消すと
  §4.3 が引き継ぐとした機能が一時的に無くなるため。
