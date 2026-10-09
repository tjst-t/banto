# E2E を worker ごとの core で並列に走らせる（2026-10-08）

フル E2E が 50 分（89 spec・239 件、workers: 1）。ユーザーが決めた順の2段目——1段目（機械全体のロック・spec ごとの
所要時間・spec の替わり目の戻し・action の上限・偽の Infisical）のあとで、**worker ごとに core を1本持たせて並べる**。

## 流し方

```
cd banto/e2e && npx playwright test [spec...]          # 既定は 2 並列
BANTO_E2E_WORKERS=1 npx playwright test [spec...]      # 切り分け：core 1本・worker 1つ（並列にする前と同じ形）
BANTO_E2E_WORKERS=3 npx playwright test [spec...]      # 1〜6
```

- **`--workers`／`-j` は使わない**。core は `BANTO_E2E_WORKERS` の数だけ起きるので、それより多い worker は相手の
  core が無い——`config.ts` が理由つきで止める
- incus グループの付いていないプロセス（Shell の runCommand・サブエージェントの中）から流しても、主プロセスが
  `sudo -n -E -u <自分>` で自分を起こし直す（`incus-access.ts`）。手で `sudo -u` を付けなくてよい
- 並列でだけ落ちる spec があれば、まず `BANTO_E2E_WORKERS=1` で同じ spec を流して比べる

## 作った形

| どこ | 何をする |
|---|---|
| `playwright.config.ts` | webServer に core を `CORE_COUNT` 本（`BANTO_E2E_CORE_INDEX=i`）と画面1本。`workers: CORE_COUNT` |
| `config.ts` | 番号（core は `BANTO_E2E_CORE_INDEX`、worker は Playwright の `TEST_PARALLEL_INDEX`、主プロセスは 0）から、port・置き場（`<回>/w<番号>/…`）・偽物の行き先を決める。**定数の名前は変えない**（65 の spec が読み込み時に import している） |
| `start-core.ts` | 自分の番号の `CONFIG_PATH` を `BANTO_CONFIG_PATH` に置いてから起きる。片づけ役（`run-reaper.ts`）も core ごとに1本 |
| `global-setup.ts` | 前の回の置き場・コンテナの片づけは 0 番の core だけ（同じものを何本もが消しに行かない） |
| `global-teardown.ts` | 全部の core の札（`coreDataDir(i)`）のコンテナを消す |
| `containers.ts` | 札の形 `E2E_OWNER` に `w<番号>/` を足す（次の回の始めが拾える） |
| `test-base.ts` | 替わり目の戻しは自分の core にだけ効く（`CORE_BASE_URL`・`DATA_DIR` がその worker のもの、覚えるファイルも `w<番号>` の下） |
| `spec-timing-reporter.ts` | worker の数と spec の時間の和（並ぶので回の合計を超える）を出す |

- **core の寿命は回に結びつける**。webServer は主プロセスが回の始めに起こし、終わりに止める。worker は落ちると
  作り直される（同じ `parallelIndex`）が、同じ番号の core をそのまま使い、覚えたファイル（前の spec 等）の続きから読む
- **画面（next）は1本を共有**——`?bantoHost=` が localStorage に覚えられるので、ブラウザの文脈（テストごと）が
  自分の worker の core を向く
- **port**：4740〜4939 を回ごとに 25 ずつ（8 枠）。先頭が画面、続けて core ごとに4つ（core・sandbox・偽の MCP Registry・
  偽の npm registry）。上限 6 本はこの枠から。同じ機械の回はロックで1回ずつなので、枠がぶつかるのはロックを外したときだけ
- **土台イメージ**は core を起こす前に主プロセスが `ensureBaseImage` を呼ぶ（2 本以上のとき）。`@banto/container` は
  同時に呼ばれても1回にまとめるが、それはプロセスの中だけ——core が何本も同時に作り始めると、後から publish した
  ほうが alias の重複で落ちる。あれば問い合わせ1回で終わる

## 片づけ（Playwright が SIGKILL されても）

- core ごとの片づけ役が、Playwright の pid が居なくなったら自分の core を止め、自分の札のコンテナを消す（画面の
  サーバもどれかが止める）
- 起こし直した形（sudo）では、外側のプロセスが SIGKILL されると子に信号が届かない——子が外側の pid を見張り、
  居なくなったら自分に SIGINT を送る。SIGINT・SIGTERM・SIGHUP は外側から子へ渡す
- 確かめた：2 並列で turn-reattach・backlog を流し、外側の node を `kill -9`。子が止まり、片づけ役2本がそれぞれ
  自分のコンテナ（1台・2台）を消し、core・画面のサーバ・ロックが残らなかった

## 並列の数を測った

この機械：4 コア・11.6GiB・swap 無し。同じ 18 本（67 件。コンテナを使うもの・host を起こし直すもの・banto 全体の
Module を触るものを混ぜた）を 1・2・3 並列で1回ずつ。資源は 10 秒ごとに `/proc/loadavg`・`MemAvailable`・
`/proc/pressure/{cpu,memory,io}` の some avg10・動いている banto のコンテナの数を取った。

| 並列 | 回の時間 | 落ち | spec の時間の和 | load1 平均／最大 | cpu some 平均／最大 | io some 平均／最大 | MemAvailable 最小 | コンテナ最大 |
|---|---|---|---|---|---|---|---|---|
| 1 | 787 秒 | 0 / 67 | 12.4 分 | 3.1 / 6.2 | 17.5% / 58.4% | 1.8 / 13.6 | 6855 MiB | 11 |
| 2 | 534 秒 | 0 / 67 | 15.9 分 | 6.3 / 8.9 | 44.4% / 78.2% | 5.9 / 25.7 | 6136 MiB | 12 |
| 3 | 532 秒 | 0 / 67 | 21.1 分 | 9.5 / 18.7 | 59.8% / 86.1% | 9.4 / 50.2 | 5123 MiB | 13 |

- **既定は 2**。3 にしても回は縮まない——worker の仕事は釣り合っていた（3 並列の各 worker が働いた時間 410・476・
  378 秒）ので、配り方の偏りではなく **CPU が詰まって spec 1本ずつが遅くなった**（spec の時間の和が 2→3 で +33%）
- メモリは足りている（最小でも 5GiB 残る）。コンテナの数は spec の替わり目に畳むので、並列の数＋α に収まる
- フル（89 本）の見込み：50 分 ×（534−約40）/（787−約40）≈ **33 分前後**（測っていない——最後のフルは依頼主が流す）
- 2 並列でもう1組（18 本：host の起こし直し・自前の host・SSH の相手・画面からの更新・Repositories・Vault の置き場・
  サブエージェントなど）を流した：下の「2組目」

### 2組目

（記入：下で測る）

## 直列にしたもの

なし。機械全体の何かを触る spec を探した：

- host を起こし直す spec（turn-resume-restart・update-wait-restartable・subagent-resume-restart・
  factory-resume-restart・stream-relay）は自前の host（`own-host.ts`、空き port・回の下の `own-*`）を起こすので、
  worker の間で混ざらない。self-update は core ごとの置き場（`releaseDir`・偽の systemctl）
- remote-runtime-ssh-host の土台イメージ（`banto-e2e-sshd-…`）は機械で共有だが、使うのはこの spec だけ。同時に
  作っても publish の失敗は「もうある」で受ける作り
- wide-root（Project の根＝ホーム）はホーム全体をコンテナに見せるが、他の worker の置き場が見えるだけで書かない
- project-container の資源の上限は host の総量から計算する（空き量ではない）ので、並びの影響を受けない
- 受信箱・Project の一覧・banto 全体の Module・Vault の alias は core ごと

## 残っていること

- 並列にしたフル E2E はまだ流していない（依頼主が流す）。並列でだけ落ちる spec が出たら、待ちを延ばさず、
  `BANTO_E2E_WORKERS=1` と比べて資源の合図か spec 同士の干渉かを分ける
- 自前の host（`own-host.ts`）の置き場は今も `<回>/own-*`（passwd のホームの下）で、`w<番号>` の下ではない。札で
  引くのに困らないので変えていない
