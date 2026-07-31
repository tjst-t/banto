---
id: task-0039
type: task
kind: feature
title: repo-manager モジュール（ghq / gwq を状態を持たずに提供する）
status: draft
parent: epic-0009
depends: [task-0038]
refs: [adr-0010, spec-multi-project]
scope:
  paths: ["packages/banto-repo-manager/**", "packages/banto-host/src/**", "packages/banto-daemon/src/**", "tests/acceptance/**", "tsconfig.json"]
acceptance:
  - { id: a1, text: "repo-manager が PlaceProvider の実装として、ghq が知るリポジトリと gwq が知るワークツリーを場所として返す" }
  - { id: a2, text: "独自の台帳・設定ファイルを持たない。一覧は毎回 ghq / gwq から導出する（D3）" }
  - { id: a3, text: "ghq / gwq が未導入の環境では場所を1つも返さず、静的な場所だけで動く。無いことをエラーにして番頭を止めない" }
  - { id: a4, text: "ワークツリーの作成・削除ができる。これは共通契約ではなく repo-manager 固有の Tool" }
  - { id: a5, text: "Kobo の createWorktree / removeWorktree が repo-manager 経由になり、機能が2箇所に分散しない。振る舞いは変えない" }
  - { id: a6, text: "Kobo も Banto も起動せずに repo-manager 単体の受け入れテストが実行できる" }
  - { id: a7, text: "既存の acceptance / e2e が通り、npm run build・typecheck・test が通る" }
---

## 背景

ADR-0010 決定36（a）(b)(h)。提案書は `docs/proposals/2026-07-30-repo-manager-module.md`（採否は末尾）。

**扱うのは Git リポジトリとワークツリーであって、店（プロジェクト）ではない。** プロジェクトは統治の単位で Kobo の `ProjectRegistry` が持ち続ける。repo-manager はその下にある**作業場所の実体**を扱う。

**worktree の現状はちぐはぐである。** `createWorktree` / `removeWorktree` は `banto-worker-pool/src/pi-rpc-driver.ts` にあるが、**Worker Pool 自身は1度も呼んでいない**。実際に呼ぶのは Kobo だけ（`daemon.ts` / `merge-queue.ts`）。task-0010 で切り出したとき pi ドライバの隣にあったヘルパーが付いてきたものと思われる。

## 実装メモ

- **状態を持たないのが要点。** `ghq` の配置と `gwq list` から毎回導出する（D3）。Worker Pool が `SpawnLedger` を持つのとは対照的——あちらは「起こしたプロセス」という導出できない事実が要るが、こちらは要らない
- 外部コマンドは `git` と同じ扱い（`execFile` で引数配列。シェルを介さない。D6）
- Kobo を寄せるのは決定23・32 と同じ2段階の1段目：**まず切り出し、Kobo は当面ライブラリとして参照**

## スコープ外

- **Git の変更操作**（commit / push / branch / remote / tag）。決定24 を覆す話で別途の裁定が要る
- Kobo をサービス利用へ切り替える段（2段目）
- `spec-multi-project` §1 の改訂（task-0040）
