---
id: imp-0055
kind: improvement
status: open
severity: medium
created: 2026-08-15
refs: [imp-0054]
---

# 記録の id が衝突している——同じ番号の起票・ADR が2本ずつ在り、相互参照がどちらを指すか読めない

## 何が起きているか

2026-08-15、未コミットの記録を洗い出す過程で、**同じ id を名乗る文書が2本ずつ在る**組を4つ見つけた
（いずれも frontmatter の `id:` まで同じ）。加えて **adr-0024 が欠番**である。

| id | 先に在ったもの（履歴が古い。id を保つ） | 後から付いたもの（2026-08-15 に履歴へ入れた。振り直した） |
| --- | --- | --- |
| adr-0023 | `docs/adr/adr-0023-po-approval-is-separated-by-route-not-by-secret.md` | `adr-0023-one-entrance-contract-from-the-tool.md` → **adr-0026** |
| imp-0040 | `work/inbox/improvement/imp-0040-env-notices-shares-one-state-file.md` | `imp-0040-supersede-bypasses-the-amend-line.md` → **imp-0064** |
| imp-0041 | `work/inbox/improvement/imp-0041-depends-resolves-at-merging-not-merged.md` | `imp-0041-steer-cannot-catch-a-running-branch.md` → **imp-0065** |
| inc-0070 | `work/inbox/incident/inc-0070-acceptance-suite-flaky-under-added-load.md` | `inc-0070-model-select-e2e-broken.md` → **inc-0074** |

欠番: `docs/adr/adr-0024-*.md` は存在しない（adr-0022 → adr-0023 が2本 → adr-0025）。

## なぜ困るか

**相互参照がどちらを指すのか読めない。** 実際に曖昧になっている参照:

- `imp-0044` の `refs: [imp-0040, imp-0036]`、本文「imp-0040 で直したのとまったく同じ構造」
- `imp-0046` の `refs: [imp-0041]`、本文「imp-0041（依存の解決状態）の職人が…」（＝depends 側と読める）
- `imp-0027` の `refs: [task-0151, inc-0070]`
- `imp-0053` 本文「inc-0070 に『間欠』として挙がっている失敗の一部は…」（＝flaky 側と読める）
- `imp-0050` の `refs: [imp-0034, adr-0023, 決定113]`
- `imp-0049` は `docs/adr/adr-0026-one-entrance-contract-from-the-tool.md` と**パスで**書いている（曖昧でない）
- `inc-0071` は `inc-0074-model-select-e2e-broken.md` と**パスで**書いている（曖昧でない）

## なぜ起きるのか

**imp / inc / adr の採番に機構が無く、番頭が「一覧を見て次の番号を手で決める」運用だから**（imp-0054）。
枝が並走していると、同じ空き番号を2つの枝が同時に取る。task-NNNN は Kobo が採番するのでこれは起きない。

## どう直すか

### いま（番号の振り直し）

**後から付いた側**を空き番号へ振り直す。ファイル名と frontmatter の `id:` を直し、
そのうえで**参照している側を全部当たり直す**（`refs:` と本文の両方。上の一覧が出発点）。

**実施済み（task-0152・2026-08-15）。** 起票時の案（adr-0024 / imp-0056 / imp-0057 / inc-0072）は
使っていない——imp-0056〜0063・inc-0072/0073 はその後の起票で埋まり、**欠番は埋めない**方針
（欠番それ自体は異常ではない。起票して消した場合もある）に変えたため、いずれも**その時点の空き番号**を採った。

- `adr-0023-one-entrance-contract-from-the-tool.md` → **adr-0026**（`adr-0024` は欠番のまま残す）
- `imp-0040-supersede-bypasses-the-amend-line.md` → **imp-0064**
- `imp-0041-steer-cannot-catch-a-running-branch.md` → **imp-0065**
- `inc-0070-model-select-e2e-broken.md` → **inc-0074**（inc-0073 まで使用済み）

振り直しは**コミットを分けて**行い、「どの id がどれになったか」を対応表としてコミットメッセージに残す。

### 先（再発の防止）

imp-0054 の案 (b)（起票専用の口を足し、**採番を機構へ寄せる**）が入れば、この種の衝突は起きなくなる。
それまでの当座の凌ぎとして、**参照は id ではなくパスで書く**と曖昧にならない（imp-0049 / inc-0071 の書き方）。

## 受け入れの目安

- `work/inbox/**` と `docs/adr/**` の各ファイルの `id:` が一意である（同じ id を名乗る文書が無い）
- ファイル名の id と frontmatter の `id:` が食い違わない
- 欠番は**落とさない**（警告として一覧できれば足りる。起票して消した跡かもしれないため）
- 振り直した id を指していた参照が、すべて新しい id（またはパス）に付け替わっている
- 上を機械で落とす受け入れ試験がある（`tests/acceptance/record-id-uniqueness.spec.ts`・task-0152）

## 出所

2026-08-15、枝「起票の未コミット」で 30 件の未コミット記録を洗い出す過程で検出。
振り直しは**この枝では行っていない**——コミットと同じ回に中身を書き換えると、
「何を入れたのか」が読めなくなるため分けた。
