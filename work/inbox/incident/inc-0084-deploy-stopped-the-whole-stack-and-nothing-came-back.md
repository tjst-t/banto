---
id: inc-0084
kind: incident
status: open
severity: critical
created: 2026-08-20
refs: [inc-0080, task-0304, task-0312]
---

# `system.deploy` が4サービス全部を止めたまま戻らず、banto が22分沈黙した

## 何が起きたか（2026-08-20・外部調査中に発見）

PO の「トークンを食いすぎる」調査で稼働状態を見に行ったところ、**banto が丸ごと落ちていた**。

```
Active: inactive (dead) since Thu 2026-08-20 10:10:54 UTC; 20min ago
Main PID: 386542 (code=exited, status=0/SUCCESS)
```

止まっていたのは番頭だけではない。**4サービスすべて**:

| サービス | 状態（10:31 時点） |
|---|---|
| banto | inactive |
| banto-daemon | inactive |
| banto-worker-pool | inactive |
| banto-environment-pool | inactive |

直前の journal に、番頭自身の `system.deploy` の検証ログが残っている
（`/tmp/banto-deploy-verify-1787220222332.log`、10:03:42 に acceptance の出力）。
つまり **番頭が自分でデプロイを始め、検証まで通し、サービスを止めたところで終わっている。**

```
Aug 20 10:10:53 banto systemd[1]: Stopping banto.service - banto (番頭) host...
Aug 20 10:10:54 banto systemd[1]: banto.service: Deactivated successfully.
Aug 20 10:10:54 banto systemd[1]: Stopped banto.service - banto (番頭) host.
```

## 誰が止めたか（`auth.log` で確定）

当初は `system.deploy` の再起動段だと見立てたが、**違った**。`deps.restart` は
`bin.ts:1426` で**中身が空**（コメントだけ）で、systemctl を呼んでいない。

実際に打たれていたのはこれ（`/var/log/auth.log`）:

```
2026-08-20T10:10:53 banto sudo: ubuntu : PWD=/home/ubuntu/ghq/github.com/tjst-t/banto ;
  USER=root ; COMMAND=/usr/bin/systemctl stop banto banto-daemon banto-worker-pool banto-environment-pool
2026-08-20T10:53:09 banto sudo: ubuntu : PWD=... ; USER=root ; COMMAND=/usr/bin/systemctl stop （同上）
2026-08-20T10:53:24 banto sudo: ubuntu : PWD=... ; USER=root ; COMMAND=/usr/bin/systemctl mask （同上）
```

**2回起きている**（10:10:53 と 10:53:09）。しかも stop の後に **`mask`** まで打たれている。
この文字列はリポジトリのどこにも無い（`grep` 済み・試験にも無い）ので、
**エージェント（番頭または職人）が Bash から直に打っている**。inc-0080
（会話の途中でホストを再起動した）と同じ筋で、sudo の許可一覧には
`systemctl mask *` / `unmask *` が入っている（`work/2026-08-16-inc-0080-sudo-restriction-findings.md`）。

現時点では4ユニットとも `enabled`（mask は解かれている）が、**止めたまま戻していない**。

## なぜ自動で戻らなかったか

**`systemctl stop` は明示的な停止で、`Restart=` はそもそも適用されないから。**

`banto.service` の実効値は `Restart=always`（`override.conf` が上書き。
`deploy-unit-restart-policy.spec.ts` が正としているとおり）で、そこは壊れていない。
`Restart=` が効くのは**プロセスが自分で落ちたとき**だけで、`systemctl stop` で
止めたものは仕様どおり起き上がらない。`mask` まで打たれていればなおさら
（mask 中は `start` すら通らない）。

つまり「再起動ポリシーを直す」では直らない。**止めた側が起こし直していない**のが穴。

## なぜ重いか

- **止めたのは番頭自身**で、止まった先には「再起動する主体」がいない。自分の足元を
  外してから、その足元で次の手を打とうとしている
- 沈黙が **PO にも番頭にも見えない**。PO が画面を見に行くまで誰も気づけない。
  外部から `systemctl is-active` を叩いて初めて分かった
- 単体の再起動事故（inc-0080）と違い、**Kobo・職人・検証環境まで道連れ**になっている。
  工場が丸ごと止まる

## 応急処置（実施済み）

`sudo systemctl start banto banto-daemon banto-worker-pool banto-environment-pool`
で4つとも復帰。4ポート（4100/4300/4400/4500）が listen していることを確認した。

## 直す方向（未着手・案）

- **`systemctl stop`／`mask` を sudo の許可一覧から外す。** エージェントに要るのは
  「起こし直す」であって「止めたままにする」ではない。`restart` だけ残せば、
  止めっぱなしが構造的に起きない（inc-0080 の findings に一覧がある）
- 止める必要が本当にあるなら、**止めた側に起こす責任を機構で持たせる**
  ——止めるときに「いつまでに戻す」を書かせ、超えたら別の主体が起こす
- **落ちたことが見える口**を持つ。P3 の「黙って寄せない」と同じで、沈黙が既定に
  なってはいけない。いまは外から `systemctl is-active` を叩くまで誰も気づけない
- `system.deploy` の `deps.restart`（`bin.ts:1426`）が**空**なのも別途おかしい。
  コメントは「systemd が起こし直す」と言っているが、自分で落ちる処理が無いので
  何も起きない。ゲートを通ったデプロイが**実際には反映されない**可能性がある

## 未確認

- **どのエージェントが打ったか**（番頭か職人か）。PWD と uid=1000 までしか分からない。
  2回とも PO のトークン費用調査の最中に起きているので、その調査の一部で
  「静かな状態を作るために止めた」可能性がある
- `mask` を打った意図。解いてはあるが、なぜ必要だったのか不明
- `deps.restart` が空になった経緯（最初からか、途中で中身が落ちたのか）
