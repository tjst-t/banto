/**
 * 場所の帳簿と砦（ADR-0010 決定36c/d/g・決定38・task-0038）。
 *
 * **砦は既にあったが、穴が1つ空いていた。** `file.*` には範囲チェック（リンク解決後に
 * 判定）があり `git.*` は cwd 固定で外を向けないのに、`worker.delegate` の
 * `worktreePath` だけ無検査で、番頭が任意のディレクトリを職人に書き換えさせられた。
 * ここで判定基準を「1つの固定ルート」から「**登録された場所のいずれかの中**」へ
 * 一般化し、読み取りも副作用も同じ砦を通す。
 *
 * **引数は消さない。場所の外を指したときに弾く**——既存の Tool 契約を壊さないため。
 *
 * D3: 場所の一覧は提供元が毎回導出する。ここでキャッシュしない。
 * I2: 範囲外・未登録は黙って既定へ落とさずエラーにする。別の場所を触るより止まる方がよい。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Place, PlaceProvider } from "@banto/core";

/**
 * どんな設定でも書けない範囲（決定38d）。
 *
 * `.git/` を書けると、番頭は git コマンドを使わずに履歴を書き換えられる——
 * **決定37（番頭は Git の変更操作を持たない）の抜け道**になる。
 * ホスト自身のデータ置き場も、許可の宣言を書き換えられると自己昇格が成立する（決定38b）。
 */
const NEVER_WRITABLE = [".git", ".banto"] as const;

/** 広すぎる書き込み範囲。許すこと自体は禁じないが、黙って通さない（決定38e）。 */
const BROAD_PATTERNS = ["**", "**/*", "*"] as const;

/** 静的な場所（ホスト設定で与える。決定36d）。 */
export interface StaticPlaceConfig {
  id: string;
  label?: string;
  path: string;
  writable?: readonly string[];
}

/** ホスト設定から静的な場所を提供する。モジュールにはしない（決定36d）。 */
export function createStaticPlaceProvider(configs: readonly StaticPlaceConfig[]): PlaceProvider {
  return {
    name: "static",
    // 設定は起動時に読んだものをそのまま返す。導出する余地が無いので毎回同じ
    list: async () =>
      configs.map((c) => ({
        id: c.id,
        label: c.label ?? c.id,
        path: path.resolve(c.path),
        ...(c.writable && c.writable.length > 0 ? { writable: c.writable } : {}),
      })),
  };
}

/** 場所の帳簿。提供元を束ね、砦の判定に使う。 */
export class PlaceRegistry {
  private readonly providers: PlaceProvider[];

  constructor(providers: readonly PlaceProvider[] = []) {
    this.providers = [...providers];
  }

  add(provider: PlaceProvider): void {
    this.providers.push(provider);
  }

  /**
   * いま使える場所の一覧。**毎回すべての提供元に聞く**（D3：キャッシュしない）。
   *
   * I2: 1つの提供元が落ちても他は返す。`ghq` 未導入で repo-manager が空を返しても、
   *     静的な場所だけで動けばよい。
   */
  async list(): Promise<Place[]> {
    const all: Place[] = [];
    const seen = new Set<string>();
    const seenPaths = new Set<string>();
    for (const provider of this.providers) {
      let places: Place[];
      try {
        places = await provider.list();
      } catch (err) {
        // 提供元の失敗で番頭を止めない。ただし黙らせない
        console.error(`[banto] 場所の提供元 "${provider.name}" が失敗しました: ${String(err)}`);
        continue;
      }
      for (const place of places) {
        // 先に登録された提供元が勝つ（設定で明示したものが、自動発見より優先される）
        if (seen.has(place.id)) continue;
        // **同じディレクトリも先勝ち。** 設定で書き込みを許した場所が、repo-manager の返す
        // 読み取り専用の同じリポジトリと二重に並ぶと、番頭がどちらの id を選ぶかで
        // 書けたり書けなかったりする（決定38a の許可が id 次第で変わって見える）
        const key = path.resolve(place.path);
        if (seenPaths.has(key)) continue;
        seen.add(place.id);
        seenPaths.add(key);
        all.push(place);
      }
    }
    return all;
  }

  /** id で1つ引く。I2: 未登録は黙って既定へ落とさずエラーにする。 */
  async require(id: string): Promise<Place> {
    const places = await this.list();
    const found = places.find((p) => p.id === id);
    if (!found) {
      const known = places.map((p) => p.id).join(", ");
      throw new Error(`Unknown place "${id}". Registered: ${known || "(none)"}`);
    }
    return found;
  }

  /**
   * 場所を1つ選ぶ。`id` 省略時は**1つしか無ければそれ**。
   *
   * I2: 複数あるのに省略されたら決めない——黙って先頭を選ぶと、番頭が言わなかった
   *     ときに別の場所を触る。「どこでやりますか」と聞き返させる。
   */
  async resolve(id?: string): Promise<Place> {
    if (id !== undefined) return this.require(id);
    const places = await this.list();
    if (places.length === 1) return places[0]!;
    if (places.length === 0) throw new Error("No place is registered.");
    throw new Error(
      `Multiple places are registered (${places.map((p) => p.id).join(", ")}). Specify one.`
    );
  }

  /** 登録されている場所のうち、与えられた絶対パスを含むものを返す。 */
  async placeContaining(absolutePath: string): Promise<Place | undefined> {
    const real = realPathOfNearestExisting(absolutePath);
    for (const place of await this.list()) {
      if (isInside(real, place.path)) return place;
    }
    return undefined;
  }

  /**
   * 副作用のある操作の宛先を検査する（決定36g）。
   *
   * `worker.delegate` の `worktreePath` や検証環境の `workdir` がここを通る。
   * I2: 登録された場所の外なら弾く。黙って動かすと、番頭が別のリポジトリを
   *     職人に書き換えさせられる。
   */
  async requireInsideSomePlace(absolutePath: string, what: string): Promise<Place> {
    const place = await this.placeContaining(absolutePath);
    if (!place) {
      const known = (await this.list()).map((p) => `${p.id} (${p.path})`).join(", ");
      throw new Error(
        `${what} "${absolutePath}" is outside every registered place. Registered: ${known || "(none)"}`
      );
    }
    return place;
  }
}

// ── 砦 ──────────────────────────────────────────────────────────────────────

/**
 * 場所の中の実パスへ解決する。
 *
 * シンボリックリンクを解決した**後**に判定するので、リンク経由で外へ出ることもできない。
 * 存在しないパスはリンク解決できないため、存在する最も近い祖先まで遡って判定する。
 * （`workspace.ts` の `resolveInWorkspace` と同じ性質を、場所ごとに一般化したもの。）
 */
export function resolveInPlace(place: Place, relativePath: string): string {
  const candidate = path.resolve(place.path, relativePath);
  const resolved = realPathOfNearestExisting(candidate);
  const realRoot = fs.existsSync(place.path) ? fs.realpathSync(place.path) : path.resolve(place.path);

  if (!isInside(resolved, realRoot)) {
    throw new Error(`Path "${relativePath}" is outside the place "${place.id}".`);
  }
  return resolved;
}

/**
 * 書き込んでよいかを判定する（決定38）。
 *
 * 既定は読み取り専用。`writable` に**明示的に許された範囲**だけが書ける。
 * `.git/` 等は `**` を許しても書けない（決定38d：決定37 の抜け道を塞ぐ）。
 *
 * @param protectedPaths ホスト自身のデータ置き場（絶対パス）。名前で弾く `NEVER_WRITABLE`
 *   だけでは足りない——`BANTO_DATA_DIR` は差し替えられるので、`.banto` という名前を
 *   当てにすると設定を変えた瞬間に穴が開き、決定38(b) の自己昇格が成立する。
 */
export function assertWritable(
  place: Place,
  relativePath: string,
  protectedPaths: readonly string[] = []
): string {
  const resolved = resolveInPlace(place, relativePath);
  const rel = path.relative(place.path, resolved);

  const first = rel.split(path.sep)[0];
  if (first !== undefined && (NEVER_WRITABLE as readonly string[]).includes(first)) {
    throw new Error(
      `"${rel}" は書き込めません（${first}/ はどの設定でも書き込み禁止です）。`
    );
  }

  for (const guarded of protectedPaths) {
    // 実パスで比べる。リンク越しに入られると名前の比較はすり抜ける
    const real = fs.existsSync(guarded) ? fs.realpathSync(guarded) : path.resolve(guarded);
    if (isInside(resolved, real)) {
      throw new Error(
        `"${rel}" は書き込めません（Banto 自身のデータ置き場はどの設定でも書き込み禁止です）。`
      );
    }
  }

  const patterns = place.writable ?? [];
  if (patterns.length === 0) {
    throw new Error(`場所 "${place.id}" は読み取り専用です（書き込み範囲が許可されていません）。`);
  }
  if (!patterns.some((pattern) => matchesGlob(rel, pattern))) {
    throw new Error(
      `"${rel}" は場所 "${place.id}" の書き込み範囲の外です（許可: ${patterns.join(", ")}）。`
    );
  }
  return resolved;
}

/** 広すぎる書き込み範囲を持つ場所。起動時に警告するため（決定38e）。 */
export function broadlyWritable(places: readonly Place[]): Place[] {
  return places.filter((p) =>
    (p.writable ?? []).some((pattern) => (BROAD_PATTERNS as readonly string[]).includes(pattern))
  );
}

// ── 小道具 ──────────────────────────────────────────────────────────────────

/**
 * ごく小さな glob 判定。`**` は任意の深さ、`*` は1階層内の任意、それ以外は素の一致。
 *
 * D6: glob ライブラリを足さない。書き込み範囲の指定に要るのはこれだけで、
 *     `?` や `[]` まで要る場面が出てから考える。
 */
function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const escaped = pattern
    .split("/")
    .map((segment) =>
      segment === "**"
        ? " DEEP "
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
    )
    .join("/");
  // `a/**` は a 自身にも a 配下にも当てる
  const source = escaped
    .replace(/\/ DEEP /g, "(?:/.*)?")
    .replace(/ DEEP /g, ".*");
  return new RegExp(`^${source}$`).test(normalized);
}

/** `child` が `root` と同じか配下か。 */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

/** 存在する最も近い祖先まで遡って実パスに直す（存在しないパスにも使える）。 */
function realPathOfNearestExisting(candidate: string): string {
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  return path.join(real, path.relative(existing, candidate));
}
