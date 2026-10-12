# 移している最中の Project を開いたら、移していると分かるようにする（Backlog #270 runtime-move-visible）

2026-10-12。仕様は `docs/specs/v4-frontend.md` §6.38。

## 決めたこと・理由

- **渡し方は出来事の流れ（hello＋`runtime_move.changed`）**。帯のために `GET .../runtime-move` を会話の面で定期的に読む案は
  採らなかった——会話の面のポーリングは assistant-ui のランタイムを壊した前例がある（`app-events.ts`）。read model の `move`
  だけでは進み具合（写した量）が出ないので、移す本体（`ProjectMover`）が段の変わり目と、写している間は1秒に1回まで知らせる
- **会話の面は「移しているか」（真偽）だけを読み、進み具合は帯だけが読む**（`useProjectMoving` と `useRuntimeMove` を分けた）
  ——進み具合のたびに会話の面ごと描き直さないため
- **入力欄は隠さず、打てない・送れない状態にして理由を上に出す**。閉じた Fork のように隠すと書きかけが見えなくなる
- **「移せなかった」は host に持たせない**（hello に載せない）。正本は受信箱の知らせで、帯はその場で見ている人のためのもの。
  人が閉じるか、次に移し始めるまで残す
- 移し終えたら画面がその Project の根と実行場所を読み直す（移す画面を閉じていても、サイドバーの title や設定の欄が古い場所の
  ままにならないように）
- 写す大きさの書き方（`formatMoveBytes`）は移す画面と帯で1つにした

## E2E

`e2e/specs/runtime-move-visible.spec.ts`（自前の host と SSH の相手、写す速さを 256 KiB/秒に抑えて 8 MiB を写す）。
移せない場合は、写している間に移す先の根へ余計なファイルを置き、写したあとの確かめ（件数）で合わなくする。

## 確かめたこと

- `runtime-move-visible.spec.ts` は1回目で通過（3.3 分）。関係する spec（入力欄・Fork の面・サイドバーの印・携帯・移す画面——
  close-fork-*・composer-image-paste・mobile-*・resources・sidebar*・thread-running-icon・runtime-move-ui・runtime-move-visible）
  19 件も通過。単体（frontend・core・module-*）も通過
- **フル E2E は最後まで回していない**。254 件で、10 分で 27 件——SSH の相手や自前の host を立てる spec があり、規則15 の
  「約7分」に収まらない。途中までの 27 件に失敗は無かった
