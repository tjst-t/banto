# 07-landlock-allowlist-from-path — Landlock 許可リストを `PATH` から組めるか

**問い**（`docs/specs/v4-modules.md` §5 の未決）：Landlock の許可リストを
`/usr` 等の**固定リスト**にすると環境によって壊れるのではないか。
起動時に `PATH` を読んで**動的に**組めば直るか。

手法は `poc/00-prior-2026-08-30/landlock2.py` と同じ（Python + ctypes で
`landlock_create_ruleset` / `add_rule` / `restrict_self` を直叩き）。
Landlock は一度掛けると外せないので、**実験ごとに子プロセスを起こす**。

```
python3 landlock_allowlist.py     # 全実験。出力は run-output.txt に保存済み
```

計測環境：kernel **6.8.0-137-generic**、Landlock **ABI 4**、
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin`、
`node`/`npm` は `/usr/local/bin`、`git` は `/usr/bin`。

---

## 結論（先に）

1. **`PATH` 由来の動的許可リストは機能する。** node / npm / git がすべて動き、
   Project の根の中だけ読み書きでき、ホーム配下の資格情報は読めない
2. **ただし「PATH のディレクトリを許す」だけでは足りない。**
   `PATH` に置かれているのは**入口の symlink** であることが多く、実体は
   `PATH` の外にある（`/usr/local/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js`）。
   **実測で npm が起動しなくなった**
3. **前提の一部は誤りだった。** 「固定リストは `/usr/local/bin` を取りこぼす」は
   **成り立たない**——`/usr/local/bin` は `/usr` の**下**なので、
   `landlock2.py` の固定リストでも node/npm/git は動いた（実測）。
   **固定リストが実際に壊れるのは、PATH がホーム配下や `/opt`・`/snap` を
   指したとき**（nvm・asdf・Homebrew）。これも実測で再現した
4. **PATH に含めたディレクトリの中身は、全部読める。** Landlock の
   ルールはディレクトリ単位で、ファイル単位の除外は無い（ABI 4 時点）。
   **PATH に入れるディレクトリに資格情報を置かない、という運用上の前提に依存する**

---

## 実験と実測値

`run-output.txt` が生の出力。

| モード | 許可リストの作り方 |
|---|---|
| `baseline` | Landlock なし（対照） |
| `fixed` | `landlock2.py` の固定リスト（`/usr`,`/lib`,`/lib64`,`/bin`,`/etc`,`/proc`,`/dev`）＋ Project の根 |
| `fixed-home` | 上に加えて `PATH` の先頭にホーム配下の偽 nvm bin を置く |
| `path` | `PATH` の各ディレクトリ＋`ld.so.conf` 由来のライブラリ＋`/etc`,`/proc`,`/dev`＋Project の根 |
| `path-nolocallib` | `path` から `/usr/local/lib` を抜く（symlink の実体に届かない状況の再現） |
| `path-resolved` | `path-nolocallib` ＋ PATH 内 symlink の**実体のディレクトリ**を足す案 |
| `path-home` | `path` ＋ `PATH` にホーム配下の偽 nvm bin |
| `path-prefix` | `path-home` の各 `.../bin` の**親（導入先）ごと**足す案 |
| `path-siblings` | `path-home` の各 `.../bin` の**兄弟 `lib`/`lib64`/`libexec`/`share` だけ**足す案 |

### ツールが動いたか

| モード | `node --version` | `npm --version` | `git --version` | 根の読み書き |
|---|---|---|---|---|
| `baseline` | OK | OK | OK | OK |
| `fixed` | **OK** | **OK** | OK | OK |
| `fixed-home` | OK | OK | OK | OK（ただし偽 nvm の実行は**拒否**） |
| `path` | OK | OK | OK | OK |
| `path-nolocallib` | OK | **起動できず (EACCES)** | OK | OK |
| `path-resolved` | OK | **失敗 (rc=1, `node:fs`)** | OK | OK |
| `path-home` | OK | OK | OK | OK |
| `path-prefix` | OK | OK | OK | OK |
| `path-siblings` | OK | OK | OK | OK |

### 根の外（**すべての閉じ込めモードで同じ**）

| 対象 | 結果 |
|---|---|
| `~/.claude/.credentials.json`（実在） | **拒否** |
| `~/.ll-poc-credentials.json`（ダミー） | **拒否** |
| `~/.bashrc` | **拒否** |
| Project の根の外の一時ファイル | **拒否** |

`baseline` ではすべて読めた（対照が効いていることの確認）。

---

## 分かったこと（順に）

### 1. `/dev` は読み取りだけでは足りない

最初の試行で **`git --version` が落ちた**：

```
fatal: could not open '/dev/null' for reading and writing: Permission denied
```

`git` は `/dev/null` を `O_RDWR` で開く。`/dev` に **`WRITE_FILE` を足す**必要がある
（`landlock2.py` の固定リストは `/dev` を読み取り＋実行だけで許していたので、
**あのリストのままでは git が動かない**——比較を成立させるため、
この PoC では固定リスト側の `/dev` にも書き込みを足してある）。

### 2. 固定リストが壊れるのは「`/usr` の外」であって「`/usr/local/bin`」ではない

`which node` が `/usr/local/bin/node` であることは事実だが、
**`/usr/local/bin` は `/usr` の部分木**なので、`/usr` を許せば覆われる。
`fixed` モードで node も npm も動いた——**当初の懸念のうち、この点は外れ**。

固定リストが**実際に**壊れるのは `PATH` が `/usr`・`/bin` の外を指す場合：
`fixed-home`（`PATH` の先頭にホーム配下の bin）では、

```
偽 nvm bin の実行ファイル -> 起動できず(PermissionError)
```

nvm（`~/.nvm/versions/node/vXX/bin`）・asdf（`~/.asdf/shims`）・
Linuxbrew（`/home/linuxbrew/.linuxbrew/bin`）・snap（`/snap/bin`）は
**すべてこの形**。**懸念そのものは正しく、根拠が違っていた。**

### 3. 「PATH のディレクトリを許す」だけでは npm が動かない

`/usr/local/bin/npm` は symlink で、実体は
`/usr/local/lib/node_modules/npm/bin/npm-cli.js`。**Landlock は解決後のパスで
判定する**ので、`/usr/local/lib` 側を許さないと開けない。

この環境では `/usr/local/lib` が **`/etc/ld.so.conf.d/libc.conf` に載っていた**ため、
「ライブラリのディレクトリ」として**偶然**許可されていた。抜いてみる（`path-nolocallib`）と：

```
npm --version -> 起動できず(PermissionError: [Errno 13] Permission denied: 'npm')
```

**`PATH` だけでは不十分。** nvm 配下では `~/.nvm/versions/node/vXX/lib/node_modules`
が同じ位置にあり、これは `ld.so.conf` には載らない——**偶然に頼れない。**

### 4. 「symlink の実体を足す」案は不十分、かつ一度**危険な方向に外した**

`path-resolved`（PATH 内 symlink の実体があるディレクトリを足す）を最初に書いたとき、
`os.path.dirname(os.path.realpath(p))` としていた。結果、
**`/usr/bin/X11 -> /usr/bin`** の dirname が **`/usr`** になり、
**`/usr` 全体が許可リストに紛れ込んだ**。npm は動いたが、それは
「案がうまくいった」からではなく**許可リストが静かに広がったから**だった
（規則1：測る前に犯人を決めない——この行を直してから測り直した）。

symlink がディレクトリを指す場合を直して測り直すと：

```
npm --version -> 失敗(rc=1) ['node:fs:441']
```

`npm-cli.js` の**入っているディレクトリ**だけでは足りない
（`../lib/npm.js`・`../node_modules/` を読む）。**この案は採らない。**

### 5. 動いた案は2つ

- **`path-prefix`**：`PATH` の `.../bin` の**親ごと**許す
  （`/usr/local/bin` → `/usr/local`）。動くが、`/usr/bin` の親は `/usr` なので
  **結局ほぼ固定リストと同じ広さに戻る**
- **`path-siblings`**：`.../bin` の**兄弟 `lib`/`lib64`/`libexec`/`share` だけ**足す
  （`/usr/local/bin` → `/usr/local/lib`, `/usr/local/share`）。
  **node/npm/git すべて動き、`path-prefix` より狭い**

**`path-siblings` が、実測した中では一番狭くて全部動く形。**

### 6. ホーム配下が `PATH` にある場合の境界（本題）

`path-home`（`PATH` に `~/.ll-poc-nvm/versions/node/v99.0.0/bin` を追加）の実測：

| 対象 | 結果 |
|---|---|
| その bin の実行ファイル | **動く** |
| `~/.claude/.credentials.json` | **拒否**（ホーム全体が開くわけではない） |
| `~/.bashrc` | **拒否** |
| 許可した bin の**中**に置いた `.npmrc-with-token` | **読めた** |
| その bin の**隣**（`../lib/secret.txt`） | **拒否** |

**懸念は実測で確認された。** ディレクトリ単位のルールなので、
**許可した `PATH` ディレクトリの中に置かれた機微なファイルは読める。**
一方、**ホームディレクトリ全体が開くことはない**——`PATH` エントリの
**その一段だけ**が開く。

さらに `path-prefix` / `path-siblings` では**兄弟の `lib` も開く**ので、
`../lib/secret.txt` も**読めた**。**動かすために広げると、露出も広がる**
——この交換関係は消せない。

### 7. 存在しないディレクトリは黙って飛ばさない

`/snap/bin` はこの環境に無い。`landlock2.py` は `os.path.exists` で黙って
skip していたが、**この PoC では「不在なので追加せず」と出す**（規則2）。
本実装でも**握りつぶさない**——PATH の綴り間違いで静かに壊れるのを防ぐ。

---

## 運用上の前提（隠さず書く）

- **`PATH` に含まれるディレクトリに資格情報を置かない**、という前提に依存する。
  Landlock ABI 4 にファイル単位の除外は無いので、**機構では守れない**
- 現実に危ないのは `~/.local/bin`・`~/bin`・プロジェクトの `node_modules/.bin`
  のような**人が自由に物を置くディレクトリ**が `PATH` にある場合
- **`PATH` は shell の環境変数であり、AI が書き換えられる**。
  許可リストを組むのに使う `PATH` は **banto 側が確定させた値**でなければならず、
  **Shell の中で `export PATH=...` されても許可リストは変わらない**
  （Landlock は掛けた後は追加も緩和もできないので、この性質は自動的に満たされる。
  ただし**起動時に読む `PATH` を誰が決めるか**は設計事項）
- `/etc` を読み取りで許す限り `/etc/passwd` 等は読める（`landlock2.py` の時点で
  既知）。この PoC はそこを狭めていない

---

## 仕様へ反映すべきこと（提案。反映は別途）

- `docs/specs/v4-architecture.md` §2.7「実務上の落とし穴が2つ」に**3つ目**を足す
  ——**許可リストは `PATH` から動的に組む。固定リストは PATH がホーム配下や
  `/opt`・`/snap` を指す環境（nvm・asdf・Homebrew・snap）で壊れる。**
  合わせて「`PATH` のディレクトリだけでは足りない（symlink の実体が外にある）」
  「`/dev` は書き込みも要る」を書く
- 同 §2.7 の実測表に「`git --version` は `/dev` に `WRITE_FILE` が要る」を足す
- `docs/specs/v4-modules.md` §5-2 の「Landlock 許可リストの粒度」を
  **未決から外し、決定として書く**（この PoC で決められる）。
  残す未決は「`PATH` を誰が確定させるか」と
  「`PATH` 内に機微ファイルを置かない前提を運用でどう担保するか」

---

**捨てる。本実装に流れ込ませない。**
