// banto の置き場（backendPath）と Infisical のフォルダの対応（1か所に置く。backend と台帳の両方が使う）。
//
//   backendPath `g/key`          → フォルダ `/g`        の秘密 `key`     （alias 名 `key`）
//   backendPath `g/sub/key`      → フォルダ `/g/sub`    の秘密 `key`     （alias 名 `sub/key`）
//   backendPath `g/a/b/key`      → フォルダ `/g/a/b`    の秘密 `key`     （alias 名 `a/b/key`）
//
// **グループは直下のフォルダ**（今までどおり）。その中のフォルダは**平らにせず、グループからの相対の道を
// 名前にする**（決定・2026-10-06、ユーザー）——`infisical run --path=/g --recursive` で読んでいる人の
// フォルダ分けをそのまま使えるように。以前は直下のフォルダの秘密しか数えず、サブフォルダの秘密は一覧に
// 出なかった。根（`/`）に直接置いた秘密は今までどおりどのグループにも属さない。
//
// alias 名の衝突は起きない——同じグループの中では道が違えば名前も違う（`KEY` と `sub/KEY` は別の名前）。
//
// **版（環境）**（決定・2026-10-06）：グループが `g@prod` なら環境 prod のフォルダ `/g`。`@` の無い
// グループは接続設定の環境（既定の版）。kit が決めた書き方 `<グループ>@<版>` を、ここだけが環境として読む。
//
//   backendPath `g@prod/sub/key` → 環境 prod のフォルダ `/g/sub` の秘密 `key`（alias 名 `sub/key`）

import type { InfisicalConnection } from "./client.js";

/**
 * フォルダ名として許す形。**組み込み Vault と同じ規律**（2026-09-10 の `vault-os-surface-hardening`）——
 * `..` や空の段を通すと、フォルダ階層の外や別の場所を指せる。サブフォルダの段にも同じものを当てる。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeFolder(name: string, label = "グループ名"): void {
  if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") {
    throw new Error(`${label}に使えるのは英数字と . _ - だけです（先頭は英数字）: ${JSON.stringify(name)}`);
  }
}

export interface Place {
  /** グループ（直下のフォルダの名前。版は含まない）。 */
  group: string;
  /** 版（環境）。無ければ接続設定の環境。 */
  env?: string;
  /** backendPath の頭（`g` か `g@prod`）。 */
  groupId: string;
  /** グループの中のフォルダ（無ければ空）。 */
  subfolders: string[];
  /** 秘密の名前。 */
  key: string;
  /** Infisical のフォルダの道（`/g` や `/g/sub`）。 */
  folder: string;
}

/** backendPath を Infisical の置き場に直す。**怪しい段は通さない**（規則2）。 */
export function placeOf(backendPath: string): Place {
  const parts = backendPath.split("/");
  if (parts.length < 2) throw new Error(`vault path must be "group/key", got "${backendPath}"`);
  const { group, env, groupId } = parseGroupId(parts[0]!);
  const key = parts[parts.length - 1]!;
  const subfolders = parts.slice(1, -1);
  for (const sub of subfolders) assertSafeFolder(sub, "フォルダ名");
  if (key === "") throw new Error(`秘密の名前が空です: "${backendPath}"`);
  return { group, env, groupId, subfolders, key, folder: `/${[group, ...subfolders].join("/")}` };
}

/**
 * グループ（`g` か `g@prod`）を読む。**環境の名前も同じ規律で検める**——Infisical の環境の slug は
 * 英小文字・数字・`-` なので、この形に収まる
 */
export function parseGroupId(groupId: string): { group: string; env?: string; groupId: string } {
  const at = groupId.indexOf("@");
  const group = at === -1 ? groupId : groupId.slice(0, at);
  const env = at === -1 ? undefined : groupId.slice(at + 1);
  assertSafeFolder(group);
  if (env !== undefined) assertSafeFolder(env, "環境の名前");
  return { group, env, groupId };
}

/**
 * Infisical の一覧の1件（フォルダの道と秘密の名前）を backendPath に直す。
 * **根に直接置いた秘密はグループに属さない**ので undefined。
 */
export function backendPathOf(secretPath: string, secretKey: string, env?: string): string | undefined {
  const segments = secretPath.split("/").filter((s) => s !== "");
  if (segments.length === 0) return undefined;
  if (env !== undefined) segments[0] = `${segments[0]}@${env}`;
  return [...segments, secretKey].join("/");
}

/** backendPath から、グループを除いた道（＝ banto の注記が無いときの alias 名）。 */
export function nameWithinGroup(backendPath: string): string {
  return backendPath.slice(backendPath.indexOf("/") + 1);
}

/**
 * その置き場のフォルダを、グループから順に作る。**冪等**——既にあるのは失敗ではない。
 * Infisical の `folders.create` は既にあると 400 を返すので飲み込む（「既にある」以外の失敗は通す）。
 */
export async function ensureFolders(
  conn: InfisicalConnection,
  place: Pick<Place, "group" | "subfolders" | "env">,
): Promise<void> {
  let parent = "/";
  for (const name of [place.group, ...place.subfolders]) {
    try {
      await conn.folders().create({ ...conn.scopeFor(place.env), name, path: parent });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    parent = parent === "/" ? `/${name}` : `${parent}/${name}`;
  }
}

/** Infisical の「もうある」を見分ける。**文言に頼るのは弱い**ので、状態符号も見る。 */
export function isAlreadyExists(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exist/i.test(message) || /StatusCode=409/.test(message);
}
