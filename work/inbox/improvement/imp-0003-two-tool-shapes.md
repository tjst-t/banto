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

## 経緯（なぜ起きたか）

task-0004 で pi SDK に載せる際、`defineTool()` をラップするのが最短だったため
banto-host 側に新しい型を作った。既存の `BantoTool` との関係を整理しないまま、以降の
Tool をすべて新しい型で作り続けたため差が広がった。ADR の該当条項（決定1）を都度
参照していれば気づけた。

## 対処

- 本incidentでは記録に留め、task-0010 は現行の `NamespacedToolDefinition` で進める。
  Worker Pool だけ別の型にすると、モジュールレジストリが2つの形を受ける必要が生じて
  かえって悪化するため
- 統合は別タスクとする（→ 起票）。方向としては、契約（名前・JSON Schema・説明・実行）を
  banto-core に置き、pi 向けの型変換はアダプタ（banto-host）に寄せる形が決定1に沿う
