---
id: inc-0080
kind: incident
status: open
severity: high
created: 2026-08-16
refs: [inc-0077, imp-0080]
---

# 自動のエージェントが番頭ホストを再起動した（走行中の会話が切れる）

## 事実（journal そのまま）

```
Aug 16 07:37:03 banto sudo[4052651]: ubuntu : PWD=/home/ubuntu/ghq/github.com/tjst-t/banto ;
                                     USER=root ; COMMAND=/usr/bin/systemctl restart banto.service
```

その `sudo` の素性：

```
_SYSTEMD_UNIT=opencode.service
_SYSTEMD_CGROUP=/system.slice/opencode.service
```

**打ち手は人の対話セッション（`session-*.scope` / `sshd`）ではなく、`opencode.service` の配下**である
——**自動のエージェントのセッションから、番頭ホストが再起動された。**

**同じ日の 06:34:58 にも、同じ `opencode.service` の配下から `sudo systemctl daemon-reload` が打たれ、
その1秒後に番頭が OOM kill されている**（`--runtime` の一時上限が `/etc` の恒久値 3G に上書きされたため。
経緯は inc-0077）。**同じ経路で、同じ日に2回、番頭ホストが落ちている。**

**注意（取り違えないこと）**：`opencode.service` は **banto の職人（`banto-worker-pool.service`）ではない**。
banto の工房の職人は `banto-worker-pool.service` の配下で走る。**別系統のエージェントである。**
**ただし「自動のエージェントが sudo で systemctl を叩ける」という性質は同じ**で、
**線引きの議論（imp-0080）はどちらにも当てはまる。**

## 何が起きるか

- **`systemctl restart banto.service` は、走行中の会話をすべて切る。**番頭のターンは中断され、
  進行中の応答は失われる（会話の記録は残るが、**そのターンは戻らない**）。
- 今日は**記録の欠落（inc-0075）と壊れた行の永久消失**が、まさに「書き込みの途中で殺される」ことから起きている。
  **再起動そのものが、記録を壊す窓を開ける。**
- **07:37:03 の再起動は、結果としては無害だった**（メモリは 2.7 GiB＝上限の54%で、OOM ではない。
  新しい上限 5G/8G を効かせるための反映と読める）。**問題は結果ではなく、「誰でも打てる」という構造。**

## 判断が要ること（**PO**）

**線引きの案と比較は imp-0080 にまとめてある**（取り上げる／読み取りだけ許す／許すが番頭へ知らせる／何もしない）。
**この事故は、その議論に「2件目の実例」を足すものである。**

番頭の推しは変わらず **(b) 読み取り系だけ許す**（`show` / `cat` / `status`）。
**理由**：今日の調査で自動のエージェントが実際に使ったのは**ほぼ読み取りだけ**であり、
**書き換えが要る場面は、そもそも人の判断が要る場面**でもある。

**なお `restart` は `daemon-reload` より重い**——`daemon-reload` は設定を読み直すだけだが、
**`restart` は走行中の会話を確実に切る**。**線引きを1段だけ入れるなら、まず `restart` / `stop` を止めること。**

## 出所

- `journalctl _PID=4052651 -o verbose`（2026-08-16 実測）
- `journalctl -u banto.service --since "2026-08-16 07:20" --until "2026-08-16 07:45"`
  （同時間帯に**カーネルの OOM 記録は無し**＝落ちたのではなく止められた）
- inc-0077（06:34:58 の `daemon-reload` → 06:34:59 の OOM kill）
