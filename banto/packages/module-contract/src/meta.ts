// docs/specs/v4-architecture.md §5.1・§5.4、docs/specs/v4-modules.md §2.1 の実装。
// `_meta["dev.banto/module"]` の型・parser・visibility解決。
// 接頭辞は `dev.banto`（決定・2026-09-02、実際にDNSを持つ必要はない——
// 逆DNS記法は名前空間衝突回避のための記法でしかない）。

export const VENDOR_PREFIX = "dev.banto";
export const MODULE_META_KEY = `${VENDOR_PREFIX}/module`;
export const VISIBILITY_META_KEY = `${VENDOR_PREFIX}/visibility`;
/**
 * その資源が**どの面か**（決定・2026-09-07）。いまは `"config"`（設定 Canvas）だけ。
 *
 * MCP Apps の仕様に「設定画面」という概念は無い（UI のライフサイクルは
 * 完全に tool 起点）。**ここは banto が足した拡張**であると自覚して扱う。
 * banto が全 Module に `ui://<id>/config` を投機的に読みにいく形にはしない
 * ——「在るかもしれない」を毎回試すと、無いのか壊れているのかが曖昧になる
 * （規則2、`docs/specs/v4-frontend.md` §6.2）。**Module が名乗る。**
 */
export const CANVAS_META_KEY = `${VENDOR_PREFIX}/canvas`;

export type Visibility = "agent" | "module" | "admin";
export const DEFAULT_VISIBILITY: Visibility = "agent";

export type Isolation = "in-process" | "subprocess";
export type Scope = "instance" | "project";

export interface RoleDependency {
  role: string;
  required: boolean;
}

export interface Confinement {
  kind: "landlock";
  root: "project";
}

export interface BantoModuleMeta {
  satisfies: string[];
  dependsOn: RoleDependency[];
  isolation: Isolation;
  /** Module自身のバックエンドコードが平文の値を変数・引数として受け取るか。既定false。 */
  handlesSecrets: boolean;
  /** 既定 "instance"。"project" は Shell/FileSystemのようにLandlockで
   *  Project単位にプロセスを分ける必要があるModule向け。 */
  scope: Scope;
  confinement?: Confinement;
}

export class ModuleMetaError extends Error {}

function isRoleDependency(x: unknown): x is RoleDependency {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as RoleDependency).role === "string" &&
    typeof (x as RoleDependency).required === "boolean"
  );
}

/** 静的宣言・動的自己申告のどちらもこの1つのparserを通す（規則3）。 */
export function parseModuleMeta(raw: unknown, source: string): BantoModuleMeta {
  if (typeof raw !== "object" || raw === null) {
    throw new ModuleMetaError(`${source}: ${MODULE_META_KEY} はオブジェクトである必要があります`);
  }
  const obj = raw as Record<string, unknown>;

  const satisfies = obj.satisfies;
  if (!Array.isArray(satisfies) || !satisfies.every((s) => typeof s === "string")) {
    throw new ModuleMetaError(`${source}: satisfies は string[] である必要があります`);
  }

  const dependsOnRaw = obj.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw) || !dependsOnRaw.every(isRoleDependency)) {
    throw new ModuleMetaError(`${source}: dependsOn は {role,required}[] である必要があります`);
  }

  const isolation = obj.isolation;
  if (isolation !== "in-process" && isolation !== "subprocess") {
    throw new ModuleMetaError(`${source}: isolation は必須で in-process か subprocess`);
  }

  const handlesSecrets = obj.handlesSecrets === true;
  const scope: Scope = obj.scope === "project" ? "project" : "instance";

  let confinement: Confinement | undefined;
  if (obj.confinement !== undefined) {
    const c = obj.confinement as Record<string, unknown>;
    if (c.kind !== "landlock" || c.root !== "project") {
      throw new ModuleMetaError(`${source}: confinement の形が不正です`);
    }
    confinement = { kind: "landlock", root: "project" };
  }

  const meta: BantoModuleMeta = {
    satisfies,
    dependsOn: dependsOnRaw as RoleDependency[],
    isolation,
    handlesSecrets,
    scope,
    confinement,
  };

  assertConsistent(meta, source);
  return meta;
}

/**
 * docs/specs/v4-modules.md §2.1「VaultUIのisolation」・
 * docs/specs/v4-security.md「Projectの根はModule起動時に確定させる」の
 * 機械チェック。読み違えたまま動かさない（規則2）。
 */
function assertConsistent(meta: BantoModuleMeta, source: string): void {
  if (meta.handlesSecrets && meta.isolation === "in-process") {
    throw new ModuleMetaError(
      `${source}: handlesSecrets:true の Module は isolation:"in-process" を宣言できません`,
    );
  }
  if (meta.confinement && (meta.scope !== "project" || meta.isolation !== "subprocess")) {
    throw new ModuleMetaError(
      `${source}: confinement を持つには scope:"project" かつ isolation:"subprocess" が必要です`,
    );
  }
}

/**
 * 食い違いを検出したら差し替えてよいフィールドと、してはいけないフィールドを分ける
 * （決定・2026-09-03）。spawn の仕方を左右する4つは、動的自己申告のほうが正しいと
 * 分かっても「読み替えるだけ」では済まない——呼び出し側が再spawnする責任を持つ。
 */
export const SPAWN_SHAPE_FIELDS = ["scope", "isolation", "handlesSecrets", "confinement"] as const;

export interface ReconcileResult {
  reconciled: BantoModuleMeta;
  /** true なら呼び出し側は接続を切って正しい形で再spawnしなければならない。 */
  requiresRespawn: boolean;
  changedFields: string[];
}

/**
 * 宣言（Config）と自己申告（Module）の食い違いを、**方向で**分ける
 * （決定・2026-09-06）。
 *
 * **Module の申告は「より厳しくする方向にだけ効く情報」**として扱う。
 * Module は他人が書いたものでありうるので、「私は秘密を扱いません、
 * 閉じ込めは要りません」という自己申告を鵜呑みにして隔離を外すのは、
 * 攻撃者にとって一番都合のいい形になる。**運用者の意図（Config）が上位**。
 *
 * - `stricter`：Module のほうが厳しい → Config を直して起動し直してよい（安全側）
 * - `looser`：Module のほうが緩い → **従わない。繋がずに人に上げる**
 * - `other`：起動の形に関わらない差分（役割名など）→ 記録して続行してよい
 */
export interface MetaDifference {
  stricter: string[];
  looser: string[];
  other: string[];
}

/** その項目について、a は b より厳しいか。 */
function isStricter(field: (typeof SPAWN_SHAPE_FIELDS)[number], a: BantoModuleMeta, b: BantoModuleMeta): boolean {
  switch (field) {
    case "scope":
      // Project ごとに分ける方が、instance に1本より厳しい
      return a.scope === "project" && b.scope === "instance";
    case "isolation":
      return a.isolation === "subprocess" && b.isolation === "in-process";
    case "handlesSecrets":
      // 「秘密を扱う」と申告する方が厳しい（追加の検査が掛かる）
      return a.handlesSecrets && !b.handlesSecrets;
    case "confinement":
      return a.confinement !== undefined && b.confinement === undefined;
  }
}

export function classifyMetaDifference(
  declared: BantoModuleMeta,
  selfReported: BantoModuleMeta,
): MetaDifference {
  const stricter: string[] = [];
  const looser: string[] = [];
  const other: string[] = [];

  for (const field of SPAWN_SHAPE_FIELDS) {
    if (JSON.stringify(declared[field]) === JSON.stringify(selfReported[field])) continue;
    if (isStricter(field, selfReported, declared)) stricter.push(field);
    else if (isStricter(field, declared, selfReported)) looser.push(field);
    else other.push(field);
  }
  if (JSON.stringify(declared.satisfies) !== JSON.stringify(selfReported.satisfies)) other.push("satisfies");
  if (JSON.stringify(declared.dependsOn) !== JSON.stringify(selfReported.dependsOn)) other.push("dependsOn");

  return { stricter, looser, other };
}

export function reconcileModuleMeta(
  staticMeta: BantoModuleMeta,
  dynamicMeta: BantoModuleMeta,
): ReconcileResult {
  const changedFields: string[] = [];
  let requiresRespawn = false;

  for (const field of SPAWN_SHAPE_FIELDS) {
    const a = JSON.stringify(staticMeta[field]);
    const b = JSON.stringify(dynamicMeta[field]);
    if (a !== b) {
      changedFields.push(field);
      requiresRespawn = true;
    }
  }
  if (JSON.stringify(staticMeta.satisfies) !== JSON.stringify(dynamicMeta.satisfies)) {
    changedFields.push("satisfies");
  }
  if (JSON.stringify(staticMeta.dependsOn) !== JSON.stringify(dynamicMeta.dependsOn)) {
    changedFields.push("dependsOn");
  }

  // 動的自己申告を正とする（satisfies/dependsOnはルーティングにしか
  // 影響しないので、そのまま採用してよい）。
  return { reconciled: dynamicMeta, requiresRespawn, changedFields };
}

/** 全 tool/resource が明示的な visibility を持つかを確認する
 *（handlesSecrets:true の Module に要求される、決定・2026-09-03）。 */
export function assertAllVisibilityExplicit(
  entries: Array<{ name: string; meta?: Record<string, unknown> }>,
  source: string,
): void {
  for (const e of entries) {
    const v = e.meta?.[VISIBILITY_META_KEY];
    if (v === undefined) {
      throw new ModuleMetaError(
        `${source}: handlesSecrets:true の Module は全 tool/resource に明示的な ` +
          `${VISIBILITY_META_KEY} が必要です（${e.name} に無い）`,
      );
    }
  }
}

export function visibilityOf(x: { _meta?: Record<string, unknown> }): Visibility {
  const v = x._meta?.[VISIBILITY_META_KEY];
  return v === "agent" || v === "module" || v === "admin" ? v : DEFAULT_VISIBILITY;
}

/** dev.banto/ 接頭辞のキーだけを取り除く。他ベンダの _meta は残す。 */
export function stripBantoMeta<T extends { _meta?: Record<string, unknown> }>(x: T): T {
  if (!x._meta) return x;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x._meta)) {
    if (!k.startsWith(`${VENDOR_PREFIX}/`)) kept[k] = v;
  }
  return { ...x, _meta: Object.keys(kept).length > 0 ? kept : undefined };
}
