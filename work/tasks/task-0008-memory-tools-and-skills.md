---
id: task-0008
type: task
kind: feature
title: 記憶Toolの公開とSKILL読み込みの配線（番頭が記憶とSKILLを使えるようにする）
status: draft
parent: epic-0001
depends: [task-0006, task-0007]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "memory.save / memory.recall が名前空間規則に従うToolとして実装され、MemoryStore経由でのみ記憶に触る（Tool内でファイル操作をしない）" }
  - { id: a2, text: "createBantoHostSession が packages/banto-host/skills/ 配下のSKILL.mdを読み込み、一覧（name＋description）をシステムプロンプトへ注入する。本体は skill.read Tool で読む（progressive disclosureを自前で持つ）" }
  - { id: a3, text: "セッション開始時に既存の記憶（active な好み・習慣）がシステムプロンプトへ注入され、前回保存した記憶が次のセッションで参照できる" }
  - { id: a4, text: "上記がKoboに接続せず検証でき、npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

task-0007 で記憶の保存層（`MemoryStore` / `JsonlMemoryStore`）を、task-0005 で最初のSKILL（`work-handoff`）を作ったが、どちらも番頭からは まだ使えない——保存層は呼ぶ人がおらず、SKILL.md は読み込まれていない。本タスクはこの2つを番頭核へ配線し、D11（番頭は記憶を持つ）を実際に成立させる。

記憶の露出は決定9の境界線に従い Tool とする（単発の照会・単発のアクション）。Tool 名は決定9の名前空間規則、LLMへ渡す際は決定22の wire 名変換を通る（task-0006 で実装済み）。

**SKILLはpiの機構に乗せず自前で持つ（実装中に判明、PO裁定 2026-07-29）**：pi の SKILL 機構は progressive disclosure（一覧のみプロンプトへ、本体は `read` ツールでモデルが読む）が前提で、`read` が無いとSKILLセクションごと出力しない（`core/system-prompt.js`）。番頭は組み込みツールを無効化しているため（D10）噛み合わず、実測でSKILLがモデルに一切見えないことを確認した。piに許可リストを渡す回避はカスタムToolまで除外されるため成立しない。そこで progressive disclosure の考え方はそのままに、一覧の注入と `skill.list` / `skill.read` Tool を自前で実装する。番頭に汎用のファイル読み取りを与えずに済み、決定1（結合はTool/SKILLの公開I/Fのみ）・ハーネス差し替え可能性とも整合する。

## スコープ外

- 記憶の第二層（SKILL自動蒸留）・第三層（セッション横断検索）— task-0007 と同じくスコープ外
- ホストプロセス化・WS API・UI（task-0009 / epic-0002）
- Kobo Tool（`kobo.*`）の実装
