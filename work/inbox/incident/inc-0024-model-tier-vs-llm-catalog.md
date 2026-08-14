---
id: inc-0024
type: incident
kind: incident
origin: agent
class: spec-drift
status: resolved
refs: [adr-0011, adr-0013, adr-0021, spec-daemon-core]
---

## 内容

`spec-daemon-core` §3.5「モデルtier（層B）」は、`meta/config.yaml` に独自のルーティング表を持つと規定している。

```yaml
models:
  reasoning: { runtime: claude-agent-sdk, model: ... }
  standard:  { runtime: pi-rpc, provider: zen, model: ... }
```

一方 **ADR-0011 決定42（2026-08-03、PO裁定）は「LLM・モデル管理は中核のドメイン」と決め、`LlmCatalog`（banto-core）に一本化した**。番頭は常に `llm.*` を持ち、設定は中核の区画に出る。

実装は spec ともADRとも違う第三の状態にある——Kobo は `BANTO_PI_PROVIDER` / `BANTO_PI_MODEL` の**環境変数2つ**でモデルを固定しており、tier ルーティング表は存在しない。

## なぜ問題か

「タスクをひたすら積む」運用（ADR-0013）では、**同時実行数とモデル tier が費用を決める**。方針が2箇所（spec の表・Kobo の環境変数）にあり、しかもどちらも中核の `LlmCatalog` の外にいるため、PO が1箇所で費用を制御できない。

`spec-daemon-core` §3.5 が定めた「失敗駆動の昇格（監査2回不通過で一段上の tier）」は実装されているが、**昇格先の tier が何を指すかを解決する台帳が無い**状態でもある。

## 対処

ADR-0013 決定60 で「中核のドメインは中核の Tool 面を叩く」と決めた。実装は task-0061。

**`spec-daemon-core` §3.5 の改訂が別途要る**——ルーティング表の記述を削り、`LlmCatalog` を指す形へ書き換える。tier という語彙自体（`reasoning` / `standard` / `fast`）は `LlmCatalog` 側にも存在するので、失効するのは置き場所の指定だけである。

## 解消（2026-08-13・ADR-0021）

**「PO が1箇所で費用を制御できない」は解けた。**

- `BANTO_PI_PROVIDER` / `BANTO_PI_MODEL` は**決定60a で既に廃止**されていた（この起票の
  「環境変数2つでモデルを固定」はもう実態ではない）
- 等級 → モデルの解決は**核の台帳**（`<data>/model-roles.json`）1つになった（決定101）。
  設定の「役ごとのモデル」1枚で、番頭と職人の等級を**バックエンドを跨いで**選べる
- 「昇格先の tier が何を指すかを解決する台帳が無い」も同じ台帳が答える。
  ただし**等級は落ちない**（決定104）——候補が無ければ解決せず、人に設定させる

**`spec-daemon-core` §3.5 の `meta/config.yaml` のルーティング表は、いまも実装に無い。**
spec の側を ADR-0021 の形へ改訂する必要がある（P3）。→ **task-0110 に起票**

