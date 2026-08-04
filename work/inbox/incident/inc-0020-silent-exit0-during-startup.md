---
id: inc-0020
type: incident
kind: incident
origin: agent
class: bug
status: resolved
refs: [inc-0018, inc-0019, imp-0017, adr-0011]
---

## 内容

ホストの起動中に職人を復帰させると、**待ち受けを始める前に、ログを何も残さず exit 0 で終了する**ことがある。systemd の `Restart` が起き直すので、外からは「再起動が1回余分に入る」ように見える。

```
02:00:09  systemd: Started banto.service              ← ブートA
02:00:11  [worker-pool] 落ちる前に生きていた職人: 1 件
02:00:14  systemd: banto.service: Deactivated successfully   ← exit 0。listening まで到達せず
02:00:19  systemd: Scheduled restart job
02:00:21  [worker-pool] 前回の起動から 10 秒しか経っていないため…見送ります   ← ブートB
02:00:22  listening on ws://localhost:4100/ws
```

ブートAとBの違いは**職人を復帰させたかどうかだけ**。エラーログは無く、終了コードは0。

## 原因

`PiRpcDriver.spawn()` は子プロセスと stdio を **`unref` している**（`pi-rpc-driver.ts`）。意図は「テストやシャットダウン時に、職人が残っていてもホストが抜けられるように」。

ところが同じ関数が、**その unref した handle からの応答を待つ**。

```ts
proc.unref();
proc.stdout.unref(); proc.stderr.unref(); proc.stdin.unref();
...
const startResult = await new Promise((resolve) => { /* stdout の data / proc の exit で settle */ });
```

待ち受けを始めた後なら、サーバのソケットが ref された handle としてイベントループを保つので問題にならない。**起動中は他に ref された handle が無い**ため、ドライバ側の ref されたタイマー（起動待ち＋3秒のフォールバック）が尽きた瞬間に、Node が「やることが無い」と判断して `await` の途中でプロセスを畳む。落ちるのが約3秒後なのは、この 3000ms のフォールバックと一致する。

### 仕組みの実証

同じ形を最小構成で再現した。`★` には到達せず、exit 0 で終わる。

```js
const proc = cp.spawn("sleep", ["30"], { stdio: ["pipe","pipe","pipe"] });
proc.unref(); proc.stdout.unref(); proc.stderr.unref(); proc.stdin.unref();
(async () => {
  await new Promise((r) => setTimeout(r, 300));           // ref されたタイマー
  await new Promise((resolve) => {                        // ここから先は unref のみ
    proc.stdout.on("data", resolve);
    proc.on("exit", resolve);
  });
  console.log("★ ここに到達したら仮説は誤り");
})();
// → "startup delay 経過" のあと process.on(exit): code=0
```

## 対応（暫定）

`serve()` の入口で ref されたタイマーを1本掴み、待ち受けを始めたら放す。

```ts
const startupKeepAlive = setInterval(() => {}, 1 << 30);
...
server = await BantoHostServer.start({ ... });
clearInterval(startupKeepAlive);
```

起動中に走る非同期処理が unref された handle だけを待っていても、ホストが途中で抜けなくなる。職人の復帰に限らず、起動中の非同期処理すべてに効く。

## 再現（確定）

**タイミング依存だった。** 落ちるかどうかは、pi のハンドシェイクがドライバ側の ref されたタイマーより早く返るかで決まる。

- 小さいセッション（117KB）だと復帰が2秒で終わり、**修正前でも落ちない**
- 実際に落ちた `task-0116-chat-attachment-survey` のセッションは **2.5MB** で、システム内で最大だった

そのセッションを複製し、起動中と同じ条件（他に ref された handle が無い状態）で
`pool.delegate({ resumeSessionPath })` を呼んで再現した。

```
=== 修正前（keepAlive なし）===
await pool.delegate({
^
[repro] ★ 途中で落ちた（code=13）── 到達していない

=== 修正後（keepAlive あり）===
Error: Started a worker for "repro-0020" but failed to deliver the instruction:
       Error: [pi-rpc] no response for 'inject-1' within 10000ms
```

**掴みを足すと、消える代わりに本当のエラーが表に出る。** 起動時はこれを
`resumeWorkers` が捕まえて「失敗」として記録し、起動は続く（I2）。

### 併せて分かったこと

この職人は**修正後も復帰できない**。2.5MB のセッションが pi の inject タイムアウト
（10秒）内に読み終わらないため。ただし黙って消えるのではなく、失敗として記録されて
次へ進む。セッションの肥大そのものは別の課題（`worker_reported` を4回繰り返しており、
畳まれないまま復帰を重ねた結果と思われる）。

## 根の問題（未対応）

**unref した handle からの応答を待つ、という矛盾自体は残っている。** 掴みを足したのは対症で、`spawn()` / `inject()` は依然として「自分が unref したもの」を待っている。起動以外の場面（例：他に ref された handle が無い状態で職人を起こす経路）で同じことが起きうる。

筋としては、待っている間だけ `ref()` し直し、settle 後に `unref()` する方が正しい。ただし `delegate()` は spawn のあとに `inject()` も待つので、範囲の見極めが要る。
