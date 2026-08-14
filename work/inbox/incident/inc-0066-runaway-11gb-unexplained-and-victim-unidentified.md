# inc-0066 暴走した1本の 11GB の内訳と victim の同定ができていない

- 起票: 2026-08-14（番頭）
- 深刻度: 中（**封じ込めは別途入るが、原因は塞がっていない**）
- 状態: open（**未解明であること自体を記録として残す**。推測で埋めないこと）

## これは「分からなかった」ことの記録である

2026-08-14 00:27:55 UTC の OOM で VM が丸ごと応答不能になり、PO が2度 VM を再起動した。
原因側の手当てを一次情報で洗った結果、**11GB を確保した機構は特定できなかった**。
封じ込め（`banto-worker-pool.service` への `MemoryMax` と `OOMPolicy=continue`）は
別途入るが、それは「1本の暴走で店を閉めない」ための手当てであって、
**なぜ1本が 11GB まで膨らんだのかは未解明のまま残る**。

次に読む人が誤った前提から再出発しないよう、**当初の見立ての撤回**も明記する。

## 撤回する見立て

> 「11GB を抱えていたのは職人 `banto-restart` で、引き金は `node_modules` の minify 済み
> JS への巨大 grep（`grep -rhoiE '.{0,60}truncat.{0,80}' … | sort -u | head -25`）だった」

**この同定は撤回する。** 根拠は次の2つ（いずれも一次情報）。

1. **pid の生成順が合わない。** claude は Bash 呼び出しごとに bash を1本起こし、
   パイプラインの各段は左から順に連番で付く(本件調査中に2回実測)。事故時の並びは
   `bash 431014 → sort 431015 → head 431016 → claude 431017` であり、
   `grep | sort | head` なら **431015 は grep でなければならない**。
   そして 10.7GiB のプロセス(431017)は **head より後に生まれている**。
2. **対応する node ホストが居ない。** systemd の kill 一覧(00:27:56)に載っている職人は
   「node ホスト6本 ＋ claude 6本」で対になっているが、**431017 と対になる node ホストが無い**。
   同じ一覧に bash/sort/head は載っている(＝その時点で生存)が 431017 は無い(＝既に死亡)。
3. 参考: `banto-restart` のホストは **pid 429938**(退避ディレクトリ名が一次情報)で、
   その claude は **429950(216MiB)** である可能性が高い。**確定はしていない。**

## 確かめられた事実(否定の側)

- **多数並行の積み上がりではない。** OOM ダンプの Tasks 表で claude は9本。うち8本は
  194〜308MiB(合計 1.81GiB)で、**1本だけが約 10.7GiB**(kill 行の表記は `anon-rss:11.2GB`)。
- **会話履歴の累積ではない。** 事故セッションの CLI 会話記録は 243,750バイト・115行
  (最長行 14KB)、その日いちばん大きい記録でも 2.9MB。現に動いている claude の RSS は
  稼働 166秒でも 2310秒でも 310〜370MB で平ら＝**時間と相関しない**。
- **単発の巨大ツール出力でもない。** 196KB を吐く Bash を1回だけ実測したところ、
  claude CLI は **ちょうど 30,000文字**で切り、残りは自分でファイル(`tool-results/*.txt`)へ
  逃がしていた。バイナリ内に `BASH_MAX_OUTPUT_LENGTH` と
  `[console output truncated at 50MB]` の登録もある。**Bash 経路から 11GB は入らない。**
- したがって膨らんだのは **claude CLI(297MB の Bun 単一実行ファイル・minify 済み)の内側**で、
  banto の手は届かない。**どの確保経路かは分かっていない。**

調査の全文: `banto-desk/reports/2026-08-14-oom-cause-and-fixes.md`

## 次に起きた瞬間に何を採るか(これが本体)

**プロセスが死ぬと二度と取れないもの**から順に並べる。上から順に打つこと。
`<pid>` は cgroup の中でいちばん RSS が大きい claude:
`ps -eo pid,rss,args --sort=-rss | head -5`。

### A. 死んだら消える(取り逃したら決着しない)

1. `cat /proc/<pid>/smaps_rollup`
   — **最重要。** `Anonymous` / `Rss` / `Pss` / `Private_Dirty` / `Shmem` の内訳。
     11GB が anon なのか file-backed なのか shmem なのかが、ここでしか分からない。
2. `cat /proc/<pid>/status`
   — `VmRSS` / `RssAnon` / `RssFile` / `RssShmem` / `VmSwap` / `Threads`。
3. `cat /proc/<pid>/maps`(大きければ `wc -l` の後に `sort -k1` で上位だけ)
   — 巨大 anon 領域が **1本の大きな mapping なのか、細かい多数なのか**。
     アロケータの振る舞い(JSC のヒープか、Bun の外部確保か)の切り分けはここ。
4. `tr '\0' ' ' < /proc/<pid>/cmdline; ls -l /proc/<pid>/{cwd,exe}; tr '\0' '\n' < /proc/<pid>/environ | grep -E 'BANTO_|CLAUDE'`
   — **victim の同定はここで即決着する**(今回はこれを取り逃した)。
     `BANTO_TASK_ID` が入っているので、どの職人かが1発で分かる。
5. `ls -l /proc/<pid>/fd | head -50` と `cat /proc/<pid>/fdinfo/*`
   — mmap したファイル・一時ファイルの正体。
6. `ps -eo pid,ppid,rss,vsz,etime,lstart,args --sort=-rss | head -40`
   — 親子関係の全体像。**死ぬと ppid が失われ、二度と復元できない**(今回まさにこれ)。

### B. 死んでも当面残る(ただし unit 再起動・再起動・tmp 掃除で消える)

7. `cat /sys/fs/cgroup/system.slice/banto-worker-pool.service/{memory.current,memory.peak,memory.stat,memory.events}`
   — `memory.stat` の `anon` / `file` / `slab` / `kernel` の別。**unit を再起動すると消える。**
8. `journalctl -k --since '5 min ago'` の OOM ダンプ(Tasks state 表と kill 行)
   — 残る。ただし **A と突き合わせないと今回と同じ取り違えを繰り返す。**
9. 退避先 `${TMPDIR:-/tmp}/banto-worker-offload/<taskId>-<pid>/`
   — **ディレクトリ名に taskId と pid が入っているので victim 同定の鍵**。
     ただし tmp なので VM 再起動で消える。**再起動より先に採ること。**
10. セッション記録 `/var/lib/banto/worker-pool/sessions/*.jsonl`、CLI 側
    `~/.claude/projects/**`、`tool-results/*.txt`、banto の帳簿(worker events / spawn-ledger)
    — 残る。急がない。

## そもそも人が間に合わないなら何が要るか

**人は間に合わない。** 0 から 11GB までは分単位で進み、今回は深夜で誰も見ていなかった。
必要なのは **天井(`MemoryMax`)の手前に `MemoryHigh` を置いて throttle を掛け、
その瞬間に上の A-1〜A-6 を自動で採る張り込み**(`memory.events` の `high` を
poll / inotify で拾う小さな常駐)である。throttle は暴走を殺さずに引き延ばすので、
採取の時間を作れる。**これは第2段(封じ込めの設計)への入力とする。**

## 関連

- `banto-desk/reports/2026-08-14-oom-containment-plan.md` — 第1段(`MemoryMax` / `OOMPolicy=continue`)
- `banto-desk/reports/2026-08-14-oom-cause-and-fixes.md` — 原因側の全調査
- **別件だが同時に見つかった**: 台帳が知っていた職人は2件なのに claude は9本走っていた
  (実測で1GB前後の無駄)。番頭が直接 `worker.spawn` する経路には本数の門も無い
  (`packages/banto-worker-pool/src` に `maxConcurrent` の類は1件も無い)。**これは別に扱う。**
