---
date: 2026-08-17
topic: Worker Pool 並行制御のリソースベース化
branch: Worker並行制御のリソースベース化
status: accepted
---

# Worker Pool 並行制御のリソースベース化 — 設計書

## 背景
現在の `banto-worker-pool` は「枠（数）」で並行制御を行っている。

- `BANTO_WORKER_MAX_CONCURRENT`（既定 6）＝同時走行の合計上限
- `BANTO_WORKER_AUDIT_RESERVED`（既定 2）＝監査・判定用の予約席
- つまり「実装 4 本＋監査・判定 2 本」の固定枠

ランタイム（Claude / Pi）を区別していないため、実装枠が 4/4 だと Pi の軽い調査職人でも起動できない。

PO 提案（2026-08-17）: 枠を増やすのではなく、各ランタイムの想定消費リソースを決め、ホストの空きリソースから起動可否を判定する。

## 現状の判定経路

`packages/banto-worker-pool/src/pool.ts`:

- `delegate()`（L1371）→ `reserveSlot()` → `spawnWorker()`
- `reserveSlot()`（L1398）が実質の判定。満杯なら `recordDecline()` ＋ `WORKER_LIMIT_CODE` 付き throw
- `isFull()`（L1445）が本命:
  ```ts
  if (status.limit <= 0) return false;
  if (status.running >= status.limit) return true;
  return role === "executor" && status.byRole.executor >= status.executorLimit;
  ```
- `concurrency()`（L805）が「生きている職人＋起動中の枠（starting Map）」から毎回数え直す
- 環境変数は `bin.ts` で解決し、`WorkerPool` コンストラクタへ渡す（pool.ts は `process.env` を読まない）
- 拒否時のログは `console.error` のみ。イベントログやメトリクスカウンタは無い

既存の資源関連情報:

- 職人 1 本の cgroup 上限 2 GiB（`BANTO_WORKER_MEMORY_MAX`）
- 平常時の職人 1 本は 0.23〜0.56 GiB（役・ランタイム混在の平均）
- `worker-cgroup.ts:9`: 「実測で健全な 1 本は約 600MB」
- `claude-agent-driver.ts:260`: Claude CLI は暴走時に 11GB まで膨らむ実績
- Pi ランタイムの資源数字は未記載

ホスト空きリソース取得ユーティリティは**存在しない**（`os.totalmem/freemem/cpus`、/proc 読みは packages 全体で使われていない）。

## 設計案

### 1. 想定消費リソースの定義

各ランタイム登録（`RuntimeRegistration`）に想定消費リソースを持たせる。

```ts
interface ResourceEstimate {
  memoryMiB: number;
  cpuFraction?: number; // 第2段で導入予定
}

interface RuntimeRegistration {
  driver: RuntimeDriver;
  title?: string;
  // ... 既存フィールド ...
  assumedResources: ResourceEstimate;
}
```

環境変数で上書き（`bin.ts` で解決）:

- `BANTO_WORKER_PI_MEMORY_MB`（既定 300）
- `BANTO_WORKER_CLAUDE_MEMORY_MB`（既定 1200）
- （第2段）`BANTO_WORKER_PI_CPU_FRACTION`, `BANTO_WORKER_CLAUDE_CPU_FRACTION`

既定値（PO 確定、2026-08-17）:

| ランタイム | 想定メモリ |
|---|---|
| `pi-rpc` | 300 MiB |
| `claude-agent-sdk` | 1200 MiB |

これらは「最悪値の保証」ではなく「常識的な混み方で殺さない」レベルの見積もり。1 本の暴走は既存の cgroup 2 GiB 上限が個別に守る。

### 2. ホスト空きリソースの計測

新規モジュール `packages/banto-worker-pool/src/host-resources.ts` を作成。

- **メモリ**: `/proc/meminfo` の `MemAvailable`（kB）を読む。無ければ `os.freemem()`。
  - コンテナ環境では `/proc/meminfo` はホスト値なので、可能なら cgroup v2 の `memory.current/memory.max` も併用。
- **CPU（第2段）**: `os.cpus().length` からコア数、`/proc/loadavg` の 1 分平均から空きコア数を推定。
  - 例: `idleCores = max(0, cpuCount - loadAvg1)`

```ts
interface HostResources {
  memoryMiB: number; // 空きメモリ
  cpuCores?: number;  // 推定空き CPU コア数（第2段）
}
```

計測は起動判定のたびに行う（軽い `/proc` 読みなので問題無い）。

### 3. 起動可否の判定ロジック

`reserveSlot()` / `isFull()` を拡張。

- `delegate()` は `input.runtime` を `reserveSlot()` へ渡す（現状渡していない）。
- `ConcurrencySlot` / `starting` Map に `runtime` フィールドを追加。
- 新関数 `canStart(status, role, runtime)`:
  1. 本数上限チェック（既存、絶対安全弁）
  2. 役による予約チェック（executor は executorLimit で頭打ち）
  3. リソースチェック:
     - 現在実行中・起動中のスロットの想定消費を合計
     - 対象ランタイムの想定消費を加えた場合、空きリソースを超えるか
     - 超えれば拒否

監査・判定用の予約リソース:

- `BANTO_WORKER_AUDIT_RESERVED` を「監査用予約リソース量（MiB）」に再解釈する。
- 具体的には、executor 用の判定から「予約分のリソース」を差し引いておき、auditor はその予約分を使えるようにする。
- これにより、実装枠が埋まっていても監査職人は予約リソース内で起動できる。

### 4. 実際の消費との乖離の扱い

- **想定より食った場合**: 個別の cgroup 2 GiB 上限が守る。aggregate リソース判定は安全弁なので、個別暴走は影響を局所化。
- **想定より食わなかった場合**: 無駄に空きが出るが安全側。後で `worker-cgroup.ts` の `memory.peak` 実測から校正。
- **校正（第 2 段）**: 各 runtime の実測ピークを収集し、想定値を更新する仕組み。手動または定期的な自動更新。

### 5. 既存の枠との整合・後方互換

- `BANTO_WORKER_MAX_CONCURRENT`: **本数の絶対上限（安全弁）として残す**。0 で無制限（既存の挙動）。
- `BANTO_WORKER_AUDIT_RESERVED`: **監査用に予約するリソース量（MiB）**に再解釈。既定値は 2 席分に相当するリソース量（例: 2400 MiB）を検討。
- リソース判定は追加のゲートとして導入。本数判定が先に通らないとリソース判定は行わない。
- 環境変数 `BANTO_WORKER_RESOURCE_BASED=0` でリソース判定を無効化し、旧来の本数のみ判定に戻せる。
- 断りメッセージ（`declineHeadline`, `WORKER_LIMIT_CODE`）をリソース理由も含む形へ拡張。acceptance テスト `worker-pool-audit-reservation.spec.ts`（a1〜a6）が枠表現を契約として固定しているため、文言変更はテスト修正を伴う。

### 6. 実装方針とタスク分割

タスクを Kobo に積む前提で分割する。

#### タスク A: ホストリソース計測モジュールの追加
- ファイル: `packages/banto-worker-pool/src/host-resources.ts`
- 内容: `/proc/meminfo`, `/proc/loadavg`, `os.cpus()` から `HostResources` を導出
- 受け入れ条件: 単体テストで Linux 環境の値と整合する。/proc 読み込み失敗時のフォールバックを持つ。

#### タスク B: ランタイム別想定消費リソースの定義と環境変数解決
- ファイル: `packages/banto-worker-pool/src/backends.ts`, `packages/banto-worker-pool/src/bin.ts`, `packages/banto-worker-pool/src/pool.ts`（options）
- 内容:
  - `RuntimeRegistration` に `assumedResources` を追加
  - `bin.ts` で `BANTO_WORKER_PI_MEMORY_MB` / `BANTO_WORKER_CLAUDE_MEMORY_MB` を解決
  - `WorkerPoolOptions` にリソース設定を追加
- 受け入れ条件: 環境変数で想定値を変えたとき、pool の設定に反映される。

#### タスク C: pool.ts の起動可否判定をリソースベースに拡張
- ファイル: `packages/banto-worker-pool/src/pool.ts`
- 内容:
  - `delegate()` → `reserveSlot()` に `runtime` を渡す
  - `ConcurrencySlot` / `starting` Map に `runtime` を追加
  - `reserveSlot()` / `isFull()` を `canStart()` に拡張し、リソース判定を追加
  - `concurrency()` に想定消費合計を追加
- 受け入れ条件:
  - Pi 軽量職人を多数起動できる
  - Claude 重い職人は空きリソースに応じて抑えられる
  - 実装枠満杯時でも監査職人がリソース予約分内で起動できる

#### タスク D: 断りメッセージ・一覧表示の更新
- ファイル: `packages/banto-worker-pool/src/pool.ts`, `packages/banto-worker-pool/src/worker-tools.ts`
- 内容: リソース不足による拒否を表現する文言と、`worker.list` の内訳表示に想定消費・空きリソースを追加
- 受け入れ条件: リソース不足で断られたとき、理由が分かるメッセージになる。

#### タスク E: acceptance テスト追加・修正
- ファイル: `tests/acceptance/worker-pool-audit-reservation.spec.ts`, 新規テスト
- 内容:
  - 既存の a1〜a6 をリソースベース下でも成立させる（文言変更に対応）
  - 新規: リソース充足時に Pi を多数起動できる、Claude は空きリソースで抑えられる、監査予約リソースが守られる
- 受け入れ条件: 既存テストがリソースベース有効時も通る。

#### タスク F（第 2 段）: 実測値フィードバックによる想定値校正
- ファイル: `packages/banto-worker-pool/src/worker-cgroup.ts`, `packages/banto-worker-pool/src/pool.ts`
- 内容: `memory.peak` を収集し、runtime 別の実測ピークを導出。想定値の手動/自動更新の仕組み。
- 受け入れ条件: 各 runtime の実測ピークがログまたは画面で確認できる。

## 決定事項

1. **想定消費の既定値**: Pi 300 MiB / Claude 1200 MiB を仮置きで実装し、後で `memory.peak` 実測から校正する。
2. **CPU 判定の導入**: 初版はメモリのみに絞り、CPU は第 2 段とする。
3. **`BANTO_WORKER_AUDIT_RESERVED`**: 本数予約を廃止し、「監査用予約リソース量（MiB）」に再解釈する。
4. **`BANTO_WORKER_MAX_CONCURRENT`**: 本数の絶対上限（安全弁）として残す。
5. **リソース判定の無効化スイッチ**: `BANTO_WORKER_RESOURCE_BASED=0` で旧来の本数のみ判定に戻せる。
