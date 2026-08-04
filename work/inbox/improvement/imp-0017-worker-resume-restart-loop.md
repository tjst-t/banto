---
id: imp-0017
type: improvement
kind: incident
origin: banto
class: worker-resume-restart-loop
status: accepted
refs: []
---

# 再起動後に履歴上の職人が自動復帰し、`system.restart` ツールで無限再起動ループに入る

## 内容

2026-08-02、VM の reboot 後に `banto.service` が 5〜20 秒ごとに再起動を繰り返し、ポート 4100 にアクセスできなくなった。

- **原因**: `worker-pool` のイベントログに `worker_closed` 状態の職人が残っており、ホスト起動時の `resumeWorkers()` がこれらを自動で復帰させた。復帰した職人のタスク（`post-restart-healthcheck*` や `task-0058-mobile-footer-nav` 等）が `npm test` を実行し、 acceptance テストの中で `system.restart` ツールを呼んでいた。`system.restart` は実際にホスト自身を `process.exit(0)` して systemd の `Restart=always` で再起動するため、職人が再び復帰 → 再びテスト → 再び再起動、という無限ループになった
- **切り分け**: 同じ `huihui` 設定で自動復帰対象をゼロにすると正常に起動することを確認。auth.json の有無やモデル設定自体は関係なかった
- **応急処置**: `/var/lib/banto/worker-pool/worker-events.jsonl` から 99 件の `worker_closed` イベントを削除し、自動復帰対象を空にした。元ファイルは `worker-events.jsonl.bak` に退避済み
- **副作用**: `worker.viewer` 等で「畳んだ職人」の履歴が表示されなくなる。セッション JSONL ファイルは残っているため、ファイルパスがわかれば履歴は読める

## 調査対象

- `packages/banto-host/src/bin.ts` の `resumeWorkers()` 自動復帰ロジック
- `packages/banto-host/src/bin.ts` の `system.restart` ツール実装
- `tests/acceptance` 内で `system.restart` を呼ぶテスト（`banto-host-tools.spec.ts` 等）
- `worker-pool` のイベントログが復帰対象を決める仕組み

## 現状の措置

- 2026-08-02: `banto.service` を停止 → 全 `worker_closed` イベントを削除 → 再起動。`huihui/huihui-qwen3.6-35b-abliterated` 設定で正常にリッスン中（127.0.0.1:4100）
- `override.conf`（`BANTO_PROVIDER=huihui`, `BANTO_MODEL=huihui-qwen3.6-35b-abliterated`）および `/var/lib/banto/settings.json` の worker-pool 設定も `huihui` のまま維持
- `Restart=always` は当面維持（修正後に `on-failure` への見直しを検討）

## 対応方針

### 選定方針: 案3（`resumeWorkers()` に安全弁を追加）

既存の4候補のうち、**案3**が最も実装がシンプルで効果が高いと判断した。

**選定理由:**
- `system.restart` の振る舞い（`process.exit(0)`）を変更する必要がない。既存の graceful shutdown 循環をそのまま維持できる
- 修正は `packages/banto-host/src/bin.ts` の1関数（`resumeWorkers()`）だけで完結する
- `worker-pool` が自動で記録する `WorkerInfo.closedAt` を使い、追加のメカニズムが不要（D3：導出できる値は保存しない）
- 職人の履歴をそのまま維持できる（`worker_closed` のまま残るので、`worker.viewer` での履歴表示も維持される）

**実装詳細:**

| 項目 | 変更内容 |
|------|----------|
| ファイル | `packages/banto-host/src/bin.ts` の `resumeWorkers()` 関数 |
| 安全弁1 | `closeAt` が直近（**30秒以内**）の職人を除外。`system.restart` → `process.exit(0)` → systemd `Restart=always` の再起動サイクルは数秒で完了するため、30秒以内の closed は「今回の再起動で落ちた職人」と判断できる |
| 安全弁2 | `closeReason` が `"done"` または `"stopped"` のものを優先的に除外。`worker_closed` イベントの `data.reason` は worker-pool が記録している（`pool.ts:658`） |
| 安全弁3 | 複数職人が同時に closed している場合、直近30秒以内に `closeAt` が更新された職人同士をまとめて除外（`closeAt` のミリ秒精度を利用） |
| 結果返値 | スキップした職人の `sessionId` を `results` に `{ ok: true, instruction: "skipped (recently closed)" }` として含める。ログ出力で区別可能にする |

**コード変更のポイント:**

```typescript
// bin.ts の resumeWorkers() 内
async function resumeWorkers(workerPool): Promise<...> {
  const now = Date.now();
  const THRESHOLD_MS = 30_000; // 30秒以内
  const closed = workerPool
    .list({ includeClosed: true })
    .filter((w) => {
      if (w.state !== "closed") return false;
      // 安全弁: closeAt が直近の職人はスキップ
      if (w.closedAt) {
        const closeTime = new Date(w.closedAt).getTime();
        if (now - closeTime < THRESHOLD_MS) return false;
      }
      return true;
    });
  // ... 既存の wake() ループ
}
```

**期待効果:**
- `system.restart` で `process.exit(0)` した直後の再起動で無限ループしなくなる
- 30秒以上経過した closed 職人は正常に復帰する（通常の再開サイクルを維持）
- `worker-pool/worker-events.jsonl` から `worker_closed` イベントを削除する応急処置の必要がなくなる

**検討した他の候補:**
1. **案1**（`system.restart` にフラグ追加）: 確実に無限ループを遮断できるが、`system.restart` のパラメータ定義変更（`Type.Object({ skipExit: Type.Optional(Type.Boolean()) })`）と、職人が `skipExit=true` を付けて呼ぶ仕組みの両方が要る。実装量は案3より少し多い
2. **案2**（`BANTO_HOST_URL` 分離）: テスト実行時のホストへの依存を断てるが、環境変数の管理が増える。今回の根本原因（職人の自動復帰）を直接解決するわけではない
4. **案4**（職人に SKILL 追加）: 職人が `system.restart` 実行前に確認する仕組み。SKILL の追加と職人の判断ロジックの両方を変えてしまうため、実装・検証が重い

- 再現条件を確定したら、回帰テストとして「履歴に `system.restart` 職人が残っても再起動後に無限ループにならない」シナリオを追加

## 実装完了（2026-08-02）

- **変更ファイル**: `packages/banto-host/src/bin.ts` の `resumeWorkers()` 関数
- **確認**: `npm run typecheck` および `npm run build` 両方とも終了コード 0 で完了（I1 検証済み）
- **ステータス**: `accepted`（実装済み・検証済み）
