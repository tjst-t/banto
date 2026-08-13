---
id: task-0106
type: task
kind: improvement
title: "段1a: 役の台帳を核に作る（版印つき・書き口は部分更新1本）"
status: done
refs: ["adr-0021"]
scope:
  paths: ["packages/**", "tests/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る（**挙動が変わらない**のが完了条件）" }
  - { id: a2, text: "役へ書く経路がすべて backend を明示する（落ちる経路が無い）" }
  - { id: a3, text: "稼働中の banto に反映し、実データの移行を件数で確認している" }
review:
  policy: manual
---
## やること（ADR-0021 段取り 1a）

- **役の台帳を別ファイルに作る**（決定101a）。`schemaVersion` を持ち、**版が違えば読み手は止まる**
  ——番頭ホストと工房は別サービスで再起動が独立し、工房は mtime で走行中に読み直すため、
  版印が無いと古い版が新しい形を読んで**黙って別のモデルで走る**
- `roles` を `llm-registry.json` からそこへ移す（`backend` を落とさない）
- **書き口を部分更新1本に**（決定101c）。`roles` へ書く経路は7つあり、`backend` を運ぶのは2つだけ
  （`llm.set_role` / `core-settings` / `bin.ts` の移行 / `repairDefaults` / `migrateRoles` /
  `migrateWorkerDefault` / `migrateOnce`）
- `llm.set_role` に `backend` を足す
- **`policy` は据え置き・画面も据え置き**（1b でやる）

## 注意

**台帳の読み手が居ないうちは、書き手（番頭ホスト）だけが触る。** 工房が新しい台帳を読むのは
段2。それまで工房は従来どおり `llm-registry.json` を読む。

## 済んだこと（2026-08-13）

- `packages/banto-core/src/model-ledger.ts`（`ModelLedger`）。版印つき・部分更新・読み取り専用の口
- `roles` を `llm-registry.json` → `<data>/model-roles.json` へ移す（`backend` の無い旧データは pi）
- **役へ書くのは `writeRole` 1本**（決定101c）。`repairDefaults` も `backend: "pi"` を明示して書く
- `llm.set_role` に `backend`。LLM 画面の3つの呼び出しは `backend: "pi"` を明示
  （この画面が並べているのは pi の台帳のモデルなので、経路も pi と名乗る）

### 途中で見つかった穴（どちらも入れ替えの窓で出る）

1. **同じミリ秒に2回書くと読み手が取りこぼす。** `LlmCatalog` は更新時刻で読み直すが、
   台帳でそれをやると「黙って別のモデルで走る」（決定101a がまさに避けたいこと）。
   **毎回ディスクから読む**ことにした（数KB）
2. **読み取り専用の台帳で移行を走らせると落ちる／台帳がまだ無いと役が空になる。**
   工房を先に上げる運用なので、この窓は必ずできる。移行は書き手だけが走らせ、
   **台帳が無いうちは従来のオーバーレイを読む**

### 確かめたこと（I1）

- `npm test` **1,623件 green**（新規15件）・typecheck・typecheck:web
- **直しを戻すと落ちる**ことを確認（フォールバック／読み取り専用の移行の2箇所）
- **実データの写しで移行を実測**：役4件が台帳へ移り、`steward` の `backend` は
  `claude-agent-sdk` のまま、職人3件は `pi` が入る。オーバーレイの `roles` は消え、
  `policy` 32件はそのまま。`resolveForWorker("standard")` は移行前と同じ
  `opencode-go/deepseek-v4-flash` を返す（**挙動が変わらない**）

