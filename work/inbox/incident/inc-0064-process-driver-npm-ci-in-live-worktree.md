# inc-0064 検証環境の process ドライバが、稼働中の本番ワークツリーで `npm ci` を走らせる

- 起票: 2026-08-13（番頭）
- 深刻度: 高（**稼働中の banto を起動不能にし得る**）
- 状態: open

## 起きたこと

ターン予算の修正（`turn-budget.ts`）を確かめるため、番頭が

```
env.verify({ profile: "test-docker", workdir: "/home/ubuntu/ghq/github.com/tjst-t/banto", ... })
```

を呼んだ。`test-docker` プロファイルの実体は **process ドライバ**で、setup が
**渡した workdir そのもの**——すなわち稼働中の本番ワークツリー——で `npm ci` を実行した。

```
process-driver: .../banto/node_modules に実体があるため置き場を使いません（毎回 setup になります）
process-driver provision: setup が失敗しました（exit 243）: npm ci
npm error code EACCES
npm error syscall unlink
npm error path .../packages/banto-host/node_modules/.bin/anthropic-ai-sdk
```

`npm ci` は既存の `node_modules` を消してから入れ直すため、**EACCES で途中終了した時点で
node_modules が壊れた**。直後から職人が起動できなくなった:

```
[claude-agent] tsx を解決できません: Cannot find module '.../node_modules/tsx/dist/loader.mjs'
```

稼働中の banto は systemd から `node --import tsx packages/banto-host/src/bin.ts` で
**src を直接読んで**動いている。既に起動済みのプロセスは生き延びたが、この状態で再起動
していれば **banto は起動に失敗し、中から復旧する手段が無かった**（実際、番頭は同じターンで
旧ターン予算に当たって道具を全部失っており、PO の手作業に頼るほか無かった）。

復旧は PO の手作業: `npm ci --include=dev`（`NODE_ENV=production` のため `--include=dev` が必須）。

## なぜ起きたか

1. **プロファイルが「使い捨ての場所」を用意しない。** `test-docker` は名前に反して process
   ドライバで、`workdir` に渡されたディレクトリで直接 setup を走らせる。呼ぶ側が本番の
   ワークツリーを渡せば、本番でビルドが走る。
2. **`node_modules` に実体があると置き場（キャッシュ）を使わない**という判断が、
   「毎回 setup になる」＝「毎回 `npm ci` が走る」に直結している。読み取りだけのつもりの
   検証が、破壊的な操作になる。
3. 番頭の側にも落ち度がある。**稼働中の本番と同じディレクトリを検証環境に渡した。**

## 処方（案）

- process ドライバは、**渡された workdir を書き換えない**ことを既定にする。setup が要るなら
  ワークツリーの複製か別の置き場で行い、本番のディレクトリで `npm ci` 相当を走らせない。
- それができないなら、**banto 自身のリポジトリを workdir に渡された時点で断る**
  （稼働中のインストール先を検証環境に使わせない）。
- `test-docker` という名前が process ドライバを指しているのは誤解を招く。名前を実態に合わせる。

## 当面の回避

banto 自身のテストは、別ワークツリーを切って職人に走らせる。`env.verify` に本番の
ワークツリーを渡さない。
