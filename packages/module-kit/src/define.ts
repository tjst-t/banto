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

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
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

interface ToolSpecBase<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly input: Shape;
}

/** テキストだけを返すツール。**読み手が人か AI のときはこれでよい。** */
export interface TextToolSpec<Core, Shape extends z.ZodRawShape> extends ToolSpecBase<Shape> {
  /** core だけを触る。ここにロジックを書かない（唯一の規約）。 */
  run(core: Core, args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

/**
 * **返り値の型を決めるツール**（MCP の `outputSchema` / `structuredContent`）。
 *
 * **モジュールが他のモジュールを呼ぶとき（要件 C10・C13）は必ずこちら。**
 * テキストで返すと、呼ぶ側が文字列を解くことになる——実際そう書いていて、
 * `yes` / `no` を自前で判定していた。**MCP は最初から型を決められる。**
 *
 * 型は宣言ではなく**強制**である。実測（2026-08-21）：`outputSchema` に合わない
 * `structuredContent` を返すと、SDK が `Output validation error` で断る。
 * つまり**契約の形で破れないようにできる**——「気をつける」で担保しない。
 *
 * `content`（テキスト）も一緒に出す。同じ事実を AI が読む形にしただけで、
 * **第二の真実ではない**——`summary` を省けば構造をそのまま JSON にする。
 */
export interface StructuredToolSpec<Core, Shape extends z.ZodRawShape, Out extends z.ZodRawShape>
  extends ToolSpecBase<Shape> {
  readonly output: Out;
  run(core: Core, args: z.infer<z.ZodObject<Shape>>): Promise<z.infer<z.ZodObject<Out>>>;
  /** AI が読む1行。省くと構造をそのまま JSON にする。 */
  readonly summary?: (value: z.infer<z.ZodObject<Out>>) => string;
}

export type ToolSpec<Core, Shape extends z.ZodRawShape> = TextToolSpec<Core, Shape>;

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
export type AnyToolSpec<Core> =
  | (TextToolSpec<Core, z.ZodRawShape> & { readonly output?: undefined })
  | StructuredToolSpec<Core, z.ZodRawShape, z.ZodRawShape>;

/**
 * ツールを1つ組み立てる。**`input` から `run` の引数の型が決まる。**
 *
 * 配列に入れた時点で Shape は潰れるので、潰す前に1つずつ通す必要がある
 * ——これを挟まないと `run` の引数が unknown になる。
 *
 * `output` を書くかどうかで、`run` が返すものが変わる。
 */
export interface ToolBuilder<Core> {
  <Shape extends z.ZodRawShape, Out extends z.ZodRawShape>(
    spec: StructuredToolSpec<Core, Shape, Out>,
  ): AnyToolSpec<Core>;
  <Shape extends z.ZodRawShape>(spec: TextToolSpec<Core, Shape>): AnyToolSpec<Core>;
}

/**
 * モジュールが持つ **URI 空間**（要件 C14・決定19）。
 *
 * AI は画面の名前を知らない。**URI を指すだけ**で、その URI を読めるのは
 * それを持っているモジュールである。**中身をどこかに写さない**——
 * 指した時点の写しを持つと、現物と食い違う（規則3）。
 *
 * `uri` は RFC 6570 のテンプレートを書ける（`banto://fs/file/{+path}`）。
 * **`banto://<モジュール id>/…` にする**——先頭を見るだけで持ち主が分かるので、
 * 「どのモジュールがこの URI を持っているか」の表を別に持たずに済む（規則3）。
 */
export interface ResourceSpec<Core> {
  readonly name: string;
  readonly description: string;
  /** 固定の URI か、RFC 6570 のテンプレート。 */
  readonly uri: string;
  readonly mimeType?: string;
  /** core だけを触る。ツールと同じ規約（C8a）。 */
  read(core: Core, uri: URL, params: Record<string, string | string[]>): Promise<string>;
}

export interface ModuleSpec<Core> {
  readonly manifest: BantoModule;
  /** ドメインロジック。**モジュールにつき1つだけ。** */
  createCore(): Core;
  /** `tool` を通して書く。Core は `createCore` から決まる。 */
  tools(tool: ToolBuilder<Core>): readonly AnyToolSpec<Core>[];
  /** 持っている URI 空間（要件 C14）。省ける——**画面を持たないモジュールは普通にある**。 */
  resources?: readonly ResourceSpec<Core>[];
}

const buildTool = <Core,>(spec: AnyToolSpec<Core>): AnyToolSpec<Core> => spec;

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

    for (const resource of spec.resources ?? []) {
      const config = {
        description: resource.description,
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
      };
      // テンプレートかどうかは形で決まる。**両方を1つの書き方で受ける。**
      const target = resource.uri.includes('{')
        ? new ResourceTemplate(resource.uri, { list: undefined })
        : resource.uri;
      server.registerResource(
        resource.name,
        // any の理由（規則9）：`registerResource` は文字列とテンプレートで
        // 別のオーバーロードを持ち、ここではどちらか静的に決まらない。
        target as any,
        config,
        (async (uri: URL, params: Record<string, string | string[]>) => {
          // 握りつぶさない（規則2）。読めない理由をそのまま投げる。
          const text = await resource.read(core, uri, params ?? {});
          return {
            contents: [
              {
                uri: uri.href,
                ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
                text,
              },
            ],
          };
        }) as never,
      );
    }

    for (const toolSpec of spec.tools(buildTool as ToolBuilder<Core>)) {
      server.registerTool(
        toolSpec.name,
        {
          description: toolSpec.description,
          inputSchema: toolSpec.input,
          ...(toolSpec.output === undefined ? {} : { outputSchema: toolSpec.output }),
        },
        // any の理由（規則9）：MCP SDK の ToolCallback は Shape ごとに型が決まり、
        // ここでは Shape が不定。境界はこの1関数の中に閉じている。
        (async (args: any) => {
          const blockedBy = declineReason.get(toolSpec.name);
          // **断りは outputSchema があっても通る**（実測 2026-08-21）。
          // `isError` はそのまま呼び手に届く。
          if (blockedBy !== undefined) return decline(blockedBy);
          try {
            if (toolSpec.output === undefined) return await toolSpec.run(core, args);
            const value = await toolSpec.run(core, args);
            return {
              structuredContent: value,
              // AI が読む分。**同じ事実を別の形で出すだけ**で、第二の真実ではない。
              content: [{ type: 'text', text: toolSpec.summary?.(value) ?? JSON.stringify(value) }],
            };
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
