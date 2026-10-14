---
title: 困ったとき
description: 入れる・動かすときに出るものと、見るところ。
---

| 出たもの | 見るところ |
|---|---|
| 「段「…」で止まりました」 | その下の「直し方」。直して同じコマンドを打ち直す（済んだ段は飛ばします） |
| banto が起きない | `tail -50 ~/banto-host.log`・`systemctl status banto-host` |
| https が通らない | `journalctl -u caddy -n 50`（証明書の取得・設定の誤り） |
| 更新できなかった・前の版に戻った | 画面の 設定 → 更新 の「ログを開く」、または `~/.local/share/banto/update/` の下のログ |
| Project の Module が繋がらない | `cd ~/.local/share/banto-release/current/banto && node packages/container/dist/doctor.js` |
| ログインのリンクが切れた | `cd ~/.local/share/banto-release/current/banto && node scripts/login-link.mjs` |
| 「HTTPS で開いてください」と出る | http で開いています。`https://<名前>/` で開き直してください |

## マシンのメモリが足りなくなる

Project のコンテナには、メモリ・CPU・プロセス数の上限が付いています（既定はマシンの資源から計算します）。上限に当たると受信箱に知らせが届きます。**設定 → 資源** で、マシン全体と Project ごとに何がどれだけ使っているかを見られます。

上限は **設定 → コンテナ**（banto 全体）と、Project の設定の「コンテナ」（その Project だけ下げる）で変えられます。
