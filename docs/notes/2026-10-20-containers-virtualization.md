# containers で仮想化の実験——実測（2026-10-20）

仕様：`docs/specs/v4-security.md` §1「`containers` で仮想化の実験——/dev/kvm と特権」。

## 場所

- ベアメタル `banto@10.10.254.50`（下ごしらえのスクリプトで作ったユーザー、uid 1001、incus グループ、NOPASSWD の sudo）
- Ubuntu 26.04.1・72 コア・256GB・Intel（入れ子 Y、kvm_intel）・カーネル 7.0.0-38・Incus 7.5.1（Zabbly）
- 区画 `user-1001`（incus-user が作ったもの）。置き場 `banto`（btrfs）。/ は ext4 98GB
- 測るときだけ、Vault の `test-baremetal-server-ssh-key` を人が banto の authorized_keys に足した（終わったら外す）

## 区画の既定

```
restricted: "true"
restricted.containers.nesting: allow
restricted.devices.disk: allow
restricted.devices.disk.paths: /home/banto
restricted.devices.gpu: allow
restricted.devices.proxy: allow     # core の準備で足したもの
restricted.idmap.uid/gid: "1001"
restricted.networks.access: incusbr-1001
```

既定のままでは：`incus config device add … unix-char` → "Unix character devices are forbidden"、`security.privileged=true` →
"Privileged containers are forbidden"、`linux.kernel_modules` → "Use of low-level config … is forbidden"。

## 特権無し＋`restricted.devices.unix-char=allow`

コンテナ `vt-a`（`images:ubuntu/24.04`、`security.nesting=true`、置き場 banto）。

- `/dev/kvm`・`/dev/vhost-net` を unix-char（`mode=0666`）で足せた。`/dev/net/tun` は既定で見える（足そうとすると「既にある」で失敗）
- qemu 8.2.2 で cirros 0.6.3 を起動：`-accel kvm -cpu host` で `Hypervisor detected: KVM`、init まで 0.92 秒（ゲストの時計）。
  `-accel tcg` は 2.54 秒。メタデータを待つので login までは測れていない
- `ip link add br0 type bridge`・`ip tuntap add tap0 mode tap`・`vxlan`・`macvlan`・`veth` すべて作れた。`ip_forward` は書ける
- qemu を `-netdev tap,vhost=on` で起こすと、qemu が `/dev/kvm`・`/dev/net/tun`・`/dev/vhost-net` を開いていた
- `docker.io` を入れて `docker run` が動く。containerlab 0.81.1（get.containerlab.dev）で alpine 2 台＋bridge のトポロジーを
  deploy し、r1→r2 に ping が通った
- `docker run --privileged` の中で qemu を `-accel kvm` で起こすと `Hypervisor detected: KVM`（vrnetlab の VM のノードの形）

足りないもの：

- `modprobe dummy` → "Module dummy not found"（中に `/lib/modules` が無い）。`/proc/sys/net/bridge` が無い（br_netfilter がサーバで
  読まれていない）
- `sysctl -w vm.nr_hugepages=64` は通るが値は 0 のまま。`mount -t hugetlbfs` は permission denied

埋め方（どちらも効いた）：

- 区画に `restricted.containers.lowlevel=allow`、コンテナに `linux.kernel_modules=br_netfilter,dummy` → 起こし直すとサーバで読まれ、中で
  `ip link add d0 type dummy`・`/proc/sys/net/bridge/*` が使えた
- サーバで `sysctl vm.nr_hugepages=128`、`mount -t hugetlbfs -o uid=1001,gid=1001,mode=0770 none /home/banto/vt-hugepages`、
  コンテナに disk device で `/dev/hugepages` → qemu `-m 128 -mem-path /dev/hugepages` の間、サーバの HugePages_Free が 128→64

## 特権あり（`restricted.containers.privilege=allow`）

コンテナ `vt-b`（`security.privileged=true`、`volatile.idmap.current: []`）。作るのに時間がかかった（測りのコマンドが 300 秒で切れた。
原因は見ていない）。

- 中で `id -u` 0、uid_map は `0 0 4294967295`
- `mount -t hugetlbfs` は通る。`sysctl -w vm.nr_hugepages=16` は値が 0 のまま（中からは確保できない）
- `modprobe` は特権でも中に `/lib/modules` が無く失敗
- `/dev/kvm` は `root:kvm 0660`（unix-char を mode 無しで足した。特権無しの vt-a は `mode=0666` で足した）

→ 今回の範囲では、特権でないと動かないものは無かった。

## 片づけ

コンテナ2つとイメージを消し、区画の設定を測る前の控え（`incus project show` の YAML）から `incus project edit` で戻して差分が無いことを
確かめ、hugepages を 0、hugetlbfs を外してフォルダを消し、`modprobe -r dummy br_netfilter`。

## 測っていないこと

- 特権コンテナで、中のユーザー（1000）と VM の SSH ユーザー（1001）の番号が食い違い、見せたフォルダに書けない件（仕様の 3.）
- 中の AI から Incus の口に届かないこと（特権のコンテナで）
- 長い負荷での速さ、本物のルータのイメージ（SR Linux・vrnetlab）、既定のモジュールの組
