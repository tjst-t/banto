---
id: inc-0073
kind: incident
status: fixed
severity: high
created: 2026-08-15
refs: [imp-0043, inc-0029, inc-0064, task-0075, task-0080, task-0089, task-0093]
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

工場は必ずワークツリーで回る。だから工場でだけ落ちていた。

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

### 原因2: リンクされたワークツリーでは器の中で git が使えない

ワークツリーの `.git` は**ファイル**で、中身は
`gitdir: /home/ubuntu/ghq/github.com/tjst-t/banto/.git/worktrees/<名前>`。
このパスは器に mount されていない（compose は `..:/app` しか渡していない）ので、
器の中の `git ls-files` は `fatal: not a git repository: (null)` / exit 128 になる。
`git` バイナリ自体は `/usr/bin/git` に在る。

これで `tests/acceptance/source-hygiene.spec.ts`（inc-0029 の再発防止・追跡ファイルに
NUL が無いこと）が**ワークツリーでは必ず落ちる**。main のチェックアウトは `.git` が
本物のディレクトリなので通る——上の表と矛盾しない。

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

枝 `fix/env-container-parity`（2コミット）。

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
- docker ドライバがそれを `BANTO_GIT_COMMON_DIR` として compose へ渡し、compose は
  **ホストと同じ絶対パス**へ read-only で張る:
  `${BANTO_GIT_COMMON_DIR:-../.git}:${BANTO_GIT_COMMON_DIR:-/app/.git}:ro`。
  `.git` ファイルの `gitdir:` はホストの絶対パスを指しているので、同じ場所に見えれば
  git はそのまま辿れる。read-only は、器がリポジトリ本体の履歴を書き換えられないようにするため。
- 単体テスト（`npm test` 側）と、docker を実際に叩く端から端まで
  （`env-docker-git-in-worktree.spec.ts`・`npm run test:docker` 側。列挙にも追加済み）。

## 確かめたこと（`env.verify` ＝機構が返した事実）

枝のワークツリーに対して:

1. `npm run typecheck` → **exit 0**。器の中で
   `packages/banto-host/node_modules/@anthropic-ai/claude-agent-sdk` が見える
   （musl 版＝器の中で入れたもの。ホスト側の実体ではない）
2. **置き場が温まった状態**での `npm test` → 2357件 / pass 2350 / **fail 2**。
   同じ provision の中で `node_modules/.package-lock.json` の時刻が 5分前
   （＝**この provision では `npm ci` が走っていない**）にもかかわらず、入れ子の SDK が在る
   ——**これが今まで壊れていた当の場面**で、そこで直っていることが確かめられた。
3. 残る fail 2 は**どちらも git を叩く試験**（`source-hygiene` と、直しB自身の単体テスト）。
   直しBは常駐サービス `banto-environment-pool.service` の中のドライバのコードなので、
   **サービスを入れ替えるまでは `env.verify` には効かない**。職人の側では
   ホスト実行で `npm test` 2357/fail 0・`npm run test:docker` 75/fail 0 まで確認済み。

## 残り

- `banto-environment-pool.service` の入れ替え（＝直しBの反映）。これが済めば
  ワークツリーでの `npm test` は fail 0 になる見込み。
- **同じ種類の穴が `test-docker` プロファイル（`driver: process`）に残っている。**
  `process-driver.ts:419` は `cachePath`（`node_modules`）1本を symlink するだけなので、
  入れ子は置き場ではなくホストの作業ツリーに書かれる。置き場が温まっていて作業ツリーが素なら、
  同じく入れ子だけが欠ける。この経路は**本番の作業ツリーを直に触る**（2026-08-13 の事故の現場・
  inc-0064）ので、直すなら副作用の見積もりが別物になる。今回は触っていない。
- docker は bind mount の載り先をホスト側に root 所有で作る。直しAで mount が増えたぶん、
  検証にかけたワークツリーに**空で root 所有のディレクトリが増える**（`node_modules` に
  ついては以前からそう）。そのワークツリーで後からホスト側 `npm ci` を打つと EACCES に
  なり得る。種類としては既存の振る舞いと同じ。
