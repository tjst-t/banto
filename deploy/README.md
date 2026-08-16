# deploy/ — 稼働機に入れる systemd の一式

banto は4本のサービスに分かれている。

| unit | 役 | port |
| --- | --- | --- |
| `banto.service` | 番頭ホスト | 4100 |
| `banto-worker-pool.service` | 職人（Worker Pool） | 4300 |
| `banto-environment-pool.service` | 検証環境（Environment Pool） | 4400 |
| `banto-daemon.service` | Kobo（統治基盤） | 4500 |

このほかに `system.slice.d/oom.conf` が要る（slice の drop-in。unit ではない）。

---

## 新しい機械への入れ方

前提: `ubuntu` ユーザの ghq チェックアウト
（`/home/ubuntu/ghq/github.com/tjst-t/banto`）で `npm install` と `npm run build:web`
が済んでいること。`/var/lib/banto` を `ubuntu` が読み書きできること。

```bash
cd /home/ubuntu/ghq/github.com/tjst-t/banto

# 1. unit ファイルを置く（symlink ではなく**コピー**。稼働機もそうなっている）
sudo install -m 644 deploy/banto.service \
                    deploy/banto-daemon.service \
                    deploy/banto-worker-pool.service \
                    deploy/banto-environment-pool.service \
                    /etc/systemd/system/

# 2. system.slice の drop-in を置く（**これを飛ばすと MemoryMin が全部黙って効かない**。
#    理由は deploy/system.slice.d/oom.conf の中に書いてある）
sudo install -d -m 755 /etc/systemd/system/system.slice.d
sudo install -m 644 deploy/system.slice.d/oom.conf \
                    /etc/systemd/system/system.slice.d/oom.conf

# 3. 反映して起動
sudo systemctl daemon-reload
sudo systemctl enable --now banto-daemon banto-worker-pool banto-environment-pool banto
```

### 入ったことの確かめ方

```bash
for u in banto banto-daemon banto-worker-pool banto-environment-pool; do
  echo "== $u"
  systemctl show "$u" -p MemoryAccounting -p MemoryMax -p MemoryMin \
    -p MemoryHigh -p OOMPolicy -p OOMScoreAdjust -p TasksMax
done
systemctl show system.slice -p MemoryMin
```

期待する値（バイト表記で出る）:

| unit | MemoryMax | MemoryMin | OOMPolicy | OOMScoreAdjust | TasksMax |
| --- | --- | --- | --- | --- | --- |
| `banto` | 5G | 1G | stop | -500 | （既定） |
| `banto-worker-pool` | 8G | 0 | **continue** | +500 | 2048 |
| `banto-daemon` | 1G | 256M | stop | -500 | （既定） |
| `banto-environment-pool` | 1G | 256M | stop | -500 | （既定） |
| `system.slice` | — | 1536M | — | — | — |

---

## 重なりの注意 — **drop-in が残っている限り drop-in が勝つ**

systemd は unit ファイルを読んだあとに drop-in（`*.service.d/*.conf`）を重ねる。
**同じキーは後勝ち**なので、unit ファイル側の値を直しても、drop-in に同じキーが
残っていれば drop-in の値のままになる。

drop-in は2種類あり、優先順は下ほど強い:

1. `/etc/systemd/system/<unit>.service.d/*.conf` — **恒久**。手で置いた drop-in
2. `/run/systemd/system.control/<unit>.service.d/*.conf` — **一時**。
   `systemctl set-property --runtime` が置く

いま実際に効いている重なりは、これで全部見える:

```bash
systemctl cat banto.service        # unit ファイル + 重なる drop-in を全部（順に）表示
systemd-delta --type=extended      # 上書きされている箇所の一覧
```

### 稼働機の現状（2026-08-16 時点）

- `/etc/systemd/system/<unit>.service.d/oom.conf` に**恒久の値**が入っている。
  ただし**その中身はまだ古い値（`banto` 3G / `banto-worker-pool` 9G）**で、
  この README と `deploy/*.service` の新しい値（5G / 8G）とは食い違っている
- そのうえに `systemctl set-property --runtime` の**一時の上限**が乗っている
  （`banto` 5G / `banto-worker-pool` 8G）。凌ぎであって恒久の値ではない

そのため、**移行が済むまでは、`deploy/*.service` の値をそのまま入れても実効値は
変わらない**（`/etc/.../oom.conf` の drop-in が勝つ）。恒久の値を unit ファイル側へ
寄せ切るなら、対応する `oom.conf` を消してから `daemon-reload` すること
（**これは root の作業＝PO の操作**）。

**恒久側が古いままだと、`--runtime` が消えるたびに再発する。**
一時の drop-in（`/run`）は恒久の drop-in（`/etc`）より**先**に読まれ、同じキーは
後勝ちなので `/etc` 側が勝つ。実際 2026-08-16 06:34:58 に `sudo systemctl daemon-reload`
が打たれた1秒後、`banto` の一時の 5G は恒久の 3G に上書きされ、3G に当たって
OOM kill された（inc-0077）。**`/run` にファイルが残っていても効いていない**
——「ファイルが在る＝効いている」ではない。確かめるなら:

```bash
systemctl show banto.service -p DropInPaths   # 読まれる順に出る（後ほど強い）
systemctl show banto.service -p MemoryMax     # いま実際に効いている値
```

### `--runtime` は機械の再起動で消える

`systemctl set-property --runtime ...` の drop-in は `/run` に置かれる。

- **サービスの再起動では消えない**（`/run` は残るため。実測で確認済み）
- **機械（VM）の再起動で消える**。`/run` は tmpfs なので飛ぶ

つまり `--runtime` で入れた上限は、次の reboot で黙って無くなる。
恒久にしたい値は必ずこのリポジトリの `deploy/` に書き、上の手順で置き直すこと
（そうしないと、機械を作り直した瞬間に封じ込めが消え、2026-08-14 の事故に戻る）。

一時の上限を今すぐ剥がしたいときは、値を空にする:

```bash
sudo systemctl set-property --runtime banto.service MemoryMax=
```

---

## OOM 封じ込めの値の根拠

値そのものの導出（MemTotal 15.6 GiB の内訳、なぜ番頭が 5G・工房が 8G か、
なぜ `OOMPolicy=continue` か、`prlimit` / `ulimit -v` を却下した理由）は、
設定のすぐ横のコメントに要約してある。一次資料は次の3本:

- `2026-08-14-oom-containment-plan.md` — 事故の一次記録と、値の導出・却下した案
- `2026-08-14-oom-stage2-addendum-cgroup-v2.md` — 第2段（職人1本ごとの cgroup 隔離）
- `2026-08-16-oom-host-facts.md` — 封じ込めが入った後の実測と kill の一次記録

置き場は稼働機の `/home/ubuntu/banto-desk/reports/`（リポジトリ外）。

**数字だけ写して根拠を落とさないこと。** 上限を動かすときは、まず
`system.slice.d/oom.conf` の合計と、上の内訳（番頭 5G + 工房 8G + Kobo 1G +
検証環境 1G = **15 GiB ≦ MemTotal 15.6 GiB**）が崩れないかを確かめる。
**上限は予約ではない**ので、総和が MemTotal を超えていても普段は動く。だが4つが
同時に上限近くまで伸びた瞬間に **VM ごと死ぬ**（2026-08-14 の global OOM がその形）。
工房を 9G のままにすると 16 GiB になり、まさにその形になる。

### 2026-08-16 の改訂（番頭 3G → 5G / 工房 9G → 8G）

判断の基準は「**上限が実測ピークより低ければ、当たるのは『時間の問題』ではなく、
もう当たっている**」。

- 番頭の実測は平常 **2.6〜3.0 GiB**（会話を触るたびに `claude` の子プロセスが増える
  構造。詳細は **inc-0077**）。3G はその実測ピークより低い
- 3G のまま **2026-08-15〜16 に5回 OOM kill**（8/15 13:59:54 / 14:46:40 / 22:56:25、
  8/16 00:48:38 / 06:34:59）。いずれも `oom_memcg=/system.slice/banto.service`、
  `memory: usage 3145728kB, limit 3145728kB`（3G にきっかり当たっている）
- 総和を MemTotal に収めるため、番頭に足した分を工房から引いた（9G → 8G）

**これで足りる、とは書かない。** 同じ日の実測では**工房は 8G でも落ちている**
（`memory.events` の `oom_kill` が 116 → 139）。この改訂は「もう当たっている状態を
解く」ためのもので、**根治ではない**。根治は次の3本:

- **task-0186** — 検証を袋の外で回し、結果も切り詰める
- **task-0165** — アイドルな会話のセッションを畳む
- **task-0168** — 同時に走る職人の本数の上限

---

## そのほか

- `pi-auth.json.example` — `~ubuntu/.pi/agent/auth.json` の雛形（`chmod 600`）
