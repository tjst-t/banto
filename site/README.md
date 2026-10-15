# banto の公開サイト（banto.tjst-t.dev）

ランディングページと利用者向けのドキュメント。Astro Starlight で組み、Cloudflare Pages で配る。

| 場所 | 中身 |
|---|---|
| `src/pages/index.astro` | ランディングページ（Starlight の外。色・書体はこのファイルの中） |
| `src/content/docs/docs/` | マニュアル（`/docs/…`）。並びは `astro.config.mjs` の `sidebar` |
| `src/styles/` | 書体（IBM Plex Sans JP・IBM Plex Mono、同梱）とマニュアルの色 |
| `public/_redirects` | `/install.sh` を GitHub の release の install.sh へ転送（Cloudflare Pages が読む） |

`docs/specs` は開発者向けの仕様で、ここには載せない。マニュアルは利用者向けに書き直したもの——振る舞いを変えたら、
このマニュアルのほうも直す。

## 手元で見る

```sh
npm ci
npm run build && npx astro preview --host 0.0.0.0 --port 4321
```

## スクリーンショットを撮り直す

`src/assets/screens/*.png` は本物の banto の画面から撮ったもの。E2E の仕組み（`banto/e2e`）で banto を立て、
偽の AI で場面を作って撮る（場面の中身は `banto/e2e/site-shots/scene.ts`）。banto を build してから：

```sh
cd banto && npm run build
cd e2e && npx playwright test -c site-shots/playwright.config.ts
```

全部の PNG を上書きする。一部だけなら `BANTO_SITE_SHOTS_ONLY=hero,inbox`（場面はいつも全部作る）。
E2E と同じく Incus が要り、同じ機械の E2E とは1回ずつ（ほかの E2E が走っていれば待つ）。

| ファイル | 写っているもの |
|---|---|
| `hero.png` | パソコンの全画面。Project 4つ・Fork 4本・判断待ちのカード |
| `approval.png` | 会話の中の承認カード（切り抜き） |
| `inbox.png` | 受信箱の全面（縦長）。判断待ち2・決めることがある2（ターンの終わりのまとめ）・返ってきた会話2（まとめあり・なし） |
| `inbox-card.png` | 受信箱の1枚のカード（切り抜き）。決済の案B のまとめで、選択肢を押して返信の欄に入ったところ |
| `mobile-inbox.png` | 携帯の幅で開いた受信箱 |
| `fork.png` | Fork の会話（決済の方式を比べている案A） |
| `module.png` | Module の画面（Backlog の Canvas） |
| `mobile.png`・`mobile-drawer.png` | 携帯の幅の会話と Drawer |

## Cloudflare Pages の設定（人が Cloudflare の画面で一度だけ）

- リポジトリ：`tjst-t/banto`、本番のブランチ：`release`
- Root directory：`site`
- Build command：`npm run build`、Build output directory：`dist`
- 環境変数：`NODE_VERSION=22`（以上）
- カスタムドメイン：`banto.tjst-t.dev`

言語は日本語だけ。英語を足すときは `astro.config.mjs` の `locales` に `en` を足し、`src/content/docs/en/` に置く。
