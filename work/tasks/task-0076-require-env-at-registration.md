---
id: task-0076
type: task
kind: feature
title: 検証環境が無いリポジトリは受け持たない（原理原則の徹底）
status: done
refs: [task-0075, inc-0032]
scope:
  paths: ["packages/banto-daemon/src/kobo-tools.ts", "packages/banto-daemon/src/daemon.ts", "packages/banto-daemon/skills/kobo-onboarding/SKILL.md", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "検証プロファイルが無いリポジトリは kobo.register_project が断る" }
  - { id: a2, text: "断るときは**何をどこに書けばよいか**まで言う" }
  - { id: a3, text: "確かめるのは検証環境に聞いて。Kobo はプロファイルの定義を自分で読まない（決定60a）" }
  - { id: a4, text: "検証環境へ届かないときは「確かめられない」と言う。勝手に受け持たない（I2）" }
  - { id: a5, text: "SKILL kobo-onboarding の手順1が検証環境になる（受け持たせる前）" }
  - { id: a6, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

**PO 指示**：「テスト環境の立ち上げが environment として共通の IF で定義されているのが
かなり素晴らしいところです。その原理原則を徹底してください。」

task-0075 で Kobo は検証をホストで走らせなくなった。**だがプロファイルの無いリポジトリを
受け持てたまま**だった——登録できてしまうと、**最初のマージで初めて落ちる**。
10タスク積んだあとに言われるより、受け持った時点で言う方が親切。

## やったこと

### 1. 登録時に検証プロファイルを要求する（a1・a2）

`kobo.register_project` が、Git リポジトリであることの検査に続けて**検証プロファイルが
解決できるか**を確かめる。無ければ断り、**何をどこに書けばよいか**まで返す：

- どのプロファイル名を探したか（`meta/config.yaml` の `verify.profile`・既定 `test`）
- 在るが使えないなら**その理由**（上限超過等）
- 使えるものが他にあるならその一覧
- なぜ要るのか（「Kobo は検証をホストで走らせません」）と、書き方の SKILL

### 2. 確かめるのは検証環境に聞いて（a3）

**Kobo はプロファイルの定義を自分で読まない**（決定60a）。読み方を2箇所に置くと
**同じ定義に2つの解釈**ができ、「Kobo は使えると言うのに立たない」が起きる。
`env.list_profiles` を呼ぶ形にした（`environmentProfilesAt`）。

既存の検査（`kobo-touchable-review.spec.ts`）が「Kobo が定義ファイルを読んでいないこと」を
**ソースの文字列で**見張っており、私が書いたコメントの中の文字列で落ちた。
検査としては粗いが**狙いは正しい**ので、コメントの方を書き直した。

### 3. 届かないときは「確かめられない」（a4）

検証環境へ届かないなら**受け持たない**。確かめられなかったことを「確かめた」にしない（I2）。

### 4. SKILL の手順を組み替えた（a5）

`kobo-onboarding` の**手順1が検証環境**になった（以前は手順4「要るなら」）。
「受け持たせる前に」と明記し、**コミットすること**まで書いた——未追跡のファイルは
職人の worktree からもゲートからも見えない（loamium で実際に踏んだ）。

層B設定の例にも `verify.profile` を足した。

## 「徹底」の下見（どこまで共通IFに乗っているか）

コマンドを起こしている箇所を全部洗った：

| どこ | 何を起こすか | 判定 |
|---|---|---|
| `merge-gate.ts` | 検証コマンド | **検証環境経由**（task-0075）。残る `execFile` は `git diff`＝Kobo自身の判断 |
| `merge-queue.ts` | `git` のみ（rebase・merge・worktree） | Kobo 自身の統治。ホストで正しい |
| `banto-host/git-tools.ts` | `git` の読み取り（画面用） | 同上 |
| `banto-repo-manager` | `git worktree` | 同上 |
| `banto-worker-pool` | pi の起動 | 職人は Worker Pool の持ち物。**職人に `env.*` は渡さない**（spec-environment §3）——自分の成果を自分で検証させると I1 が崩れる。職人が回すテストは**主張**であって証明ではなく、証明はゲートが出す |

**プロファイルの解釈も1箇所**（`banto-core/src/env-profile-parser.ts` を検証環境だけが使う）。
Kobo も番頭も自分では読まない。

## 確かめたこと（I1）

- `npm test` **1,298件 green**（新規5件）・typecheck
