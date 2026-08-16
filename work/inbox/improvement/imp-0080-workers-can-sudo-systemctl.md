---
id: imp-0080
kind: improvement
status: open
severity: high
created: 2026-08-16
refs: [inc-0077, imp-0079]
---

# 職人が `sudo systemctl` を叩ける（それが番頭ホストを落とした）

## 事実（2026-08-16・journal そのまま）

```
Aug 16 06:34:58 banto sudo[3862725]: ubuntu : PWD=/home/ubuntu/ghq/github.com/tjst-t/banto ;
                                     USER=root ; COMMAND=/usr/bin/systemctl daemon-reload
Aug 16 06:34:58 banto systemd[1]: Reloading requested from client PID 3862727 ('systemctl') (unit opencode.service)...
Aug 16 06:34:59 banto systemd[1]: Reloading finished in 651 ms.
Aug 16 06:34:59 banto kernel: ... oom_memcg=/system.slice/banto.service ...
                             Killed process (MainThread) ... 以下 claude 5本
```

- **職人のセッション（`unit opencode.service`、PWD はリポジトリ）から `sudo systemctl daemon-reload` が打たれた。**
- **その1秒後、番頭ホストが OOM kill され、再起動した**（`claude` 5本を巻き添え）。
- 機構は inc-0077 に書いたとおり：`daemon-reload` で drop-in が読み直され、
  **`--runtime` で入れていた 5G が `/etc` の恒久値 3G に上書きされ**、2.6〜3.0 GiB を使う番頭が即座に上限に当たった。

**打った職人に落ち度は無い。** `daemon-reload` は unit ファイルを扱う仕事では普通の操作である
（当時、稼働機の unit とリポジトリの食い違い＝`imp-0076` まわりの仕事が動いていた）。
**問題は「打てること」そのもの**——**routine な操作が、無関係な番頭ホストを落とせる。**

## なぜ重いか

- **職人は、自分が何を落とすか知らない。** 職人には「番頭ホストの上限がいま一時設定で持ち上がっている」
  という文脈が無い（**職人は記憶を持たない**）。**知りようがないことで事故が起きる形は、作法では防げない。**
- **落ちるのは番頭ホスト＝PO の会話そのもの**である。今日は記録の欠落（inc-0075）にも繋がっている。
- **`daemon-reload` に限らない。** `systemctl restart` / `stop` / `set-property` も同じ権限で打てる。

## 線引きの案（**決めるのは PO**）

| 案 | 何が起きるか | 費用 |
|---|---|---|
| (a) **職人から `systemctl` を取り上げる**（sudoers で拒否） | 事故は止まる。**unit を扱う仕事が職人にできなくなる**——その種の仕事は PO か番頭が手で打つ | 小（sudoers 1行）／運用が増える |
| (b) **読み取り系だけ許す**（`show` / `cat` / `status`） | 調査は職人にできる。**変更は人が打つ**。今日の事故は止まる | 小〜中（sudoers の書き方） |
| (c) **`daemon-reload` は許すが、番頭へ知らせる** | 事故は止まらないが、**気づける**（落ちた理由が即分かる） | 中（通知の経路が要る） |
| (d) **何もしない** | 同じ事故が起きる。**ただし恒久側を実測に合わせれば（task-0196）、`daemon-reload` が引き金にならなくなる** | 0 |

**補足**：**task-0196（恒久の上限を 5G/8G に直す）が着地すれば、`daemon-reload` を打たれても
上限は下がらない**——今日の事故の「引き金」は消える。**それでも `systemctl restart` / `stop` は残る**ので、
**(d) は「今日の形」だけを塞ぐ選択である。**

## 番頭の推し

**(b)。** 職人に要るのは**ほぼ読み取りだけ**である（今日の調査でも `show` / `cat` / `status` しか使っていない。
**書き換えが要る場面は、そもそも人の判断が要る場面**でもある）。**(d) と併せて task-0196 を通すこと。**

**これは統治の線引きなので、決めるのは PO。** 番頭は勝手に sudoers を触らない。
