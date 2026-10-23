# メタ Project の結合試験・E2E と release への反映（Backlog #539）

2026-10-23。対象は main の `dea2926ca`〜`b9d761f82`（#532 作成と専用 Fork・#533 read_thread・#534 通知・#535 Backlog Gist・
#536 自動化を聞かずに作る・#537 権限・#538 設定画面）。

## 試した結果（main `b9d761f82` の上）

- `npm run build` → 24 個すべて通る
- 単体・結合（frontend・core・module-contract・module-factory・module-subagent・module-backlog）→ 失敗 0
- E2E（共通の道——Project・Fork・中継の承認・自動で許可・ターンの終わり・受信箱・設定画面——に当たるものを一式、32 spec・59 件）→ 全部通る
  - meta-project-settings backlog remote-backlog-ssh-push auto-approve-all automation-ai-tools automation-inbox
    ai-start-forks fork-session fork-dialog fork-from-message sidebar-fork project-thread-fork close-fork-dropped
    close-fork-warning relay-approval relay-cards inbox inbox-page new-project-ai-settings permission-mode-and-two-approvals
    judgment-deny judgment-after-reload turn-decisions chat sidebar sidebar-project-groups thread-lifecycle read-only-runs
    mission project-modules subagent-from-module stream-relay
  - 1回目は `subagent-from-module` の1件だけ落ちた。原因は機構ではなく走らせた環境：Factory の作業者の `HOME` が長く、
    E2E の置き場（`homedir()/.cache/banto-e2e`）から作る Incus の device のパスが `file name too long` になった。
    `HOME=/home/ubuntu` で同じ spec を流し直して 4 件とも通った（メタ Project の変更とは関係しない）

## release への反映——まだしていない

`origin/release` は main と大きく分かれている（main にしか無いコミット 179、release にしか無いコミット 360。番頭（§4.5）・
特権コンテナなどは release にしか無い）。7 コミットを `origin/release` の上に1つずつ当てると、次が衝突する
（`git merge-tree` で、各コミットを素の `origin/release` に当てた結果。順に積めばさらに増えうる）：

| コミット | 衝突するファイル |
|---|---|
| #532 | frontend `lib/backend/client.ts`・core `http/app.test.ts`・`project-thread/fold.ts`・`project-thread/store.ts` |
| #533 | core `http/app.ts`・`http/turn-runner.ts` |
| #535 | なし |
| #536 | core `automation/tools.test.ts`・`http/app.ts`・`http/fork-tool.ts` |
| #534 | `docs/specs/v4-architecture.md` |
| #537 | core `cli.ts`・`http/app.test.ts`・`http/app.ts`・`http/turn-runner.ts`・`relay/agent-proxy.ts` |
| #538 | frontend `lib/backend/client.ts`・`docs/specs/v4-architecture.md`・`docs/specs/v4-frontend.md` |

多くは並べて足せば済むが、**番頭と重なるところは決めが要る**（規則8——黙って寄せない）：

- `project-thread`：release の `restriction` は `ThreadRestriction`（`read-only`｜`supervisor`）、main は `"read-only"` だけ。
  `managedProjectId` を足すだけでよいか（番頭の回に専用 Fork が立つことは無い前提でよいか）
- `relay/agent-proxy.ts`：release は番頭の回でも自動許可の印を刻まない（`restricted()`）。#537 の LAN までの公開の印
  （`AUTO_APPROVE_REACH_META_KEY`）も番頭の回では刻まない、でよいか
- `http/turn-runner.ts`：release は番頭の回で `report_turn` を出さない。#537 の `metaPermissions` と並べる

作業者の側では、release 用の枝・worktree を作る操作が権限の確かめで断られ、また Factory の決まりで push しないので、
**衝突の解消・その版での build と試験・`origin/release` への push は人（または権限のある作業者）に残した。**
