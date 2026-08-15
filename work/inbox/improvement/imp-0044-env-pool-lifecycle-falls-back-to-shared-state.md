---
id: imp-0044
kind: improvement
status: open
severity: low
created: 2026-08-15
refs: [imp-0040, imp-0036]
---

# env-pool-lifecycle が fixture の既定（固定パス1本）に落ちていて、imp-0040 と同じ地雷を踏める

## 何が起きているか

`tests/acceptance/env-pool-lifecycle.spec.ts` は `tests/fixtures/failing-teardown-driver.ts`
を使いながら `BANTO_FAILING_DRIVER_STATE_FILE` を渡していない。そのため fixture の既定
（`os.tmpdir()/banto-failing-teardown-driver-state.json`）＝**固定パス1本**に落ちる。

これは imp-0040 で直したのと**まったく同じ構造**である。imp-0040 は
`env-notices.spec.ts` の側を試験ごとの一時ディレクトリへ分けて解決したが、既定そのものは
固定パスのまま残っているので、**既定に落ちる試験が2本以上になった瞬間に踏み合う**。

## いま落ちていない理由

現状 fixture の既定を使う試験が `env-pool-lifecycle.spec.ts` 1本だけなので、共有する相手が
いない。**運が良いだけ**で、構造は直っていない。

## どう直すか（案）

どちらかで足りる。両方やる必要はない。

1. **fixture 側の既定をやめる。** `BANTO_FAILING_DRIVER_STATE_FILE` が無いときは
   既定パスへ落ちるのではなく**失敗させる**（I2「黙って続けない」）。渡し忘れが
   その場で分かるので、同じ地雷が二度と埋まらない。
2. **fixture 側の既定を走行ごとにする。** 環境変数が無いときは `mkdtemp` で走行専用の
   パスを作る。呼ぶ側を直さなくても踏み合わなくなるが、「隔離されているかどうか」が
   呼ぶ側から見えないままになる。

番頭の見立てでは **1 のほうが良い**（隔離は呼ぶ側の責任だと明示できる）。ただし
`env-pool-lifecycle.spec.ts` 側に渡す修正が同時に要る。

## なぜ imp-0036 の職人が直さなかったか

P1（頼まれた範囲の外に手を出さない）に従って触らず、報告に懸念として残した。判断は正しい。

## 出どころ

imp-0036 の職人が imp-0040 を直す過程で見つけ、報告に残した懸念（2026-08-15）。
