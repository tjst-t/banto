/**
 * Tool 契約 — ランタイム中立（ADR-0010 決定1・決定9、imp-0003 / task-0025）。
 *
 * **契約の型はここ1つだけ。** 以前は2つ並立していた（banto-core の `BantoTool` と
 * banto-host の pi 由来の型）。決定1「ツール定義はランタイム中立の共通ライブラリに置き、
 * 各ハーネスのアダプタは薄い皮に留める」と決定27b「契約体系を2つ持たない」の両方に
 * 反していたため統合した。
 *
 * **依存は型に焼き込まない。** 旧 `BantoTool` は `execute(client: DaemonClient, args)` で
 * Kobo のクライアントに結合しており、「中立な型」ではなく「Kobo を呼ぶ型」だった。
 * 実行に要るもの（Kobo クライアント・WorkerPool・キャンバス等）は**Tool を作る関数の
 * 引数**で受け、クロージャに閉じ込める（`createWorkerTools(pool)` の形）。
 *
 * D5: ここに判断は無い。契約の形だけ。
 * D6: 依存は typebox のみ。**typebox は pi ではなく独立した JSON Schema ビルダ**
 *     （`node_modules/typebox`）なので、パラメータは typebox のままで中立にできる（imp-0003）。
 * I4: TypeScript strict。
 */

import type { Static, TSchema } from "typebox";
import { assertNamespacedToolName, type NamespacedToolName } from "./tool-namespace.js";

// ── 結果 ────────────────────────────────────────────────────────────────────

/**
 * Tool が返す中身。いまはテキストのみ。
 *
 * pi の `AgentToolResult.content` は画像も受けるが、既存の Tool は1つも使っていない。
 * 使わない表現を契約に置くと、アダプタが写せることを誰も確かめないまま増える——
 * 要るようになったらそのとき足す。
 */
export interface BantoToolTextContent {
  type: "text";
  text: string;
}

export interface BantoToolResult<TDetails = unknown> {
  content: BantoToolTextContent[];
  /**
   * 構造化された詳細。GUI・ログ向けで、LLM に渡る本文ではない。
   * 省略可（アダプタが既定値で埋める）。
   */
  details?: TDetails;
}

// ── 実行時の文脈 ────────────────────────────────────────────────────────────

/**
 * 実行のたびに変わる文脈。**依存の注入口ではない**（依存はクロージャで持つ）。
 *
 * いまのところ全 Tool が使っていないが、契約からは落とさない——`signal` を捨てると
 * 長く走る Tool（環境での検証コマンド等）を中断する手立てが無くなる。
 * 使わない Tool は `execute(args)` とだけ書けばよい（引数を減らした実装は代入できる）。
 */
export interface BantoToolContext {
  /** この呼び出しのID。ログの突き合わせに使う。 */
  toolCallId: string;
  /** 中断の合図。長く走る Tool は見ること。 */
  signal?: AbortSignal;
}

// ── 契約 ────────────────────────────────────────────────────────────────────

export interface BantoToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** 論理名。`<domain>.<verb...>`（決定9）。wire 名への変換はアダプタの仕事（決定22）。 */
  name: string;
  /** 人が読む名前（GUI 表示用）。 */
  label: string;
  /** LLM に渡す説明。 */
  description: string;
  /** パラメータの JSON Schema（typebox）。 */
  parameters: TParams;
  /**
   * `ctx` は**省略されうる**。呼び出し口によっては本物の呼び出しIDも中断の合図も無い
   * （モジュールの HTTP 面はIDを合成しているだけ）。実装が当てにしてよい前提ではないので、
   * 型でもそう表す——`ctx!.signal` と書けてしまう形にしない（I2）。
   */
  execute(args: Static<TParams>, ctx?: BantoToolContext): Promise<BantoToolResult<TDetails>>;
}

/**
 * 名前が名前空間つきであることを型でも要求する契約。
 *
 * 実行時の検証は `assertNamespacedToolName`（レジストリ登録時）。ここは型側の網。
 */
export type NamespacedToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> = BantoToolDefinition<TParams, TDetails> & { name: NamespacedToolName };

/**
 * パラメータの型推論を保つための恒等関数。
 *
 * オブジェクトリテラルをそのまま配列へ入れると `TParams` が widen されて
 * `execute` の引数が `unknown` になる。pi の `defineTool()` と同じ役目だが、
 * **pi には依存しない**——モジュールが Tool を定義するのにハーネスの型を要求しないのが
 * 決定1 の要点（imp-0003 の実害はまさにこれだった）。
 */
export function defineBantoTool<TParams extends TSchema, TDetails = unknown>(
  tool: BantoToolDefinition<TParams, TDetails>
): BantoToolDefinition<TParams, TDetails> {
  return tool;
}

/**
 * 名前空間つき Tool を定義する。モジュールが番頭へ公開する Tool はすべてこれ（決定9）。
 *
 * I2: 命名規約に反していたら黙って登録せず、その場で失敗させる。
 */
export function defineNamespacedTool<TParams extends TSchema, TDetails = unknown>(
  tool: NamespacedToolDefinition<TParams, TDetails>
): NamespacedToolDefinition<TParams, TDetails> {
  assertNamespacedToolName(tool.name);
  return tool;
}

/**
 * 型を消した契約。レジストリ・モジュール定義など、パラメータの型に関心が無い側が使う。
 *
 * `any` の理由（I4）：`execute` は `TParams` に対して反変なので、具体的な
 * `BantoToolDefinition<TObject<...>>` をパラメータ消去した形へ代入するにはこれが要る
 * （pi の `AnyToolDefinition` と同じ逃げ道）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由 (I4)
export type AnyBantoTool = BantoToolDefinition<any, any>;
