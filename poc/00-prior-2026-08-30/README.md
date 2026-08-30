# 00-prior-2026-08-30 — v4-architecture.md §8 実測の退避

**捨てる。本実装に流れ込ませない。**

`docs/specs/v4-architecture.md` §8（A-1〜A-9・B-1/B-2・Landlock・forkSession・
tool数・Skill の実測）は 2026-08-30 に `/tmp/banto-exp/` で行われたが、
そこは git 管理外で `/tmp` はいずれ消える。**唯一の写しを失う前に、このワークツリーへ
そのまま退避した**（2026-08-30、`poc/00-prior-2026-08-30/` へコピー）。

## 何をしたか

- `/tmp/banto-exp/*.mjs` `*.py` `usage.json` をそのままコピー
  （**`cred2.json` は資格情報なので持ち込んでいない**）
- 各 `.mjs` は `@anthropic-ai/claude-agent-sdk` を
  `/home/ubuntu/worktrees/banto-v3/node_modules/...` へ**絶対パス**で import していた
  （v3 の node_modules が upgrade されると気づかず追随する壊れ方をする）ので、
  `package.json` を足して版を明示的に固定し（`0.3.237` / MCP SDK `1.30.0` /
  zod `4.4.3` ——元のスクリプトが実際に読んでいた版と一致することを確認済み）、
  import を `./node_modules/...` の相対パスに機械的に置換した
- `npm install`（`NODE_ENV=production` だと devDependencies が飛ぶので
  `--include=dev` が要る——`memory/npm-install-drops-devdeps.md` の再発）
- `exp1.mjs` を実際に走らせて動くことを確認した（教訓1：退避しただけで動作未確認のまま
  「移した」と言わない）。新規セッションなので `cache_creation` のみ、費用 $0.1555

## 結果の記録先

数値そのものと結論は `docs/specs/v4-architecture.md` §8 に**既に転記済み**。
ここにあるのは**再現用のコード**であって、結果の一次情報ではない。

## 中身

| ファイル | 何を測ったか |
|---|---|
| `exp1.mjs` | B-1: cold な単一ターンの起動費用 |
| `exp2.mjs` | A-1: `resume` しながら MCP サーバ集合を変える |
| `exp3.mjs`/`exp4.mjs` | A-2 の否定側: 閉じた入力での `interrupt()` は失敗し処理は完走する |
| `exp5.mjs` | A-2 の肯定側: 開いたままの入力での `interrupt()` は成功する |
| `exp6.mjs`/`exp7.mjs`/`usage.json` | A-9: 使用量 API |
| `expA5*.mjs` | A-5: ファイル巻き戻しが `resume` をまたぐか |
| `expA78*.mjs`/`expC.mjs` | A-7/A-8: 資格情報を跨いだ `resume`・キャッシュ挙動 |
| `expB2.mjs`/`stdio-mcp.mjs` | B-2: Module 再接続コスト |
| `expTools.mjs` | tool 数と文脈・キャッシュ |
| `expSkill.mjs` | Skill と文脈 |
| `expFork.mjs` | `forkSession` の枝分かれ |
| `landlock.py`/`landlock2.py` | Landlock による閉じ込め |

## 既知の欠け

`/tmp/banto-a5`（A-5 の cwd）は既に消滅済み、`~/.claude-c`（`expC.mjs` が使う
資格情報ディレクトリ）は元々このマシンに存在しなかった——**その2本はこのままでは
再現できない**（元の実測時点のログが §8 に残っているのみ）。
