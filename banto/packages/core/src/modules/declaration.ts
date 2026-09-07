// Module の宣言（決定・2026-09-06、Phase 1「契約が確定し、その契約で3つ書けた」）。
//
// **どの Module を、どう起動するかは、コードではなく宣言で決める。**
// 以前は cli.ts に「vault の dist パス直書き」「`"shell" | "filesystem"` の
// リテラル union」「node で dist/server.js を実行する形」が埋まっており、
// 4本目を足すには本体を書き換えてビルドし直す必要があった——
// TypeScript でない Module（Python）は、そもそもこの形では表現できなかった。
//
// 決めたこと（未決 modules item 9 の決着）：
// **受け入れる起動の形は「このプログラムを、この引数で、この環境変数で」1種類だけ。**
// パッケージ名からの解決・自動インストール・レジストリ取得は入れない（規則10）
// ——いま要るのは「もうそこにあるものを起動する」だけで、それ以上は必要になってから足す。
// この1種類で Python も Ruby も Go も同じ書き方で載る。
//
// 置き場は Configuration（Event Store）——Module 集合は Project 単位（§2.2）で、
// instance 既定＋Project 上書きの仕組みが既にある。新しい置き場を発明しない（規則12）。

import { parseModuleMeta, type BantoModuleMeta } from "@banto/module-contract";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { applyModuleOverlay, diffFromDefaults, type ModuleOverlay } from "./overlay.js";

export class ModuleDeclarationError extends Error {}

/** 起動の仕方。**これが受け入れる唯一の形**（決定・2026-09-06）。 */
export interface ModuleLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ModuleDeclaration {
  /** 一覧の中で一意。Runner から見える名前（`mcp__<name>__…`）でもある。 */
  name: string;
  launch: ModuleLaunch;
  /** `@banto/module-contract` の語彙をそのまま使う（独自の形を作らない）。 */
  meta: unknown;
}

export interface ParsedModuleDeclaration {
  name: string;
  launch: ModuleLaunch;
  meta: BantoModuleMeta;
}

/**
 * 起動の直前に実際の値へ置き換わる差し込み語。
 * **ここに無い語を書いたら、起動する前に落とす**（規則2——黙って空文字で起動しない）。
 */
export interface LaunchContext {
  nodeExec: string;
  monorepoRoot: string;
  dataDir: string;
  hostRelayUrl: string;
  hostRelayToken: string;
  /** その Module 自身の状態の置き場（決定・2026-09-07）。banto が Module ごとに
   *  用意し、閉じ込めていてもここだけは書ける——Project の中を汚さずに
   *  自分の設定を持てるようにするため。 */
  moduleDataDir: string;
  /** Project 単位の Module だけが使える。 */
  projectRoot?: string;
}

const INSTANCE_PLACEHOLDERS = [
  "nodeExec",
  "monorepoRoot",
  "dataDir",
  "hostRelayUrl",
  "hostRelayToken",
  "moduleDataDir",
] as const;
const PROJECT_ONLY_PLACEHOLDERS = ["projectRoot"] as const;

const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/g;

function checkPlaceholders(text: string, scope: "instance" | "project", source: string): void {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1] ?? "";
    if ((INSTANCE_PLACEHOLDERS as readonly string[]).includes(key)) continue;
    if ((PROJECT_ONLY_PLACEHOLDERS as readonly string[]).includes(key)) {
      if (scope === "project") continue;
      throw new ModuleDeclarationError(
        `${source}: instance に1本の Module は \${${key}} を使えません（Project ごとの Module だけが使えます）`,
      );
    }
    throw new ModuleDeclarationError(`${source}: 知らない差し込み語 \${${key}} が書かれています`);
  }
}

export function parseModuleDeclaration(raw: unknown, source: string): ParsedModuleDeclaration {
  if (typeof raw !== "object" || raw === null) {
    throw new ModuleDeclarationError(`${source}: Module の宣言はオブジェクトである必要があります`);
  }
  const { name, launch, meta } = raw as Partial<ModuleDeclaration>;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ModuleDeclarationError(`${source}: name が要ります`);
  }
  const parsedMeta = parseModuleMeta(meta, `${source}(${name})`);
  if (typeof launch !== "object" || launch === null) {
    throw new ModuleDeclarationError(`${source}(${name}): launch が要ります`);
  }
  const { command, args, env } = launch as Partial<ModuleLaunch>;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ModuleDeclarationError(`${source}(${name}): launch.command が空です`);
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new ModuleDeclarationError(`${source}(${name}): launch.args は文字列の配列である必要があります`);
  }
  const envEntries = Object.entries(env ?? {});
  if (envEntries.some(([, v]) => typeof v !== "string")) {
    throw new ModuleDeclarationError(`${source}(${name}): launch.env の値は文字列である必要があります`);
  }

  for (const text of [command, ...args, ...envEntries.map(([, v]) => v)]) {
    checkPlaceholders(text, parsedMeta.scope, `${source}(${name})`);
  }

  return { name, launch: { command, args, env: env ?? undefined }, meta: parsedMeta };
}

function expand(text: string, context: LaunchContext, source: string): string {
  return text.replace(PLACEHOLDER_PATTERN, (_all, key: string) => {
    const value = (context as unknown as Record<string, string | undefined>)[key];
    if (value === undefined) {
      // parse で弾いているはずのものがここへ来たら、黙って空文字にしない（規則2）
      throw new ModuleDeclarationError(`${source}: \${${key}} に入れる値がありません`);
    }
    return value;
  });
}

export function expandLaunch(launch: ModuleLaunch, context: LaunchContext): ModuleLaunch {
  const source = "launch";
  return {
    command: expand(launch.command, context, source),
    args: launch.args.map((a) => expand(a, context, source)),
    env: launch.env
      ? Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, expand(v, context, source)]))
      : undefined,
  };
}

/**
 * Configuration に入れるときの鍵。instance 既定と Project 上書きで同じ鍵を使う。
 *
 * **`modules` は古い形**（丸ごとの写し）。読むだけで、もう書かない
 * ——2026-09-07 より前に書かれたものが残っているので、読み込みでは翻訳する。
 */
export const MODULE_DECLARATIONS_KEY = "modules";

/** **いま書く鍵**。中身は既定との差分だけ（決定・2026-09-07）。 */
export const MODULE_OVERLAYS_KEY = "moduleOverlays";

/**
 * 同梱の既定。**ここが「コードに書いてある唯一の Module 情報」**で、
 * これも宣言の形をしている——特別扱いしない（規則3）。
 */
export const DEFAULT_MODULE_DECLARATIONS: ModuleDeclaration[] = [
  {
    // Vault は instance に1本。Landlock は掛けない（秘密の保管庫自身は
    // Project の根に閉じ込める対象ではない、v4-security.md）。
    name: "vault",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault/dist/server.js"],
      env: { BANTO_VAULT_DATA_DIR: "${dataDir}/vault" },
    },
    meta: {
      satisfies: ["vault"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      handlesSecrets: true,
    },
  },
  {
    // Shell/FileSystem は Project ごと——Landlock は一度掛けたら緩められないので、
    // Project の根が決まった時点で別プロセスとして立てる（v4-security.md）。
    name: "shell",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/shell/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["shell"],
      dependsOn: [{ role: "vault", required: true }],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project" },
    },
  },
  {
    name: "filesystem",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/filesystem/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["filesystem"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project" },
    },
  },
];

/**
 * その Project で繋ぐ Module の宣言。
 * Project 上書きがあればそれ、無ければ instance 既定、それも無ければ同梱の既定。
 * **導出できるものを写さない**（規則3）——一覧はここでだけ作る。
 */
export function loadModuleDeclarations(
  config: RuntimeConfigStore,
  projectId: string,
): ParsedModuleDeclaration[] {
  // **Config に入っているのは差分**（決定・2026-09-07、VS Code と同じ形）。
  // 既定はコードが持ち、写さない——写すと、既定を改良しても写しを持つ Project
  // には届かない（実測・2026-09-07、規則3）。
  //
  // **鍵を分ける。** 古い鍵（`modules`）には**丸ごとの写し**が入っていて、
  // 差分とは形が同じでも意味が違う（差分の「書いていない」は既定のまま、
  // 写しの「載っていない」は外した）。**同じ鍵に混ぜると読み分けられない**ので、
  // 差分は別の鍵に置き、古い鍵は読むときだけ差分へ翻訳する。
  const storedOverlays = config.resolve(MODULE_OVERLAYS_KEY, projectId);
  const storedWhole = config.resolve(MODULE_DECLARATIONS_KEY, projectId);

  let overlays: ModuleOverlay[] = [];
  let source = "default";
  if (Array.isArray(storedOverlays)) {
    overlays = storedOverlays as ModuleOverlay[];
    source = "config(moduleOverlays)";
  } else if (Array.isArray(storedWhole)) {
    // 古い形——**丸ごとの写しを差分に翻訳してから**重ねる
    overlays = diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, storedWhole as ModuleDeclaration[]);
    source = "config(modules)";
  }
  const raw = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, overlays);
  const parsed = raw.map((d) => parseModuleDeclaration(d, source));
  const names = new Set<string>();
  for (const d of parsed) {
    if (names.has(d.name)) {
      throw new ModuleDeclarationError(`${source}: Module 名が重複しています: ${d.name}`);
    }
    names.add(d.name);
  }
  return parsed;
}

/**
 * 宣言を差し替える。projectId を渡すとその Project だけ。
 *
 * **保存するのは既定との差分だけ**（決定・2026-09-07）。渡すのは「こうなって
 * ほしい一覧」で、既定と同じところは書かない——**書くと、既定を改良しても
 * ここが古いまま残る**（規則3）。
 */
export async function setModuleDeclarations(
  config: RuntimeConfigStore,
  declarations: ModuleDeclaration[],
  projectId?: string,
): Promise<void> {
  // 入れる前に検める——壊れた宣言を Event Store に残さない（規則2）
  for (const d of declarations) parseModuleDeclaration(d, "setModuleDeclarations");
  const overlays = diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, declarations);
  const value = overlays as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1];
  if (projectId) await config.setProjectOverride(projectId, MODULE_OVERLAYS_KEY, value);
  else await config.setInstanceDefault(MODULE_OVERLAYS_KEY, value);
}
