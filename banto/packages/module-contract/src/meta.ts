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

/**
 * その tool が**秘密の値を返さない**ことの申告（決定・2026-09-12）。
 *
 * Module 間中継の承認ゲートが守っているのは**値**であって、名前ではない
 * ——`relayListTargets` を承認も監査も通さないのは、返すのが名前と role
 * だけだから（アーキ仕様 §2.5）。同じ理由で、**一覧・検索のような
 * 「値を返さない口」は初回の承認を要らないことにする**。
 *
 * **無指定は「返す」扱い**（fail closed）。第三者の Module はこのキーを
 * 持たないので、既定を「返さない」にすると、名乗らないだけで承認を
 * すり抜けられることになる。**名乗った Module だけが緩む。**
 */
export const VALUE_FREE_META_KEY = `${VENDOR_PREFIX}/valueFree`;

/**
 * **その呼び出しが、どの Project のためのものか**（決定・2026-09-13）。
 *
 * host が中継するときに刻む——**Module に自己申告させない**（申告なら詐称できる）。
 * Vault の「この alias はどの Project から使えるか」は、これが根拠になる。
 *
 * 値は `{ project: "<id>" }` か `{ admin: true }`（人が管理画面から直接触っている）。
 * **刻印が無い呼び出しは「決められない」**——受け手は fail closed で止める
 * （規則2。既定を「全部見える」にすると、名乗らないだけで制限をすり抜けられる）。
 */
export const CALLER_META_KEY = `${VENDOR_PREFIX}/caller`;

export type CallerStamp = { project: string } | { admin: true };

/** 刻印を読む。**形が違えば `undefined`**——「たぶんこう」で通さない。 */
export function callerOf(meta: Record<string, unknown> | undefined): CallerStamp | undefined {
  const raw = meta?.[CALLER_META_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.admin === true) return { admin: true };
  if (typeof obj.project === "string" && obj.project !== "") return { project: obj.project };
  return undefined;
}

/** その tool が「値を返さない」と名乗っているか。**`true` 以外は全部「返す」。** */
export function isValueFree(x: { _meta?: Record<string, unknown> }): boolean {
  return x._meta?.[VALUE_FREE_META_KEY] === true;
}

export type Visibility = "agent" | "module" | "admin";
export const DEFAULT_VISIBILITY: Visibility = "agent";

export type Isolation = "in-process" | "subprocess";
export type Scope = "instance" | "project";

/**
 * **その Module がどこから来たか**（追加・2026-09-15）。
 *
 * **これは信頼の境界であって、表示のための札ではない。** banto に同梱された
 * 実装と、人が外から繋いだ第三者のコードでは、**許してよいことが違う**
 * ——`valueFree` で承認を飛ばす・敏感な役割を名乗る・閉じ込め無しで立つ、は
 * どれも同梱にしか許せない（`docs/specs/v4-security.md`）。
 *
 * **`bundled` は host だけが付けられる。** 人や差分（overlay）が名乗っても
 * 受け付けない——名乗れたら境界の意味が無い。
 */
export type ModuleOrigin = "bundled" | "external";

/**
 * **同梱の実装だけが名乗ってよい役割**（追加・2026-09-15、レビューで発覚）。
 *
 * `satisfies` は自己申告で、`SPAWN_SHAPE_FIELDS` の厳格さが掛かっていない。
 * 第三者が `vault-directory` を名乗れれば、**AI と Shell が話す窓口になりうる**
 * ——alias 名を全部観測し、値を取りに行く先を自分の実装へ向けられる。
 * `shell` を名乗れば閉じ込めの緩い profile（`exec`）を得られる。
 *
 * **これらは banto の骨格そのものなので、外から名乗らせない。**
 * 第三者が拡張したいのは「新しい役割」であって、既にある骨格の乗っ取りではない。
 */
export const RESERVED_ROLES = ["shell", "filesystem", "vault", "vault-directory"] as const;

/**
 * **instance 全体で1本しか居てはいけない役割**（追加・2026-09-15）。
 *
 * 束ね役（窓口）は「複数を1つに見せる」ためのものなので、**それ自体が
 * 複数あると意味が消える**——呼ぶ側（Shell）は「唯一の1本」を引けなくなる。
 * **A 面を持つかどうかからは導出できない**（A 面を持たない2本目の窓口実装は
 * 理屈の上では作れてしまうため）ので、ここに明示で持つ。
 */
export const SINGLETON_ROLES = ["vault-directory"] as const;

export interface RoleDependency {
  role: string;
  required: boolean;
}

export interface Confinement {
  kind: "landlock";
  root: "project";
  /**
   * 許す広さ（追加・2026-09-15、レビューで発覚）。
   *
   * 以前は host が **`satisfies.includes("shell")` から決めていた**ので、
   * **`shell` を名乗るだけで広いほう（PATH の実行を許す）を取れた**
   * ——自己申告が閉じ込めの強さを決めてしまっていた。宣言で持つ。
   */
  profile: "exec" | "files-only";
}

export interface BantoModuleMeta {
  /** どこから来たか。**host だけが `bundled` を付けられる**（上記）。既定 `external`。 */
  origin: ModuleOrigin;
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

  // **書き間違いを「無指定」と同じに扱わない**（決定・2026-09-10）。
  // 既定（handlesSecrets:false / scope:"instance"）は**キーが無いとき**の話であって、
  // 値が壊れているときの話ではない——`"handlesSecrets": "true"`（文字列）や
  // `"scope": "projekt"` を黙って緩い側に倒すと、秘密を扱う Module が in-process で
  // 立ち、Project ごとに分けるべき Module が1本で共有される（規則2）
  if (obj.handlesSecrets !== undefined && typeof obj.handlesSecrets !== "boolean") {
    throw new ModuleMetaError(
      `${source}: handlesSecrets は true か false（${JSON.stringify(obj.handlesSecrets)} が来ました）`,
    );
  }
  const handlesSecrets = obj.handlesSecrets === true;
  if (obj.scope !== undefined && obj.scope !== "instance" && obj.scope !== "project") {
    throw new ModuleMetaError(
      `${source}: scope は instance か project（${JSON.stringify(obj.scope)} が来ました）`,
    );
  }
  const scope: Scope = obj.scope === "project" ? "project" : "instance";

  let confinement: Confinement | undefined;
  if (obj.confinement !== undefined) {
    const c = obj.confinement as Record<string, unknown>;
    if (c.kind !== "landlock" || c.root !== "project") {
      throw new ModuleMetaError(`${source}: confinement の形が不正です`);
    }
    // **広さは書いていなければ狭いほう**（追加・2026-09-15）。
    // 書き間違いを緩い側に倒さない（既存の handlesSecrets / scope と同じ姿勢）
    if (c.profile !== undefined && c.profile !== "exec" && c.profile !== "files-only") {
      throw new ModuleMetaError(
        `${source}: confinement.profile は exec か files-only（${JSON.stringify(c.profile)} が来ました）`,
      );
    }
    confinement = { kind: "landlock", root: "project", profile: c.profile === "exec" ? "exec" : "files-only" };
  }

  // **`bundled` は host だけが付けられる**（上記 ModuleOrigin）。
  // **書いてあっても読まない**——parse の出口は必ず `external` で、
  // 印を立てられるのは host の `markBundled()` だけ。捨てるのであって
  // 「緩いほうへ倒す」のではない（規則2）——宣言に決める権利が無いという話

  const meta: BantoModuleMeta = {
    origin: "external",
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
/**
 * **同梱の印を立てる。host だけが呼ぶ**（`DEFAULT_MODULE_DECLARATIONS` の parse 後）。
 *
 * parse は必ず `external` を返すので、**印は「host がこの経路を通した」ことの
 * 証拠**になる。差分（overlay）で足された宣言はこの経路を通らないので `external`。
 */
export function markBundled(meta: BantoModuleMeta, source: string): BantoModuleMeta {
  const marked: BantoModuleMeta = { ...meta, origin: "bundled" };
  assertConsistent(marked, source);
  return marked;
}

/**
 * **骨格の役割は、同梱だけが名乗れる**（追加・2026-09-15、レビューで発覚）。
 *
 * parse の中ではできない——parse は必ず `external` を返すので、そこで検査すると
 * **同梱も弾かれる**。origin が決まったあと（host が `markBundled` を通したあと）
 * に呼ぶ。
 *
 * 第三者が `vault-directory` を名乗れれば **AI と Shell が話す窓口になりうる**
 * （alias 名を全部観測し、値を取りに行く先を自分の実装へ向けられる）。
 * `shell` を名乗れば閉じ込めの緩い profile を得られた（そちらは宣言へ移した）。
 */
export function assertRolesAllowed(meta: BantoModuleMeta, source: string): void {
  if (meta.origin === "bundled") return;
  const taken = meta.satisfies.filter((r) => (RESERVED_ROLES as readonly string[]).includes(r));
  if (taken.length > 0) {
    throw new ModuleMetaError(
      `${source}: ${taken.join("・")} は banto 同梱の実装だけが名乗れる役割です` +
        "（外から繋ぐ Module は、別の名前の役割を名乗ってください）",
    );
  }
}

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

/**
 * その tool/resource を誰に見せるか。
 *
 * **キーが無い＝既定（`agent`）**。第三者の Module は banto 独自のこのキーを
 * 持たないので、無指定を `agent` にしないと何も動かない（`docs/specs/v4-modules.md` §2.1）。
 *
 * **ただし「書き間違い」は無指定ではない**（決定・2026-09-10）。`"modle"` のような
 * 値を既定に落とすと、**Module 専用のつもりの道具がいちばん緩い側（AI に見せる）へ
 * 転落する**。ここでは**いちばん狭い側**（`module`——AI にも画面にも出ない）へ倒し、
 * 入口（Module を繋ぐとき）では `assertVisibilityValues` で**繋がずに止める**。
 */
export function visibilityOf(x: { _meta?: Record<string, unknown> }): Visibility {
  const v = x._meta?.[VISIBILITY_META_KEY];
  if (v === undefined) return DEFAULT_VISIBILITY;
  return v === "agent" || v === "module" || v === "admin" ? v : "module";
}

/**
 * 宣言されている `visibility` の**値**が語彙の中にあることを確かめる
 * （決定・2026-09-10）。壊れた値を持つ Module は**繋がない**——黙って
 * 「いちばん狭い側」で動かすと、書いた人は自分の意図どおりだと思い続ける（規則2）。
 */
export function assertVisibilityValues(
  entries: Array<{ name: string; meta?: Record<string, unknown> }>,
  source: string,
): void {
  const broken = entries.filter((e) => {
    const v = e.meta?.[VISIBILITY_META_KEY];
    return v !== undefined && v !== "agent" && v !== "module" && v !== "admin";
  });
  if (broken.length === 0) return;
  const detail = broken
    .map((e) => `${e.name}=${JSON.stringify(e.meta?.[VISIBILITY_META_KEY])}`)
    .join(", ");
  throw new ModuleMetaError(
    `${source}: ${VISIBILITY_META_KEY} の値が agent / module / admin のどれでもありません（${detail}）`,
  );
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
