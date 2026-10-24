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

## 実装（2026-10-24、Backlog #542〜#548）

番頭の実コードは残したまま、一般化先を新しく足した（削除は #549）。仕様に書いた細部（v4-architecture.md §4.3「判断役の一般化」の
「実装で決めた細部」、v4-frontend.md §6.56）の、決めた理由と退けた案：

- **`canAdvanceProject` を見回り（`mode: "patrol"`）に持たせない**：頼んだときの指示文には「見回り（mode: "patrol"）でも使える」と
  あったが、見回りの回は読むだけ（§4.4。印は会話に刻まれ、外す口を作らない）で、`instruct_thread`・`runFactory` は読むだけではない。
  仕様 §4.3 の「見回り（時刻のきっかけ）」は番頭の見回り＝ふつうの時刻の自動化を指すと読み、守りの境界を変えない側に倒した。
  **人の確認待ち**（規則8）——読むだけの見回りに進める権限を持たせたいなら、§4.4 の読むだけの定義から決め直す
- **任された行い**：`delegateKinds` は判断役にしか持てないので、時刻の自動化（見回りの代わり）の任された行いは Project の方針（番頭と
  共有の `supervisor.delegate`）にした。`delegateKinds` と方針の積（両方に入っているものだけ）も考えたが、答えるとき（#543）は
  `delegateKinds` だけを見る決まりなので、同じ自動化で2つの判断が食い違わないよう「あればそれ、無ければ方針」にそろえた
- **記録を番頭の記録と分けた**（`advanceActs`）：番頭の記録（`supervisorActs`）に書くと、番頭の画面・取り消し・1日のまとめ・番頭の
  全体の上限の数えに混ざる。番頭を消すときに `advanceActs` を正にすればよい
- **指示の届けものは番頭の印（`origin.supervisor`・書き手 `supervisor`）をそのまま使った**：新しい印を足すと、Thread の fold・届ける口・
  自動化の回の区切り・任務の区切り・届けものの見直しのすべてに分岐が要る。そのぶん、宛先の AI に添える前置き（`KIND_NOTE.supervisor`）は
  「番頭が方針の範囲で頼んだ決まった手順」のまま——**番頭を消すときに一般名へ直す**（#549 の作業に含める）
- **Factory の照らし合わせは、進める自動化の回でなければ素通し**：番頭の照らし合わせは「番頭の回でなければ断る」だが、一般化後は
  ふつうの会話からも `runFactory` を呼ぶ（人が頼む）ので、断ると今までの挙動が壊れる
- **上限の鍵の読み替え**：起動のたびに「新しい鍵が無ければ旧鍵から写す」にすると、人が新しい鍵を消したあとに旧鍵で戻ってしまう。
  済んだ印を残して一度きりにした
- **番頭の「全部止める」**（`SupervisorControls.stopAll`）は、届けものの印で見分けるので、進める自動化のまだ始まっていない指示も一緒に
  捨てる（記録は書けずにログに残る）。番頭を消すまでの間の挙動として残した
- **確かめたこと**：core の単体試験（台帳・answer_decision・instruct・Factory の照らし合わせ・上限・届ける層の飛ばし・HTTP の口・AI の
  代理）、E2E `automation-advance-ui.spec.ts`（フォーム・行・テンプレート、進める自動化の回が instruct_thread で失敗した会話を進めて
  受信箱に出る）。Factory を入れた Project でのテンプレートと、進める自動化からの runFactory・answerFactory の E2E はまだ無い
- **E2E で踏んだ既存の競合（直していない・規則7）**：自動化の画面で「足す」を押すと、行は台帳の写しを置き換えた時点で出るが、作るフォームを
  閉じる `onDone`（`setEditing(null)`）は台帳の取り直し（`refreshAutomations`）を待ってから呼ばれる。その間に出た行の「直す」を押すと、
  遅れて届いた `onDone` が直すフォームを閉じる。`automation-advance-ui.spec.ts` が関係する spec と並べて流したときに1回落ちた
  （単独では2回とも通過）。トレースで、画面は作り直されておらず（作った直後の案内が残る）URL も変わっていないことを確かめた。
  試験は「作るフォームが閉じた」を待ってから次へ進むようにした。画面の直し（`onDone` を先に呼ぶ等）は人に上げる
