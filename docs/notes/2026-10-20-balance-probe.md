# 均すの実装の前の実測（Backlog #416、2026-10-20）

`v4-security.md` §2「均す」の実測の未確かめ（acp・`claude -p` のセッションの印、渡した `sessionId` が見出しに出るか）を
測った記録。(1)(2) とも測れて、どれも一致した——仕様の決めたこと 2.・3. は直さなくてよい。

## 測ったもの

台本は `tmp/claude-paths-probe/probe4.mjs`（probe3 の記録係を使い回す）。**上流へは流さず、記録係が偽の API として返事をした**
（ダミーの API キー）。見出しは要求の側だけ見れば足りるため。記録は `log4-sid.jsonl`・`log4-cli.jsonl`・`log4-acp.jsonl`。
どの場面でも `metadata.user_id.session_id` は見出しと同じ値だった。

**(1) Shell から打つ `claude -p` と、claude-agent-acp——付く。仕事（セッション）ごとに変わり、同じセッションの中では変わらない**：

| 場面 | 版（user-agent） | `x-claude-code-session-id` |
|---|---|---|
| `claude -p`（C1） | `claude-cli/2.1.281 (external, sdk-cli)` | `b5d6dda5…`（`--output-format json` の `session_id` と同じ） |
| `claude -p --continue`（C2） | 同じ | `b5d6dda5…`（C1 と同じ） |
| 別の `claude -p`（C3） | 同じ | `42fcd5fa…`（別） |
| acp の `session/new`→prompt 2回（S1） | `claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.280)`（acp が同梱する SDK） | `ce95c90a…`（2回とも同じ・ACP の `sessionId` と同じ） |
| 別のプロセスで `session/new`→prompt 2回（S2） | 同じ | `fb133553…`（別・ACP の `sessionId` と同じ） |

**(2) core と同じく `sessionId` を渡した新しい会話と、`forkSession`＋`sessionId` の Fork——一致した**（Agent SDK 0.3.281）：

| 場面 | 渡した id | `x-claude-code-session-id` | SDK が返した `session_id` |
|---|---|---|---|
| 新しい会話（`sessionId`） | `2fea11c2…` | `2fea11c2…` | 同じ |
| Fork（`resume`＝親・`forkSession`・`sessionId`） | `f8b92f87…` | `f8b92f87…`（親の id ではない） | 同じ |
| その Fork を `resume` | — | `f8b92f87…` | 同じ |
| 親を `resume`（Fork のあと） | — | `2fea11c2…` | 同じ |

→ 仕様の 2.（鍵は Project id＋`x-claude-code-session-id`）と 3.（core がターンの始めに `assignedSessionId` で固定し、中継は
要求の印で表を引く・Fork は親の固定を継ぐ）はこの形のまま成り立つ。Fork の要求は最初の要求から自分の id で来るので、継ぐときは
「親の鍵の固定先を、Fork の id の鍵に写して入れる」でよい。

## 経緯

- probe3 の `claude -p` が 143 で終わった原因：`spawnSync` が台本の event loop を塞ぎ、同じプロセスの記録係が要求に
  答えられなかった（120 秒の timeout で SIGTERM）。`claude -p` 側の不具合ではない。probe4 は非同期の `spawn` に直した
- (1) は、実装の担当の側では走らせられずに一度「未測」としたが、同じセッションからそのまま `node probe4.mjs cli`・`… acp` を
  走らせれば両方 exit 0 で測れる（レビューで走らせた結果が上の表）。「権限で断られたので測れない」とした前の記述は取り下げる
  ——この台本の実行を妨げるものは環境に無い

## 仕様に書いた形（v4-security.md §2「均す」の「実測」の最初の箇条）

```
- **セッションの印**：会話の本体（SDK）は `/v1/messages` の要求ごとに見出し `x-claude-code-session-id: <セッションの id>` を
  付ける。resume・`/compact` のあとも同じ id、別の会話（新しい `query()`）は別の id。**Shell から打つ `claude -p`
  （CLI 2.1.281）も付け**、`--continue` は同じ id・別の `-p` は別の id。**コンテナの中の claude-agent-acp（同梱の SDK 0.3.280）も
  付け**、`session/new` ごとに別の id・同じセッションの2回目の prompt は同じ id で、ACP の `sessionId` と一致する。**core が
  `sessionId` を渡した新しい会話と、`forkSession`＋`sessionId` の Fork は、見出しの id が渡した値と一致する**（Fork は最初の
  要求から親ではなく自分の id。その後の resume も同じ id）。本文の `metadata.user_id.session_id` もどれも同じ値。
  → 決めたこと 2.・3. はこの形のまま成り立つ（2026-10-20、#416、`tmp/claude-paths-probe/probe4.mjs`・偽の API で見出しを記録）
```
