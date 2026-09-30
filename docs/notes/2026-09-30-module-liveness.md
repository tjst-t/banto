# 止まった・黙った Module を見つけて起こし直す（2026-09-30）

決まったことは `docs/specs/v4-architecture.md` §5.4-0「止まった Module は起こし直す」。ここは経緯と却下した案。

## 何が起きたか

ユーザー報告：「理由がわからないけど、また Ctrl-K で Module の UI が全部消えた。Tool も消えてる」。
前日の件（`2026-09-29-shell-output-limit.md`。Shell が 10 MiB を越えた返事で切れた）とは別の原因だった。

| 時刻（UTC） | 出来事 |
|---|---|
| 06:56:43 | banto を再起動（release の反映）。コンテナの中の4本（filesystem・service・shell・subagent）が繋がる |
| 06:57:22 | `unattended-upgrade` が `libssl3t64`/`openssl` を上げる |
| 06:57:25 | 古い libssl を使っていたサービスが再起動される。**`incus.service` も対象**（incus-base が入れる `/etc/needrestart/conf.d/incus.conf` は `incus-lxcfs` しか外していない）。ssh・journald・fwupd なども同時に |
| 〜07:02:25 | 旧 incusd が終わるまで約5分。この間の別 Project のコンテナ起動は `Error: Shutting down` で失敗し、**宣言が変わるまで試さない**と覚えられた |
| 07:02:25 | 旧 incusd が終わる。コンテナの中の filesystem・service・shell は消え、subagent は孤児で残る |
| 以降 | host から呼ぶたびに `MCP error -32001: Request timed out`。`/ui-launchers` は 500 |

**なぜ閉じずに黙ったか**：ubuntu は `incus` グループ（`incus-admin` ではない）なので、`incus exec` は incusd では
なく**ユーザー用の中継デーモン incus-user** に繋がる（`ss -xp` で相手を確かめた）。incus-user は再起動されず、
クライアントとの接続を ESTAB のまま持ち続けた。host からは標準入出力が開いたままに見え、20分たっても
`incus exec` のプロセスは生きていた。

## 直したこと

1. **生きているかを確かめる**：MCP の `ping`（仕様の Ping——健全性を確かめるために定期的に送ってよい）を
   15 秒ごと、1回 10 秒まで。2回続けて答えなければ止まったとみなす（`modules/liveness.ts`）。
   Kubernetes の liveness probe と同じ考え方
2. **止まった Module を起こし直す**：台帳から外し、プロセスを確実に落とし（黙っている `incus exec` は
   閉じるまで残る）、間を置いて起こし直す。間は 5 秒から倍々、上限 5 分。あきらめない。10 分動き続けたら
   数え直す（`modules/connect-backoff.ts`、Kubernetes の CrashLoopBackOff）。起こすときは宣言を引き直す
3. **一覧は1本の失敗で落とさない**：`listResourcesOfAll` を、答えない1本だけ落とす形に
4. **ログに残す**：接続の異常（`client.onerror`——SDK の既定は握りつぶし）・止まったこと・起こし直したこと

あわせて、**繋げなかったことを「宣言が変わるまで」覚える**のをやめ、上と同じ間で試し直すようにした。
今回の `Error: Shutting down` のような一時的な失敗が、host の再起動まで戻らなかったため。お知らせは
続いた失敗の最初の1回だけ（試し直すたびに出すと、人が確認したものがまた出る）。

## 確かめたこと

- E2E `module-restart.spec.ts`（本物のコンテナ）：Shell 自身に自分のプロセスへ `SIGTERM`（止まる）・
  `SIGSTOP`（繋がりは残ったまま黙る——incusd の再起動のときと同じ見え方）を送らせ、**プロセスの番号が
  変わって答える**まで待つ。黙っている間も `/ui-launchers` は 200 で、Command Palette に「ファイル」が出る。
  起こし直した後、次のターンで AI の道具として Shell を使える
- 直す前の host では `MCP error -32603: Not connected` のまま戻らずに落ちた（09-29 の本番と同じ）
- 最初に書いた試験は、シグナルが届く前（1秒後に送る）の古い Shell が答えたのを「戻った」と見て通っていた。
  答えただけでは見分けがつかないので、**プロセスの番号が変わったこと**を印にした

## 却下した案

- **自動更新のあとに Incus を再起動させない**（needrestart の `override_rc`）——ユーザー判断で不要。
  Incus 本体の更新では結局再起動されるうえ、incusd へのセキュリティ修正が遅れる。起きる回数を減らすだけ
- **次に使われたときだけ起こす（遅延のみ）**——走っているターンの AI は、次のターンまで道具を失ったまま。
  画面を開いた瞬間に起こす形だと、その要求が起動を待つ（コンテナの待ちで最大 30 秒）
- **何回か失敗したらあきらめる**（systemd の StartLimitBurst）——incusd の再起動のような「数分で直る」ものを
  取りこぼす。Kubernetes と同じく間を伸ばすだけにした

## 残っていること

- 孤児になった subagent のプロセス（コンテナの中）は残る。合言葉は失効しているので中継は通らないが、
  プロセスは次にコンテナを止めるまで生きている。他の Module は標準入力が閉じると自分で終わるが、
  subagent は何かに生かされている（未調査）
- E2E の後始末はコンテナを先に消すので、その回の host は Module が止まったとみなして起こし直しを予約する。
  host がすぐ止まるので実害は無い（残ったコンテナは次の回の起動時にも片づく）
