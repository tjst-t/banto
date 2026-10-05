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
| systemd の unit | `banto-host.service`（host）・`banto-frontend.service`（画面）。定義は `systemctl cat` で見る。ログは従来どおり `~/banto-host.log`・`~/banto-frontend.log` に追記される |

**起動・再起動は `systemctl` で行う。Claude Code のセッションから `nohup` などで起こさない**
——そのセッションの cgroup（`cloudcli.service`）に入り、cloudcli を再起動したときに banto も一緒に止まる
（2026-09-27 に踏んだ。これを受けて unit にした）。

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

3. build して、**途中で切れるものが無くなってから**起こし直す

   ```sh
   cd "$REL/banto"
   npm ci --include=dev
   npm run build
   node scripts/restart-when-idle.mjs
   ```

   `restart-when-idle.mjs` は、稼働中の host に「いま動いているもの」（`GET /api/admin/activity`）を数秒おきに聞き、
   **切れると結果が分からなくなるもの**（実行中の Module の呼び出し・「続けられる」と名乗らない Module の返事待ちの
   仕事）が無くなったら `systemctl restart banto-host.service banto-frontend.service` する。走っている AI のターン
   （文を書いている・考えている）・続けられる Module の仕事（サブエージェントの待たない仕事など）・人の返事待ちは、
   起き直したあと続くので待たない（アーキ仕様 §2.5「起こし直しをまたいで続ける」）。まず sudo 無しで打ち（D を済ませた
   host では polkit の規則で許されている）、断られたら（Interactive authentication required・Access denied）`sudo` で
   打ち直す——そのときは sudo のパスワードを聞かれることがある。待っている間は、待つものと起き直したあと続くものが出る。

   - 見るだけ：`node scripts/restart-when-idle.mjs --status`（再起動してよければ終了コード 0、待つものがあれば 1）
   - 今までどおり全部（走っているターン・返事待ちの仕事・人の返事待ちも）が空くまで待つ：`--all`
   - 待ちきれないとき：`--timeout <分>`（時間切れなら再起動せずに終わる）
   - `--ignore-waiting-on-human` は無くなった（人の返事待ちは既定で待たない）。打つと理由を出して止まる

   待つものが無いと見てから再起動するまでの間に、走っているターンが次の tool を呼ぶことはありうる。host は止める
   信号を受けたら新しい呼び出しを実行せずに断り（AI には「起き直したあとにもう一度呼んでください」が返る）、実行中の
   呼び出しを最長 60 秒待ってから止まる（systemd の止める上限 90 秒より短い。アーキ仕様 §2.5「いま動いているもの」）。Service で動かしているものはコンテナの
   中の systemd で動くので、数えない（host を起こし直しても切れない）。**動いている host が待つものを分けて返さない
   古い版のとき**（B では REL の新しいスクリプトが古い host に聞く）は、`--all` と同じに全部が空くまで待つ。
   **この口をまだ持たない版のとき**は 404 で止まる——その回だけは画面で確かめてから
   `systemctl restart banto-host.service banto-frontend.service`（D の前なら `sudo` を付けて）を手で打つ

4. A-6 の 1・2 で確かめる

**戻すとき**：`git -C "$REL" reset --hard <前のコミット>` → 3 をもう一度。前のコミットは
`git -C "$REL" reflog` で分かる。

> **D を済ませたあとは B を使わない**。設定の「更新」から行う（画面が開けないときは host で
> `node "$REL/current/banto/scripts/update.mjs" --now`）。D のあとの REL は版ごとのフォルダの形で、B の `git merge` は当てはまらない

---

## C. 人のログインに切り替える（2026-10-03 の版を初めて反映するとき、1回だけ）

この版から、画面は合言葉（`authToken`）を使わず、端末ごとのログイン（パスキー・端末を追加・host のリンク）で入る
（`docs/specs/v4-security.md`「人のログイン」）。合言葉は機械の口（`restart-when-idle.mjs` 等）にだけ残す。
**いまブラウザに覚えている合言葉は、新しい画面を開いた時点で消える**——この手順のリンクで入り直す。

1. **設定に画面の住所があるか確かめる**。無ければ足す（無いと画面のオリジンを `http://localhost:4175` とみなし、
   ログインが通らない）

   ```sh
   grep -E '"(publicUrl|uiOrigin)"' ~/.config/banto/config.json
   # 何も出なければ、config.json に "publicUrl": "https://banto.tjstkm.net" を足す（画面と同じ住所。末尾の / は無し）
   ```

2. **B の 1〜3 で反映する**（release へ上げる・REL に取り込む・build・`restart-when-idle.mjs`）。
   この時点ではまだ古い合言葉のまま動く

3. **合言葉を作り直し、ログインのリンクを出す**（REL の `banto` で）

   ```sh
   cd "$REL/banto"
   node scripts/login-link.mjs --rotate-machine-token
   ```

   作り直した合言葉は host を起こし直すまで効かない。**ここでは `restart-when-idle.mjs` を使えない**——設定の新しい
   合言葉で聞くので、古い合言葉で動いている host に断られる（401）。2 で起こし直した直後なので、そのまま打つ：

   ```sh
   sudo systemctl restart banto-host.service
   ```

4. **3 で出たリンクを、パソコンのブラウザで開く**（10分・1回だけ。切れたら `node scripts/login-link.mjs` で出し直す）。
   入ったら **設定 → ログイン → この端末のパスキーを登録**

5. **携帯を足す**：パソコンの **設定 → ログイン → 端末を追加** で出る QR を携帯で読む（読めなければ、リンクを携帯へ
   送って開く）。入ったら携帯でも **この端末のパスキーを登録**。「ログイン中の端末」に2台並ぶことを確かめる

6. **公開中のもの**：前から公開しているものは「認証なし」のまま残る（記録の認証は書き換えない）。banto のログインで
   守るなら、公開をやめて公開し直す（新しく公開するものは既定で banto のログイン）

**入れなくなったとき**：host で `node scripts/login-link.mjs` を打てば、いつでも新しいリンクが出る。

---

## D. 画面から更新できるようにする（一度だけ）

設定の「更新」から反映できるように、host を整える（仕組みは `docs/specs/v4-architecture.md` §2.5
「画面から banto を更新する」）。**`install.sh` で入れた host は、この D が済んだ形で入る**（install.sh が setup-update.sh を打つ。
`docs/runbooks/install.md`）——ここは手で組んだ host のための手順。やることは3つ：

- REL を版ごとのフォルダの形にする（`repo.git`・`versions/<commit>`・`current`）。今の clone はそのまま
  「今の版」として `versions/` に入る（組み立て直さない）
- `banto-host.service`・`banto-frontend.service` のパスを `current` を通す形に書き換える
- 更新用の unit（`banto-update.service`）と polkit の規則1つを入れる

これをまとめて行うのが `banto/scripts/setup-update.sh`（何度打っても壊れない）。**root の要る段（polkit・unit・規則・
規則が効いているかの確かめ）を先に済ませ、置き場を動かすのはそのあと**——sudo や polkit で止まっても、動いている
clone は元の場所のまま。

**スクリプトは置き場の外に写してから打つ**——1回目は置き場そのものを動かすので、`$REL/banto/scripts/` から直に
打つと、途中で止まったときに同じパスで打ち直せない。

1. **今の REL を最新にしておく**（B の 1〜3。この機能が入った版で動いていること）
2. **写して、何が変わるかを見る**（変えずに出すだけ）

   ```sh
   cp "$REL/banto/scripts/setup-update.sh" ~/banto-setup-update.sh   # 2回目からは $REL/current/banto/scripts/ から
   bash ~/banto-setup-update.sh --dry-run
   ```

   **変えるものがあるかだけを知りたいとき**は `bash ~/banto-setup-update.sh --check`（sudo を使わず、何も変えない。
   見たものを1行ずつ出し、終了コード 0＝何も変えない・1＝変えるものがある・2＝root でないと分からない所がある）。
   polkit の規則はこのユーザーには読めないので、止まっている `banto-update.service` の stop が許されるかで効き目を見る
   （更新が走っている間は見ない＝2）。install.sh は「要るときだけ setup を打つ」のにこれを使う

   画面のポートは `banto-frontend.service` の起動の仕方（ExecStart の `-p`、`npm run start` なら package.json の
   `scripts.start`、無ければ `PORT`）から読む。読めないと止まるので、そのときは
   `BANTO_UI_URL=http://127.0.0.1:4175/ bash ~/banto-setup-update.sh` のように指す

3. **行う**（最初に sudo のパスワードを聞かれる。最後に banto を起こし直すので、空いているときに）

   ```sh
   bash ~/banto-setup-update.sh
   ```

   - unit の元の定義と、元の clone の `.git` は `$REL.setup-backup/` に写してから書き換える
   - polkit の規則を置いたあと、`pkcheck` で「このユーザーに banto-update.service の start・stop、banto-host・
     banto-frontend の restart が許され、banto-host の stop は断られる」ことを確かめる。通らなければ止まる
     （polkit が古く JS の規則を読まない等。置き場はまだ動かしていない）
   - **途中で止まったら、banto を触らず（手で直さず・起こし直さず）、同じコマンドを打ち直す**
     （`bash ~/banto-setup-update.sh`）。どこまで済んだかは置き場の形から読み取って続きから行う

4. **確かめる**：
   1. 画面の 設定 → 更新 に今の版が出て、「準備が済んでいません」が出ない
   2. A-6 の 1・2 ももう一度（`cmd` が `~/.local/share/banto-release/current/...` になっている）
   3. A-6 の 3 ももう一度——ただしコンテナに見えるパスは **`~/.local/share/banto-release/versions/<commit の頭12>/banto`**
      になる（node が symlink を解いた本当のパスで動くため。`current` のままではない）

**戻すとき**：`$REL.setup-backup/units/` の定義を `sudo systemctl edit --full` で戻し、`sudo systemctl daemon-reload`・
restart。版のフォルダは `versions/` に残っているので、元のパスに戻すなら `setup-update.sh` が出した移し先を見る
