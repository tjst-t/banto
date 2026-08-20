---
id: inc-0086
kind: incident
status: open
severity: major
created: 2026-08-20
refs: [task-0323, task-0311, task-0313]
---

# `deploy-verify-failure-extraction.spec.ts` の a3 試験が検証環境で間欠的に落ちる

## 何が起きたか（2026-08-20・task-0323 の `report_done` 検証中に発見）

task-0323（`packages/banto-core/src/prompt-assets.ts` と
`tests/acceptance/audit-checklist-assets.spec.ts` だけを触る fix）の
`report_done` で、Kobo が検証環境（env-0296534cb8）で受け入れ基準 [a4]
`npm test && npm run typecheck` を回したところ、2918件中1件だけ落ちた：

```
test at tests/acceptance/deploy-verify-failure-extraction.spec.ts:1:3046
✖ ノイズが数百行先行していても後方の本物の失敗行が報告に出る（a3） (134.078226ms)
  AssertionError [ERR_ASSERTION]: ノイズに埋もれて本物の失敗が消えています: 終了コード 1 で失敗（fail 行は拾えなかった）
  生ログ: /tmp/deploy-verify-a3-noise-mxu7mr/deploy-verify-2026-08-20T11-31-36.601Z.log
      at TestContext.<anonymous> (/app/tests/acceptance/deploy-verify-failure-extraction.spec.ts:119:12)
```

## 自分の変更ではない（スコープが交わらない）

task-0323 が触るのは `packages/banto-core/src/prompt-assets.ts` と
`tests/acceptance/audit-checklist-assets.spec.ts` のみ。落ちた
`deploy-verify-failure-extraction.spec.ts` は `packages/banto-host/src/deploy-verify.js`
（task-0311・task-0313 の対象）を検証する試験で、経路が交わらない。

同じ検証環境の同じ実行で、task-0323 が固定しようとしている3本
（`audit-checklist-assets.spec.ts` / `kobo-evidence-versions.spec.ts` /
`kobo-role-prompts.spec.ts`）は failing tests の一覧に一件も出ていない
——task-0323 の変更自体は効いている。

## 計測できていない（P6・未完了）

P6 は「何回中何回落ちるか」を計測することを求めるが、このワークツリー
（`task-task-0323`）は `node_modules` が空（`npm ci` されていない）で、
`npm run test:one` すら `ERR_MODULE_NOT_FOUND: tsx` で即失敗する。
`npm ci` は一式（禁止された自己実行コマンド）にあたるため、このワークツリー
から単独で回数を計測することができない。今回わかっているのは検証環境での
1回の実行結果（2918件中この1件のみ fail）だけで、間欠か確定的かは未確認。

## 疑わしい原因（未検証）

落ちた試験自体が「ノイズが数百行先行していても後方の本物の失敗行が報告に出る」
ことを固定するものであり、`console.log` を300行書いたあと `not ok 1` を書いて
`process.exit(1)` する子プロセスを `runDeployVerify` 経由で spawn し、
その stdout を親側で読み切れているか（バッファリング・パイプの取りこぼし）を
見ている。検証環境（コンテナ）側の負荷やCPU割当てで、この手のI/Oタイミングに
依存した試験が揺れる可能性がある——が未検証。

## なぜ重いか

task-0323 のように無関係なタスクの `report_done` を巻き込んで
[a4]（`npm test && npm run typecheck`）を赤くする。P6（間欠を「既存の
不安定さ」で片付けない）に従うなら、この試験自体の安定性を計測・修正する
別タスクが要る。

## 未確認

- 何回中何回落ちるか（このワークツリーからは計測不能。別環境か、node_modules
  が揃ったワークツリーで計測する必要がある）
- `runDeployVerify` 側のI/O取りこぼしか、試験のタイミング前提が甘いのか
- スコープ外なので触っていない（P1）
