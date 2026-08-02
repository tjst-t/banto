---
id: imp-0013
type: improvement
kind: task
origin: po
status: open
refs: [imp-0014]
---

# モジュール使い方 SKILL の不在

## 内容
PO 指摘（2026-08-01）: Env / Proxy / Git / Banto の各モジュールの「使い方 SKILL」（手順知識）が存在しない。

確認結果:
- 登録済み SKILL は work-handoff と worker-delegation の2つだけ（skill.list で確認）
- 仕様（docs/spec/environment.md 等）はあるが、それは「何ができるか・設計」であって「どう使うか・手順」ではない
- 今回の一連の作業（テスト環境を立てて外に見せる）で得た手順知識がどこにも残っていない:
  - proxy exposer は WS を中継しない（中継 URL で開いた WebUI は「画面だけテスト・会話は本番」の偽テスト環境になる）
  - Caddy サブドメイン公開は WS も通る（基本形）。ただし DNS ワイルドカード・settings（caddyAdmin/envDomain）の保存・banto.service 再起動が必要
  - caddy-exposer が返す URL は https:// だが実態は http（読み替えが必要）
  - process driver のプロセスは banto.service の cgroup に入る（本番再起動で巻き添え死。imp-0011）
  - この環境の npm はグローバルに omit=dev が効くため `npm ci --include=dev` が必須

## 対応（案）
以下を SKILL.md（agentskills.io 形式）として作成し、登録する:
1. **env モジュール**: 検証環境の立て方・畳み方・外への見せ方（verify / provision / expose / teardown、公開方式の違いと WS の可否）
2. **git / リポジトリ**: ワークツリーの切り方・コミット/マージのフロー（番頭は commit を持たず職人へ委譲する点を含む）
3. **banto 基本操作**: モジュール一覧・place（読み取り専用/書込許可）・worker 委譲・記憶の保存

優先度: P1（次回同じ作業をするときに同じ苦労を繰り返さないため）
