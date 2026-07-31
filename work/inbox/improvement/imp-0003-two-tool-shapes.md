---
id: imp-0003
type: improvement
kind: incident
origin: agent
class: spec-impl-mismatch
status: resolved
resolution: 契約をランタイム中立な BantoToolDefinition 1つに統合し、pi への変換は banto-host の toPiTool に閉じた。依存はTool生成関数の引数で受ける（task-0025、2026-07-30）
refs: [task-0010, adr-0010, task-0004, task-0025]
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

## 対処の結果（2026-07-30・resolved / task-0025）

3つの問題（(1) 実装の近道 (2) 決定1と決定11の継ぎ目が未仕様 (3) 既存の「中立な型」が中立でない）
のうち、(1)(3) を解消した。(2) は下記のとおり形が決まったので ADR への追記を判断できる状態になった。

- **契約は `banto-core/src/banto-tool.ts` の1つだけ**。`BantoToolDefinition` /
  `NamespacedToolDefinition` / `defineBantoTool` / `defineNamespacedTool`
- **依存は型に焼き込まない**。旧 `BantoTool.execute(client, args)` をやめ、依存は
  **Tool を作る関数の引数**で受けてクロージャに閉じ込める形へ統一した
  （`createExecutorTools(client)` / `createAuditTools(client)` / `createWorkerTools(pool)`）
- **pi への変換は `banto-host/src/tool-registry.ts` の `toPiTool` だけ**。写すのは
  name（wire名へ変換）/ label / description / parameters / execute の5つで、残りは pi の既定。
  決定1 の「薄い皮」が実際に成立した
- **Tool 名前空間の規約（決定9・決定22）を banto-core へ移した**。名前空間は Banto 全体の
  契約であって pi アダプタの都合ではなく、モジュールが banto-host 抜きで名乗れる必要がある
- **`worker.*` から pi の型 import が消えた**。`packages/banto-host/src/bin.ts` にあった
  `workerPoolModule as any`（Worker Pool が BantoModule 型を参照できないための逃げ）も外れた

### 見立てのとおりだった点

`typebox` が pi から独立しているという見立ては正しく、パラメータは typebox のまま中立化できた。
アダプタは実際に「5つ写して残りは既定」で済んでいる。

### 変わったもの（振る舞いの範囲内）

`report_phase` の `phase` の符号化が `enum: [...]` から typebox の `anyOf: [{const}...]` に変わった。
手書き JSON Schema を typebox に寄せた結果で、同じ形は `worker.delegate` の `modelTier` 等で
既に実プロバイダ相手に動いている。テストは符号化ではなく**許す値の集合**を見るように直した。

### 再発防止

`banto-core-layering.spec.ts` に2本足した。(a) **pi の import は banto-host（アダプタ層）だけ**——
全パッケージの src を走査し、他所からの import を見つけたら落とす。(b) 契約が `@banto/core` 由来で、
pi の型は type import に留まっていること。

網の効きを実際に確かめた（I1）：worker-pool・environment-pool・daemon の3パッケージに
pi の import を1つずつ差し込み、いずれも検出されることを確認した。

**当初は Worker Pool の src だけを見る形にしていたが、それでは足りなかった**——
(i) 別パッケージに新しいモジュールを足したときに素通りする、(ii) 1行前提の正規表現では
複数行の `import {\n ... \n} from "..."` を取りこぼす（実際に `host-session.ts` を
見落としていた）。走査範囲を全パッケージへ広げ、複数行の import も拾うようにした。
