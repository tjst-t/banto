---
id: adr-0005
type: adr
status: accepted
refs: [vision, principles, adr-0002]
---

# ADR-0005: リポジトリ管理は ghq/gwq 前提、契約層の雛形は AGENT.md

## 文脈

プロトタイプの初期版は、プロジェクト登録で「取り込み先パス」を尋ねていた。POは palmux と同様に **ghq（リポジトリ配置管理）・gwq（git worktree 管理）を前提**とし、その配置管理に委ねたい（具体的なフォルダをどこに置くかを問わない）と指摘した。また契約層のエージェント指示ファイルは、pi 等の無改造ランタイム方針（ランタイム中立）から、`CLAUDE.md` ではなく **`AGENT.md`** を採用する。

## 決定

- リポジトリの配置は **ghq** に委譲する（取り込み：`ghq get`、選択：`ghq list`）。worktree は **gwq** を用いる。banto は配置先パスを問わず、`host/owner/repo` から ghq 管理下のパスを解決する。
- 契約層のエージェント指示ファイルは **`AGENT.md`**（`CLAUDE.md` ではない）とする。

## 帰結

- (+) 配置規約を ghq/gwq に一元化し、POに具体パスを問わない（操作の記憶をシステムが持つ＝D8）
- (+) ランタイム中立（AGENT.md）で特定ツール名に縛られない（VISION：piは無改造ランタイム）
- (+) palmux 等の既存ワークフローと揃う
- (−) ghq/gwq をホスト前提に加える（依存追加＝D6。理由：配置・worktree 管理の標準化、自作より既存資産）
- (−) 既存に `CLAUDE.md` 参照があれば `AGENT.md` へ移行が要る
