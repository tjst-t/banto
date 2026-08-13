---
id: inc-0059
type: incident
kind: bug
origin: claude
class: llm-registry
status: open
refs: [adr-0020, adr-0011]
---

## 内容

**複数鍵のフェイルオーバーは「未確認」ではなく、機構として作動しない**（2026-08-13 に静的に確定）。

- `auth.json` は「プロバイダ名 → 鍵」の形で、`llm-registry.ts` の `keysOf` は
  `authNames.filter((n) => n === providerId)` ——**候補は最大1本**
- 選択関数 `resolveKey` は **レジストリ外に呼び出し元が1つも無い**
- 実際の認証は pi の `ModelRegistry.getApiKeyAndHeaders`（`bin.ts`）

したがって `keyOrder` / `keyScopes` / `markKeyLimited` / `markKeyInvalid` と、
それを操作する `llm.set_key_order` / `llm.set_key_scope` は**実際の呼び出し先に一切影響しない**。

## なぜ起票するか

ADR-0020 決定95 の表に「未確認」として残っていた。**「使われていない」と「死んでいる」は違う**
（`picks` は生きていた）ので確かめてから決める、としていた——確かめた結果は「死んでいる」。

## 決めること

削るか、`auth.json` のデータモデルごと複数鍵に対応するか（ADR-0011 決定45 は
「複数鍵は auth.json のデータモデル変更で別に決める」としている）。**削るなら道具2本も一緒に。**
