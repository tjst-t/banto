---
id: inc-0047
type: incident
kind: incident
origin: po
class: availability
status: resolved
refs: [inc-0046, task-0087, adr-0016]
---

## 内容

PO要請で番頭ホストを再始動したところ、**待ち受け開始まで5分01秒かかった**（2026-08-09 04:23）。
直前の再始動（同日 02:59）は**4秒**。その間、Banto の画面は一切開けない。

```
04:23:28  systemd: Started banto.service
04:23:32  [banto] 0.0.0.0 で待ち受けます（…）      ← ここで止まる
04:28:33  [banto] 書き込み禁止の置き場: …          ← 5分01秒後
04:28:35  [banto] listening on ws://localhost:4100/ws
```

## 実測

止まっていた区間にあるのは `ModelRuntime.create()` と `modelRegistry.refresh()` の2つだけ
（`bin.ts`）。切り分けると：

| 呼び出し | 台帳が温かいとき | 台帳が冷えているとき |
|---|---|---|
| `ModelRuntime.create()` | 56ms | **47〜70ms**（内側の更新は `allowNetwork: false`） |
| `refresh({allowNetwork:false})` | — | **16ms**（モデル 1231 件が揃う） |
| `refresh()`（既定＝遠隔あり） | 21ms | **300 秒超で失敗 → 再試行で 322ms** |

冷えた台帳で `refresh()` を測ると、外へ出る呼び出しがそのまま出る：

```
     47ms  create（refreshOnCreate:false）→ models=1231
 300844ms  ✗ 300778ms https://pi.dev/api/models/providers/opencode      TypeError: fetch failed
 300846ms  ✗ 300767ms https://pi.dev/api/models/providers/opencode-go   TypeError: fetch failed
 301168ms  → 200 322ms https://pi.dev/api/models/providers/opencode-go
```

**300.8 秒 ＝ Node の `fetch` が自前で諦める既定値。** 番頭側には上限が無かったので、
その 300 秒がそのまま待ち受け開始の遅れになった。

裏付け：`~/.pi/agent/models-store.json` の `checkedAt` が
`opencode` = 04:23:32、`opencode-go` = **04:28:33**——止まっていた区間の両端と一致する。

そして `pi.dev` はこの機体から**今も届かない**（20 秒上限で 5/5 時間切れ。v4 も v6 も）。
届く日と届かない日がある相手で、届かない日は毎回 5 分待つ。

## 原因

**起動が、外の応答に握られていた。**

- pi は起動時にプロバイダごとの目録を `https://pi.dev/api/models/…` から取り直す
- `bin.ts` はそれを `await` していた（`await modelRegistry.refresh()`）
- `refresh()` は `signal` を渡さなければ**上限を持たない**。頼れるのは `fetch` の既定 300 秒だけ

しかも**待つ必要が無かった**：解決に要る表は `models.json` と組み込みの定義から既に
組めている（実測 1231 件、16ms）。遠隔の目録が効くのは**新しいモデルが増えたとき**だけで、
起動を止めてまで揃えるものではない。

`await` を置いた理由はコメントに残っていた——「pi 0.84 で `refresh()` が非同期になった。
**await してから同期の読み出しをすること**と型に書いてある」。読み方が一段ずれていた：
待つべきは**手元の表が組み上がるまで**（`create()` が済ませている）であって、
**遠隔の目録が届くまで**ではない。

## 直したこと

`refreshModelCatalog()`（`packages/banto-host/src/model-catalog.ts`）を作り、
**待たない・上限を持つ・黙らない**の3つを機構として持たせた。

- **待たない**：`void refreshModelCatalog(modelRegistry)`。届いたら反映される
- **上限を持つ**：`AbortSignal.timeout(10 秒)`。届いた日の実測は 322ms なので、
  遅い回線でも十分に広く、300 秒からは2桁小さい
- **黙らない**（I2）：諦めた・一部取れなかった・失敗した、をそれぞれログに出す。
  出しておかないと「モデルの一覧が古い」の原因がここだと誰も辿れない
- **投げ返さない**：待たない呼び出しの例外は `unhandledRejection` でプロセスごと落とす。
  目録が古いだけで番頭が死ぬのは筋が違う

`bin.ts` から切り出したのは**試験から掴むため**。あちらは読み込むと `main()` が走る入口で、
中の関数を試験から呼べない。

## 確かめたこと

**同じ条件で測り直した**（台帳を消す＝冷えた状態、`pi.dev` は届かないまま）：

| | 待ち受け開始まで |
|---|---|
| 直す前 | **5分01秒**（1/1。切り分けの計測では 300.8 秒 ×2 で 6分40秒でも終わらず） |
| 直した後 | **4.0 / 5.0 / 4.0 / 5.1 / 4.0 / 5.1 秒**（6/6） |

起動ログにも出る：

```
[banto] モデルの目録を 10 秒で諦めました（手元の models.json で動きます。新しいモデルは出ないことがあります）
```

目録が届かなくても**モデルは解決できている**ことを実機で確認した——起動ログの
`model: opencode-go/deepseek-v4-flash`、`llm.list` が 3 プロバイダ・32 モデル
（採用済み 32 件すべて）を返す。

見張り：`tests/acceptance/model-catalog-startup.spec.ts`（6本）。

## 相手側の状態（切り分け済み・2026-08-09 05:2x）

**こちらの回線ではない。** 順に潰した：

| 見たもの | 結果 |
|---|---|
| DNS | システムも `1.1.1.1` も同じ（104.21.62.67 / 172.67.221.13） |
| TCP 443 | 両方つながる |
| TLS | ハンドシェイク成功（TLSv1.3・証明書 CN=pi.dev・検証 OK） |
| 他の Cloudflare 前段（models.dev / cloudflare.com / registry.npmjs.org） | いずれも 200、20〜25ms で接続 |
| HTTP/1.1 と HTTP/2 の別 | **どちらも同じに止まる**（h2 の問題ではない） |

**pi.dev 自体は生きていて速い。止まるのはあの経路だけ：**

```
https://pi.dev/                                  → 200  0.07 秒
https://pi.dev/api/latest-version                → 200  0.06 秒  {"ok":true,"version":"0.84.1",…}
https://pi.dev/api/models/providers/opencode-go  → 100 秒待っても応答なし
```

`/api/models/providers/` は**プロバイダを問わず**止まる——存在しない id
（`nonexistent-xyz`。本来なら即 404）でも 15 秒で無応答。openai / anthropic / opencode /
opencode-go も同じで 5/5。

つまり **`/api/models/providers/*` が向こう側で詰まっている**（04:45 頃に1度だけ 322ms で
返ったので、落ちきってはおらず断続的）。こちらで直せるものではない。

**やることは無い。** 上限つき・待たない作りにしたので、詰まっていても起動は 4〜5 秒で、
モデルは手元の表で解決できる。相手が戻れば次の起動で目録が更新される。
`PI_OFFLINE=1` で叩くこと自体を止める手もあるが、**断続的に戻る相手なので入れない**
——入れると戻った日にも取りに行かなくなる。
