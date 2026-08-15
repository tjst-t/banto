---
id: inc-0073
kind: incident
status: fixed
severity: high
created: 2026-08-15
refs: [inc-0038, imp-0043, inc-0029, inc-0064, imp-0062, task-0075, task-0080, task-0084, task-0089, task-0093]
---

# 検証環境は「ワークツリーのとき」だけ構造的に落ちる（Kobo を開けられなかった理由）

## 起きたこと

banto 自身を Kobo に載せて回そうとすると、**監査もマージ前ゲートも、中身と無関係に
落ち続ける**。マージ前ゲート（`packages/banto-daemon/src/merge-gate.ts`）は受け入れ条件の
コマンドを検証環境（`test` プロファイル）の中で走らせるので、器が通らない限り何を積んでも
溜まるだけになる。そのため Kobo の積む口とマージキューを止めたままにしてあった。

これまでの枝（thread-97 / thread-105）は「今回に効く試験だけ名指しで通す」で凌いでいて、
原因は「`@anthropic-ai/claude-agent-sdk` が器に入らないらしい」までしか割れていなかった。

## 分かったこと

**この症状は main のチェックアウトでは再現しない。ワークツリーのときだけ起きる。**
そして原因は独立した2つだった。2026-08-15、`env.verify` で実測（すべて機構が返した事実）。

| 何を | repoPath | 結果 |
|---|---|---|
| `npm test` | main のチェックアウト | 通る（2341件 / fail 0 / exit 0） |
| `npm run typecheck` | main のチェックアウト | 通る（exit 0） |
| `npm test` | node_modules の無い素のワークツリー | 大量に落ちる |
| 器の中で手で `npm ci` してから `npm test` | 同じワークツリー | fail 1 まで減る |

工場は必ずワークツリーで回る。だから工場でだけ落ちていた。**「手元では通るのに工場では落ちる」
の正体はこれ**で、8月13日に工場を止めてから今日まで、ここが塞がっていなかった。

### 原因1: 置き場（cache）が `npm ci` の出力を全部覆っていない

`@anthropic-ai/claude-agent-sdk`（と `@anthropic-ai/sdk`）は**巻き上げられず**、
`packages/banto-host/node_modules` と `packages/banto-worker-pool/node_modules` に
入れ子で入る（`package-lock.json` にその鍵で並んでいる。ルートの `node_modules/@anthropic-ai/`
には主パッケージが無く、古い 0.3.226 の platform 用パッケージだけが残っている）。

ところが `docker/test.yaml` が置き場として bind mount していたのは
`${BANTO_CACHE_DIR}:/app/node_modules` の**1本だけ**。そして
`packages/banto-environment-pool/src/pool.ts:1009` は

```ts
if (resolved.profile?.setup && !primed && !setupDone) { … }
```

——**置き場に `.banto-primed` の印があれば `npm ci` を打たない**。

つまり「置き場は温まっている＋ワークツリーは素」という組み合わせで、
ルートの node_modules は置き場から現れるのに、**入れ子の分だけが黙って欠ける**。
実測では素のワークツリーで `ls node_modules | wc -l` が 350 なのに
`packages/banto-host/node_modules` は存在しなかった。

**要点は「置き場が `setup` の出力を全部覆っている」という前提が成り立っていなかったこと。**
npm の workspace では、巻き上げられない依存は置き場の外（＝ワークツリー側の bind mount）へ
書かれる。`primed` は置き場についての印であって、`setup` の出力全体についての印ではない。

これは imp-0043（マージ前ゲートの検証環境に node_modules が無い）と同じ家系だが、あちらで
挙がっていた `NODE_ENV=production` は**今回の原因ではない**——SDK は `dependencies` に居るし、
器の中で `NODE_ENV` は空だった（実測）。

### 原因2: リンクされたワークツリーでは器の中で git が使えない

ワークツリーの `.git` は**ファイル**で、中身は
`gitdir: /home/ubuntu/ghq/github.com/tjst-t/banto/.git/worktrees/<名前>`。
このパスは器に mount されていない（compose は `..:/app` しか渡していない）ので、
器の中の `git ls-files` は `fatal: not a git repository: (null)` / exit 128 になる。
`git` バイナリ自体は `/usr/bin/git` に在る。

これで `tests/acceptance/source-hygiene.spec.ts`（inc-0029 の再発防止・追跡ファイルに
NUL が無いこと）が**ワークツリーでは必ず落ちる**。main のチェックアウトは `.git` が
本物のディレクトリなので通る——上の表と矛盾しない。

**そしてこれは新顔ではない。inc-0038（status: resolved）と同じ穴で、その直し（task-0084）が
効いていなかった。** task-0084 は「本体の `.git` を同じ絶対パスで read-only に見せる」を
docker ドライバの **`run` の側**に入れていた（`resolveWorktreeGitdirMount(runWorkdir)`）。
ところが基点の `workdir` は任意の引数で、`env.verify` が `repoPath` だけで呼ばれると
`run` の側では決まらない——**mount の `-v` が出ないまま素通りしていた**。
「直したことになっていたが、実際には一度も効いていなかった」種類の穴で、
`status: resolved` がそれを覆い隠していた。

## 判断：試験側を弱めず、器を直した

「SDK は器に入る必要があるのか（入らないのが正しくて、試験を SDK 無しで通る形に直すべきでは
ないか）」を検討したが、**採らなかった**。

- SDK は認証も外部通信も要らない、ただの npm パッケージ。器の中に現に置ける
  （手で `npm ci` を打てば揃う）。入らなかったのは**置き場の配置の穴**であって、
  依存の性質ではない。贋物で置き換えれば、ハーネス周りの実物を一切検証しないまま
  緑になる——直す動機が消える方向なので採れない。
- 原因2も同じ。**検証環境はワークツリーを写したものであるべきで、git だけ欠けているのは
  器の不備**。試験を skip させると、inc-0029 の再発防止が工場では一切効かなくなる。

つまり**どちらも「分離」ではなく「器を直す」で決着させた**。黙って除外したものは無い。

## 直し

枝 `fix/env-container-parity` の2コミット（`c96c3b1e` / `e0134886`)を
`ede88825` で main へマージ。

**直しA（`c96c3b1e`）— 置き場が `npm ci` の出力を全部覆うようにする**

- `docker/test.yaml` / `docker/dev.yaml` の置き場を小部屋に分けて張る:
  `root` / `pkg-banto-host` / `pkg-banto-worker-pool` の3本。
- `meta/environments.yaml` の `test` / `dev` の `cache.key` に、その compose ファイル自身を足す。
  理由は2つ:(a) node_modules の**置き場所を決めているのは compose ファイル**なので、
  変われば置き場は別物でなければならない (b) いま温まっている置き場は新しい配置になって
  いないので、鍵が変わらないと**直しを入れた瞬間に空の小部屋を掴んで全部落ちる**。
  実測で旧鍵 `bfde5701…`（`.banto-primed` あり＝当人）→ 新鍵 `54083c0a…` に変わることを確認。
- **不変条件のテスト**を追加（`tests/acceptance/env-cache-covers-nested-node-modules.spec.ts`・
  `npm test` 側）。`package-lock.json` から「入れ子を持つ workspace」を拾い、compose に
  対応する mount が在ることを assert する。**次に同じ穴が空いたら黙らない**——
  新しい入れ子の依存が増えた瞬間に、意味の分かる文言で落ちる。

**直しB（`e0134886`）— 器の中でも git が動くようにする**

- 純関数 `packages/banto-environment-pool/src/git-common-dir.ts` の `resolveGitCommonDir()`
  が、`.git` がファイルなら `gitdir:` → `commondir` を辿って共通 git ディレクトリを求める
  （git を起こさずファイルだけで解く／分からなければ `undefined` で、推測して mount しない）。
- **provision の時点で解いて handle に持ち回る**（ここが inc-0038 の直しとの違い。`run` の側で
  解こうとすると基点が無い呼び方で素通りする）。`BANTO_CACHE_DIR` と同じ形で
  `BANTO_GIT_COMMON_DIR` として compose へ渡し、compose は**ホストと同じ絶対パス**へ
  read-only で張る:
  `${BANTO_GIT_COMMON_DIR:-../.git}:${BANTO_GIT_COMMON_DIR:-/app/.git}:ro`。
  `.git` ファイルの `gitdir:` はホストの絶対パスを指しているので、同じ場所に見えれば
  git はそのまま辿れる。read-only は、器がリポジトリ本体の履歴を書き換えられないようにするため。
- 単体テスト（`tests/acceptance/env-git-common-dir.spec.ts`）と、docker を実際に叩く
  端から端まで（`env-docker-git-in-worktree.spec.ts`・`npm run test:docker` 側）。

## 反映（直しBは main へのマージだけでは効かない）

直しBは `banto-environment-pool.service` の中のコードで、**これは `banto.service` とは別の
常駐サービス**。`system.restart` では起こし直せない。手順は imp-0062 の追記に書いたが要点だけ：

```
systemctl show banto-environment-pool.service -p MainPID   # → 2351610
kill -9 2351610                                            # sudo は通らない
sleep 15                                                   # Restart=on-failure が拾う
systemctl show banto-environment-pool.service -p MainPID -p ActiveState -p SubState
                                                           # → 2781906 / active / running
```

**巻き添えは無い**（実測）。立っていた検証環境2つ（`env-898eb2aac9` / `env-d6ca9c424b`・
PO が触るレビュー環境）はコンテナも Caddy の route も無傷で、公開 URL は 200 のままだった。
docker のコンテナは `/system.slice/docker-<id>.scope` に居て pool の cgroup とは兄弟であること、
route は `caddy.service` 側が保持していること、pool の起動時処理（`sweep` / `reconcile`）は
生きている環境を畳まないこと——を先に確かめてから撃った。

## 確かめたこと（`env.verify` ＝機構が返した事実）

**現在の main（`63a72f8a`）の、node_modules がまったく無い素のリンクワークツリー**に対して、
`test` プロファイルの器の中で：

```
HEAD:   63a72f8a
now                 2026-08-15T16:44:48Z
npm ci が最後に走った 2026-08-15T16:19:19Z   ← この provision では走っていない（置き場が温まっている）
入れ子: claude-agent-sdk claude-agent-sdk-linux-x64-musl sdk
git:    /home/ubuntu/ghq/github.com/tjst-t/banto/.git
TYPECHECK_EXIT=0
TEST_EXIT=0
ℹ tests 2361 / pass 2356 / fail 0 / cancelled 0 / skipped 5
```

**「置き場が温まっていて `npm ci` が走っていない provision で、入れ子の SDK が器の中に在る」
——これが今まで壊れていた当の場面**で、そこで直っていることが確かめられている。
落ちていた2件も器の中で名指しで確認した（`env-git-common-dir` + `source-hygiene` を単体で回して
`pass 10 / fail 0`）。

## 「ゲートの器が構造的に通らない」問題は、どこまで解けたか

| 既知の原因 | いま | 
|---|---|
| ① docker 未到達（器に docker socket が無い） | **解決済み**（分離）。docker を要する試験は `test-docker` プロファイル（`driver: process`・ホスト実行）へ分け、`npm test` 側は同じ7ファイルを除外する。PO が明示的に認めた例外 |
| ② Node の版差 | **解決済み**（task-0093） |
| ③ fix2-b | **解決済み**（task-0093） |
| ④ ゲートの器に node_modules が無い（imp-0043） | **解決済み**（今回の直しA。NODE_ENV でも symlink でもなく、置き場が覆っていないことが今日の原因だった） |
| ⑤ ワークツリーでは器の中で git が動かない（inc-0038） | **解決済み**（今回の直しB。前の直しは効いていなかった） |

**`test` プロファイル（＝マージ前ゲートの既定）で回る限り、構造的に落ちる筋はもう見えていない。**

### ただし残っている（Kobo を開ける前に知っておくこと）

- **`test-docker` プロファイル（`driver: process`）には原因1と同じ穴が残っている。**
  `process-driver.ts:419` は `cachePath`（`node_modules`）1本を symlink するだけなので、
  入れ子は置き場ではなくホストの作業ツリーに書かれる。置き場が温まっていて作業ツリーが素なら、
  同じく入れ子だけが欠ける。**この経路を名指しするタスクを積むと落ちうる。**
  この経路は本番の作業ツリーを直に触る（inc-0064・2026-08-13 の事故の現場）ので、
  直すなら副作用の見積もりが別物になる。今回は触っていない。
- docker は bind mount の載り先をホスト側に root 所有で作る。直しAで mount が増えたぶん、
  検証にかけたワークツリーに**空で root 所有のディレクトリが増える**（`node_modules` に
  ついては以前からそう）。そのワークツリーで後からホスト側 `npm ci` を打つと EACCES に
  なり得る。種類としては既存の振る舞いと同じ。
- `status: resolved` の記録が、実際には効いていない直しを覆い隠していた（inc-0038）。
  **「直した」の根拠が、機構が返した事実になっているかを見る**必要がある。
