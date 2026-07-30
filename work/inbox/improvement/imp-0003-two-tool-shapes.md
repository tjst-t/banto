---
id: imp-0003
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: open
refs: [task-0010, adr-0010, task-0004]
---

## 内容

Tool定義の型が2つ並立している。

1. **`banto-core/src/tools.ts` の `BantoTool`** — ランタイム中立。`name` / `description` /
   `parameters`（素のJSON Schema）/ `execute(client, args)`。職人・監査セッション向けの
   既存Tool（`report_phase` 等）が使う
2. **`banto-host/src/tool-registry.ts` の `NamespacedToolDefinition`** — pi の
   `ToolDefinition` ＋ typebox。task-0004 以降に作った全Tool（`canvas.*` / `memory.*` /
   `skill.*` / `file.*` / `git.*`）が使う

ADR-0010 決定1 は「**ツール定義はランタイム中立の共通ライブラリ（banto-core）に置き、各
ハーネスのアダプタは薄い皮（ツール登録とフック接続のみ）に留める（D5）**」と定めている。
2 は banto-host（pi 依存）にあり、pi の型を契約そのものに使っているため、この規定に反する。

決定27b も「呼び出しの単位は既存の Tool 契約（決定9）を使う。**契約体系を2つ持たない**」と
明記しており、現状はこれにも反している。

## 実害

- **モジュールを作るたびに pi への型依存が要る。** ADR-0009・決定3 の「ハーネスは差し替え
  可能」が、モジュール側にも pi を強制する形で崩れる
- task-0010（Worker Pool）で顕在化した：Worker Pool は pi を**バイナリとして**使うだけで
  型依存は無かったのに、`worker.*` Tool を定義するために pi の型を引き込む必要が生じた

## 経緯（なぜ起きたか）— 3つの別々の問題が混ざっている

**(1) 実装の近道（番頭の失敗）**：task-0004 で pi SDK に載せる際、`defineTool()` を
ラップするのが最短だったため banto-host 側に新しい型を作った。既存の `BantoTool` との
関係を整理しないまま、以降の Tool をすべて新しい型で作り続けたため差が広がった。
ADR の該当条項（決定1）を都度参照していれば気づけた。

**(2) 決定1と決定11が接続されていない（検討側の抜け）**：決定1 は「ツール定義はランタイム
中立」と定めたが、決定11 で pi SDKモードを選んだとき、**中立な定義がどういう形で、SDKの
`customTools` へどう写るのか**を決めていない。SDKモードを選ぶとハーネスの型が目の前にある
状態になるため、継ぎ目が未仕様だと近道が既定の結果になる。決定22（wire名変換）でも
「変換はアダプタの責務」と書いただけで、変換の入力になる中立な型の存在を確認していない。
**規約が実装に落ちる継ぎ目を仕様化していなかった**——同種の漏れは他の決定にもありうる。

**(3) 既存の「中立な型」自体が中立でない（本incidentより前からある欠陥）**：
`BantoTool.execute(client: DaemonClient, args)` は Kobo の HTTP クライアントに結合して
いる。つまり `BantoTool` は「中立なTool」ではなく「**Koboを呼ぶTool**」で、
`canvas.*` / `memory.*` / `file.*` / `git.*` / `worker.*` はこの型では表せない。
S254276 期の実装で、番頭の作業より前から存在する。

**(3) の帰結として、当初 task-0025 に書いた「ランタイム中立を banto-core へ戻す」は
前提が誤っていた**（戻す先が無い）。統合には依存を注入する新しい形が必要で、task-0025 を
その方向に書き直した。

## 見立てを狭める発見

`typebox` は pi ではなく独立した JSON Schema ビルダ（`node_modules/typebox`。
`@mariozechner` 配下ではない）。pi がそれを使っているだけなので、**パラメータは typebox の
ままで中立化できる**。pi 固有なのは `label` / `promptSnippet` / `promptGuidelines` /
`renderShell` / `executionMode` / `renderCall` / `renderResult` と、`execute` の第5引数
`ExtensionContext`・戻り値型だけ。アダプタは「name/description/parameters/execute を写し、
残りは既定値」で済み、決定1 の「薄い皮」が実際に成立する。

## 対処

- 本incidentでは記録に留め、task-0010 は現行の `NamespacedToolDefinition` で進める。
  Worker Pool だけ別の型にすると、モジュールレジストリが2つの形を受ける必要が生じて
  かえって悪化するため
- 統合は別タスクとする（→ 起票）。方向としては、契約（名前・JSON Schema・説明・実行）を
  banto-core に置き、pi 向けの型変換はアダプタ（banto-host）に寄せる形が決定1に沿う
