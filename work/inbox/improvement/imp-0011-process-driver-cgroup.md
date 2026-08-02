---
id: imp-0011
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: open
refs: [task-0102-banto-live, imp-0010, imp-0014]
---

# process driver のプロセスが banto.service の cgroup に巻き込まれる

## 内容
process driver が spawn するプロセスは、banto.service（KillMode=control-group）の cgroup に入る。banto.service を再起動すると、テスト環境のプロセスも巻き添えで kill される。

- 2026-08-01 実機確認: env-3655b2bcee（テスト Banto）が、banto.service 再起動の巻き添えで消えた。systemctl status の CGroup 一覧に検証環境のプロセスが並ぶのを確認
- 影響: 本番再起動のたびに立っているテスト環境が全部死ぬ。テスト環境を維持しながら本番を再起動できない

## 対応方針（PO 裁定 2026-08-01）
**起動時に cgroup の所属を選べるようにする**:
- 独自の cgroup（例: systemd-run --scope）にするか、banto.service の cgroup のままにするか、を process driver の設定（config）で選べる
- 既定: 独自 cgroup（本番の再起動に影響されない）
- オプション: banto.service の cgroup（現行挙動）
- spec（docs/spec/environment.md）への反映と実装が必要

## 注意（調査が必要な点）
- ubuntu ユーザーが systemd-run --scope を非対話で実行できるか要確認（polkit の対話認証が要る場合は別経路が必要）
- process driver は D6 の制約（node:child_process 等のみ）があるため、systemd-run を子プロセスとして呼ぶ形になる
