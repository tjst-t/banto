# Shell が長い出力で消えた件と、長い出力の返し方（2026-09-29）

決まったことは `docs/specs/v4-modules.md` §2.3「長い出力」。ここは経緯・測ったこと・却下した案。

## 何が起きたか

banto.tjstkm.net で「Shell Module が使えなくなる。再起動すると治るが、またすぐ使えなくなる。そうなると
他の Module も Ctrl-K の Launcher から選べなくなる」（ユーザー報告）。

- `~/banto-host.log` には `[host] shell の tool 一覧が取れませんでした…: Not connected` と
  `[host] リクエスト処理で例外: Not connected` だけ。落ちた痕跡（スタック・FATAL）も OOM も無い
- Runner の記録（`~/.claude/projects/<cwd>/*.jsonl`）を引くと、2回とも直前の呼び出しは同じ Fork の
  `cp -al …/node_modules /home/ubuntu/wt-inline-fix/banto/node_modules`（14:01:24 と、再起動直後の 14:07:09）。
  写し先はコンテナの rootfs（btrfs）、写し元は Project（ext4 の bind mount）で、ハードリンクが全部 EXDEV で落ちる。
  コンテナの中で測ったエラー出力は **12,122,706 バイト**
- 同じ時刻に別の Thread の `tsc` なども `Not connected` になった——Shell は Project の全 Thread で共有

### 仕組み（再現して確かめた）

MCP SDK 1.30.0 の `ReadBuffer`（`shared/stdio.js`）は **1通 10 MiB（10,485,760 バイト）が上限**。越えると
host 側の `StdioClientTransport` が `ReadBuffer exceeded maximum size` を `onerror` に出して閉じ、子（Shell）は
**exit 0・stderr 無し**で終わる。Shell を単独で stdio で起こして試した：

| 返事の大きさ | 結果 |
|---|---|
| 10,384,055 バイト | 返る |
| 10,587,500 バイト | `ReadBuffer exceeded maximum size of 10485760 bytes` → `Connection closed`、Shell は exit 0 |

Shell の `runCommand` は stdout/stderr を全部ためて1通で返していたので、1回の大きな出力で越えた。
SDK 1.30.0 は 2026-09-05 からで、上限はずっとあった（出力の大きいコマンドが引き金を引いただけ）。

### 連鎖していたもの（この回では直していない・未決）

1. **host は Module の切断を記録しない**——`client.onerror`/`onclose` をログに出さないので、理由が残らなかった
2. **切れた Module を作り直さない**——`connectedModules` に死んだ client が残り、`spawnDeclaredModuleOnce` は
   「もう繋がっている」と見て起こさない。host の再起動まで `Not connected`
3. **入口と設定画面の一覧が1本の失敗で全部落ちる**——`listResourcesOfAll` が `Promise.all` で、各 Module の
   失敗を拾っていない。`/api/projects/:id/ui-launchers`・`/ui-settings` が 500（実測）になり、Ctrl-K の
   「Module の入口」が全部消えた。会話側の `listUiToolsForThread` は 2026-09-22 に1本ずつ落とす形に直してある

1・3 は方針に迷いが無い。2 は「どう起こし直すか」を仕様で決める必要がある。どれも人に確認中。

## 他の道具はどうしているか（2026-09-29 に各リポジトリの現行版を読んだ）

どれも「出力が多いから止める」はしない。持つ量と返す量に上限を置き、切ったことを伝える。

| 道具 | 走っている間 | AI に返す量 | 切った分 |
|---|---|---|---|
| Claude Code 2.1.280 | 8 MiB までメモリ、越えたらファイル（5GB まで） | 30,000 文字（`bashOutputMaxChars`、4,000〜128,000） | ファイルに保存し、先頭 2KB とパス |
| Codex CLI | 1 MiB | 約1万トークン | 途中を捨て、頭と末尾を半々 |
| Gemini CLI | 末尾 16 MB | 40,000 文字 | ファイルに保存し、頭 20%・末尾 80% |
| OpenHands | 10,000 行 | 30,000 文字 | 頭と末尾を半々（ファイルに保存する経路もある） |
| Goose | 上限なし | 2,000 行または 50,000 B | ファイルに保存し、末尾 50 行（8枠を使い回す） |
| Cline | 48,000 文字 | 48,000 文字 | 頭と末尾を半々＋「grep/head/tail で絞って」 |
| Desktop Commander（MCP） | 50 MiB | 1000 行ずつ | ページ送り。1回の返事の上限は無い |

- Claude Code は自分の Bash で実際に確かめた（`seq 1 100000` → `<persisted-output>Output too large (575.1KB).
  Full output saved to: … Preview (first 2KB): …`）。**MCP の結果は別扱い**で、25,000 トークン
  （`MAX_MCP_OUTPUT_TOKENS`）を越えると先頭だけ残して `[OUTPUT TRUNCATED - exceeded 25000 token limit]`
  を付ける（コードを読んだだけ、実測はしていない）。banto の Shell の返事は JSON で終了コードが後ろにあったので、
  10 MiB 未満でも成否が見えなくなりえた
- Desktop Commander のコメントに「上限が無いと V8 の Invalid string length でサーバごと落ちる」とある
- 数字は各リポジトリのソースで照合済み（Codex `utils/pty/src/lib.rs` の `DEFAULT_OUTPUT_BYTES_CAP`、
  Gemini `config.ts` の `DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD`、Cline `output-limits.ts`、
  Goose `developer/shell.rs`、OpenHands `terminal/constants.py`、Desktop Commander `terminal-manager.ts`）

## 案

- **A：途中を捨て、頭と末尾を残す**（Codex・Cline・OpenHands）。置き場も片づけも要らない
- **B：全体をファイルに残し、一部とパスを返す**（Claude Code・Gemini CLI・Goose）

最初は A を推した（決めることが少ない）が、**B にした**。出力が大きくなるかは打つ前に分からないので、A の
「要るなら自分でファイルに書き出す」は、あふれた後にしか使えない＝**打ち直し**になる。打ち直しは高い
（フル E2E は約7分——規則15）か、できない（`git push`・移行など2回目で結果が変わるもの）。B は、返す一部を
頭と末尾にすれば A を含む。増えるのは置き場と片づけの決めごとだけで、どちらも小さい。

**置き場はコンテナの中の Shell のホーム。** banto の AI には Claude Code の Read も Bash も渡していない
（`RUNNER_BUILTIN_TOOLS` は Web と MCP resource だけ）ので、Claude Code 流に `~/.claude/projects/…` に
置いても AI は読めない。Project のフォルダに置くと `git status` を汚す。

## 閾値（「3万文字は大きすぎない？」への答え）

手元の Runner の記録から `runCommand` の出力（stdout＋stderr）1,840 回分を測った：

| | 文字数 |
|---|---|
| 中央値 | 641 |
| 上位 1% | 10,429 |
| 上位 0.1% | 19,524 |
| 最大 | 22,527 |
| 30,000 超 | 0 回 |

大きいものは、ほぼ全部が AI がわざと丸ごと読んだもの（`cat …tsx`、`sed -n 1,471p server.ts`）。閾値を
8,000 に下げると 2.8%（52回）がファイル送りになり、AI は細切れに読み直すことになる。**閾値は 30,000 のまま**
（Claude Code の Bash と同じ）。大きすぎたのは**あふれたときに返す量**のほうで、最初の案（頭と末尾で計3万文字）を
**頭 1,000＋末尾 3,000 文字**に変えた。末尾を多めにするのは、エラーのまとめ・`rc=…` が末尾に出るから
（Gemini CLI も 2:8）。

## 実装で決めた細部（人に確かめていないもの）

- 保存は1ストリーム **64 MiB** まで。`yes` のような止まらない出力でディスクを埋めない（Claude Code は 5GB）。
  越えたら書くのをやめるが、返す末尾は本当の終わり。上限ちょうどで、UTF-8 の文字の途中では切らない
- 置き場は `<Shell のホーム>/.cache/banto-shell/output/<時刻>-<連番>-<乱数>.stdout|.stderr`（0700／0600）。
  host の `syncShellHome` は写した設定ファイルしか消さないので、ここには触らない
- 片づけは直近 20 回分（ユーザー了承）。名前の並び＝起きた順（同じミリ秒でも連番で並ぶ）
- 文字数で数えるため、子の出力を `setEncoding("utf8")` で受ける。以前は `Buffer#toString` をかたまりごとに
  していたので、読み込みの区切りに掛かった日本語が壊れていた（実測：12万字の日本語で、直す前は 5回中5回、
  1回あたり 7〜15 文字が U+FFFD に化けた。直した後は 0回）
- 返すのは子の `exit` の時点（従来どおり）。`exit` のあとにパイプに残った出力を取りこぼすかを測った——
  `seq 1 1000000; echo rc=done` を 20 回、取りこぼし 0 回。`close` まで待つ形にすると、`cmd &` で後ろに残った
  プロセスがパイプを握っている間は返らなくなるので、変えない
