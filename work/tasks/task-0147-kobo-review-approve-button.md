---
id: task-0147
type: task
kind: improvement
title: "レビュー面から PO が承認できるようにする（承認ボタンの配線）"
status: queued
refs: ["task-0094", "task-0099"]
scope:
  paths: ["packages/banto-web/src/**", "packages/banto-host/src/**", "tests/**"]
acceptance:
  - { id: a1, text: "npm run typecheck" }
  - { id: a2, text: "npm test" }
review:
  policy: manual
---

## 背景

task-0094（PO 裁定 2026-08-11・第0波 0-3）で、Kobo の HTTP 面に **PO 専用の承認口**を作った。

```
POST /api/kobo/projects/{project}/tasks/{taskId}/approve
Authorization: Bearer <BANTO_PO_TOKEN>   （X-Banto-PO-Token でも可）
```

口は生きていて合言葉も設定済み（2026-08-13 実機確認）。**しかし画面から押す経路が無い。**
レビュー面（`kobo.review` / `KoboReview.tsx`）は閲覧だけで、承認ボタンが存在しない。

そのため 2026-08-13 に task-0099 を通したとき、PO はサーバへ入って curl を手打ちすることになった。
レビュー段が `po` のタスク（統治コード・PO 必須の面に触るもの）は**番頭からは通せない**（決定57）ので、
この経路が塞がっている限り、PO が判断するたびに毎回 SSH が要る。

## やること

レビュー面に**承認ボタン**を配線し、PO がブラウザから通せるようにする。

## 設計の縛り（ここを外すと統治の穴になる）

1. **ブラウザから Kobo（127.0.0.1:4500）へは直接届かない。** Kobo は loopback でしか待ち受けておらず、
   PO が見ているのは Caddy 経由の banto-web。したがって **banto-host が中継する**ことになる。
2. **番頭ホストは合言葉を保存しない・ログに出さない。** リクエストごとにブラウザから受け取り、
   そのまま Kobo へ渡して捨てる。保存すると「番頭が自分で通せる」状態が出来上がり、決定57 が空文になる。
3. **番頭の Tool 経路からは使えないこと。** `kobo.approve`（番頭）の判定は一切変えない。
   増やすのは PO がブラウザから叩く HTTP 経路だけで、番頭のモデルからは呼べない形にする。
4. **合言葉はブラウザにも残さない**のを既定とする。押すときに入力してもらい、
   保持するとしても最長でタブを閉じるまで（sessionStorage）。localStorage には置かない。
5. 帳簿には既存の口がそのまま `approved_by: "po"` と書く。**書き手の名前を変えない。**
6. 通しても関所は飛ばない（決定57）。承認の後にマージ前ゲートが回るのは番頭経由と同じ。

## 画面の振る舞い

- レビュー段が `po` のタスクにだけボタンを出す（番頭が通せるものに PO 用のボタンを出さない）
- 合言葉が未設定で口が閉じている場合（503 `po_token_not_configured`）と、
  名乗りが違う場合（401 `unauthorized`）を**区別して**画面に出す。「失敗しました」で潰さない
- 通った後は状態が `approved` に変わったことが画面で分かること

## スコープ外

- Kobo 側の承認エンドポイントの仕様変更（`packages/banto-daemon/**` は触らない。既にある口を使う）
- 番頭の `kobo.approve` の判定変更
- 合言葉の配り方・回し方（今回は「PO が知っているものを入力する」で足りる）
