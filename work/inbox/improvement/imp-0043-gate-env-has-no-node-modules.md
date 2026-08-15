---
id: imp-0043
type: improvement
kind: correctness
origin: banto
status: in-progress
resolution: ""
refs: [imp-0023, imp-0025, imp-0042, imp-0045, dentaku-task-0020, dentaku-task-0021, dentaku-task-0023]
---

# マージ前ゲートの検証環境に node_modules が無い（監査は通るのにゲートだけ落ちる）

## 症状

dentaku の task-0020・0021・0023 が、**監査 pass・rebase 済み・職人の手元では受け入れ基準が全通過**
なのに、マージ前ゲートだけで落ちた。ログの形は毎回同じ：

- a1・a2 → `exit=127`（`vitest: not found` / `tsc: not found`）
- a3 → `npx` が vitest を新たに落としてきて `Cannot find package 'vite'` → `failed to load config from /app/vite.config.ts`
- grep 系の基準だけは通る（`/app` のソース自体は見えている）

`kobo.reopen` の reverify（回し直し）を打つと**通る**。

## 真因（2026-08-15・職人の実測。再現 6/6、対照 12/12 健全、並行は無関係＝決定的）

**二段構え。**

### 1. 職人プロセスに `NODE_ENV=production` が効いている

`banto-worker-pool.service` に `Environment=NODE_ENV=production` があり、職人の子プロセスが継ぐ。
npm 11 は `NODE_ENV=production` のとき `omit` の既定を `["dev"]` にするため、
**devDependencies が1つも入らない**。dentaku の依存（typescript / vite / vitest）は全部
devDependencies なので、`npm install` は `up to date, audited 1 package` と答えて
`node_modules` を作らない。**cwd も package.json も `npm prefix` も正しい**
（`env -u NODE_ENV npm install` なら 39 パッケージ入る）。

### 2. その凌ぎに張られた `node_modules` の symlink が、ゲートを必ず落とす

職人は 1 に詰まり、`ln -sfn <本体チェックアウト>/node_modules node_modules` で凌ぐ。すると：

- docker のボリュームは **symlink の指す先のパス**にマウントされる
  （`/proc/self/mountinfo` で実測：ボリュームは `/app/node_modules` ではなく
  `/home/ubuntu/ghq/.../dentaku/node_modules` に載る）
- setup コンテナの `npm ci` は `/app/node_modules`（symlink）を **unlink できてしまう**ので成功し、
  同じ場所に実体ディレクトリを作って 39 パッケージを書く。落ちる先は **bind mount＝ホストのワークツリー**。
  **setup は exit 0**
- 検証の `compose run` は新しいコンテナ。今度はボリュームが正しく `/app/node_modules` を覆う → **空**
- **reverify が通る理由**：1回目の setup で symlink が実体ディレクトリに化けているので、2回目は素直にボリュームへ入る

### 物証（指紋照合）

| ワークツリー | `.package-lock.json` | 所有者 | 書いたのは |
|---|---|---|---|
| task-0019（通った） | 24296 bytes | ubuntu | ホストの npm 11.16.0 |
| task-0020（落ちた） | 24214 bytes | root | コンテナの npm 10.9.8（setup） |
| task-0021（落ちた） | 24214 bytes | root | 同上 |

タイムスタンプは台帳の env 生成時刻の直前＝ provision の setup 区間にぴたり収まる。

### 否定された仮説

- 「setup が非同期で走って間に合っていない」→ `docker-driver.ts:159` の `runCmd` は `spawnSync`。デタッチ無し
- 「setup の失敗を握り潰している」→ 非0・時間切れなら `cleanupAfterFailedSetup` して `process.exit(1)`
- 「compose のプロジェクト名が setup と run で食い違う」→ 同じ `composeArgs` を通る。`-p`/`-f` 同一
- 「並行実行の競合」→ 3本並行×2周でも 6/6 健全

## 直し（着手済み・枝 `fix/worker-env-and-symlink-gate`）

- **d**：`NODE_ENV` を**職人へ渡す env から落とす**（ユニットファイルからは外さない。プール自身の実行環境は別の話）
- **a**：provision で、compose が宣言するボリュームのマウント先について
  **bind mount 元のホスト側パスが symlink なら環境を立てずに失敗させる**（I2）
- **c**：成功した setup の stdout/stderr を捨てず残す

**b**（provision の最後に検証と同じ `compose run` を立てて成果を確かめる）は、
毎回の provision に時間が乗り、「何を見れば用意できたと言えるか」がプロファイル依存になるため今回は入れない。

## 残っているもの

- 落ちた回のワークツリーに **root 所有の `node_modules`** が残る（imp-0023・imp-0025 と同根）
- 落ちた回のゲートログが reverify で消える → imp-0045

## 経緯

2026-08-15、幹「電卓開発」から3件目の報告（task-0023）を受けて調査。番頭が起票した。
