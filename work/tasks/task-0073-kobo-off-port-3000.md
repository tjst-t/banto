---
id: task-0073
type: task
kind: fix
title: Kobo を 3000番から退かす（受け持つプロジェクトの検証と衝突する）
status: done
refs: [inc-0032, task-0071, task-0072]
scope:
  paths: ["packages/banto-daemon/src/**", "packages/banto-core/src/daemon-client.ts", "packages/banto-cli/src/cmd-status.ts", "packages/banto-host/src/module.ts", "packages/banto-host/src/protocol.ts", "packages/banto-worker-pool/src/service.ts", "packages/banto-environment-pool/src/service.ts", "deploy/banto-daemon.service"]
acceptance:
  - { id: a1, text: "Kobo の既定ポートが 3000 でなくなる（BANTO_PORT / BANTO_KOBO_PORT / BANTO_DAEMON_URL の既定）" }
  - { id: a2, text: "番頭ホスト・CLI・職人の拡張が、新しい到達先で繋がる" }
  - { id: a3, text: "loamium の npm test が全件通る（3000番を空けたことで最後の1件が解消する）" }
  - { id: a4, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

PO 指示「全部やって」の一環（loamium の2本をどうするか）。task-0071 で検証の制限時間を
直したうえで loamium の `npm test` を実測したら、**時間は4分で収まる**のに**落ちる**。

原因を1件ずつ潰した：

| 落ちていたもの | 原因 | 直し方 |
|---|---|---|
| 3件（`samples.spec.ts`） | `spawn make ENOENT` ——機械に `make` が入っていない | `apt-get install make` |
| 1件（`cli.spec.ts`） | 「3000番に何も居ないこと」を確かめる検査。**Kobo が居座っていた** | 本タスク |

## なぜ Kobo が悪いか

**3000 は最も一般的な dev サーバの既定ポート**（Express・Next.js・Rails・Grafana …）。
banto の仕事は**他人のプロジェクトの検証をこの機械で走らせること**なので、banto が占有する
ポートはそのまま「受け持つプロジェクトが使えないポート」になる。
**いちばん混む番地に居てはいけない。**

しかも落ち方が悪い：検証が落ちるだけで、**なぜ落ちたかはゲートのログにしか出ない**
——「loamium のテストが壊れている」と読める形で失敗する。

## やったこと

Kobo の既定ポートを **3000 → 4500**。番頭 4100 / WebUI開発 4200 / 工房 4300 /
検証環境 4400 の並びに揃えた。触ったのは既定値と、実機のユニット＋drop-in の2行。

## D9 の判断（なぜ番頭が決めてよいか）

- Kobo は **127.0.0.1 のみ**。PO が触るのは :4100 とブラウザで、**利用体験は変わらない**
- **完全に可逆**（設定2箇所＋既定値）。外に累積する副作用ではない
- pre-release なので既定値は壊してよい（D9）

## 確かめたこと（I1）

- 実機で Kobo を 4500 へ移し、**番頭ホストから `kobo.projects` が通ること**を確認
- 3000番が空いたことを確認
- **loamium の `npm test` が 1943 件すべて通った**（exit 0・4分）。
  移す前は 1942/1943 で、落ちる1件がこれだった
- `npm run typecheck` / `npm test`（banto 側）

## 残っている問い（inc-0032）

- **ポートを避け続けるのはいたちごっこ**。根本は「受け持つプロジェクトの検証と banto の
  常駐が同じ機械に同居している」こと。隔離（コンテナ等）を考えるかは PO 判断
