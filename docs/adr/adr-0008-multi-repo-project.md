---
id: adr-0008
type: adr
status: accepted
refs: [spec-multi-project, principles, adr-0002, adr-0005]
---

# ADR-0008: 1プロジェクト＝複数リポジトリ、契約層は primary repo に置く（project-meta を別に作らない）

## 文脈

spec-multi-project は当初「リポジトリパス＋プロファイル」＝実質 1プロジェクト 1リポジトリを前提にしていた。全体像設計プロトタイプで、POが「**1プロジェクトが複数リポジトリ（例：web / api）からなる構造**」を求めた。すると契約層（vision / principles / roadmap / spec / ADR / タスク定義 / AGENT.md）を**どのリポジトリに置くか**が問題になる（統治の単位＝プロジェクト、混ぜない＝spec-multi-project §1）。POの整理は「project-meta もこの仕組みで拾える。要は **primary repo を project-meta にすればいいだけ**」。

## 決定

- 1プロジェクトは **1つ以上のリポジトリ**を持てる。各リポジトリは取り込み時に選んだ認証アカウント（ADR-0007）とセットで保持する。
- **契約層は「primary」リポジトリに置く**。**project-meta という別概念は導入しない ―― primary repo が project-meta を兼ねる**。専用のメタ/契約リポジトリが要る場合は、それを primary に指定すれば同じ仕組みで拾える。
- 参照は `<project>/<id>`。リポジトリ跨ぎの参照は repo 名を含める（spec-multi-project §2 の名前空間を repo 粒度へ拡張）。

## 帰結

- (+) 複数repo構成を、新しい文書種・別レジストリを作らずに扱える（primary＝meta の統合）
- (+) 統治の単位がプロジェクトのまま保たれる（契約層は1箇所＝primary に集約、混ざらない）
- (+) メタ専用repo運用も「primary に指定」で表現でき、特別扱いが要らない
- (−) spec-multi-project §2（ID空間）を repo 跨ぎ参照（`project/repo/id` 相当）に拡張・追記する（P3）
- (−) primary の移動、複数repo間の依存（scope 重なり判定＝§3）の扱いは実装で詰める
