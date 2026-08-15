---
id: imp-0027
kind: improvement
status: open
created: 2026-08-14
refs: [task-0151, inc-0070]
---

# 職人の自動起動を止める弁を、rework 系の経路が見ていない

## 先に事実の訂正

「設定の読み手が `packages/banto-daemon/src` に見当たらない」という見立ては**外れている**。
`disableAutoSpawn` は main（`7e476cbd`）の `daemon.ts` に**読み手がある**：

```
packages/banto-daemon/src/daemon.ts:326   disableAutoSpawn?: boolean;        ← 型
packages/banto-daemon/src/daemon.ts:566   if (!config.disableAutoSpawn) {    ← 読み手（tick の登録）
packages/banto-daemon/src/daemon.ts:692   if (this.config.disableAutoSpawn || …) ← 起動時に帳簿へ出す
```

`grep` で見つからなかった理由は分からないが、**設定が黙って無視されているのではない**。
問題はそこではなく、**弁が届く範囲が狭いこと**である。

## 何が起きるか

`disableAutoSpawn` が止めるのは **`auto-spawn` という tick ジョブの登録だけ**だ
（`daemon.ts:566-570`）。職人を起こす道はそれ以外にもあり、そちらは弁を見ない。

| 職人を起こす経路 | 呼ぶ場所 | 弁を見るか |
|---|---|---|
| 通常の着手（ready → 職人） | `runAutoSpawn`（4042）→ `spawnTask` | **見る**（tick を登録しない形） |
| 監査（implementing → auditing） | 3058 | **見る**（`disableAuditSpawn`）。しかも**黙らない**——`audit_spawn_disabled` を積む |
| **監査人が判定を出さずに落ちた再試行** | 2827 | **見ない** |
| rework（監査落ち1回目） | `handleAuditVerdict` → 3335 | **見ない** |
| rework（`kobo.reopen` mode:rework） | 1548 | **見ない** |
| rework（`kobo.send_back`） | 1623 | **見ない** |
| rework（衝突からの差し戻し・第4便） | 4346 | **見ない** |
| `kobo.reopen` mode:reverify | — | 職人を起こさない（`approved` へ戻すだけ・1466） |

つまり **`spawnReworkSession` を通る4経路と、監査の再試行**が弁の外にある。
`spawnTask` 自体にも検査は無いので、直に呼べば弁に関係なく起きる（試験が実際にそうしている）。

**監査だけが正しい形になっている。** 弁を見て、抑止したことを帳簿に残す（F2 統治：
「黙って迂回できる経路を作らない」）。rework 系にはその両方が無い。

## なぜ問題か

### 1. 試験の中で**本物の**職人が起動しうる

Kobo が職人を頼む先の既定は **`http://127.0.0.1:4100/api/worker-pool`**（`daemon.ts:498-502`）。
このホストではそこに**稼働中の Worker Pool が居る**（実測：`worker.list` が 200 を返す）。

`npm test` は `BANTO_WORKER_POOL_URL=http://127.0.0.1:1/...` を渡して届かない先へ逃がしているが、
**`node --import tsx --test <1本>` を直に叩くとその環境変数は付かない**。
`disableAutoSpawn: true` と書いてある spec でも、rework 系の経路に入れば
**稼働中の Worker Pool へ「職人を起こせ」と言いに行く**。
書いた人は「自動起動は止めてある」と思っているので、これは意図されていない。

### 2. 弁が嘘になる

`disableAutoSpawn: true` は「この試験では職人を起こさない」という宣言として読まれている。
実際には**半分しか止まらない**。読んだとおりに動かない設定は、次に誰かが
「止めたはずなのに起きた」を追うときの時間を丸ごと持っていく。

### 3. 間欠の温床になる

第4便で実際に踏んだ。衝突で `merging → implementing` へ戻したあと `spawnReworkSession` が走り、
届かない Worker Pool に当たって I2 のとおり `recordTaskFailed`（`daemon.ts:3403`）が動く。
その結果、**戻した直後の状態が「職人を起こせたか」で `implementing` と `failed` に割れる**。
状態を見ていた試験3本が「単体では通り全量では落ちる」形になった
（試験の側を「遷移そのものを見る」に直して収めたが、**根はこの不揃い**）。

### 4. 抑止が帳簿に残らない

監査は `audit_spawn_disabled` を積むので、あとから「なぜ起きなかったか」を追える。
rework 系は仮に止めても何も残らない。**止まったことと壊れたことが区別できない**。

## 直し方（案）

**弁を1つにし、抑止を必ず記録に残す**、が筋。

1. **`spawnReworkSession` の入口で弁を見る。** `disableAutoSpawn`（＝職人を起こさない）を
   見て、止めるときは `audit_spawn_disabled` と同じ形の抑止イベントを積む。
   4経路が1関数を通っているので、**直すのは1箇所**で済む。
2. **監査の再試行（2827）も `disableAuditSpawn` を見る。** いまは
   「1回目は止まるが、監査人が落ちたときの2回目は起きる」という読めない形になっている。
3. **名前を役割に合わせる。** いまの `disableAutoSpawn` は字面が「自動着手だけ」に読める。
   実装を「職人を起こす道すべて」に広げるなら、名前もそちらへ寄せた方がよい
   （例：`disableWorkerSpawn`。既存の呼び名を変えるので、これは番頭の判断）。
4. **`spawnTask` にも同じ検査を置くか**は要判断。試験は**意図して**直に呼んでいるので、
   ここを塞ぐと「弁を閉じたまま1本だけ起こす」ができなくなる。**塞がない**方に一票。

**併せて**：既定の Worker Pool が**稼働中のもの**であること自体が危うい。
`BANTO_WORKER_POOL_URL` を渡し忘れた試験が本番の工房を叩く形になっている。
「試験では既定を届かない先にする」か「既定を持たず、未設定なら起こさずに断る」かは、
上の1〜3とは別の判断として切り出せる。

## 確かめた手順

- main `7e476cbd` の `packages/banto-daemon/src/daemon.ts` を読み、上表の行番号を突き合わせた
- `rg -n 'disableAutoSpawn' packages/ --glob '!dist'` で読み手が 566 / 692 にあることを確認
- `ss -ltnp | grep :4100` と `curl -X POST .../worker.list` で、既定の宛先に**生きた Worker Pool が居る**ことを確認（200）
- 第4便の作業中に、状態で見ていた試験3本が単体と全量で結果が割れることを実測（原因は上の3）

**コードは直していない。** これは起票である。
