---
id: imp-0037
title: system.restart が再起動をまたぐ会話を落とす（道具が running のまま残り、番頭が黙る）
status: open
severity: P1
origin: 幹「帳場」の枝「system.restart が効かない」（2026-08-15）
refs:
  - packages/banto-host/src/bin.ts:1141-1153
  - packages/banto-host/src/server.ts:859-867
  - packages/banto-host/src/server.ts:1424
  - packages/banto-host/src/threads.ts:452
  - packages/banto-host/skills/safe-restart/SKILL.md:24
---

## 何が起きているか

PO 報告は「`system.restart` を呼んでも再起動しない」。**これは誤診で、再起動は毎回成功していた**。
journalctl（2026-08-15 JST）に自力の clean exit が3回あり、3回とも
`Deactivated successfully` → `Scheduled restart job` → `Started` が並び、9秒で完全復帰している
（`会話を 64 本読み戻しました` / `listening on ws://localhost:4100/ws` まで確認）。
`Restart=always` はドロップイン `/etc/systemd/system/banto.service.d/override.conf` が
本体ユニットの `on-failure` を上書き済みで、実測で効いている。`NRestarts=0`、start limit で
諦めた形跡もゼロ。**ユニット定義は触らないこと。**

PO に見えていたのは「再起動したのに番頭が黙っている」姿。帳場・thread-61 の jsonl に残る
`system.restart` の記録は**全件 `state:"running"` のまま**で、その直後が notice、次が PO の
「固まってた」発言。番頭は再起動の前後で一言も喋っていない。

## 原因（3つ・独立）

### 原因1【本命】道具が `tool_end` を書く前に落ちる
`bin.ts:1141-1153` の `execute()` は notify → 300ms → `await server.close()` → `process.exit(0)`。
`server.ts:1424` の `tool_end`（`ok`/`failed` への確定）へ到達しないので、履歴に `running` が
永久に残る。さらに**起動時に残った `running` を確定させる処理がどこにも無い**——`threads.ts:452`
の突き合わせは、後から `ok`/`failed` が来たときにしか動かない。再起動後にそのスレッドを起こす
機構も無いので、PO が話しかけるまで番頭は黙り続ける。
PO が見た「completed with no output」は、次のターンで Agent SDK を `--resume` したときに
結果の無い tool_use へ空を埋めた姿（推測・未確認）。`process.exit(0)` 到達は journal で確定。

### 原因2 道具の説明と SKILL が、存在しない機構を約束している
道具 description の「再起動後に続きから話せる」、`skills/safe-restart/SKILL.md:24` の手順5
「再起動後を確かめる」は、いまの実装では**番頭に実行不可能**（そのターンは死んでいる）。
原因1を直せば文言のままで正しくなる。

### 原因3【潜在・今回は未発火だが実測で再現】`close()` に無期限で待つ経路があり保険が無い
`server.ts:859-867` は `for (const ws of this.clients) ws.close()` → `wss.close()` →
`httpServer.close()` のみ。`closeAllConnections()` はリポジトリ全体で1箇所も呼んでおらず期限も無い。
同形を別プロセスで再現した実測（Node v24.18.1 / ws 8.21.1）：

- 応答しない WS クライアント1本 → `wss.close()` が **30003ms**（ws の closeTimeout）
- モジュール中継の upgrade ソケット1本（`this.clients` に入らない）→ `httpServer.close()` が
  **70秒待っても返らない＝無期限 hang**

実機は `remote-module.ts:164` / `remote-pools.ts:102` が kobo・worker-pool・environment-pool・
pi-agent の WS を中継していて socket は現に22本開いている。発火する確率は低くない。
SIGTERM ハンドラ（`bin.ts:1901-1914`）も同じ `close()` を通るので同時に直る。

## 直し方

1. **`system.restart` は結果を返してから落ちる**（bin.ts）。`execute()` は文字列を返して即 resolve し、
   終了はターンの外へ（`setTimeout(...).unref()` で 1秒後に close→exit）。より厳密にやるなら
   tool_end が履歴へ flush されたのを待って exit。
2. **起動時に残った `running` を確定させる**（threads.ts の読み戻し）。一般の道具は `failed` ＋
   「ホストの再起動で中断されました」（I2：黙って ok にしない）。`system.restart` だけは `ok` ＋
   「再起動しました」とし、**そのスレッドへ「再起動が完了しました。中断した続きを進めてください」を
   入れる**。これで SKILL 手順5 が初めて実行可能になる。
3. **`close()` に期限と能動的な切断を入れる**（server.ts）。`ws.close()` → `ws.terminate()`、
   `wss.close()` は2秒・`httpServer.close()` は3秒の期限付き（超過は `console.error` に残して
   先へ進む＝握り潰さない）、その前に `this.httpServer.closeAllConnections()` を呼ぶ。

## 受け入れ基準

- ポート0で `BantoServer` を立て、`/api/kobo/...` へ生ソケットで upgrade を1本張った状態で
  `await server.close()` が **5秒以内に resolve**（現状は70秒返らない＝必ず落ちる試験）
- `/ws` に無応答クライアント1本の状態で `close()` が **2秒以内に resolve**（現状30秒）
- `state:"running"` の `system.restart` を含む thread jsonl を一時ディレクトリに置いて読み戻すと、
  `ok` に確定し、そのスレッドへ再開の知らせが1件入る
- `process.exit` をスタブして `system.restart` の `execute()` を呼ぶと、**文字列を返して即座に
  resolve する**（現状は resolve しない）
- 実機の最終確認（1回だけ・番頭が行う）：`system.restart` を呼ぶ → 履歴でその道具が `ok` に
  なっている／journal に Deactivated→Scheduled restart→Started が並ぶ／**再起動後に番頭が
  自分から「再起動が完了しました」と喋る**

## やり残し・別件

- 3件の呼び出しと3回の自力終了の1対1対応は、jsonl に時刻フィールドが無いため厳密には未確定
  （件数・文脈・PO の手動再起動のタイミングは全て一致）
- 「completed with no output」がどの層で作られたかは実物未確認
- 08-14 に `code=killed, status=9/KILL` の異常終了が4回（PO の手動 kill と思われる）。スコープ外
- 衛生（PO が root で任意実施）：`/etc/systemd/system/banto.service.d/bind-fix.conf` は
  `[Service]` 見出しが無く毎回 systemd が「Assignment outside of section. Ignoring.」を出す。
  同じ `BANTO_HOST_BIND=0.0.0.0` は override.conf にあるので `sudo rm` ＋ `daemon-reload` で足りる
