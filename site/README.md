# banto の公開サイト（banto.tjst-t.dev）

ランディングページと利用者向けのマニュアル。Astro Starlight で組み、Cloudflare Pages で配る。

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

## Cloudflare Pages の設定（人が Cloudflare の画面で一度だけ）

- リポジトリ：`tjst-t/banto`、本番のブランチ：`release`
- Root directory：`site`
- Build command：`npm run build`、Build output directory：`dist`
- 環境変数：`NODE_VERSION=22`（以上）
- カスタムドメイン：`banto.tjst-t.dev`

言語は日本語だけ。英語を足すときは `astro.config.mjs` の `locales` に `en` を足し、`src/content/docs/en/` に置く。
