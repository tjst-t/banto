---
id: inc-0072
title: 稼働機の banto.service とリポジトリの deploy/banto.service が食い違う——入れ直すと再起動が効かなくなる
status: inbox
kind: incident
origin: imp-0062（再起動で落ちる範囲を事実に合わせる）の実装中に、職人が稼働機とリポジトリを突き合わせて発見。P3 に従い起票
refs:
  - deploy/banto.service
  - packages/banto-host/src/restart-tool.ts
  - imp-0062
created: 2026-08-15
---

## 何が食い違っているか

| | `Restart=` |
|---|---|
| 稼働機 `/etc/systemd/system/banto.service` | **always**（`NRestarts=9`） |
| リポジトリ `deploy/banto.service` | **on-failure** |

`system.restart` は **`exit(0)`** で終わる（＝正常終了）。`Restart=on-failure` は正常終了では
起動し直さない——つまり **リポジトリの内容をそのまま稼働機へ入れると、`system.restart` を
撃った瞬間に banto が上がってこなくなる**。

いま動いているのは、稼働機の側が手で直されている（あるいは古い）からで、**リポジトリは
稼働の姿を写していない**。

## なぜ危ないか

- `system.restart` は番頭が日常的に撃つ道具で、その復帰は systemd 任せ。ここが食い違うと
  **「撃ったら死ぬ」**という一番痛い形で出る（しかも撃つまで分からない）。
- どちらが正しいのかも、この起票の時点では決まっていない。**`always` にすべきなら
  リポジトリを直す／`on-failure` が正なら稼働機を直したうえで `system.restart` の終了コードを
  見直す**、のどちらか。**挙動を変える話なので PO の判断が要る。**

## 分かっていないこと

- 稼働機のユニットをいつ・誰が `always` に変えたか（履歴が残っていない）。
- 他のユニット（`banto-worker-pool.service` / `banto-environment-pool.service`）にも同種の
  食い違いがあるか——**まだ突き合わせていない**。

## いま踏まないための当座

**稼働機のユニットを、リポジトリの内容で上書きしないこと。** 上書きするなら、先にこの件を
決着させる。
