---
id: task-0102
type: task
kind: improvement
title: "決定94 の残り（概念を 7→5 に畳み切る）"
status: closed
refs: ["adr-0020", "adr-0019"]
scope:
  paths: ["packages/**", "docs/adr/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "稼働中の banto に反映し、起動ログで確認している" }
review:
  policy: manual
---
## 背景

ADR-0020 決定94 は「概念を 7 → 5」と決めたが、**2026-08-13 時点で畳めたのは束縛だけ**
（`defaults.host` ＋ `picks` → `roles`）。ADR の「実装した形」節は roles の表しか示しておらず、
読むと完了したように見えるため、レビューで指摘された。

## やること

- `NotSupported` を型で持つ（`resolve(ref) → Binding | NotSupported`）。Agent SDK は
  Claude 以外に繋げないので、契約が「どのモデルもどのハーネスでも動く」と仮定してはいけない
- `hostUsable` / `workerUsable` → **Policy 1つ**に畳む
- `ModelRef` を1文字列にするか、3フィールドのまま行くかを決める（**D1：公開I/F**。
  `worker.delegate` の `model` 引数や Kobo のタスク定義に波及する）
- Catalog を**ハーネスへの問い合わせ**に倒す（いまは `CLAUDE_KNOWN_MODELS` の直書き＋自前台帳）
- `LlmDefaults.workerTier` の撤去（`defaults()` が常に `"standard"` を返す死んだ欄）
- モデル操作 Tool 17 → 4

## 注意（今日2回踏んだ）

**書き先を移すときは、その欄に書く全部の経路を探すこと。** `roles` へ移したときは
`migrateOnce` / `migrateWorkerDefault` / `repairDefaults` / `tiers()` の4箇所あり、
さらに `repairDefaults` は backend を落として書き潰していた。
**スキーマを変えるときは、そのファイルを書く全プロセスを入れ直すこと**（工房が古いコードで書き戻した）。

## 済んだこと（2026-08-13・決定98）

6点すべて。詳細は ADR-0020 決定98。

- **a** `supports(ref) → true | NotSupported`。バックエンドが自分で答える
  （`packages/banto-host/src/harness-backends.ts`）。断る理由に**次にどうすればよいか**を書く
  ——「採用してください」（pi）と「経路を替えてください」（Claude 専用）は直し方が違う
- **b** `policy: ModelUse[]` 1つへ。書き先は `allowUse` 1箇所に集約
- **c** **`ModelRef` は3フィールドのまま**（PO裁定）。1文字列化は決定94 から落とした
- **d** `query().supportedModels()` を聞く。**待たない**（写しを返し、裏で聞き直す）
- **e** `LlmDefaults.workerTier` 撤去
- **f** 番頭に渡す `llm.*` は4本（`list` / `resolve` / `check_key` / `reload`）。
  **HTTP 面は17本のまま**（設定画面の到達先。絞ると 404 になる）

### 途中で見つかったもの（起票に無い）

**設定画面の選択肢が起動時に凍っていた。** 区画は起動時に1回だけ組まれるので、
`options` を配列で持つと、モデルを採用しても出てこない。問い合わせ（1秒後に返る）も
反映されないので、d を入れる前提として直した（`get options()`）。

### 確かめたこと（I1）

- **実データの写しで移行を実測**（`/var/lib/banto/llm-registry.json` の87件）：
  `hostUsable=true` 30件 → `policy⊃host` 30件、`workerUsable=true` 26件 → 26件、
  併記されていた `contextWindow` も落ちない。移行後は旧欄が0件
- **`supportedModels()` を実機で確認**：LLM を呼ばずに約1秒。手書きの表に無い
  `default` / `opus[1m]` / `claude-fable-5[1m]` が並んだ——**表は既に古かった**
- `npm test` 全通過・typecheck・typecheck:web・build:web

> 2026-08-13: 内容は既に main に取り込み済みのため、Kobo 側で failed→closed として畳んだ（キューの棚卸し）。
