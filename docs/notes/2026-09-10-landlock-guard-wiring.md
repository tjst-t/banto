# 2026-09-10 ルールセットの最終検査を本番経路に繋ぐ——繋いだら E2E が落ちた

`docs/tasks.json` の `landlock-guard-wiring`。`assertRulesetIsSafe`（`/`・home・
banto のデータ置き場の祖先・資格情報を含むディレクトリを拒否する）は実装もテストも
あったのに、**`cli.ts` が呼んでいなかった**。呼び出しは `guard.test.ts` だけ
（2026-09-09 のレビューで grep 済み）。

書き出す直前に1回呼ぶだけの変更……のはずが、**繋いだ瞬間に E2E が全部落ちた**。

## 落ちた理由——試験環境だけが緩かった

```
ルールセットが dataDir の祖先を許可しています:
  /home/ubuntu/worktrees/banto-v4/banto ⊇ /home/ubuntu/worktrees/banto-v4/banto/e2e/.tmp-data
```

開発時のモノレポでは、Module に**モノレポの根**を読み取り許可している
（npm workspaces が `node_modules` を根に hoist し、ワークスペース間参照が
`packages/*` への symlink になるため——`derive.ts` の `moduleInstallDirs`）。
E2E の `dataDir` はそのモノレポの中（`e2e/.tmp-data`）に置いてあった。

つまり **E2E では Module が banto 自身の Event Store を読めた**。本番
（`~/.local/share/banto`）には無い形で、試験環境だけが緩い。検査を疑う場面ではなく、
**置き場のほうが間違っていた**——`banto/e2e/config.ts` の `DATA_DIR`／`CONFIG_PATH` を
`os.tmpdir()/banto-e2e/` へ移した（本番と同じ「リポジトリの外」という関係になる）。

`moduleInstallDirs` を Module のパッケージ単位に絞る案は採らない——開発時の
hoist と symlink の事情でモノレポの根が要る（`shell/src/landlock.integration.test.ts`
のコメントに記録済み）。**本番の配布形ではこの緩さ自体が無い。**

## ついでに直したこと

新しい spec が受信箱にお知らせを2件残すため、`module-connect-failure.spec.ts` の
「受信箱に1件だけ」が3件を数えて落ちた。**受信箱は banto 全体で1つ**なので、

- 新しい spec は出したお知らせを最後に片づける
- `module-connect-failure` の画面側の数えは**自分の Project の分だけ**に絞る
  （他の spec の事情で落ちる試験にしない、規則6）

の両方を入れた。根っこ（spec が同じ core と受信箱を共有して並走する）は
`docs/tasks.json` の `e2e-run-isolation` のまま。

## 測った結果

- 新しい E2E（`e2e/specs/landlock-guard.spec.ts`）：Project の根に home を指定すると
  **Shell と FileSystem は繋がらず、Vault は繋がる**（全部が止まるわけではない）／
  受信箱のお知らせに `禁止パス` と当のパスが出る／画面でもそれが読める
- **検査の呼び出しを外すと、この spec が「shell も filesystem も繋がってしまった」で
  落ちる**ことを確かめた（規則1）
- E2E 27件・単体155件・typecheck 通過
