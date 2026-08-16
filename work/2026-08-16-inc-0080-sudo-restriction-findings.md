# inc-0080 — 自動エージェントの `sudo systemctl` を読み取り系に絞る：調査結果（フェーズ1）

- 日付: 2026-08-16
- 状態: **PO 判断待ちで保留**（案は用意済み・未配置）
- 出所: 枝「sudo を読み取り系に絞る」（幹「banto開発」）／職人 `9b54ef19` の実測
- 関連: `work/inbox/incident/inc-0080-agent-restarted-the-host-mid-conversation.md`, `work/inbox/improvement/imp-0080-workers-can-sudo-systemctl.md`

## 結論（先に）

1. **このホストで sudo が通るのは `opencode.service` 配下だけ。** banto の4ユニットは `NoNewPrivileges=true` で、TTY の有無以前に sudo が落ちる。
   → **`imp-0080`（職人が sudo systemctl を叩ける）は既に解消済み。** 縛るべき相手は `opencode.service` ただ1つ。
2. **番頭も職人も sudoers を読めない／書けない。** よってこの変更は **PO の手元 ssh** か **opencode 経由**でしか撃てない（委譲不能）。
3. **TTY 軸は成立する。** 人の操作だけが `TTY=` を持つ。PO の経路は巻き添えにならない。
4. **書き込み系 `sudo systemctl` に依存する自動運用は見つからない**（(d) は白）。

## 実測

### NoNewPrivileges の実効値

| unit | NoNewPrivileges |
|---|---|
| `opencode.service` | **no**（sudo が通るのはここだけ） |
| `banto.service` | yes |
| `banto-worker-pool.service` | yes |
| `banto-environment-pool.service` | yes |
| `banto-daemon.service` | yes |

職人の文脈では、pty を掴んでも `sudo: The "no new privileges" flag is set, which prevents sudo from running as root.` で落ちる。
`/etc/sudoers` は `-r--r----- root:root`、`/etc/sudoers.d` は `drwxr-x--- root:root` で非 root からは読めない。

### TTY の有無で人と自動が分かれるか

- 8/1 以降の sudo 実行 875件のうち `TTY=` を持つのは **23件、すべて人の操作**（`pts/N`・シリアルコンソール `ttyS0`）。
  人が `systemctl restart banto` を打った回も含まれる。
- **今日（8/16）の sudo 13件は全部 `_SYSTEMD_UNIT=opencode.service`・`audit_session=None`・TTY 無し。**
  - 06:34:58 `systemctl daemon-reload`（OOM の引き金）
  - **07:37:03 `systemctl restart banto.service` も人ではなく opencode**（従来「人が打った」と記録していたが誤り）
  - ほかに `tee` / `install` で `/etc/systemd/system/*.d/*.conf` を書く操作、`set-property --runtime ... MemoryMax=` 3回

### (d) 既存の自動運用への影響

- リポジトリのコードから `systemctl` を打つ箇所は **0件**（当たった3件はコメントと `packages/banto-worker-pool/src/resume.ts` の**禁止側**パターン `/systemctl/i`）
- `/etc/systemd/system/` の `Exec*` から systemctl を呼ぶユニット **0件**
- cron（`/etc/cron.d`・`cron.{daily,hourly,weekly,monthly}`）と timer 17件は **OS 標準のみ**、banto 由来なし
- **未確認**: `ubuntu` / `root` の crontab 本体（root 権限が要る）
- **`kill -9 <MainPID>` の道は無影響**: 4ユニットとも `User=ubuntu`、MainPID の所有者も ubuntu。同一 uid へのシグナルに sudo は不要（`kill -0` が rc=0）。
- **`systemctl --user` は元から使えない**: `XDG_RUNTIME_DIR` 無し・`loginctl enable-linger` 未設定でユーザ bus が存在しない（TTY の有無に関係なく `Failed to connect to bus`）。
  → **ユーザ単位常駐を既定にするなら、別途 root で `loginctl enable-linger ubuntu` が要る。**

## 入れる案（作成済み・未配置）

配置先: `/etc/sudoers.d/50-systemctl-write-requires-tty`
**ファイル名にドットを入れないこと**（`.` や `~` を含むファイルは sudo に無視される）。所有 `root:root`・パーミッション `0440`。

**本文（これが全文。`/tmp` にしか無いと消えるのでここに貼る）**

```
# inc-0080: 書き込み系の systemctl は TTY のあるときだけ許す（自動エージェントの誤射を止める）
Cmnd_Alias SYSTEMCTL_WRITE = \
    /usr/bin/systemctl restart *, /usr/bin/systemctl stop *, /usr/bin/systemctl start *, \
    /usr/bin/systemctl reload *, /usr/bin/systemctl try-restart *, /usr/bin/systemctl reload-or-restart *, \
    /usr/bin/systemctl kill *, /usr/bin/systemctl mask *, /usr/bin/systemctl unmask *, \
    /usr/bin/systemctl enable *, /usr/bin/systemctl disable *, /usr/bin/systemctl isolate *, \
    /usr/bin/systemctl set-property *, /usr/bin/systemctl edit *, /usr/bin/systemctl revert *, \
    /usr/bin/systemctl reset-failed *, /usr/bin/systemctl daemon-reload, /usr/bin/systemctl daemon-reexec, \
    /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/systemctl halt, \
    /bin/systemctl restart *, /bin/systemctl stop *, /bin/systemctl start *, /bin/systemctl daemon-reload, \
    /bin/systemctl daemon-reexec, /bin/systemctl kill *, /bin/systemctl mask *
Defaults!SYSTEMCTL_WRITE requiretty
```

- **文法の確定事項**: 引数つきコマンドを `Defaults!` に直書きするのは文法違反。`Cmnd_Alias` を定義して参照するのが唯一の書き方（man 5 sudoers に明記）。
- `visudo -c -f <file>` → `parsed OK`（sudo 1.9.15p5 / grammar 50）。**非 root でも構文検査だけは通る。**
- 読み取り系（`show` / `status` / `cat` / `list-units` / `is-active` / `is-enabled`）には **requiretty を当てない**（当てると自動の観測が死ぬ）。
- **既存の `Defaults !requiretty`（cloud-init が置くことがある）の有無は未確認**。配置前に `sudo grep -rn requiretty /etc/sudoers /etc/sudoers.d/` で確かめること。

## 限界（この案が守れないもの）

`requiretty` は**壁ではなく段差**である。次はいずれも素通りする:

- `sudo sh -c 'systemctl restart X'` / `sudo systemd-run` / `sudo kill <pid>`
- **`sudo tee` / `sudo install` で `/etc/systemd/system/*.d/*.conf` を書く**（今日の事故の前半そのもの）
  → `daemon-reload` だけが止まるので、**半端に書かれた設定が残る**形になる

迂回不能にしたいなら `opencode.service` に `NoNewPrivileges=true` を入れる（banto の4ユニットと一貫）。ただし opencode の sudo が全部止まるので、
**必要な特権操作だけを引数固定のラッパーにして `NOPASSWD:` で個別許可する**組み合わせが要る。

## 撃つ手順と戻し方

```sh
# 0) 現状を控える（既存 requiretty の確認もここで）
sudo cp -a /etc/sudoers /tmp/sudoers.bak.$(date +%s); sudo ls -la /etc/sudoers.d/; sudo grep -rn requiretty /etc/sudoers /etc/sudoers.d/
# 1) 上の本文を書く
sudo install -m 0440 -o root -g root /dev/stdin /etc/sudoers.d/50-systemctl-write-requires-tty <<'EOF'
（上の「本文」をそのまま貼る）
EOF
# 2) 配置直後に全体の構文検査。通らなければ即座に rm すること
sudo visudo -c && sudo -n true
# 3) 実測（的は存在しないユニット名なので実害ゼロ）
setsid --wait sh -c 'sudo systemctl restart banto-sudo-probe-nonexistent.service; echo exit=$?' </dev/null  # → "must have a tty" なら効いている
sudo systemctl restart banto-sudo-probe-nonexistent.service                                                  # → "Unit not found" なら PO の経路は生きている
sudo systemctl show banto.service -p MemoryMax; sudo systemctl status banto.service --no-pager | head -3     # → 読み取り系は通る
```

**デッドマン装置**（sudo 自体を壊しても15分で自動的に外れる。配置の前に張る）:

```sh
sudo setsid sh -c 'sleep 900; [ -f /tmp/sudo-guard-ok ] || rm -f /etc/sudoers.d/50-systemctl-write-requires-tty' >/dev/null 2>&1 &
# 全部確認できたら解除
touch /tmp/sudo-guard-ok
```

戻し方（1行）:

```sh
sudo rm -f /etc/sudoers.d/50-systemctl-write-requires-tty && sudo visudo -c
```

## PO 判断待ち（この3点が決まれば撃てる）

1. **誰が撃つか** — PO の手元 ssh / opencode に一度だけ打たせる
2. **`set-property --runtime` も塞ぐか** — opencode が今日3回、OOM 対処に使っている
3. **`requiretty` か `opencode` への `NoNewPrivileges=true` か** — 番頭の推し: まず requiretty で誤射を止め、NNP は特権用途を洗ってから第2段
