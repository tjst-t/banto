---
id: task-0040
type: task
kind: refactor
title: spec-multi-project §1「検討エージェントは横断させない」を決定36 に合わせて改訂する
status: draft
parent: epic-0009
refs: [adr-0010, spec-multi-project]
scope:
  paths: ["docs/spec/multi-project.md"]
acceptance:
  - { id: a1, text: "§1 の「検討エージェント：プロジェクトのworktreeで起動する対話セッション。横断させない」が、番頭が複数プロジェクトを扱う前提に改訂されている" }
  - { id: a2, text: "改訂にあたり、横断させないことで守ろうとしていた不変条件が何だったかを明記し、それが別の手段（場所の登録と範囲チェック）で保たれることを示している" }
  - { id: a3, text: "決定36 と spec の記述が矛盾しない" }
---

## 背景

ADR-0010 決定36(i)。`spec-multi-project` §1 は「プロジェクトごと（リポジトリに閉じる）」の項目として

> **検討エージェント**：プロジェクトのworktreeで起動する対話セッション。**横断させない**

と定めている。決定36 は番頭が複数リポジトリを扱う前提に立つため、この記述と矛盾する。**黙ってどちらかに寄せず**、改訂として起票する（P3）。

なお「統治の単位はプロジェクトであり、混ぜない」（契約層＝vision / principles / roadmap / spec / ADR / タスク定義 / inbox / environments.yaml / skills）という原則そのものは変えない——変わるのは**対話セッションが1プロジェクトに閉じるかどうか**だけである。

## スコープ外

- 記憶（D11）のプロジェクト間スコープ。番頭の記憶＝PO の好み・習慣は店を跨ぐはずで、契約層とは性質が違う。別途の論点として残す
