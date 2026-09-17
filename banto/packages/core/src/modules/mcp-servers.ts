// **MCP の共通形（`mcpServers`）で受け渡す**（決定・2026-09-16、ユーザー指示）。
//
// `docs/specs/v4-architecture.md` §5.1 は 2026-08-29 に
// 「banto は `mcpServers` 形（Claude Code・VS Code 等の事実上の共通形）に寄せる。
// **独自形式を作らない**」と決めていたのに、実装は banto 独自の形
// （`{name, launch:{...}, meta:{...}}`）のままだった——**仕様と実態の食い違い**
// （規則8）。ここで寄せる。
//
// **中身は元から同じ**：`command` / `args` / `env`。違うのは入れ物だけだった
// （名前をキーにしたオブジェクトか、`name` を中に持つ配列か）。
//
// **banto の追加は `_meta` に置く**——MCP 自身の作法（`server.json` が
// 逆 DNS 名前空間の `_meta` を定めている）。**知らないクライアントは無視する**ので、
// この1枚がそのまま他のクライアントでも動く。
//
// 参考：`mcp.json` の提案（modelcontextprotocol#2218、**まだ提案中**）が
// `type` / `cwd` / `enabled` を足そうとしている。`type` と `enabled` はここでも
// 受ける——**固まったら合わせる**の約束の範囲。

import { MODULE_META_KEY } from "@banto/module-contract";
import { isRemoteLaunch, type ModuleDeclaration } from "./declaration.js";

/** `mcpServers` の1件。**stdio と remote の両方の形を受ける**。 */
export interface McpServerEntry {
  /** `stdio`（起動する）か `http`（URL に繋ぐ）。省略時は形から推す。 */
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** banto では **`${projectRoot}` から導く**ので、書かれていても読まない。 */
  cwd?: string;
  /** banto 全体で動かすか。**止めてあることは一覧に残す**（消えたのと区別が付く） */
  enabled?: boolean;
  /** banto の追加（`dev.banto/module`）。無ければ安全側の既定を組む。 */
  _meta?: Record<string, unknown>;
}

export interface McpServersFile {
  mcpServers: Record<string, McpServerEntry>;
}

export class McpServersError extends Error {}

/** その起動の指定が `${projectRoot}` を使っているか（`scope` と閉じ込めの根が決まる）。 */
function usesProjectRoot(entry: McpServerEntry): boolean {
  const texts = [entry.command ?? "", ...(entry.args ?? []), ...Object.values(entry.env ?? {})];
  return texts.some((t) => t.includes("${projectRoot}"));
}

/**
 * **URL に繋ぐ形の既定**（追加・2026-09-17）。
 *
 * 閉じ込めは付けない——**プロセスがこちらに無いので掛からない**。付けたふりを
 * すると「閉じ込めてある」と読まれる（規則13——見えているものは繋がっている）。
 * 代わりに効くのは egress の承認で、それは口（`POST /api/modules`）が見る。
 */
function remoteDefaultMeta() {
  return { satisfies: [], dependsOn: [], isolation: "subprocess", scope: "instance" as const };
}

/**
 * `mcpServers` を banto の宣言に直す。
 *
 * **`_meta` が無いときの既定は、狭いほうに倒す**（`docs/specs/v4-security.md`）
 * ——外から貼り付けたものは第三者のコードなので、**必ず閉じ込める**。
 * 根は `${projectRoot}` を使ったかで決まる（聞かない）。
 */
export function fromMcpServers(raw: unknown): ModuleDeclaration[] {
  if (typeof raw !== "object" || raw === null) {
    throw new McpServersError("設定はオブジェクトである必要があります");
  }
  const servers = (raw as McpServersFile).mcpServers;
  if (typeof servers !== "object" || servers === null) {
    throw new McpServersError('"mcpServers" が要ります（Claude Code などと同じ形）');
  }
  return Object.entries(servers).map(([name, entry]) => {
    if (typeof entry !== "object" || entry === null) {
      throw new McpServersError(`${name}: 中身がオブジェクトではありません`);
    }
    const kind = entry.type ?? (entry.url ? "http" : "stdio");
    if (kind === "http") {
      if (typeof entry.url !== "string" || entry.url.trim() === "") {
        throw new McpServersError(`${name}: url が要ります`);
      }
      return {
        name,
        launch: { type: "http" as const, url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) },
        meta: entry._meta?.[MODULE_META_KEY] ?? remoteDefaultMeta(),
      };
    }
    if (kind !== "stdio") {
      // **黙って無視しない**（規則2）。受けられないものは、受けられないと言う
      throw new McpServersError(`${name}: 知らない繋ぎ方です（${kind}）`);
    }
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      throw new McpServersError(`${name}: command が要ります`);
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new McpServersError(`${name}: args は文字列の配列です`);
    }
    const declared = entry._meta?.[MODULE_META_KEY];
    const perProject = usesProjectRoot(entry);
    return {
      name,
      launch: { command: entry.command, args, env: entry.env },
      meta:
        declared ??
        // **貼り付けたものは、必ず閉じ込める**（外から繋ぐコードなので）。
        // 根は書いたものから決まる——「この Project のフォルダを渡したか」
        {
          satisfies: [],
          dependsOn: [],
          isolation: "subprocess",
          ...(perProject ? { scope: "project" } : {}),
          confinement: { kind: "landlock", root: perProject ? "project" : "none" },
        },
    };
  });
}

/**
 * banto の宣言を `mcpServers` の形に直す。
 *
 * **そのまま他のクライアントに貼れる**——banto の追加は `_meta` に入っていて、
 * 知らないクライアントは無視する。ただし `${...}` の差し込み語は banto の拡張で、
 * 他では展開されない（平文を書けば普通に動くので、互換は壊れない）。
 */
export function toMcpServers(
  declarations: ReadonlyArray<{ name: string; launch: ModuleDeclaration["launch"]; meta: unknown; enabled?: boolean }>,
): McpServersFile {
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const d of declarations) {
    const common = {
      ...(d.enabled === false ? { enabled: false } : {}),
      _meta: { [MODULE_META_KEY]: d.meta },
    };
    mcpServers[d.name] = isRemoteLaunch(d.launch)
      ? {
          type: "http",
          url: d.launch.url,
          ...(d.launch.headers ? { headers: d.launch.headers } : {}),
          ...common,
        }
      : {
          type: "stdio",
          command: d.launch.command,
          args: d.launch.args,
          ...(d.launch.env ? { env: d.launch.env } : {}),
          ...common,
        };
  }
  return { mcpServers };
}
