---
id: inc-0022
type: incident
kind: incident
origin: agent
class: spec-drift
status: resolved
resolution: ADR-0010 決定47(g) として裁定し、ScopedMemory で二層を実装（2026-08-05）
refs: [adr-0003, adr-0010, proposal-2026-08-05-context-strategy]
---

## 内容

**ADR-0003（status: accepted）が決めた記憶の二層のうち、第二層が実装されていなかった。**

ADR-0003 の決定:

1. あなた（人）の記憶＝全プロジェクト横断・共有
2. **プロジェクトの記憶＝各リポジトリに閉じる・横断させない**

実装は `BANTO_DATA_DIR/memory.jsonl` の単一グローバルストアのみで（`bin.ts` の `memoryPath()`、`JsonlMemoryStore` 1インスタンスを全スレッドで共有）、第二層は存在しなかった。

## なぜ問題か

決定36 で番頭は複数プロジェクトを扱うと決まっている。放置すると、あるリポジトリの決定・規約が別のリポジトリの判断に混ざる——ADR-0003 が「統治の単位はプロジェクトなので混ぜない」（spec-multi-project §1）として明示的に禁じた事故そのもの。

同日に書かれた2件の記憶関連の提案（`2026-08-05-context-memory-survey.md` / `2026-08-05-memory-progressive-disclosure.md`）は、いずれもこの齟齬に触れていなかった。

## 対処

`docs/proposals/2026-08-05-context-strategy.md` §3.5 の提案どおり、ADR-0010 決定47(g) として裁定し実装した。

- `ScopedMemory`（banto-core）が人の記憶とプロジェクトの記憶を合成する
- **ストアそのものを場所ごとに分ける**ことで「横断させない」を機構で担保する。同じファイルに `scope` フィールドで同居させると、絞り込みを1箇所書き忘れた時点で混ざるため
- プロジェクトの記憶は `BANTO_DATA_DIR/projects/<場所ID>/memory.jsonl`。リポジトリ内には置かない（決定38b：番頭が自分の記憶を書き換えられてしまう）
- `memory.save` の `scope: "project"` は `place` を要求し、知らない場所は断る（I2）
- 検証: `tests/acceptance/memory-budget-and-layers.spec.ts`
