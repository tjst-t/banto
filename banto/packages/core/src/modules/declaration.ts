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
    // **名前は `vault-local`**（改名・2026-09-13、ユーザー指摘）。役割は `vault`
    // のままで、変えたのは**実装の名前**だけ——2本目（Infisical）が入って
    // 「vault」が役割なのか実装なのか紛らわしくなったため（規則11）。
    //
    // **データ置き場は `${dataDir}/vault` のまま動かさない。** ここは宣言が
    // 固定していて Module 名から導いていないので、改名しても既存の秘密は
    // そのまま読める（移すと孤児になる）。
    name: "vault-local",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-local/dist/server.js"],
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
    // **vault 役割の2本目**（Infisical、2026-09-12）。役割は同じ `vault` で、
    // 違うのは「秘密をどこに置くか」と「メタデータをどこに置くか」だけ
    // ——A/B/C の配線は `@banto/vault-kit` が共有する。
    //
    // **資格情報は Infisical には入れられない**（金庫を開ける鍵は金庫に入らない）
    // ——組み込み Vault の `identity.txt` と同じ category。
    //
    // **繋ぎ方は人が設定画面から入れる**（改訂・2026-09-13、ユーザー要望）。
    // 以前は環境変数だけで、**設定していないと Module が立たなかった**
    // ——立たないので設定画面にも辿り着けず、host は毎回「繋げませんでした」を
    // 受信箱に出していた（毎日のノイズ）。いまは**未設定でも立つ**：設定画面を
    // 出し、値を触る口は理由つきで断る。環境変数も引き続き読む（開発・E2E）。
    name: "vault-infisical",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-infisical/dist/server.js"],
      // **資格情報はここに書かない。** `BANTO_INFISICAL_*` は host の環境変数を
      // 子がそのまま継ぐ（cli.ts が `...process.env` を渡す）——宣言は
      // Event Store に残るので、**秘密を宣言に書くと記録に残ってしまう**。
      // 置き場は運用側（banto を起動する環境）。
      env: { BANTO_VAULT_INFISICAL_DATA_DIR: "${dataDir}/vault-infisical" },
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
    // **名前から在りかを引く窓口**（`vault-directory`、v4-modules.md §2.1）。
    // 自分では秘密を保管しない——`vault` を名乗る実装を横断して、**AI・人・
    // 他 Module に1つの窓口**を見せる。**値は通さない**（`resolveAlias` は
    // 呼び出し元 → host → backend の直行のまま）。
    // ただし**人が画面で打った登録の値は通る**ので `handlesSecrets: true`＝subprocess
    // （要件 C8c、`docs/notes/2026-09-12-vault-directory.md`）。
    // Landlock は掛けない（Vault と同じく、秘密に触るものは閉じ込めの外）。
    name: "vault-directory",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-directory/dist/server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["vault-directory"],
      dependsOn: [{ role: "vault", required: true }],
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
      // **在りかは窓口に、値は金庫に**（改訂・2026-09-12）。どちらが欠けても
      // 秘密は渡せないので両方 required（v4-modules.md §2.1 B節）
      dependsOn: [
        { role: "vault-directory", required: true },
        { role: "vault", required: true },
      ],
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
  //
  // **層は2つとも重ねる**（改訂・2026-09-10）。差分は「変えたところだけ」なので、
  // instance の差分と Project の差分は**足し合わせる**もの——カスケードで片方だけを
  // 選ぶと、**Project が差分を1つ持っただけで instance 側の直しが丸ごと届かなく
  // なる**（`declaration-repair-project-overlay` の検証中に実測）。
  const sources: string[] = [];
  const layers: ModuleOverlay[][] = [];
  for (const layer of projectId ? ["", projectId] : [""]) {
    const stored = config.layerValue(MODULE_OVERLAYS_KEY, layer || undefined);
    const storedWhole = config.layerValue(MODULE_DECLARATIONS_KEY, layer || undefined);
    if (Array.isArray(stored)) {
      layers.push(stored as ModuleOverlay[]);
      sources.push(`config(moduleOverlays${layer ? ":project" : ""})`);
    } else if (Array.isArray(storedWhole)) {
      // 古い形——**丸ごとの写しを差分に翻訳してから**重ねる
      layers.push(diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, storedWhole as ModuleDeclaration[]));
      sources.push(`config(modules${layer ? ":project" : ""})`);
    }
  }
  const source = sources.length > 0 ? sources.join("+") : "default";
  let raw: ModuleDeclaration[] = [...DEFAULT_MODULE_DECLARATIONS];
  for (const overlays of layers) raw = applyModuleOverlay(raw, overlays);
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
  // **同じ形どうしで比べる**（改訂・2026-09-10）。渡ってくるのはたいてい
  // `loadModuleDeclarations` の結果＝**parse で既定が埋まった形**（`handlesSecrets:
  // false` 等）。生の既定と比べると、**既定と同じ値が「上書き」として保存され**、
  // あとで既定を直しても、その Project にだけ古い値が貼り付いたままになる
  // （規則3——写しの汚染。`declaration-repair-project-overlay` の検証中に発見）
  const parsedDefaults = DEFAULT_MODULE_DECLARATIONS.map(
    (d) => parseModuleDeclaration(d, "default") as unknown as ModuleDeclaration,
  );
  const overlays = diffFromDefaults(parsedDefaults, declarations);
  const value = overlays as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1];
  if (projectId) await config.setProjectOverride(projectId, MODULE_OVERLAYS_KEY, value);
  else await config.setInstanceDefault(MODULE_OVERLAYS_KEY, value);
}

/**
 * **自己申告のほうが厳しかったときに、宣言を直す**（`declaration-repair-project-overlay`、
 * 2026-09-10）。直すのは「この Module がこう申告した」という **Module 固有の事実**で、
 * その Project の事情ではない。
 *
 * 以前は Project の上書きを混ぜて解決した一覧を、**projectId 抜きで**保存していた
 * ——つまり
 *
 * - **その Project の上書きが、全 Project の既定に漏れる**
 * - 当の Project の上書きは直らないので、次に起動しても同じ食い違いが出る
 *
 * という二重の壊れ方をしていた（規則3——写しの汚染）。**既定は既定として読み直し、
 * そこへ足して既定に書き戻す。** ただしその Module が既定に無い（Project の上書きで
 * だけ足された Module）なら、直す先はその Project しかない。
 */
export async function repairDeclarationMeta(
  config: RuntimeConfigStore,
  input: { name: string; projectId?: string; stricter: Record<string, unknown> },
): Promise<{ writtenTo: "instance" | "project" }> {
  const base = loadModuleDeclarations(config, "");
  const inBase = base.some((d) => d.name === input.name);
  const target = inBase ? base : loadModuleDeclarations(config, input.projectId ?? "");
  const next = target.map((d) =>
    d.name === input.name ? { ...d, meta: { ...d.meta, ...input.stricter } } : d,
  );
  if (inBase) {
    await setModuleDeclarations(config, next as ModuleDeclaration[]);
    return { writtenTo: "instance" };
  }
  await setModuleDeclarations(config, next as ModuleDeclaration[], input.projectId);
  return { writtenTo: "project" };
}

/**
 * **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、
 * 2026-09-11、Phase 2 の入口）。
 *
 * 渡すのは「この Project で使う名前の一覧」。**外す**は差分の `enabled: false`
 * として残る——既定から消すのではなく、「この Project では使わない」と書く
 * （他の Project には影響しない）。
 *
 * **その Project 固有の直し（launch や meta の差分）は残す**——選び直しただけで
 * 消えてはいけない（規則3——ここで持っているのは「使うかどうか」だけ）。
 */
export async function setProjectModuleSelection(
  config: RuntimeConfigStore,
  projectId: string,
  selectedNames: readonly string[],
): Promise<void> {
  // **選べるのは banto が知っているものだけ**（規則2——知らない名前を順番に置かない）
  const available = loadModuleDeclarations(config, "");
  for (const name of selectedNames) {
    if (!available.some((d) => d.name === name)) {
      throw new ModuleDeclarationError(`知らない Module です: ${name}`);
    }
  }
  const selected = new Set(selectedNames);
  const existing = (config.layerValue(MODULE_OVERLAYS_KEY, projectId) as ModuleOverlay[] | undefined) ?? [];

  const byName = new Map<string, ModuleOverlay>();
  for (const overlay of existing) {
    // `enabled` は下で決め直す——古い「外した」印を持ち越さない
    const { enabled: _dropped, ...rest } = overlay;
    byName.set(overlay.name, rest as ModuleOverlay);
  }
  for (const declaration of available) {
    if (selected.has(declaration.name)) continue;
    byName.set(declaration.name, { ...(byName.get(declaration.name) ?? { name: declaration.name }), enabled: false });
  }

  // 何も言っていない差分（名前だけ）は落とす——空の印を記録に残さない
  const overlays = [...byName.values()].filter(
    (o) => o.enabled === false || o.launch !== undefined || o.meta !== undefined,
  );
  await config.setProjectOverride(
    projectId,
    MODULE_OVERLAYS_KEY,
    overlays as unknown as Parameters<RuntimeConfigStore["setProjectOverride"]>[2],
  );
}

/**
 * **この Project の Module の一覧**（選ばれているかも含めて）。
 * 画面はこれをそのまま並べる——別の一覧を作らない（規則3）。
 *
 * **繋いでみないと分からないこと（tool の数）は返さない。** 数えるには
 * 起動して聞くしかなく、一覧を見ただけで全部を起こすのは筋が悪い（規則2——
 * 分からないものを、分かったように見せない）。
 */
export function listProjectModules(
  config: RuntimeConfigStore,
  projectId: string,
): Array<{
  name: string;
  selected: boolean;
  satisfies: string[];
  dependsOn: BantoModuleMeta["dependsOn"];
  scope: BantoModuleMeta["scope"];
  confinement?: BantoModuleMeta["confinement"];
}> {
  const available = loadModuleDeclarations(config, "");
  const selected = new Set(loadModuleDeclarations(config, projectId).map((d) => d.name));
  return available.map((d) => ({
    name: d.name,
    selected: selected.has(d.name),
    satisfies: d.meta.satisfies,
    dependsOn: d.meta.dependsOn,
    scope: d.meta.scope,
    ...(d.meta.confinement ? { confinement: d.meta.confinement } : {}),
  }));
}
