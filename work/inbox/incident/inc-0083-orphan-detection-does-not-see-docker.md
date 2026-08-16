---
id: inc-0083
kind: incident
status: open
severity: critical
created: 2026-08-16
refs: [inc-0082, imp-0074]
---

# 孤児検出が docker の実体を見ていない（**アドレスプールが枯渇し、工場の着地が全部止まった**）

## 何が起きたか（2026-08-16・PO の実測）

マージ前ゲートが検証環境を立てられずに落ちる：

```
docker compose up failed: Error response from daemon:
  all predefined address pools have been fully subnetted
```

docker のアドレスプールが**使い切られていた**。原因は、**畳まれずに残った検証環境が溜まり続けていたこと**。

### 数（PO が手で数えた実測）

| 見たもの | 数 |
| --- | --- |
| `docker network ls` の総数 | **31本** |
| うち `banto-env-*` | **27本** |
| `docker network prune -f` が消せた数 | **0本**（27本すべて「使用中」） |
| `docker ps -a` のコンテナ | **27件、全部 `Up`**（`Exited` / `created` は0件） |
| **`env.list`（台帳）が知っていた数** | **4件** |
| **`env.list` の `orphans`** | **0件** |

台帳が知っていた4件：
- `env-80019563fc` — dev / review-after-0041 / 公開URLあり
- `env-d64ca33338` — dev / preview-0042 / 公開URLあり
- `env-ddc82866ac` — test / task-0162
- `env-9ff88f5699` — test / task-0197-rebased

実体には `env-5bdd2526dc-app-1`・`dynport-a-app-1`・`dynport-b-app-1` のような、
**台帳に一度も載っていない名前が多数**あった（`dynport-*` は受け入れ試験が立てたものの取り残しの疑い）。

## 1. 何が検出されなかったか

**台帳に無い docker のコンテナとネットワークが、27本／27件も残っているのに、
孤児検出は「孤児 0件」と答えた。**

つまり、いまの孤児検出は **docker の実体を走査していない**。
台帳（自分が立てた記録）の中だけを見て「畳み損ねが無いか」を答えているので、
**台帳に載らなかったもの＝いちばん危ない取り残しは、原理的に永久に見つからない。**

見張りとして用をなしていない。**27本溜まって機械が止まるまで、一度も警報が鳴らなかった。**

## 2. そのせいで何が止まったか

**工場の着地が全部止まった。**
マージ前ゲートは検証環境を立てられないと落ちるので、
その日に積んだ直しは**1本もマージできない**。個別のタスクの失敗ではなく、**列そのものが止まる**。

しかも落ち方が原因を指していない——タスクは「ゲートで落ちた」ように見えるだけで、
実際の原因は「別のタスクの残骸がアドレスプールを食い潰していた」であり、
**タスクの内容とは何の関係も無い**。落ちたタスクを何度 reverify しても通らない。

## 3. `env.teardown_orphan` が使えなかったこと

機構の**正しい口が効かない**。名指しで畳もうとすると：

```
孤児 "env-5bdd2526dc" は見つかりません（照合し直した結果）。いまの孤児: (なし)
```

`env.teardown_orphan` は**孤児検出が挙げた一覧の中からしか畳めない**。
その一覧が空なので、**実体がそこに在るのに、機構の口からは1件も畳めない。**

結果、PO は docker を手で叩いて数えるところまで降りることになった。
（`docker network prune -f` も0本しか消せない——27本すべてコンテナに使われているため、
**ネットワークだけを掃除する道は最初から無い**。コンテナを先に落とす必要がある。）

なお **PO はここで正しく手を止めた**——「台帳に無いのに Up なものが多数ある。
勝手に消してはいけないパターンだ」。台帳に無いものの中に、
**PO がレビューで実際に画面を見ているもの（公開ポートを持つ dev 環境）が混ざり得る**からである。
過去に「ひらがな学習アプリ」が `http://5173--env-898eb2aac9.banto.tjstkm.net/` で
稼働中として PO に渡された実績がある。**「台帳に無い＝消してよい」ではない。**

## 4. 直す方向

### (1) 孤児検出を、**docker の実体を走査する側**へ反転させる

いまは「台帳を見て畳み損ねを探す」。これを
**「docker に在るものを列挙し、台帳と突き合わせて、台帳に無いものを孤児と呼ぶ」**にする。

- 走査するのは**コンテナとネットワークの両方**（今回はネットワークが枯渇資源だった）。
- 突き合わせの鍵は名前の `env-<id>` と、compose のラベル（`com.docker.compose.project`）。
- **env id を持たない名前（`dynport-*` など）も孤児として挙げる**。
  今回いちばん危なかったのは、まさにこの「名前の形からして台帳の管理下に無いもの」だった。

### (2) 挙げた孤児に**見分けの材料を付ける**（消す判断を機械に任せない）

孤児と呼んだものを全部消してよいわけではない。一覧に次を必ず添える：

- **公開ポートを持つか**（`Ports` が空でない＝**誰かが画面を見ている可能性がある**）
- **いつから動いているか**（古いものほど残骸の疑いが濃い）
- **どのワークツリー／リポジトリから立ったか**（マウント元）

そのうえで **(a) 台帳にある＝触らない / (b) 公開ポートを持つ＝PO の確認が要る /
(c) それ以外＝残骸の候補** に分けて出す。**(b) を機械が黙って消さないこと。**

### (3) **数で警報を鳴らす**

枯渇して初めて気づくのが今回の敗因。
`banto-env-*` のネットワーク本数がしきい値（例：docker のプールから逆算した上限の半分）を超えたら、
**着地が止まる前に**取次へ上げる。`env.list` の表示にも本数を出す。

### (4) `env.teardown_orphan` の断り方を直す

「いまの孤児: (なし)」と答えて行き止まりにするのではなく、
**実体を照合し直したうえで**、名指しされたものが docker に在るなら
「台帳にも孤児一覧にも無いが、実体は在る」と答えて、次の一手（何を確かめれば消してよいか）を示す。

## 分かっていないこと（**未確認。推測で埋めない**）

- **27件がどの経路で漏れたか**——検証が終わったのに畳まれなかったのか、
  畳む処理が例外で落ちたのか、そもそも台帳へ書く前に立ったのか。
  （`dynport-*` は受け入れ試験由来の疑いがあるが、**確かめていない**。）
- 台帳に載る前に立ったのだとすると、**立てる順序（実体を作る→台帳へ書く）にも穴がある**可能性。
  そうであれば (1) の走査だけでは再発を止められず、**立てる側の順序も直す**必要がある。

## 5. 棚卸しの実測（2026-08-16・読み取りのみ）

`docker ps -a` / `docker network ls` / `docker inspect` / `docker network inspect` / `docker info` と、
由来ワークツリーの実在確認（`[ -e ]`）だけを実行した。**削除系・prune 系は一切打っていない。**

### 5.0 前提の訂正

**コンテナは 27件ではなく 31件。** 27 は `banto-env-*` **ネットワーク**の本数。
`banto-env-*` のコンテナは 29件で、`env-9ff88f5699` と `env-ddc82866ac` が
それぞれ1環境2コンテナのため 29 − 2 = 27 ネットワークになる。
これに `docker-test-run-ada4c74157b1` と `hiragana-vite` を足して総数 31。

### 5.1 生の出力

```
$ docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Ports}}\t{{.Image}}' | sort
banto-env-dynport-a-app-1	Up 5 hours	5 hours ago	0.0.0.0:32878->4200/tcp, [::]:32878->4200/tcp	busybox:latest
banto-env-dynport-b-app-1	Up 5 hours	5 hours ago	0.0.0.0:32879->4200/tcp, [::]:32879->4200/tcp	busybox:latest
banto-env-env-00ee36f3f7-app-1	Up 5 hours	5 hours ago	0.0.0.0:32874->4200/tcp, [::]:32874->4200/tcp	busybox:latest
banto-env-env-01cc99a2d2-app-1	Up 3 hours	3 hours ago	0.0.0.0:32885->4200/tcp, [::]:32885->4200/tcp	busybox:latest
banto-env-env-17a306e489-app-1	Up 3 hours	3 hours ago	0.0.0.0:32882->4200/tcp, [::]:32882->4200/tcp	busybox:latest
banto-env-env-1c97ab671b-app-1	Up 3 hours	3 hours ago	0.0.0.0:32892->4200/tcp, [::]:32892->4200/tcp	busybox:latest
banto-env-env-559646aeb3-app-1	Up 3 hours	3 hours ago	0.0.0.0:32881->4200/tcp, [::]:32881->4200/tcp	busybox:latest
banto-env-env-5bdd2526dc-app-1	Up 2 hours	2 hours ago	0.0.0.0:32897->4200/tcp, [::]:32897->4200/tcp	busybox:latest
banto-env-env-781179c1e9-app-1	Up 5 hours	5 hours ago	0.0.0.0:32876->4200/tcp, [::]:32876->4200/tcp	busybox:latest
banto-env-env-7997af4fb3-app-1	Up 2 hours	2 hours ago	0.0.0.0:32896->4200/tcp, [::]:32896->4200/tcp	busybox:latest
banto-env-env-7e8d5ea866-app-1	Up 3 hours	3 hours ago	0.0.0.0:32891->4200/tcp, [::]:32891->4200/tcp	busybox:latest
banto-env-env-80019563fc-dev-1	Up 7 hours	7 hours ago	0.0.0.0:32872->5173/tcp, [::]:32872->5173/tcp	banto-env-env-80019563fc-dev
banto-env-env-862a24ff83-app-1	Up 2 hours	2 hours ago	0.0.0.0:32894->4200/tcp, [::]:32894->4200/tcp	busybox:latest
banto-env-env-8a4f8e4599-app-1	Up 3 hours	3 hours ago	0.0.0.0:32884->4200/tcp, [::]:32884->4200/tcp	busybox:latest
banto-env-env-968d1262c0-app-1	Up 3 hours	3 hours ago	0.0.0.0:32888->4200/tcp, [::]:32888->4200/tcp	busybox:latest
banto-env-env-9ff88f5699-test-1	Up 2 minutes	2 minutes ago		banto-env-env-9ff88f5699-test
banto-env-env-9ff88f5699-test-run-00f9b1c1a052	Up 2 minutes	2 minutes ago		banto-env-env-9ff88f5699-test
banto-env-env-a5b9fefe39-app-1	Up 3 hours	3 hours ago	0.0.0.0:32889->4200/tcp, [::]:32889->4200/tcp	busybox:latest
banto-env-env-d64ca33338-dev-1	Up 22 minutes	22 minutes ago	0.0.0.0:32898->5173/tcp, [::]:32898->5173/tcp	banto-env-env-d64ca33338-dev
banto-env-env-ddc82866ac-test-1	Up 10 minutes	10 minutes ago		banto-env-env-ddc82866ac-test
banto-env-env-ddc82866ac-test-run-292bc1992fed	Up 4 minutes	4 minutes ago		banto-env-env-ddc82866ac-test
banto-env-env-de54bf6374-app-1	Up 5 hours	5 hours ago	0.0.0.0:32877->4200/tcp, [::]:32877->4200/tcp	busybox:latest
banto-env-env-e3539e2332-app-1	Up 2 hours	2 hours ago	0.0.0.0:32893->4200/tcp, [::]:32893->4200/tcp	busybox:latest
banto-env-env-e547c3688c-app-1	Up 5 hours	5 hours ago	0.0.0.0:32873->4200/tcp, [::]:32873->4200/tcp	busybox:latest
banto-env-env-eb056fbc33-app-1	Up 3 hours	3 hours ago	0.0.0.0:32886->4200/tcp, [::]:32886->4200/tcp	busybox:latest
banto-env-env-f0687a7b14-app-1	Up 3 hours	3 hours ago	0.0.0.0:32887->4200/tcp, [::]:32887->4200/tcp	busybox:latest
banto-env-task-rebuild-1786853106464-app-1	Up 5 hours	5 hours ago		banto-env-task-rebuild-1786853106464-app
banto-env-task-rebuild-1786859568787-app-1	Up 3 hours	3 hours ago		banto-env-task-rebuild-1786859568787-app
banto-env-task-rebuild-1786861294309-app-1	Up 2 hours	2 hours ago		banto-env-task-rebuild-1786861294309-app
docker-test-run-ada4c74157b1	Up 30 hours	30 hours ago		docker-test
hiragana-vite	Up 42 hours	5 days ago	127.0.0.1:5173->5173/tcp	node:22-slim
```

```
$ docker network ls --format '{{.Name}}\t{{.Driver}}\t{{.Scope}}' | sort
banto-env-dynport-a_default	bridge	local
banto-env-dynport-b_default	bridge	local
banto-env-env-00ee36f3f7_default	bridge	local
banto-env-env-01cc99a2d2_default	bridge	local
banto-env-env-17a306e489_default	bridge	local
banto-env-env-1c97ab671b_default	bridge	local
banto-env-env-559646aeb3_default	bridge	local
banto-env-env-5bdd2526dc_default	bridge	local
banto-env-env-781179c1e9_default	bridge	local
banto-env-env-7997af4fb3_default	bridge	local
banto-env-env-7e8d5ea866_default	bridge	local
banto-env-env-80019563fc_default	bridge	local
banto-env-env-862a24ff83_default	bridge	local
banto-env-env-8a4f8e4599_default	bridge	local
banto-env-env-968d1262c0_default	bridge	local
banto-env-env-9ff88f5699_default	bridge	local
banto-env-env-a5b9fefe39_default	bridge	local
banto-env-env-d64ca33338_default	bridge	local
banto-env-env-ddc82866ac_default	bridge	local
banto-env-env-de54bf6374_default	bridge	local
banto-env-env-e3539e2332_default	bridge	local
banto-env-env-e547c3688c_default	bridge	local
banto-env-env-eb056fbc33_default	bridge	local
banto-env-env-f0687a7b14_default	bridge	local
banto-env-task-rebuild-1786853106464_default	bridge	local
banto-env-task-rebuild-1786859568787_default	bridge	local
banto-env-task-rebuild-1786861294309_default	bridge	local
bridge	bridge	local
docker_default	bridge	local
host	host	local
none	null	local
```

### 5.2 コンテナ 31件の表

`台帳` は本 incident 冒頭の4件（`env-80019563fc` / `env-d64ca33338` / `env-ddc82866ac` / `env-9ff88f5699`）に
一致するか。`由来` は `com.docker.compose.project.working_dir` ラベル。作成時刻は UTC。

| # | name | env id | 台帳 | Ports | 稼働 / 作成(UTC) | ネットワーク | イメージ / 由来 working_dir |
|---|---|---|---|---|---|---|---|
| 1 | banto-env-env-80019563fc-dev-1 | env-80019563fc | **あり** | 32872→5173 | 7h / 01:34:57 | banto-env-env-80019563fc_default | banto-env-env-80019563fc-dev / `ghq/.../dentaku/docker`（マウント `ghq/.../dentaku` → /app） |
| 2 | banto-env-env-d64ca33338-dev-1 | env-d64ca33338 | **あり** | 32898→5173 | 22m / 08:38:24 | banto-env-env-d64ca33338_default | banto-env-env-d64ca33338-dev / `worktrees/.../dentaku/task-task-0042/docker` |
| 3 | banto-env-env-ddc82866ac-test-1 | env-ddc82866ac | **あり** | なし | 10m / 08:50:13 | banto-env-env-ddc82866ac_default | banto-env-env-ddc82866ac-test / `worktrees/.../banto/task-task-0162/docker`（`sleep infinity`） |
| 4 | banto-env-env-ddc82866ac-test-run-292bc1992fed | env-ddc82866ac | **あり** | なし | 4m / 08:55:44 | 同上 | 同上（`sh -c npm test` **実行中**） |
| 5 | banto-env-env-9ff88f5699-test-1 | env-9ff88f5699 | **あり** | なし | 2m / 08:58:03 | banto-env-env-9ff88f5699_default | banto-env-env-9ff88f5699-test / `worktrees/banto/task-0197-direct/docker`（`sleep infinity`） |
| 6 | banto-env-env-9ff88f5699-test-run-00f9b1c1a052 | env-9ff88f5699 | **あり** | なし | 2m / 08:58:06 | 同上 | 同上（`sh -c npm test && npm run typecheck` **実行中**） |
| 7 | hiragana-vite | なし | 無し | **127.0.0.1:5173→5173** | 42h / 08-10 22:53 | `bridge`（既定ブリッジ） | node:22-slim / compose ラベル無し。マウント `ghq/github.com/ubuntu/hiragana-app` → /app、`npm run dev -- --host 0.0.0.0` |
| 8 | banto-env-env-e547c3688c-app-1 | env-e547c3688c | 無し | 32873→4200 | 5h / 04:11:00 | banto-env-env-e547c3688c_default | busybox:latest / `worktrees/.../banto/task-task-0175/tests/fixtures/docker` |
| 9 | banto-env-env-00ee36f3f7-app-1 | env-00ee36f3f7 | 無し | 32874→4200 | 5h / 04:11:05 | banto-env-env-00ee36f3f7_default | busybox / task-0175 fixtures |
| 10 | banto-env-env-781179c1e9-app-1 | env-781179c1e9 | 無し | 32876→4200 | 5h / 04:11:32 | banto-env-env-781179c1e9_default | busybox / task-0175 fixtures |
| 11 | banto-env-env-de54bf6374-app-1 | env-de54bf6374 | 無し | 32877→4200 | 5h / 04:11:47 | banto-env-env-de54bf6374_default | busybox / task-0175 fixtures |
| 12 | banto-env-dynport-a-app-1 | **なし** | 無し | 32878→4200 | 5h / 04:13:11 | banto-env-dynport-a_default | busybox / task-0175 fixtures（`while true; do sleep 1; done`） |
| 13 | banto-env-dynport-b-app-1 | **なし** | 無し | 32879→4200 | 5h / 04:13:14 | banto-env-dynport-b_default | busybox / task-0175 fixtures（同上） |
| 14 | banto-env-env-559646aeb3-app-1 | env-559646aeb3 | 無し | 32881→4200 | 3h / 05:56:51 | banto-env-env-559646aeb3_default | busybox / `worktrees/banto/browser-flake/tests/fixtures/docker` |
| 15 | banto-env-env-17a306e489-app-1 | env-17a306e489 | 無し | 32882→4200 | 3h / 05:56:58 | banto-env-env-17a306e489_default | busybox / browser-flake fixtures |
| 16 | banto-env-env-8a4f8e4599-app-1 | env-8a4f8e4599 | 無し | 32884→4200 | 3h / 05:57:26 | banto-env-env-8a4f8e4599_default | busybox / browser-flake fixtures |
| 17 | banto-env-env-01cc99a2d2-app-1 | env-01cc99a2d2 | 無し | 32885→4200 | 3h / 05:57:41 | banto-env-env-01cc99a2d2_default | busybox / browser-flake fixtures |
| 18 | banto-env-env-eb056fbc33-app-1 | env-eb056fbc33 | 無し | 32886→4200 | 3h / 06:08:10 | banto-env-env-eb056fbc33_default | busybox / browser-flake fixtures |
| 19 | banto-env-env-f0687a7b14-app-1 | env-f0687a7b14 | 無し | 32887→4200 | 3h / 06:08:18 | banto-env-env-f0687a7b14_default | busybox / browser-flake fixtures |
| 20 | banto-env-env-968d1262c0-app-1 | env-968d1262c0 | 無し | 32888→4200 | 3h / 06:27:57 | banto-env-env-968d1262c0_default | busybox / browser-flake fixtures |
| 21 | banto-env-env-a5b9fefe39-app-1 | env-a5b9fefe39 | 無し | 32889→4200 | 3h / 06:28:04 | banto-env-env-a5b9fefe39_default | busybox / browser-flake fixtures |
| 22 | banto-env-env-7e8d5ea866-app-1 | env-7e8d5ea866 | 無し | 32891→4200 | 3h / 06:28:36 | banto-env-env-7e8d5ea866_default | busybox / browser-flake fixtures |
| 23 | banto-env-env-1c97ab671b-app-1 | env-1c97ab671b | 無し | 32892→4200 | 3h / 06:28:53 | banto-env-env-1c97ab671b_default | busybox / browser-flake fixtures |
| 24 | banto-env-env-e3539e2332-app-1 | env-e3539e2332 | 無し | 32893→4200 | 2h / 06:38:28 | banto-env-env-e3539e2332_default | busybox / browser-flake fixtures |
| 25 | banto-env-env-862a24ff83-app-1 | env-862a24ff83 | 無し | 32894→4200 | 2h / 06:38:34 | banto-env-env-862a24ff83_default | busybox / browser-flake fixtures |
| 26 | banto-env-env-7997af4fb3-app-1 | env-7997af4fb3 | 無し | 32896→4200 | 2h / 06:39:06 | banto-env-env-7997af4fb3_default | busybox / browser-flake fixtures |
| 27 | banto-env-env-5bdd2526dc-app-1 | env-5bdd2526dc | 無し | 32897→4200 | 2h / 06:39:22 | banto-env-env-5bdd2526dc_default | busybox / browser-flake fixtures |
| 28 | banto-env-task-rebuild-1786853106464-app-1 | **なし** | 無し | **なし** | 5h / 04:13:39 | banto-env-task-rebuild-1786853106464_default | busybox / `/tmp/banto-rebuild-AmOJym` |
| 29 | banto-env-task-rebuild-1786859568787-app-1 | **なし** | 無し | **なし** | 3h / 06:00:04 | banto-env-task-rebuild-1786859568787_default | busybox / `/tmp/banto-rebuild-1JGoX3` |
| 30 | banto-env-task-rebuild-1786861294309-app-1 | **なし** | 無し | **なし** | 2h / 06:31:06 | banto-env-task-rebuild-1786861294309_default | busybox / `/tmp/banto-rebuild-uacUuz` |
| 31 | docker-test-run-ada4c74157b1 | **なし** | 無し | **なし** | 30h / 08-15 02:36 | `docker_default` | docker-test / `worktrees/.../dentaku/task-task-0005/docker`（`sleep infinity`） |

由来ワークツリーの実在確認：`worktrees/github.com/tjst-t/banto/task-task-0175` は **既に存在しない**。
それ以外（`worktrees/banto/browser-flake`、`/tmp/banto-rebuild-*` 3件、dentaku 各所、`hiragana-app`）は実在。

### 5.3 分類と件数

| 分類 | 件数 | 中身 |
|---|---|---|
| **(a) 台帳にある** | コンテナ **6** / ネットワーク **4** | 表の #1〜#6。うち `env-ddc82866ac` と `env-9ff88f5699` は棚卸し時点で **`npm test` 実行中** |
| **(b-1) 台帳外・ポートあり・本物のアプリ** | **1** | `hiragana-vite`（#7） |
| **(b-2) 台帳外・ポートあり・受け入れ試験のフィクスチャ** | **20** | 表の #8〜#27。task-0175 由来 6件（04:11〜04:13）＋ browser-flake 由来 14件（05:56〜06:39） |
| **(c) 台帳外・ポートなし** | **4** | `task-rebuild-*` 3件（#28〜#30）＋ `docker-test-run-ada4c74157b1`（#31） |
| 合計 | **31** | 6 + 1 + 20 + 4 |

指示の機械的な基準（台帳外かつ Ports が空でない）では (b-1) と (b-2) は同じ (b) に落ちるが、
中身は明確に割れるので分けた。**迷いは消す側でなく (b) に寄せてある。**

#### (b-2) の20件が残骸だと判断できる根拠（4点・全件が満たす）

1. イメージが **`busybox:latest`**（アプリのイメージではない）
2. CMD が `sh -c mkdir -p /www && echo ok > /www/index.html && exec httpd -f -p 4200 -h /www`
   ——**`ok` という文字列を返すだけの静的サーバ**。画面と呼べるものが無い
3. **マウントが1つも無い**（失って困る中身が無い）
4. `working_dir` が **`tests/fixtures/docker`**（＝テストのフィクスチャ置き場）

### 5.4 枯渇の実測

`docker info --format '{{json .DefaultAddressPools}}'` は **`null`**＝**Docker の既定プールのまま**。
実際の割り当て（`docker network inspect` の `IPAM.Config.Subnet`）は次のとおり。

- **`172.16.0.0/12`（size 16）── 14本使用**：172.17（`bridge`）／172.18〜172.30 が連続で埋まる。
  172.31 だけ空きに見えるが、ホスト側の経路衝突で回避されている可能性が高い
- **`192.168.0.0/16`（size 20）── 15本使用**：192.168.16.0/20 〜 192.168.240.0/20 が全部。
  192.168.0.0/20 のみ未使用で、これも衝突回避と見られる

サブネットを消費しているネットワークは計 **29本**（`banto-env-*` 27 ＋ `bridge` ＋ `docker_default`）。
`host` / `none` は組み込みでサブネットを持たない。**事実上、空きはゼロ。**

**`docker network prune` が1本も減らせないのは異常ではない。**
`banto-env-*` 27本すべてに生きたコンテナが刺さっている（25本が1コンテナ、
`env-9ff88f5699` と `env-ddc82866ac` の2本が2コンテナ）。**空のネットワークは1本も無い。**
つまり **ネットワークだけ先に消す道は無く、コンテナを止めない限り1本も減らない。**

### 5.5 根本原因の追記 ── 本体は「テストが後片付けしない」

台帳外の残骸 27環境の内訳は次のとおり。

- **20件が `tests/fixtures/docker` 由来**（task-0175 の受け入れ試験 6件、browser-flake ワークツリーの受け入れ試験 14件）
- **3件が `/tmp/banto-rebuild-*` 由来**（リビルド試験）
- 残り4件は (a) の台帳分（＝正規経路）

**いずれもテストが自前で compose を起こし、後片付けに失敗したもの。**
これらは本番経路を通っていないので **最初から台帳（env.list）の管轄外**であり、
「孤児検出が0件と答えた」のは**検出側の論理としては正しい**。

したがって本 incident の原因は「孤児検出が台帳しか見ていない」だけではない。
**「テストが自分で起こした compose を畳まない」ほうが本体**である。
`## 4. 直す方向` の (1)〜(4) は掃除と再発検知には効くが、
**掃除してもテストを回せばまた増える。**
テスト側に確実な後始末（成否によらず `down` する／プロジェクト名を実行ごとに使い捨てにして
実行後に必ず回収する）を入れない限り、同じことが起きる。

### 5.6 `dynport-a` / `dynport-b` ── 名前で拾う実装は二次的に取りこぼす

`banto-env-dynport-a` / `banto-env-dynport-b` は **env id を持たない**。
`working_dir` が task-0175 の fixtures、CMD が `while true; do sleep 1; done`、
ポートが 32878/32879 の連番であることから、
**「動的ポート割り当てが2環境で衝突しないこと」を確かめる受け入れ試験が、
compose のプロジェクト名を `dynport-a` / `dynport-b` とハードコードで付けて立てたもの**と読める。

`env-<hex>` の命名規約から外れているため、
**`banto-env-env-*` のような名前パターンで孤児を拾う実装だと、この2件を取りこぼす。**
(1) の走査は **`banto-env-` プレフィックスまでで判定し、env id の有無で切らない**こと。

### 5.7 `hiragana-vite` は掃除の対象から明示的に外す

- 繋がっているのは **既定ブリッジ `bridge`（172.17.0.0/16）**。
  既定ブリッジは削除されないので、**このコンテナが専有しているサブネットは0本**
- したがって **消してもアドレスプールの枯渇は1ミリも解消しない**
- 一方で `ghq/github.com/ubuntu/hiragana-app` をマウントした稼働中の開発サーバであり、
  **消せば PO が見ている画面が落ちるだけ**

**掃除の対象から明示的に外すこと。**「台帳に無い」を根拠に一括で畳む実装は、
これを巻き込む。(1) の走査は **`banto-env-*` ネットワークに繋がっているものに限定する**のが安全。
