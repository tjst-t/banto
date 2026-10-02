# host の側を守る（コンテナが資源を取り合っても banto と Incus を止めない）

**なぜ**：Project のコンテナには1台ごとの上限がある（`docs/specs/v4-security.md` §1「資源の上限を付ける」）が、
重い Project が同時にいくつも動くと、合わせて host の資源を越える。全 Project の合計の上限は Incus では掛けられない
（区画の上限は「書いた上限の合計」を数えるだけ・権限を絞った banto からは変えられない・コンテナの cgroup は
systemd の枠の外にできる。2026-10-02 に実測）。そこで、取り合いになったときに **host のサービス（incusd・banto）が
先に回る**ようにする。

**この手順は host で、sudo の使えるユーザーで一度だけ行う。** Project のコンテナの中からはできない。

## 1. CPU：host のサービスを先に回す（実測で効果を確認済み）

コンテナ（`/lxc.payload.*`）と `system.slice` は cgroup の同じ階層に並ぶ。`system.slice` の重みを上げると、
CPU が取り合いになったとき `system.slice` の中（incusd・banto-host・banto-frontend）が先に回る。取り合いが無ければ
何も変わらない（コンテナの上限も別に効いている）。

```sh
sudo mkdir -p /etc/systemd/system/system.slice.d
sudo tee /etc/systemd/system/system.slice.d/50-banto-protect.conf >/dev/null <<'CONF'
[Slice]
CPUWeight=1000
MemoryLow=2G
CONF
sudo systemctl daemon-reload
systemctl show system.slice -p CPUWeight -p MemoryLow   # CPUWeight=1000 / MemoryLow=2147483648
```

入れ子の環境での実測（2026-10-02）：1コアに絞ってコンテナと取り合わせたとき、host 側の処理の取り分は
既定で約47%、`CPUWeight=1000` で約81%。

## 2. メモリ：host のサービスのメモリを取り上げさせない（未実測）

上の `MemoryLow=2G` は、メモリが足りなくなったとき `system.slice` の 2GiB までは追い出されにくくする
（コンテナの上限の既定で host に残す量と同じ）。**これは実測していない**——効き目は、メモリが詰まったときの
`/sys/fs/cgroup/system.slice/memory.events` の `low` の数で見られる。

banto 本体が OOM で殺されないようにするには、banto の unit にだけ付ける：

```sh
sudo systemctl edit banto-host.service    # 開いた所に下の2行を書く
#   [Service]
#   OOMScoreAdjust=-800
sudo systemctl edit banto-frontend.service   # 同じ
sudo systemctl restart banto-host.service banto-frontend.service
```

**incus.service には付けない**：コンテナの中のプロセスは incusd から起きるので、値を受け継いでコンテナまで
殺されにくくなるおそれがある（確かめていない）。

## 3. 戻すとき

```sh
sudo rm /etc/systemd/system/system.slice.d/50-banto-protect.conf
sudo systemctl revert banto-host.service banto-frontend.service
sudo systemctl daemon-reload && sudo systemctl restart banto-host.service banto-frontend.service
```

## 4. 残す量 2GiB を見直すための測り方

host で、banto と Incus がふだん使っている量を見る：

```sh
for u in incus.service banto-host.service banto-frontend.service; do
  echo "$u $(( $(cat /sys/fs/cgroup/system.slice/$u/memory.current) / 1048576 )) MiB (peak $(( $(cat /sys/fs/cgroup/system.slice/$u/memory.peak 2>/dev/null || echo 0) / 1048576 )) MiB)"
done
echo "system.slice 全体 $(( $(cat /sys/fs/cgroup/system.slice/memory.current) / 1048576 )) MiB"
```

`system.slice` 全体が 2GiB に近い・越えるなら、banto 全体の設定「コンテナ」で「この機械に残すメモリ」を上げ、
上の `MemoryLow` も合わせる。
