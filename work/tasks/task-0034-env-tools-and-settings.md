---
id: task-0034
type: task
kind: feature
title: env.* Tool と Environment Pool の設定面を実装する（番頭が Kobo 無しで検証を回せる）
status: draft
parent: epic-0008
depends: [task-0033]
refs: [adr-0010, spec-environment]
scope:
  paths: ["packages/banto-environment-pool/**", "packages/banto-core/src/env-driver.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "env.verify が provision →（deploy）→ healthcheck → run → collect → teardown を一息で回し、途中で失敗しても teardown まで到達する。teardown 失敗は tornDown:false と teardownError で返り、成功に見せない" }
  - { id: a2, text: "低位動詞（env.provision / deploy / healthcheck / run / collect / teardown / list）が envId を鍵に動く。teardown は冪等" }
  - { id: a3, text: "repoPath を渡すとその meta/environments.yaml のプロファイルが解決される。Environment Pool は独自のプロジェクト登録簿を持たない" }
  - { id: a4, text: "workdir が provision / run の入力としてドライバへ渡り、ビルトイン2種がそこを cwd としてコマンドを起こす。省略時は現状どおりに落ちて既存プロファイルを壊さない" }
  - { id: a5, text: "アドホック環境（driver + config 直指定）が既定でビルトインのみ許可され、設定 adhocDrivers で all / none に切り替わる。アドホックにも既定 TTL が付いて台帳に載る" }
  - { id: a6, text: "TTL・quota のハード上限を能力側が持ち、超えるプロファイルは黙って丸めず拒否される（env_profile_rejected に理由が残る）" }
  - { id: a7, text: "Kobo も Banto も起動せずに上記が検証でき、既存の acceptance / e2e が全て通る" }
---

## 背景

ADR-0010 決定34 より。決定32 は「Environment Pool を独立モジュールにする」と決め、task-0033 で切り出し（振る舞い不変）まで済んだが、**中の契約は空白のまま**だった。

既存実装は `(projectTag, taskId, profileName)` を鍵にし、`repoPath` を Kobo の `ProjectRegistry` から引いている。つまり**Kobo を経由しない経路が成立しておらず**、決定32c（番頭は `env.*` を直接呼べる）が絵に描いた餅になっている。

加えて task-0033 の作業中に仕様の穴が見つかった：**ドライバ契約に作業ディレクトリの入力が無い**。`process` ドライバは継承した cwd で `cmd` を起こし、`docker` ドライバは相対 compose パスを `process.cwd()` で解決する。番頭が「職人が作った worktree で検証する」を頼めない——決定32 が狙った「番頭が機構の返す事実として検証結果を受け取る」が、そもそも表現できない状態だった。

## 本タスクの範囲

決定34 (a)〜(f) の実装。**契約と設定面まで**で、サービス化（HTTP面）と Kobo の差し替えは別タスク。

- **`env.*` Tool 群**（決定34a・`spec-environment` §3.1 の表）。高位 `env.verify` と低位7動詞
- **`envId` を主キーにする**（決定34b）。Kobo のタスクIDに縛られない。`projectTag`/`taskId` は台帳のラベル
- **`repoPath` からのプロファイル解決**（決定34c・§1.1）。都度読み、キャッシュしない
- **`workdir` をドライバ契約に追加**（決定34d・§2）。`EnvDriver` の型（`banto-core`）とビルトイン2種を改訂。省略時は後方互換
- **アドホック環境**（決定34e・§1.2）
- **既定とハード上限**（決定34f・§5.1）

## 実装メモ

- **`env.verify` の teardown は finally で回す。** 途中の失敗で抜けても畳む——これが高位1本を作る一番の理由（I3：消し忘れは金銭的実害）
- **`logTail` は上限行数で切り、切ったことを明示する**（`worker.attach` と同じ扱い）。ログ全文は番頭の文脈を埋め、パスだけでは番頭が結果を判断できない
- Tool の形は `worker-tools.ts` に揃える（imp-0003 の型の不整合は task-0025 の範囲。ここで別の形を持ち込まない）
- 職人には `env.*` を渡さない（決定32c）。`createWorkerTools` に混ぜない

## スコープ外

- **Environment Pool のサービス化（HTTP面）と、Kobo をサービス利用へ切り替える段**（別タスク。task-0010 → task-0024 と同じ2段階）
- モジュール HTTP 面の認証（ADR-0010 未決事項・`spec-environment` §8）
- `run` のタイムアウト規約（`spec-environment` §8 で未裁定）
- 隔離検証用プロファイルの標準名（同 §8）
