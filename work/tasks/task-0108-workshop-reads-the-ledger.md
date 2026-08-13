---
id: task-0108
type: task
kind: improvement
title: "段2: 工房の tierAssignments を廃し、誤答を止める"
status: done
refs: ["adr-0021"]
scope:
  paths: ["packages/**", "tests/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "工房の起動ログが実際に走るモデルを言う（実機の journal で確認）" }
  - { id: a3, text: "llm.resolve が実際に走るモデルを返す" }
  - { id: a4, text: "候補が無い等級は落ちずに取次へ積まれる" }
review:
  policy: manual
---
## やること（ADR-0021 段取り 2）

- 工房の `tierAssignments` を廃し、核の台帳を読む。`defaultTier` も核へ（決定99a）。
  **`defaultBackend` は工房に残す**（供給の入切）
- **上書きの経路は残す**（決定99a）——`worker.delegate` / `delegate_toolkit` の `model` は最優先
- **誤答を止める**：`llm.resolve`（番頭に渡る4本の1つ）と工房の起動ログが、実際に走るモデルと
  違うものを言っている。実機の journal に `職人の既定モデル: opencode-go/deepseek-v4-flash（standard）`
  と出るが、実際は `defaultTier: reasoning` ＋ `opus`。**1行に2つの嘘**
- **決定104**：等級の候補が無いときは黙って落ちない。取次へ積んで人に設定させる。
  帰結として**その職人は起きない**（工場が止まる場面が出る）——それを許容する

## 再起動順

**工房を先に、番頭ホストを後に。** 古い形しか読めない版が新しいファイルに出会う窓を作らない。

## 済んだこと（2026-08-13）

- 工房は核の台帳から等級の割り当てと既定等級を読む。**`defaultBackend` は工房に残す**（供給の入切）
- **上書きの経路は無傷**（決定99a）：`input.model ?? 台帳の割り当て` の順は変えていない
- **起動ログが実際に走るものを言う**。もう読まれない工房の割り当ては名指しで警告する（I2）
- **`llm.resolve` が役の割り当てを返す**（番頭に渡る4本の1つが誤答していた）
- **決定104**：等級を落とさない。`MODEL_TIERS` の並びのせいで `fast` → `reasoning` に
  落ちていた（安いつもりが一番高いモデル）
