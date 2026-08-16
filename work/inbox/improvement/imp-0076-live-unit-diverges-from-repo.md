---
id: imp-0076
kind: improvement
status: open
severity: medium
created: 2026-08-16
refs: [task-0166, task-0178, task-0179, imp-0055, imp-0075, imp-0077]
---

# 稼働機の systemd ユニットとリポジトリが別物——リポジトリに無い設定が稼働機にだけ在る

## これは task-0166 / task-0179 の隣にある問題

`task-0166` / `task-0179`（OOM 封じ込めの systemd 設定を `deploy/*.service` に書き戻す）は
「**稼働機だけに在る状態をやめる**」という同じ問題を、OOM の設定について直している。
**この起票は、同じ問題が他の設定にも在ることの報告**である。片方だけ直しても残る。

## 何が在るのか（2026-08-16 実測）

`task-0178` の作業で、稼働機のユニットを `deploy/banto.service` と突き合わせた。
**構成そのものが違う。**

| | 稼働機 | リポジトリ（`deploy/banto.service`） |
|---|---|---|
| 形 | 古い本体 ＋ **drop-in 4枚** | **本体1枚に統合** |
| `Restart=` | 本体は `on-failure`、`override.conf` が `always` で上書き | 本体に `always` |
| OOM 設定 | `oom.conf`（drop-in） | 本体に統合 |
| `BANTO_PROVIDER` / `BANTO_MODEL` | **本体に残っている**（もう読まれない値） | 削除済み（コメントで理由を明記） |

稼働機の drop-in: `kobo.conf` / `oom.conf` / `override.conf` / `pools.conf`
（加えて `/run/systemd/system.control/banto.service.d/50-MemoryMax.conf` に
`systemctl set-property --runtime` の一時上限 5G。**機械の再起動で消える**）。

## 危ないのはここ——**リポジトリのどこにも無い設定**

```
Environment=BANTO_HOST_BIND=0.0.0.0          （override.conf にだけ在る）
Environment=BANTO_KOBO_URL=http://127.0.0.1:4500/api/kobo   （kobo.conf にだけ在る）
```

**`deploy/banto.service` を稼働機へ `cp` するだけなら、drop-in は残るので即死はしない。**
問題は次の一手である:

> 「本体に統合したのだから、drop-in はもう要らない」

**この判断をした瞬間、`BANTO_HOST_BIND=0.0.0.0` が消える。**
リポジトリの本体には「**既定では 127.0.0.1 しか待ち受けない**」と書いてあるので、
banto はループバックだけを向き、**PO から見えなくなる**。
`BANTO_KOBO_URL` も同様に消え、Kobo への到達先が既定へ落ちる。

**つまり「リポジトリと同期する」つもりの操作が、そのまま到達不能を招く。**
しかも壊れるのは再起動した後なので、**打つまで分からない**。

## どうするか（案）

1. **まず、稼働機にだけ在る値をリポジトリへ書き戻す。**
   特に `BANTO_HOST_BIND` は、**なぜ `0.0.0.0` なのか**（前段が居るのか）を
   コメントに書いたうえで載せること。値だけ移すと、次に読む人が判断できない。
   なお `BANTO_HOST_BIND=0.0.0.0` そのものの妥当性は **`imp-0077` で別に扱う**。
2. **本体1枚に寄せるのか、drop-in を正とするのか、どちらかに決める。**
   いまは「リポジトリは統合派・稼働機は drop-in 派」で**思想が割れている**。
   割れている限り、同期のたびにこの事故が起きうる。
3. **同期の手順を書く。** 「`cp` して `daemon-reload` して `restart`」だけでは足りない——
   **drop-in をどうするか**が抜けていると、上の事故が起きる。

## 今日はどうしたか（前例として残す）

`task-0178` で環境変数を1つ足す必要が生じたが、**本体の差し替えはしなかった**。
稼働機の流儀に合わせて **drop-in を1枚足すだけ**にした
（`/etc/systemd/system/banto.service.d/browser.conf`）。理由:

- 要るのは環境変数1つで、本体を差し替える必要が無い
- **元に戻すのがファイル1枚消すだけ**で済む（可逆）
- 本体の差し替えは、上に書いた事故の入口になる

**リポジトリ側（`deploy/banto.service`）にも同じ環境変数を書いた**——
稼働機だけに在る設定を、こちらが新しく作らないため。
**つまり「本体を差し替える」という宿題は先送りしただけで、消えていない。**

## おまけ：比較対象を間違えると、正しい報告を潰す（番頭の失敗の記録）

この突き合わせの最中、番頭は職人の報告を**誤って訂正した**。

職人は「ブランチ側の `deploy/banto.service` には `MemoryMax` が無い」と報告した。
番頭は `git diff e7c2efed -- deploy/banto.service`（ブランチ **vs 分岐元**）が
「差分なし」であることを見て、「それは誤りだ」と訂正した。

**訂正の方が誤りだった。** 分岐した後に `task-0179`（`eb1d825f`）が main の
`deploy/banto.service` へ OOM 設定を書き戻していたため、**`分岐元 ≠ main`** になっていた。
職人は**実際の main と**比べて正しく報告していた。

**教訓：「ブランチと比べる」ときは、何と比べているのかを言うこと。**
`git diff <分岐元>` は「自分が何を変えたか」であって「main とどう違うか」ではない。
main が動いている日には、この2つは別物になる。**疑うのは仕事だが、疑い方が雑だと正しい報告を潰す。**

## 番号の取り方——**欠番は埋めない**（2026-08-16 の実例つき）

この一連の作業で札を3枚起こしたとき、`imp-0073` が**欠番**で `imp-0074` が
**既に別の誰かに取られていた**。番頭は**欠番を埋めず、`imp-0075` から取った**。

理由：**欠番は異常ではない**（振り直しや取り下げで自然に空く）。埋めると、
**過去の文書やコミットに残っている「昔の imp-0073」への参照と衝突する**。
番号は「空いているから使ってよい席」ではなく、**一度使われたら二度と再利用しない識別子**である。

**その判断は同じ日のうちに裏付けられた。**
番号をぶつけた側——`inc-0077` が2つ（`inc-0077-banto-host-oom-killed-repeatedly` と
`inc-0077-latency-threshold-tests-swing-with-host-load`）——が、
記録の id 一意性の試験2件を落とし、**main を赤にした**。
**欠番を避けた側（`imp-0075`〜`0077`）は無事だった。**

関連：`imp-0055`（記録の id が衝突する）・`task-0159`（決定番号を本当に一意にする）。

## 出所

- `diff -u /etc/systemd/system/banto.service <repo>/deploy/banto.service`（2026-08-16）
- `systemctl cat banto.service`（本体＋drop-in 5枚の全文）
- `systemctl show banto.service -p Environment -p DropInPaths -p MemoryMax -p Restart`
- `task-0178`（共有ブラウザ K2）の着地作業・マージコミット `881371a8`
