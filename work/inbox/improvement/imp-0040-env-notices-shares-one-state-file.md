---
id: imp-0040
kind: improvement
status: resolved
severity: medium
created: 2026-08-15
refs: [inc-0070, imp-0036]
---

# env-notices の試験が state ファイル1本を共有していて、負荷がかかると隣の試験を汚す

## 何が起きているか

`tests/acceptance/env-notices.spec.ts` が全量 `npm test` で落ちる。落ちる試験は
回ごとに違い、症状は2種類：

- `[PO報告 2026-08-11] 立っている環境は孤児にならない` — ENOENT
  `/tmp/banto-failing-driver-state-acceptance-env-notices.json`
- `[PO報告 2026-08-11] 同じ孤児は1度だけ` — 前の試験の `t-2-failing-env` が漏れてくる

## 計測（imp-0036 の職人が実測）

| 条件 | 走行 | 落ちた |
|---|---|---|
| 全量 `npm test`（main 258f67a1） | 3 | **3**（毎回 env-notices の別の試験が1件） |
| 単ファイル・遊んでいるマシン | 3 | 0 |
| 単ファイル・busy loop 8本で CPU を埋める | 3 | **1** |

**負荷依存のレースであり、枝の中身とは無関係。** 単体で通ることは無罪の証拠にならない
（負荷をかければ単体でも落ちる）。

## 原因の見立て

fixture ドライバの state を `os.tmpdir()` 直下の**固定パス1本**で共有し、`beforeEach` で
毎回 rm している。負荷がかかると、前の試験が起こしたドライバ子プロセス（tsx の起動が遅い）
の書き込み・読み出しが次の試験の rm を跨ぎ、**ファイルが消えた（ENOENT）／前の試験の環境が
漏れた**のどちらかになる。試験間の隔離が state ファイル1本に頼っている構造の問題。

## どう直すか

state ファイルを**試験ごとの一時ディレクトリ**へ分ける（`mkdtemp`）。固定パスをやめれば
隣の試験と踏み合わない。後始末は各試験が自分の一時ディレクトリを消す。

## 完了の見え方

- 負荷をかけた状態（busy loop 8本）で `env-notices.spec.ts` を5回回して 0 失敗
- 全量 `npm test` が失敗0（`source-hygiene` は imp-0038 で別建て）

## 直した（枝 `fix/env-notices-isolation`）

`tests/acceptance/env-notices.spec.ts` だけを変えた（製品コードには触っていない）。

- 走行ごとの根 `RUN_ROOT`（`mkdtemp`）を作り、`beforeEach` で**その試験専用のディレクトリ**を
  掘って、`BANTO_FAILING_DRIVER_STATE_FILE` / `BANTO_PROCESS_DRIVER_STATE` をそこへ向ける。
  ドライバは **spawn の時点の `process.env` を読む**（`env-driver-runner.ts` の
  `driverSpawnEnv(process.env, extraEnv)`）ので、**前の試験の遅れてきた子は前の試験の
  ファイルへ書き、こちらには届かない**
- 後始末は各試験の `afterEach` が自分のディレクトリごと消す。`beforeEach` の
  「前の試験の残りを rm する」は不要になったので消した（**この rm が踏み合いの当事者だった**）
- fixture ドライバ（`tests/fixtures/failing-teardown-driver.ts`）は変えていない。
  env で state を受け取る作りは既にあり、渡す側を分ければ足りる

## 実測（直した職人）

**決定的な再現**（`/tmp/imp0040-probe.mjs`。統計に頼らず、同じ取り違えをその場で起こす）。
試験A のドライバを起こしたまま試験B の `beforeEach` の rm を挟み、A の子が書き終えてから
B が state を読む：

| 形 | 試験B が見る state |
|---|---|
| 直す前（固定パス1本） | `['t-2-failing-env']` ← **漏れた**（全量試験で出たのと同じ症状） |
| 直した後（試験ごと） | ファイル無し（A の書き込みは A のファイルへ行った） |

**走行での確認**（4コア・load average 約10 の状態で busy loop 8本を足す）：

| 条件 | 走行 | 落ちた |
|---|---|---|
| 単ファイル・負荷あり（直した後） | **5** | **0** |
| 単ファイル・負荷あり（直す前） | 5 | 0 ← **この負荷では出なかった** |
| 全量 `npm test`（枝 b025490e + 本修正） | 1 | **0**（2178件すべて緑） |

**負荷試験は決着をつけていない**——直す前も同じ条件で5回とも通った。起票時に 3回中1回
落ちたのは工場の混み具合が違ったからで、この再現は機械の機嫌に依存する。**根拠は上の
決定的な再現の方**に置く。あわせて、直した後は **ENOENT が構造的に起こらない**：この
state ファイルを消す者が試験の最中に居なくなった（`beforeEach` の rm を消し、`afterEach` は
試験が終わってから自分のディレクトリごと消す）。

## 残っている同じ形の穴（この枝では直していない）

`tests/acceptance/env-pool-lifecycle.spec.ts` は同じ fixture ドライバを使いながら
`BANTO_FAILING_DRIVER_STATE_FILE` を渡していないので、fixture の既定
（`os.tmpdir()/banto-failing-teardown-driver-state.json`）＝**固定パス1本**に落ちる。
今は他に既定を使う試験が無いので踏み合わないが、同じ構造の地雷。P1（ついでの修正はしない）
なのでここでは触っていない。

## 備考

inc-0070（既定を自動着地へ反転すると受け入れ試験が落ちる）は resolved だが、そこで
「機械が空いていることを暗黙の前提にしている試験」として名指しされた1本がこれ。
分類で片付けず、隔離そのものを直す。
