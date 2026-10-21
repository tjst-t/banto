# チャットの画面（Backlog #503）——仕様に無かった細部の決め方

2026-10-21。仕様は v4-frontend.md §6.53（ローカルでは写し `2026-10-21-chat-spec.md`）、見本はモック `fork/draft-projects`。
実装は `banto/apps/frontend/components/banto/shell/chat-list.tsx`・`closed-chats-dialog.tsx`・`components/banto/project/promote-dialog.tsx`・
`new-chat-content.tsx`・`components/banto/settings/chat-settings-panel.tsx`、E2E は `banto/e2e/specs/chat.spec.ts`。

- **「最近のものから」は作った時刻の新しい順**。host の一覧に「最後に使った時刻」は無い（チャットの時計 `chat-idle.ts` が
  持つのは host のメモリと project-activity.json で、口に出していない）。足すと read model か口が増えるので、いまは作った順
- **「題を考えています…」は名前がまだ仮の「新しいチャット」のチャット**。host の題付け（`2026-10-21-chat-title.md`）と同じ
  見分け方——記録に「題を付けている」の印は無い。題はターンが終わってから付くので、返事が流れている間はこの表示のまま
- **閉じたチャットの小窓に「閉じた日」は出さない**（この画面で閉じたときの「たった今」だけ）。host の記録（`project.closed`）に
  時刻はあるが read model に持っていない。無い値を「不明」と書いて並べるより、行を開いたときの中身（最初・最後の発言）を出す
- **チャットの会話の上にはスリープの帯を出さない**（§6.53「会話の上に帯は出さない」）。開けば `modules/prepare` で起きるのは
  普通の Project と同じ
- **「Project にする」の名前・フォルダの名前の「AI の案」は、いまは題とそれを英小文字にしたもの**。英数字が無ければ今のフォルダ
  の名前（`<日付>-<短い id>`）。案を作る口は core に無い（小さいモデルの1回 `askSmallModel` を使えば作れるが、別の仕事にする）
- **リポジトリの欄（folder-adopter）に渡すフォルダは今の根、押したときに頼むのは移したあとの根**。押す順は host の
  promote（フォルダが移る）→ 画面への `dev.banto/adopt-folder`。リポジトリにできなかったときは Project にはなっているので
  そう言う（「できた」とだけ言わない）
- **E2E のチャットの置き場**：本物の置き場（`~/banto/chats`、固定）は人の `~/banto` の中なので、config.json に試験だけの
  `testOnlyChatsDir` を足し、実行ごとの置き場へ向けた（`testOnlyIdleCheck` 等と同じ扱い。本番の config には書かない）
