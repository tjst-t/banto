# 稼働中の banto をリリース用の clone から動かす

**なぜこうするか**は `docs/specs/v4-security.md` §2「稼働中の banto は、開発用とは別の clone から動かす」。
要点：開発用のリポジトリから動かすと、banto で banto を開発する Project の AI が書き換えたコードが、
次の再起動で host の権限のまま動く。

**この手順は host で、banto を動かしているユーザー（ubuntu）で行う。** Project のコンテナの中からは
host のプロセスも、Project の根の外も見えないので、中の AI にはできない。

| 名前 | 場所 |
|---|---|
| 開発用のリポジトリ（DEV） | `~/ghq/github.com/tjst-t/banto` |
| リリース用の clone（REL） | `~/.local/share/banto-release` |
| 動かすブランチ | GitHub の `release` |
| 稼働中の口 | host 4737（サンドボックス 4176 も同じプロセス）・画面 4175 |

設定（`~/.config/banto/config.json`）とデータ（`~/.local/share/banto`）はコードの場所に依らない
（`packages/core/src/config/bootstrap.ts`）ので、切り替えても変わらない。

```sh
DEV=~/ghq/github.com/tjst-t/banto
REL=~/.local/share/banto-release
```

---

## A. 初回：開発用のリポジトリから切り替える

### A-1. いまの起動のされ方を控える

```sh
for p in 4737 4175; do
  pid=$(ss -ltnpH "sport = :$p" | grep -oP 'pid=\K[0-9]+' | head -1)
  echo "== port $p pid=$pid"
  ps -o unit=,user= -p "$pid"
  echo "cwd: $(readlink /proc/$pid/cwd)"
  echo "cmd: $(tr '\0' ' ' < /proc/$pid/cmdline)"
done
```

- `unit` に出た名前（例 `banto-host.service`）を控える。以下 `UNIT_HOST`・`UNIT_UI` と書く
- ユーザーの unit なら以下の `sudo systemctl` を `systemctl --user` に読み替える
- **unit で動いていなかったら**（手で起動していた等）、A-5 は「止めて、REL で同じコマンドを打ち直す」に読み替える
- 元に戻せるよう、定義を写しておく：

```sh
systemctl cat UNIT_HOST > ~/banto-unit-backup-host.txt
systemctl cat UNIT_UI   > ~/banto-unit-backup-ui.txt
```

### A-2. 開発用のリポジトリで git を打つ前に確かめる

開発用の `.git` は Project のコンテナの中から書き換えられる。**host で git を打つと、そこに書かれたものが動く**。

```sh
ls "$DEV/.git/hooks" | grep -v '\.sample$'          # 何も出ないのが普通
git config --file "$DEV/.git/config" --list | grep -iE '^(core\.(hookspath|fsmonitor|sshcommand|pager|editor)|include|alias)'   # 何も出ないのが普通
```

見覚えのないものが出たら、ここで止めて中身を見る。

### A-3. `release` ブランチを GitHub に上げる

`release` は 2026-09-27 に DEV で作ってある（この手順書を足したコミット）。

```sh
git -C "$DEV" push origin release
```

> このとき DEV の `main` は GitHub より先に進んでいる（2026-09-27 時点で6コミット）。`release` はその上にあるので、
> **それらのコミットも GitHub の `release` として公開される。**

### A-4. clone して build する

```sh
git clone --branch release https://github.com/tjst-t/banto "$REL"
cd "$REL/banto"
npm ci --include=dev      # NODE_ENV=production だと devDeps が黙って落ちるので --include=dev
npm run build             # core・Module・画面（apps/frontend/.next）をまとめて
```

`vault-infisical/dev/` の `.env` などは E2E 用で、稼働中の banto には要らない（git に入っていないので REL には無い）。

### A-5. unit の起動元を書き換えて起こし直す

```sh
sudo systemctl edit --full UNIT_HOST
sudo systemctl edit --full UNIT_UI
```

どちらも、**`/home/ubuntu/ghq/github.com/tjst-t/banto` を `/home/ubuntu/.local/share/banto-release` に置き換える**
（`WorkingDirectory`・`ExecStart`・`EnvironmentFile` など、出てくる所すべて）。置き換えたパスが実在するか：

```sh
systemctl cat UNIT_HOST UNIT_UI | grep -o '/home/ubuntu/.local/share/banto-release[^ "]*' | sort -u | xargs -r ls -d
```

全部出れば（`No such file` が無ければ）起こし直す：

```sh
sudo systemctl daemon-reload
sudo systemctl restart UNIT_HOST UNIT_UI
```

### A-6. 切り替わったことを確かめる

1. **起動元**：A-1 のループをもう一度。`cwd` と `cmd` が両方の口で `~/.local/share/banto-release/...` になっている
2. **動くこと**：ブラウザで banto を開き、どこかの Project で1回話しかけて返事が来る
3. **コンテナの中**：banto 開発の Project で AI に「読み取り専用の件を確かめて」と頼む。AI が見るのは：
   - `/proc/self/mountinfo` に `~/.local/share/banto-release/banto` が **ro** で出ている
   - `~/.local/share/banto-release/banto` に書き込もうとすると `Read-only file system` で断られる
   - `…/ghq/github.com/tjst-t/banto/banto` への ro のマウントが無くなっている

   コンテナへの付け直しは、その Project の Module が起きるときに host がする（`project-container.ts` の
   `ensureNow`）。**Project を開いて話しかけてから**確かめる

### A-7. うまくいかなかったら戻す

```sh
sudo systemctl edit --full UNIT_HOST   # A-1 で写した ~/banto-unit-backup-host.txt の中身に戻す
sudo systemctl edit --full UNIT_UI
sudo systemctl daemon-reload
sudo systemctl restart UNIT_HOST UNIT_UI
```

---

## B. 2回目から：変更を反映する

1. **A-2 と同じ確かめ**をしてから、出したいコミットを GitHub の `release` に上げる

   ```sh
   git -C "$DEV" push origin <出したいコミット>:refs/heads/release
   ```

2. REL に取り込む。**早送りで済まなければ止まる**（REL で誰かが手を入れていたら気づける）

   ```sh
   cd "$REL"
   git status --short               # 何も出ないこと
   git fetch origin
   git diff --stat HEAD origin/release   # 何が入るかを見る
   git merge --ff-only origin/release
   ```

3. build して、**動いているものが無くなってから**起こし直す

   ```sh
   cd "$REL/banto"
   npm ci --include=dev
   npm run build
   node scripts/restart-when-idle.mjs
   ```

   `restart-when-idle.mjs` は、稼働中の host に「いま動いているもの」（`GET /api/admin/activity`）を数秒おきに聞き、
   走っているターン・返事待ちの仕事（待たない形で頼んだサブエージェントなど）・Module の呼び出しが無くなったら
   `sudo systemctl restart banto-host.service banto-frontend.service` する。待っている間は、何が残っているかが出る。

   - 見るだけ：`node scripts/restart-when-idle.mjs --status`（空なら終了コード 0、動いていれば 1）
   - 承認や質問の返事待ちで止まっているターンだけなら待たない：`--ignore-waiting-on-human`
   - 待ちきれないとき：`--timeout <分>`（時間切れなら再起動せずに終わる）

   空いたと見てから再起動するまでの間に新しいターンが始まることはありうる（受け付けを止める仕組みはまだ無い）。
   Service で動かしているものはコンテナの中の systemd で動くので、数えない（host を起こし直しても切れない）。
   **動いている host がこの口をまだ持たない版のとき**は 404 で止まる——その回だけは画面で確かめてから
   `sudo systemctl restart banto-host.service banto-frontend.service` を手で打つ

4. A-6 の 1・2 で確かめる

**戻すとき**：`git -C "$REL" reset --hard <前のコミット>` → 3 をもう一度。前のコミットは
`git -C "$REL" reflog` で分かる。
