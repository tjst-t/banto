# E2E が人の `~/.claude` を汚すのをやめる（2026-09-16）

## 何が起きていたか

ユーザーからの相談——「e2e やるたびに Claude Code のセッションが増えて、CloudCLI が
重くなっていく」。

実際に数えた（2026-09-16）：

| 置き場 | 件数 | うち E2E 由来 |
|---|---|---|
| `~/.claude/projects/` | 4386 ディレクトリ | **4198**（`-tmp-banto-e2e-*`） |
| `/tmp/banto-e2e-*`（作業ディレクトリ本体） | 7103 | 全部 |
| CloudCLI の `~/.cloudcli/auth.db` `projects` | 4516 行 | **4195** |
| 同 `sessions` | 6396 行 | **4816** |

期間は 2026-09-05〜09-16 の11日。

**仕組み**：Runner は claude CLI を子プロセスとして起こす。CLI は **cwd ごとに
「プロジェクト」を作り**、会話の記録を `<config>/projects/<cwd を潰した名前>/` に書く。
E2E の spec は毎回 `mkdtempSync(join(tmpdir(), "banto-e2e-<名前>-"))` で
**違うパス**の作業ディレクトリを作るので、**1回の E2E で spec の本数だけ
プロジェクトが増える**。

**容量ではなく件数の問題**だった——E2E 由来の記録は合わせて 51MB しかない。
効いていたのは一覧に並ぶ 4000 件のほう。

## 直し方の候補（検討したもの）

| | 案 | 却下した理由 |
|---|---|---|
| A | `settings.json` の `cleanupPeriodDays` を短くする | 消えるのは `.jsonl` で、**空のディレクトリが残ると一覧には残る**。しかも「人の環境に書いてから片づける」形なので、片づくまでの間は汚れたまま |
| B | 実行の後片づけ（teardown）で `~/.claude/projects/-tmp-banto-e2e-<RUN_ID>-*` を消す | 同上——**書いてから消す**かぎり、走っている最中の一覧汚染と片づけ漏れが残る。spec 45本の `mkdtemp` を helper に寄せる改修も要る |
| **C（採用）** | E2E の core に `CLAUDE_CONFIG_DIR` を渡し、**そもそも `~/.claude` に書かせない** | — |

C は「E2E は人の環境を借りない」（2026-09-13、フロントの port と `.next` を
分けたときの判断）の続き。**人の環境に書いてから片づけるのではなく、書かない。**

## 詰まったところ——認証

`CLAUDE_CONFIG_DIR` を移すと、CLI は**認証もそこから読む**。実測：

```
CLAUDE_CONFIG_DIR=/tmp/probe/cfg claude -p "Reply with exactly: OK"
→ Not logged in · Please run /login
```

資格情報は `~/.claude/.credentials.json`（OAuth）。ここで2つ試した。

1. **`.credentials.json` を symlink する** → 通った。ただし**CLI はトークンを
   更新するときに書き戻す**。写しや symlink を挟むと、更新が人の側に届かない／
   届き方が読めない——**人のログインを壊しうる**（規則3——写しを持つと、いつか食い違う）
2. **`CLAUDE_SECURESTORAGE_CONFIG_DIR` で資格情報の置き場だけ別に指す** → 通った。
   **記録は実行ごとの置き場、認証は本物**、という分け方ができる。写しを作らない

**2 を採った。**

（`CLAUDE_CONFIG_DIR` も `CLAUDE_SECURESTORAGE_CONFIG_DIR` も、
`@anthropic-ai/claude-code` の実体から名前を確かめたうえで、実際に走らせて
効くことを見ている——規則1）

## 入れたもの

- `e2e/config.ts` — `CLAUDE_CONFIG_DIR`（`/tmp/banto-e2e/<RUN_ID>/claude`）と
  `CLAUDE_CREDENTIALS_DIR`（既定 `~/.claude`）を決める
- `e2e/global-setup.ts` — 置き場を毎回作り直す。**資格情報が読めなければ、
  走る前に理由を出して止める**（指しそこねると全 spec が「AI が何も返さない」
  という形で落ち、原因が認証だと画面から分からない——規則2）
- `e2e/start-core.ts` — `cli.js` を読み込む**前に** env を置く。Runner が起こす
  CLI はこのプロセスの env を引き継ぐ

実行ごとの置き場なので、既存の `removeStaleRuns()`（1日より古い実行を消す）が
そのまま回収する。**新しい掃除の仕組みは足していない。**

## 溜まってしまった分の後始末

- `~/.claude/projects/-tmp-banto-e2e-*` 4198 件と `/tmp/banto-e2e-*` 7103 件は削除済み
  （退避：`~/banto-e2e-claude-projects-2026-09-16.tar.gz`。削除前にディレクトリ数と
  `.jsonl` 本数がディスクと一致することを照合した）
- **CloudCLI は `~/.claude/projects` を直接見ていない**——自前の SQLite
  （`~/.cloudcli/auth.db`）に `projects`／`sessions` を持っていて、**消えたパスを
  回収しない**。ファイルを消しても一覧は 4000 件のまま。
  DB 側の削除は未実施（権限の判定に弾かれ、ユーザーに判断を渡した）。
  退避は `~/cloudcli-auth.db.bak-2026-09-16`、削除スクリプトは `~/cloudcli-prune.mjs`

## 残っていること

- `/tmp/banto-*`（`banto-memory-*`・`banto-f4-*` など E2E 以外の実験）由来の
  プロジェクトが 128 件残っている
- **この件は banto 自身の課題でもある**：banto が Module や Runner を通じて
  外部ツールを起こすとき、**そのツールが人の環境のどこに書くか**を把握していないと、
  同じことが本番でも起きる。いまは E2E だけを直した
