---
id: task-0067
type: task
kind: feature
title: 検証環境の知らせを会話へ戻す（Environment Pool にイベントの口）
status: done
parent: epic-0010
refs: [task-0066, task-0058, adr-0013, adr-0010]
scope:
  paths: ["packages/banto-environment-pool/src/**", "packages/banto-host/src/**", "packages/banto-web/src/messages.tsx", "docs/spec/environment.md", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "Environment Pool が畳み忘れ（期限切れの強制 teardown）・畳み損ね・孤児を追記専用のイベントログに残し、afterEventId で続きだけを取れる" }
  - { id: a2, text: "番頭が env.events を引いて会話へ知らせる。工房と同じ形（引きに行く・落ちている間の分も取りこぼさない）" }
  - { id: a3, text: "同じことを何度も知らせない。毎分の tick で同じ文面が流れ続けない" }
  - { id: a4, text: "spec-environment §5 の「知らせが返らない」という実態の記載を、返るようになった形へ直す（P3）" }
  - { id: a5, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

task-0066 で Environment Pool を独立サービスへ出したときの**残り**。

同居していた頃は `onAttention` のコールバックが番頭ホストの中で会話へ繋がっていた。
別プロセスになったので繋ぎ先が無くなり、いまは**サービスのログに出るだけ**
（`bin.ts` の `console.warn`）。`env.list` には残るので画面からは見えるが、
**気づく契機がログしか無い**。

外に残った検証環境は金銭的実害が出る（spec-environment §5・I3）。「番頭に聞けば分かる」
では、聞かない限り気づけない。

## やること

職人（Worker Pool）と同じ形にする。決定29c が「起動時にコールバックURLを渡す案は不採用」と
した理由がそのまま当てはまる——起動元が落ちている間の知らせが消え、再送を作り始めると
結局ログが要る。

1. Environment Pool に**追記専用のイベントログ**（`<台帳>/env-events.jsonl`）
2. `env.events`（Tool）。`afterEventId` で続きだけを取れる
3. 番頭ホストに `startEnvNotices`。`startWorkerNotices` / `startKoboNotices` と同じ形
4. spec-environment §5 の実態記載を直す

## 残す出来事（3つだけ）

| 種類 | いつ | いまの扱い |
|---|---|---|
| `env_expired` | 期限切れで機構が畳んだ＝**番頭の畳み忘れ** | `console.warn` だけ（`onAttention` にも載っていない） |
| `env_teardown_failed` | リトライしても畳めなかった＝**外にリソースが残っている** | `onAttention` |
| `env_orphans_found` | 照合で台帳に無い実リソースが出た＝**孤児** | `onAttention` |

**立てた・畳んだの実況は残さない。** 番頭の会話が検証環境の中継になる。Kobo は自分の帳簿に
`env_provisioned` を持っており、画面は `env.list` を見る——読み手のいないイベントを増やさない。

## 宛先

**既定のスレッドへ返す**（起こしたスレッドではない）。`env.provision` は `origin` を受けて
おらず、畳み忘れ・孤児は環境1つの話ではなく**置き場全体の衛生**なので、宛先を持たせる
意味が薄い。スレッド宛にするなら決定35a の `origin` を provision まで通す必要があり、
呼び出し側（Kobo を含む）に及ぶ——別の話として置く。

## やったこと（2026-08-07）

- `packages/banto-environment-pool/src/event-log.ts`（新）＝追記専用の `EnvEventLog`。
  `attention()` を「ログへ積む」が主・`onAttention` が従に組み替えた。**ログは
  `onAttention` が無くても積む**——独立サービスでは繋ぎ先が無いので、そこで止めると
  何も残らない
- **`env_expired` は新しく積むようにした。** 畳み忘れはそれまで `console.warn` だけで、
  `onAttention` にも載っていなかった——同居していた頃も会話へ返っていない
- `env.events`（Tool）。`afterEventId` で続きだけを取れる（`worker.events` と同じ形）
- `packages/banto-host/src/env-notice.ts`（新）＝ `startEnvNotices`。読み位置は
  `<データ置き場>/env-cursor.json`。**職人と違って「起動時の位置から」にしない**
  ——外に残ったリソースは費用（I3）で、番頭が落ちている間に漏れた分が消えると
  気づく契機がサービスのログしか無くなる。Pool 側が同じ出来事を1度しか積まないので、
  追いついても同じ文面は並ばない
- 画面の知らせの札に `env: 検証環境` を足した（無いと生の `env` が出る）

## 確かめたこと（I1）

- `npm run typecheck` / `typecheck:web` / `build` / `build:web`
- `npm test`（**1,240件 green**。新規 `env-notices.spec.ts` が14件）。畳み損ねと孤児は
  **本物のドライバ**（`failing-teardown-driver`）で見ている
- **実機で通した**（偽ドライバだけで済ませない）：`:4400` を再起動して 5秒 TTL の環境を
  実際に立て、TTL 執行が `env_expired` を積み、番頭ホスト（再起動後）がそれを引いて
  既定スレッドへ知らせ、`env-cursor.json` が 1 まで進むところまで

## 途中で分かったこと

- **畳み損ねは孤児ではない。** 最初「畳めなかった実リソースは照合で孤児として出る」と
  思ってテストを書いたが出なかった——台帳の `teardown-failed` は `tornDownAt` を持たない
  ので `listLive` に残り、照合の既知側に入る。**機構の方が正しい**（台帳に載っている）。
  孤児の検査はドライバの管理下に台帳が知らないリソースを置く形へ直した
