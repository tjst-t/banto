# host の側を守る（コンテナが資源を取り合っても banto と Incus を止めない）

**なぜ**：Project のコンテナには1台ごとの上限がある（`docs/specs/v4-security.md` §1「資源の上限を付ける」）が、
重い Project が同時にいくつも動くと、合わせて host の資源を越える。全 Project の合計の上限は Incus では掛けられない
（区画の上限は「書いた上限の合計」を数えるだけ・権限を絞った banto からは変えられない・コンテナの cgroup は
systemd の枠の外にできる。2026-10-02 に実測）。そこで、取り合いになったときに **host のサービス（incusd・banto）が
先に回る**ようにする。

**この手順は host で、sudo の使えるユーザー（ubuntu）で一度だけ行う。** Project のコンテナの中からはできない。
**直に再起動しない**——再起動は「再起動」の節の `restart-when-idle.mjs` で、動いているものが無くなってから。

## 1. CPU：host のサービスを先に回す（実測で効果を確認済み）

コンテナ（`/lxc.payload.*`）と `system.slice` は cgroup の同じ階層に並ぶ。`system.slice` の重みを上げると、
CPU が取り合いになったとき `system.slice` の中（incusd・banto-host・banto-frontend）が先に回る。取り合いが無ければ
何も変わらない（コンテナの上限も別に効いている）。

```sh
sudo mkdir -p /etc/systemd/system/system.slice.d
sudo tee /etc/systemd/system/system.slice.d/50-banto-protect.conf >/dev/null <<'CONF'
[Slice]
CPUWeight=1000
MemoryLow=4G
CONF
sudo systemctl daemon-reload
systemctl show system.slice -p CPUWeight -p MemoryLow   # CPUWeight=1000 / MemoryLow=4294967296
```

入れ子の環境での実測（2026-10-02）：1コアに絞ってコンテナと取り合わせたとき、host 側の処理の取り分は
既定で約47%、`CPUWeight=1000` で約81%。

## 2. メモリ：host のサービスのメモリを取り上げさせない（未実測）

上の `MemoryLow=4G` は、メモリが足りなくなったとき `system.slice` の 4GiB までは追い出されにくくする
（コンテナの上限の既定で host に残す量と同じ。2026-10-04 に 2G から 4G へ）。**これは実測していない**——効き目は、メモリが詰まったときの
`/sys/fs/cgroup/system.slice/memory.events` の `low` の数で見られる。

banto 本体が OOM で殺されないようにするには、banto の unit にだけ付ける。**ここでは再起動しない**——
効くのは次に起動したときなので、再起動は下の「再起動」で、動いているものが無くなってから1回だけ行う：

```sh
sudo mkdir -p /etc/systemd/system/banto-host.service.d /etc/systemd/system/banto-frontend.service.d
printf '[Service]\nOOMScoreAdjust=-800\n' | sudo tee /etc/systemd/system/banto-host.service.d/50-banto-oom.conf
printf '[Service]\nOOMScoreAdjust=-800\n' | sudo tee /etc/systemd/system/banto-frontend.service.d/50-banto-oom.conf
sudo systemctl daemon-reload
```

`daemon-reload` は設定を読み直すだけで、サービスを止めない（`system.slice` の設定はこの時点で効く）。

**incus.service には付けない**：コンテナの中のプロセスは incusd から起きるので、値を受け継いでコンテナまで
殺されにくくなるおそれがある（確かめていない）。

### 再起動（動いているものが無くなってから）

**`sudo systemctl restart` を直に打たない**——走っている会話・サブエージェントの仕事・Module の呼び出しが途中で
切れる。`restart-when-idle.mjs` が稼働中の host に「いま動いているもの」を聞き、無くなってから再起動する
（`docs/runbooks/release.md` B-3）：

```sh
node /home/ubuntu/.local/share/banto-release/banto/scripts/restart-when-idle.mjs --status   # 見るだけ
node /home/ubuntu/.local/share/banto-release/banto/scripts/restart-when-idle.mjs            # 空いたら再起動（Ctrl-C でやめられる）
systemctl show banto-host.service banto-frontend.service -p OOMScoreAdjust                  # OOMScoreAdjust=-800 が2つ
```

反映（release.md の B）と同じ機会に行うなら、build のあとの1回の再起動にまとめる。

## 3. 戻すとき

置いたファイルだけを消す。**`systemctl revert` は使わない**——その unit の上書きを全部消すので、
起動元をリリース用の clone に向けた書き換え（release.md の A-5）まで消えてしまう。

```sh
sudo rm -f /etc/systemd/system/system.slice.d/50-banto-protect.conf /etc/systemd/system/banto-host.service.d/50-banto-oom.conf /etc/systemd/system/banto-frontend.service.d/50-banto-oom.conf
sudo systemctl daemon-reload
node /home/ubuntu/.local/share/banto-release/banto/scripts/restart-when-idle.mjs
```

## 4. 残す量 4GiB を見直すための測り方

host で、banto と Incus がふだん使っている量を見る：

```sh
for u in incus.service banto-host.service banto-frontend.service; do
  echo "$u $(( $(cat /sys/fs/cgroup/system.slice/$u/memory.current) / 1048576 )) MiB (peak $(( $(cat /sys/fs/cgroup/system.slice/$u/memory.peak 2>/dev/null || echo 0) / 1048576 )) MiB)"
done
echo "system.slice 全体 $(( $(cat /sys/fs/cgroup/system.slice/memory.current) / 1048576 )) MiB"
```

`system.slice` 全体が 4GiB に近い・越えるなら、banto 全体の設定「コンテナ」で「この機械に残すメモリ」を上げ、
上の `MemoryLow` も合わせる。


## メモリが尽きる手前で止める（earlyoom、2026-10-11）

**なぜ**：Project ごとのコンテナの上限は「この機械の全メモリ − 4GiB」で、Project を足し合わせた上限は無い（Incus の区画では
掛けられない、上を参照）。複数の Project が同時に重い仕事をすると、どれも自分の上限に届かないまま機械のメモリが尽きる。
**swap の無い機械では、カーネルの OOM が動く前にキャッシュの捨て直しで数分固まる**——2026-10-11 02:32、Banto開発 の
`npm ci` と別の Project の esbuild が重なり、banto 本体が 293 秒止まって強制再起動になった。カーネルの記録では、最後に
止められたのは段2a で止められやすくした AI の仕事（+500）で、止める順番は狙いどおりだった——遅すぎただけ。

earlyoom は空きメモリを見張り、**空きが 10% を切ったら oom_score の一番高いプロセスに SIGTERM、5% で SIGKILL** を送る。
banto は AI の仕事（Shell のコマンド・サブエージェント・Factory のテスト）を +500、Service を +200、banto 本体を −800 に
しているので、止まるのは AI の仕事から。host の基幹（init・systemd・sshd・incusd・dnsmasq・caddy・dbus）は名前で避ける。
banto が固まっていても効く（別のプロセス）。

host で一度：

```sh
sudo apt-get install -y earlyoom
sudo tee /etc/default/earlyoom >/dev/null <<'EOF'
EARLYOOM_ARGS="-m 10,5 -s 100 -r 3600 -p --avoid '(^|/)(init|systemd|systemd-journal|sshd|incusd|dnsmasq|caddy|dbus-daemon)$'"
EOF
sudo systemctl enable earlyoom
sudo systemctl restart earlyoom
journalctl -u earlyoom -n 5 --no-pager    # 「sending SIGTERM when mem <= 10.00%」と出れば効いている
```

`-s 100` は swap の条件を常に満たすため（swap の無い機械でもメモリだけで判断する。swap がある機械ではこの値を下げる）。
止めた記録は `journalctl -u earlyoom` に「sending SIGTERM to process … "名前"」で残る。新しく入れる機械は install.sh が入れる。
