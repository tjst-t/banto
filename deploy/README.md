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
| `banto` | 3G | 1G | stop | -500 | （既定） |
| `banto-worker-pool` | 9G | 0 | **continue** | +500 | 2048 |
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
  この README と `deploy/*.service` は、その内容と一致させてある
- そのうえに `systemctl set-property --runtime` の**一時の上限**が乗っている
  （`banto` 5G / `banto-worker-pool` 7G）。凌ぎであって恒久の値ではない

そのため、**移行が済むまでは、`deploy/*.service` の値をそのまま入れても実効値は
変わらない**（`/etc/.../oom.conf` の drop-in が勝つ）。恒久の値を unit ファイル側へ
寄せ切るなら、対応する `oom.conf` を消してから `daemon-reload` すること。

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

値そのものの導出（15.62GiB の内訳、なぜ工房が 9G か、なぜ `OOMPolicy=continue` か、
`prlimit` / `ulimit -v` を却下した理由）は、設定のすぐ横のコメントに要約してある。
一次資料は次の3本:

- `2026-08-14-oom-containment-plan.md` — 事故の一次記録と、値の導出・却下した案
- `2026-08-14-oom-stage2-addendum-cgroup-v2.md` — 第2段（職人1本ごとの cgroup 隔離）
- `2026-08-16-oom-host-facts.md` — 封じ込めが入った後の実測と kill の一次記録

置き場は稼働機の `/home/ubuntu/banto-desk/reports/`（リポジトリ外）。

**数字だけ写して根拠を落とさないこと。** 上限を動かすときは、まず
`system.slice.d/oom.conf` の合計と、上の内訳（OS 1.5G + 番頭 3G + Kobo 1G +
検証環境 1G + 工房 9G = 15.5GiB < 15.62GiB）が崩れないかを確かめる。

---

## そのほか

- `pi-auth.json.example` — `~ubuntu/.pi/agent/auth.json` の雛形（`chmod 600`）
