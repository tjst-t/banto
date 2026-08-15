---
id: imp-0047
title: 番頭の思考が画面に出ない——SDK に display を明示していない
status: inbox
kind: improvement
origin: 帳場の枝「思考過程が見えない件」(thread-59) からの言伝
refs:
  - packages/banto-host/src/claude-agent-harness.ts
  - packages/banto-host/src/server.ts
created: 2026-08-15
---

## 何が起きているか

番頭（claude-agent-sdk 経路）の思考が画面に一切出ない。**表示側の不具合ではなく、
banto が SDK へ思考を出す指定をしていない**。

## 実測（帳場の枝で取った事実）

- claude-agent-sdk v0.3.229 の型 `ThinkingAdaptive = { type:'adaptive'; display?: 'summarized'|'omitted' }`
  （sdk.d.ts:7308-7313）。**`display` を明示しない限り thinking ブロックの本文は空**で、
  signature だけが 2600〜3700 字埋まる——つまりサーバ側では思考しているが、本文を返していない。
- SDK 直叩き6回の実測：`model` 省略／`"default"`／`"opus"`／`thinking:{type:"adaptive"}` のみ、の
  4条件はすべて思考本文 0 字。`display:"summarized"` を足した1条件だけ 852 字が届いた。
  型コメントの「対応モデルでは adaptive が既定」は本当だが、**効くのは display の方**。
- banto 側の配線（受信→変換→保存→配信→描画）は完備。

## 直し方

`packages/banto-host/src/claude-agent-harness.ts` の `buildOptions()` に
`thinking: { type: "adaptive", display: "summarized" }` を足す。

## 読み違えないこと

`{"role":"reasoning","text":"","durationMs":N}` は reasoning_end の終端マーカー
（server.ts:1500-1502）。「空の思考が来た証拠」ではない。

## 受け入れ条件に入れること（未検証の3点）

1. **thinking 非対応の claude モデルへ番頭を切り替えたときにエラーにならないか**
   （`harnessSwitchers.claude` で model 名指し）。落ちるなら、非対応のときは `display` を
   付けない分岐が要る。I1 に照らして「できないほうへ倒す」判断を実測で決めること。
2. **resume した会話で決定90（思考の往復）に抵触しないか。**
3. **記録量への影響**（帳場からの補足）。思考が記録に載ると章を畳む閾値に効き、章が早く
   切れる可能性がある。`display:"summarized"` なら量は知れているはずだが、**同じ1ターンの
   記録量を前後で比較した実測**を出すこと（推測で「知れている」と書かないこと）。

## 扱い

banto開発(thread-61) で引き受ける。帳場では起票しない旨を返し、あちらも起票していないことを
確認済み（重複なし）。main への取り込み列（imp-0041 着地済み／imp-0042／imp-0043／imp-0034）が
捌けてから積む。`claude-agent-harness.ts` は imp-0034 が触る `bin.ts` / `server.ts` と近いので、
並行させない。
