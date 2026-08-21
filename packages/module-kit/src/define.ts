/**
 * モジュールの書きかた（要件 C8a、ADR-0001 決定5）。
 *
 * ```
 * モジュール
 *   ├── core                 ドメインロジック。ここに1つだけ
 *   ├── ツールインターフェース  core への薄い委譲（AI 向け・MCP）
 *   └── データ API            core への薄い委譲（GUI 向け）
 * ```
 *
 * **ここは Agent SDK に依存しない。** 作るのは標準の `@modelcontextprotocol/sdk` の
 * `McpServer` で、ベンダに触れるのは Runner だけ（決定6）。おかげでモジュールは
 * 他の MCP クライアントからも使える本物の資産になる（決定2）。
 *
 * **C8a は構造の裏付けを失った規約である**（要件 C8）。以前は「1モジュール＝1プロセス」が
 * 二重実装を物理的に面倒にしていたが、in-process を許した以上、守るのは規約でしかない。
 * だから **`tools` は core を受け取ってしか書けない形**にしてある——ロジックを
 * インターフェース側に書くと、core を経由しない分だけ不自然になる。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type * as z from 'zod';

import { describeDependency, type BantoModule, type Dependency } from './manifest.js';

/** ツールの戻り。MCP の形そのまま。解釈しない。 */
export interface ToolResult {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * 断る。**理由を値で返す**（教訓13）。
 * 黙って既定値に落ちたり、空を返したりしない。
 */
export function decline(reason: string): ToolResult {
  return { content: [{ type: 'text', text: `断った: ${reason}` }], isError: true };
}

export interface ToolSpec<Core, Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly input: Shape;
  /** core だけを触る。ここにロジックを書かない（唯一の規約）。 */
  run(core: Core, args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

/**
 * 任意の依存が使えるかどうか。使えないツールだけが理由つきで断る（要件 C11）。
 *
 * **受け取るのは依存そのもので、モジュール id ではない。** 役割で依存できるように
 * なった以上（決定16）、id を渡す形だと `ModuleId` と `Capability` という
 * **どちらも string の別物**が同じ引数に入る。区別できるのは形だけなので、形を渡す。
 */
export interface Availability {
  has(dep: Dependency): boolean;
  reasonFor(dep: Dependency): string;
}

export const ALL_AVAILABLE: Availability = {
  has: () => true,
  reasonFor: () => '',
};

export interface DefinedModule {
  readonly manifest: BantoModule;
  /** 標準 MCP サーバを組み立てる。Runner はこれを繋ぐだけ。 */
  createServer(availability?: Availability): McpServer;
  /** subprocess として単独で立つときの入口。stdio で喋る。 */
  serve(availability?: Availability): Promise<void>;
}

/** 蓄えるときの形。Shape はここで一度だけ潰れる。 */
export type AnyToolSpec<Core> = ToolSpec<Core, z.ZodRawShape>;

/**
 * ツールを1つ組み立てる。**`input` から `run` の引数の型が決まる。**
 *
 * 配列に入れた時点で Shape は潰れるので、潰す前に1つずつ通す必要がある
 * ——これを挟まないと `run` の引数が unknown になる。
 */
export type ToolBuilder<Core> = <Shape extends z.ZodRawShape>(
  spec: ToolSpec<Core, Shape>,
) => AnyToolSpec<Core>;

export interface ModuleSpec<Core> {
  readonly manifest: BantoModule;
  /** ドメインロジック。**モジュールにつき1つだけ。** */
  createCore(): Core;
  /** `tool` を通して書く。Core は `createCore` から決まる。 */
  tools(tool: ToolBuilder<Core>): readonly AnyToolSpec<Core>[];
}

const buildTool = <Core,>(spec: ToolSpec<Core, z.ZodRawShape>): AnyToolSpec<Core> => spec;

export function defineModule<Core>(spec: ModuleSpec<Core>): DefinedModule {
  const build = (availability: Availability): McpServer => {
    const core = spec.createCore();
    const server = new McpServer({ name: spec.manifest.id, version: '0.0.0' });

    // 任意の依存が欠けているとき、**それを使うと宣言した自分のツール**が断る。
    // 引くのは `usedBy`（自分のツール名）であって `tools`（相手のツール名）ではない。
    // 一覧からは消さない——消すと「そんなツールは無い」に見えて、
    // 何が壊れているのか分からなくなる（要件 C12）。
    const declineReason = new Map<string, string>();
    for (const dep of spec.manifest.optional ?? []) {
      if (availability.has(dep)) continue;
      const why = `${describeDependency(dep)} が使えない: ${availability.reasonFor(dep)}`;
      for (const tool of dep.usedBy ?? []) declineReason.set(tool, why);
    }

    for (const toolSpec of spec.tools(buildTool as ToolBuilder<Core>)) {
      server.registerTool(
        toolSpec.name,
        { description: toolSpec.description, inputSchema: toolSpec.input },
        // any の理由（規則9）：MCP SDK の ToolCallback は Shape ごとに型が決まり、
        // ここでは Shape が不定。境界はこの1関数の中に閉じている。
        (async (args: any) => {
          const blockedBy = declineReason.get(toolSpec.name);
          if (blockedBy !== undefined) return decline(blockedBy);
          try {
            return await toolSpec.run(core, args);
          } catch (cause) {
            // 握りつぶさない（規則2）。理由を値にして返す。
            return decline(cause instanceof Error ? cause.message : String(cause));
          }
        }) as never,
      );
    }
    return server;
  };

  return {
    manifest: spec.manifest,
    createServer: (availability = ALL_AVAILABLE) => build(availability),
    serve: async (availability = ALL_AVAILABLE) => {
      await build(availability).connect(new StdioServerTransport());
    },
  };
}
