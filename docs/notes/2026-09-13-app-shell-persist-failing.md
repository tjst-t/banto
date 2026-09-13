# `app-shell-persist` が落ちる——Vault の作業とは無関係（2026-09-13）

**直していない。記録だけ残す**（規則6——直さない選択はあってよいが、そのときは記録を残す）。

## 症状

```
specs/app-shell-persist.spec.ts:17 面をまたいでも、外枠（レール）は作り直されない
  data-persist-probe が navigation 後に消えている（AppShell が作り直されている）
specs/app-shell-persist.spec.ts:49 開いている「新しい Project」は、面を移っても入力ごと残る
  ダイアログごと消えている
```

## 私の変更ではないことの測り方

`git stash` で当日の作業（Vault の公開鍵まわり）を外し、**直前のコミット
`9926eb64` の状態で同じ spec を回したら、同じく2件とも落ちた**。

- いまの再現率：**4/4**
- **同じコミットで、約40分前のフル実行では通っていた**（65/65）

つまり**間欠だったものが、再現するところまで来ている**。規則6 が言う
「機構が壊れている合図」。待ちを延ばしてごまかさない。

## 分かっていること

- E2E のデータ置き場は**実行ごとに新しい**（`RUN_ID` が pid）。蓄積ではない
- `app-shell-persist` は Playwright の並び順で**最初に走る**ので、
  **自分で Project を作った直後**に navigation する経路になっている
  （他の spec のあとだと `createProject` を飛ばす）
- 落ちているのは「navigation で AppShell が作り直されていない」という
  frontend の不変条件。Vault・中継・刻印とは層が違う

## 次に見るなら

1. `createProject` の直後だけ起きるのか（順序を変えて測る）
2. `openNav` → `/settings` の遷移で `AppShell` が remount する条件
   （`app/layout.tsx` と route group の構成）
3. 落ちたときのブラウザ console（`pageerror` を拾っていない spec なので、
   まず**そこを足してから**測る——嘘のエラーを信じないため）
