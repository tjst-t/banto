---
id: inc-0018
type: incident
kind: incident
origin: agent
class: bug
status: resolved
resolution: resumeWorkers() を無効化（空オブジェクト返却）。再発防止は imp-0017 で扱う（2026-08-02）
refs: [imp-0017, bin-ts-resumeWorkers]
---

## 内容

`banto.service` の再起動後、**5-6秒ごとに無限再起動ループ**に陥り、ポート4100が開かない状態になった。約30分で restart 回数が380回超を記録。

## 原因

`packages/banto-host/src/bin.ts` の `resumeWorkers()` は起動時に**閉じたワーカーを全て再開**する機能が組み込まれていた。直前のシャットダウン時に 44個の `worker_closed` イベントが存在し、それらが全て再開対象となった。

このうち以下のワーカーが再開され、自身を再起動する処理を実行していた。

- `task-0124-self-restart`: `system.restart` インプリメント
- `task-0103-banto-restart`: systemctl restart を実行

再起動ループの説明：

1. サービス起動 → `resumeWorkers()` が閉じた41ワーカーを再開
2. 再開されたワーカーが `system.restart` を実行
3. `server.close()` → `process.exit(0)` でプロセス終了
4. systemd の `Restart=always` で再起動
5. 1に戻る

## 30秒フィルタが効かなかった理由

30秒フィルタは「30秒以内に閉じたワーカーのみ再開を防ぐ」もの。44個の `worker_closed` すべてが **30秒以上前** に発生していたため、フィルタをすべて通過してしまった。

## 対応

`resumeWorkers()` を無効化した。空オブジェクトを即時返却し、既存の再開ロジックを実行させない。

```ts
// imp-0017: ワーカー再開は再検討中。現在無効化。
return {};
```

コメントに imp-0017 を参照として残した。

## 検証

fix 後、15:36:44 にサービス安定。ポート4100リスニング確認、HTTP 200 OK、90秒以上再起動なし。

## 影響

bootループ中のサービス停止。約30分で380回超の再起動サイクルを記録。

## 副作用

ワーカープールの履歴（閉じたワーカー）が `worker.viewer` で見えなくなる。再開されないので viewer に表示されない。軽微なUX低下。
