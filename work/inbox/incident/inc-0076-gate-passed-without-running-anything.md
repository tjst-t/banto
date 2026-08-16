---
id: inc-0076
title: マージ前ゲートが、検証を1本も走らせないまま「通過」を出していた（嘘の緑）
status: inbox
kind: incident
origin: 枝「緑が信用できない」。ブラウザ試験を verify に書いたまま着地した過去タスクを追ったところ、別のもっと広い穴が出た
refs:
  - packages/banto-daemon/src/merge-gate.ts
  - packages/banto-daemon/src/review-policy.ts
  - task-0177
  - imp-0068
created: 2026-08-16
---

## 何が起きていたか

**受け入れ条件に `verify` を1本も持たない契約は、マージ前ゲートが何も実行しないまま
`passed: true` を出す。** 範囲検査だけで緑になり、そのままマージされる。

一次データ（Kobo の帳簿 `/var/lib/banto/data/events/2026-08.jsonl`）:

```
{"type":"merge_gate_evaluated","projectTag":"banto","taskId":"task-0099","passed":true,
 "reasons":[],"logPaths":[],"eventId":828,"timestamp":"2026-08-13T08:19:12.857Z"}
```

- task-0099 の契約は `acceptance: [{id: a1, text: "コンフリクトが解消されており…"}]` の1本だけで **verify 無し**、
  `scope.paths: ["**"]`。**範囲検査も空振り、検証も0本。**
- `approved → merging → ゲート通過 → task_merged` まで **206ms**。
- `logPaths` は空で、`/var/lib/banto/data/gate-logs/task-0099` は**存在しない**。
  貼るべきログが無いことが、そのまま「何も走っていない」証拠。

## どこが穴か

- `packages/banto-daemon/src/merge-gate.ts:395` `const withCommands = acceptance.filter((ac) => ac.verify);`
- 同 `:405` `if (withCommands.length > 0) {` — **0本なら検証ブロックごと素通り**
- 同 `:536` `const passed = reasons.length === 0;` — reasons が空なので **passed=true**
- **飛ばしたことを警告・記録する箇所が1つも無い**（だから帳簿を見ても気づけない）
- `packages/banto-core/src/task-frontmatter.ts:28` で `verify?: string` は任意。契約検査も `id` と `text` しか要求しない
- `packages/banto-daemon/src/review-policy.ts:389` `gateEvidenceBlockers` は `baseCommit` / `environmentDigest` の
  有無しか見ない＝**「1本でも走ったか」しか見ていない**ので、大半が未検査でも自動着地が通る

## 規模

- 帳簿上の受け入れ条件 **492本中95本（19%）に verify が無い**。内訳は banto 248本中94本（38%）、
  dentaku 1/204、hiragana 0/18、loamium 0/20、mirante 0/2。**穴は共通コードなので全プロジェクトに効くが、
  実害はいまのところ banto に集中している。**
- 「何も走らずに緑」の確定実例: banto `task-0099`
- 「一部の条が機械未検査のまま緑」: dentaku `task-0005`（a5）
- これから緑になりうる: banto `task-0175` / `task-0176`（a1〜a5・a1〜a6 が verify 無し）

## 併せて分かったこと（元の疑いの答え）

`task-0077` / `0078` / `0086` / `0087` / `0088` は **Kobo の帳簿に存在しない**。
banto の帳簿の最古は `task-0089`（eventId 448・2026-08-11）で、着地はいずれも**単親の直接コミット**
（0077=`4a6a24b1` / 0078=`79a50458` / 0086=`ab116b93` / 0087=`761feb8a` / 0088=`b89a73b1`）。
**マージ前ゲートを一度も通っていない。**`status: done` は人が書いた自己申告。
（task-0086 に至っては `task_ingest_rejected`（`missing required field: scope.paths`）が今日まで14回出続けているのに
`status: done`。積まれてすらいない。）

`docker/Dockerfile.test` は**全4リビジョンとも alpine でブラウザ無し**（08-07 の導入時から今日まで）。
`git log --all -S'playwright' -- docker/ meta/` の唯一のヒットは main の祖先でない keep ブランチ。
→ **「昔は Playwright が走っていた」時期は存在しない。**書いてあった `verify: npm run test:ui` は
一度も実行されていない。

なお **帳簿上「playwright を verify に書いてゲートで緑になった」実例は1件も無い**——
0077 系はゲートに来ていないため。ゲートは exit code・時間切れ・環境不備については
**正しく落としている**（loamium task-0002 の `verify_failed:a3(exit=124)`、banto task-0098 の
`exit=127` など実データで確認済み）。穴は「走らせた結果を誤読する」側ではなく、
**「そもそも走らせない契約を許す」側**にある。

## 直し

- **task-0177**（積み済み）: 契約の時点で `verify` か `unverifiable: "<理由>"` のどちらかを必須にする／
  実際に走らせた verify が0本なら `no_verify_commands` で落とす／`merge_gate_evaluated` に
  `unverifiedAcIds` を常に刻む／自動着地は未検査の条があれば通さない。

## 残っていること

1. **この器で走らない `verify` を、積むときに弾く**（`playwright` / `test:ui` を含む verify は、
   プロファイルがブラウザ対応を宣言していない限り断る）。いまは実装が済んでから最後に落ちるか、
   あるいは条件のほうが黙って消える（task-0173/0174 → 0175/0176 で実際にそうなった）。
   器を直す側は `imp-0068`。**どちらを先にするかは PO 判断。**
2. **帳簿外で `status: done` になっているタスクの棚卸し**。banto の `task-0042`〜`0076` / `0079`〜`0085` は
   帳簿に `task_created` が1本も無い。work/tasks に `status: done` のファイルがあるのに帳簿に無いものを
   列挙する検査が要る（いまは誰も見ていない）。加えて `task_settled_outside` 8件
   （task-0090/0091/0092/0100/0101/0107/0108/0147・すべて banto・settledBy: banto）も
   ゲート未通過なので、同じ目で見ること。

## 参照

- `docs/principles.md` I1（自己申告を信頼しない）・I2（確かめていないことを通ったにしない）
- 器でブラウザ試験が走らない件: `imp-0068`
- ブラウザ試験が恒常的に赤い件: `inc-0071`
