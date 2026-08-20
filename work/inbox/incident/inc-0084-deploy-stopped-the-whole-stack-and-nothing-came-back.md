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

## なぜ自動で戻らなかったか

**終了コードが 0（正常終了）だから。** ユニットの `Restart=on-failure` は
異常終了しか拾わない。`daemon-restart-needs-kill9` の知見（kill -9 なら
`Restart=on-failure` が拾う）は、**きれいに止まった場合には効かない**——
むしろ「正しく止めた」ほうが復活しない、という逆転が起きている。

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

- デプロイの再起動を**番頭のプロセスの外へ出す**。自分を止める主体が自分だと、
  止めた後の一手が構造的に打てない（systemd の `ExecStartPre` 側で入れ替える、
  oneshot ユニットに委ねる、等）
- あるいは `Restart=always` にして、正常終了でも起き直るようにする。ただし
  「意図して止める」経路と区別が付かなくなるので、止め方の語彙を分ける必要がある
- **落ちたことが見える口**を持つ。P3 の「黙って寄せない」と同じで、沈黙が既定に
  なってはいけない

## 未確認

- 番頭がデプロイのどの段で止まったか（再起動を試みて失敗したのか、そもそも
  再起動の手前で終わったのか）。`/tmp/banto-deploy-verify-1787220222332.log` は未読
- 4サービスが**同時に**止まったのか、番頭が止まった結果として連鎖したのか
