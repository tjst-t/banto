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
 * D3: 場所の一覧は提供元が導出する。ここに台帳を持たない——提供元が重い導出を
 *     写し越しに返すことはあるが（repo-manager の `gwq`）、**探している場所が無いときは
 *     取り直させてから断る**ので、「あるのに無いと言われる」は起きない。
 * I2: 範囲外・未登録は黙って既定へ落とさずエラーにする。別の場所を触るより止まる方がよい。
 */

import * as fs from "node:fs";
import * as os from "node:os";
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

/**
 * 成果物置き場（書斎）の場所ID（PO裁定 2026-08-05）。
 *
 * リポジトリに紐づかない成果物——調査レポート・比較検討——の置き場所。**id が既定で必ず
 * 存在すること**に意味がある：番頭の SKILL は配布物（`packages/banto-host/skills/`）に入るので、
 * そこへ個人の実体パスを書くと、人やデプロイ先が変わるたびに SKILL を書き換えることになる。
 * SKILL は `desk` という id だけを指し、**実体は環境の設定が与える**。
 */
export const DESK_PLACE_ID = "desk";

/**
 * 既定の書斎。実体は `~/banto-desk`。パスは環境変数・設定画面から上書きできる。
 *
 * **書ける範囲は付けない**（決定38a：既定はどの場所も読み取り専用）。場所があることと
 * 書けることは別で、範囲は PO が `place.request_write` の承認で与える。`reports/` のような
 * パス構成を既定に埋めないのは決定38f（フレームワークはパス構成を知らない）でもある。
 */
export function defaultDeskPlace(): StaticPlaceConfig {
  return { id: DESK_PLACE_ID, label: "書斎（成果物）", path: path.join(os.homedir(), "banto-desk") };
}

/**
 * 既定の書斎を足す。**同じ id が与えられていれば何もしない**——パスも書ける範囲も
 * 環境変数と設定画面から上書きできる。消しても既定に戻る：置き場所が消えると、番頭は
 * リポジトリに属さない成果物をどこにも残せなくなる。
 */
export function withDefaultDesk(configs: readonly StaticPlaceConfig[]): StaticPlaceConfig[] {
  if (configs.some((c) => c.id === DESK_PLACE_ID)) return [...configs];
  return [...configs, defaultDeskPlace()];
}

/**
 * 書斎の実体が無ければ作る。**「必ずある」ことがこの場所の値打ち**なので、設定漏れや
 * 初回起動で「場所はあるのに開けない」を作らない。
 *
 * I2: 黙って作らない——作ったときだけ、どこに作ったかを呼び手に返す（呼び手が知らせる）。
 *
 * @returns 作ったパス。既にあった・書斎が無いなら undefined
 */
export function ensureDeskDir(configs: readonly StaticPlaceConfig[]): string | undefined {
  const desk = configs.find((c) => c.id === DESK_PLACE_ID);
  if (!desk) return undefined;
  const target = path.resolve(desk.path);
  if (fs.existsSync(target)) return undefined;
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * 後から与えられた書き込み許可（決定38c・task-0042）。
 *
 * 提供元が返した場所に**重ねる**形にしてあるのが要点。`ghq` が返す読み取り専用の
 * リポジトリにも、提供元を書き換えずに許可を足せる。
 */
export interface PlaceGrantSource {
  writableFor(placeId: string): readonly string[];
  /**
   * **どの場所でも**許された範囲（決定74）。持たない実装があってよい（省略可）。
   *
   * PO裁定 2026-08-09：効く先は**登録された全ての場所**——リポジトリだけに絞ると、
   * 「効く場所と効かない場所」をPOが覚えることになる。
   */
  globalWritable?(): readonly string[];
}

/** 場所の帳簿。提供元を束ね、砦の判定に使う。 */
export class PlaceRegistry {
  private readonly providers: PlaceProvider[];
  private readonly grants: PlaceGrantSource | undefined;

  constructor(providers: readonly PlaceProvider[] = [], grants?: PlaceGrantSource) {
    this.providers = [...providers];
    this.grants = grants;
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
    /** 見かけた全ての場所の id → パス。**落としたものも覚える**（下の親の付け替えに要る） */
    const pathById = new Map<string, string>();
    /** 残った場所の パス → id。 */
    const idByPath = new Map<string, string>();

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
        const key = path.resolve(place.path);
        pathById.set(place.id, key);
        // 先に登録された提供元が勝つ（設定で明示したものが、自動発見より優先される）
        if (seen.has(place.id)) continue;
        // **同じディレクトリも先勝ち。** 設定で書き込みを許した場所が、repo-manager の返す
        // 読み取り専用の同じリポジトリと二重に並ぶと、番頭がどちらの id を選ぶかで
        // 書けたり書けなかったりする（決定38a の許可が id 次第で変わって見える）
        if (seenPaths.has(key)) continue;
        seen.add(place.id);
        seenPaths.add(key);
        idByPath.set(key, place.id);
        all.push(this.withGrants(place));
      }
    }

    // **落とした場所を親として指しているものを付け替える**（PO裁定 2026-08-05）。
    //
    // ワークツリーは親リポジトリを id で指すが（`repo-manager`）、その親が上の
    // 「同じディレクトリは先勝ち」で落とされていることがある——`BANTO_PLACES` で
    // 同じリポジトリを別名（`banto`）で登録している場合がまさにそれ。
    // 付け替えないと、親が**どの場所でもない id** を指したまま残り、プロジェクトの記憶
    // （ADR-0003）が実在しない親の下に分かれる。
    return all.map((place) => {
      if (place.parent === undefined || seen.has(place.parent)) return place;
      const parentPath = pathById.get(place.parent);
      const kept = parentPath === undefined ? undefined : idByPath.get(parentPath);
      return kept === undefined ? place : { ...place, parent: kept };
    });
  }

  /**
   * POが後から許した範囲を重ねる（決定38c・74）。
   *
   * 設定側の `writable` を**置き換えず足す**。設定で与えた範囲が、承認の取り消しで
   * 消えてしまわないようにするため（設定を書いたのは PO であって承認の帳簿ではない）。
   *
   * 重ねる順は「設定 → その場所の承認 → 全場所共通」。**判定に順序は効かない**
   * （どれか1つに当たれば書ける）が、画面がこの順で読めるようにしてある。
   */
  private withGrants(place: Place): Place {
    const granted = [
      ...(this.grants?.writableFor(place.id) ?? []),
      ...(this.grants?.globalWritable?.() ?? []),
    ];
    if (granted.length === 0) return place;
    const merged = [...(place.writable ?? [])];
    for (const pattern of granted) if (!merged.includes(pattern)) merged.push(pattern);
    return { ...place, writable: merged };
  }

  /**
   * 提供元に導出し直させてから一覧を引く。
   *
   * 探しているものが見つからなかったときだけ通る道。**普段は通らない**——毎回通すと、
   * 提供元が写しを持つ意味（＝速さ）が無くなる。
   */
  private async listFresh(): Promise<Place[]> {
    await this.invalidate();
    return this.list();
  }

  /** 提供元の写しを捨てさせる。写しを持たない提供元では何も起きない。 */
  async invalidate(): Promise<void> {
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          await provider.refresh?.();
        } catch (err) {
          // 取り直しの失敗で止めない。手元の一覧で答えられるならそれでよい
          console.error(
            `[banto] 場所の提供元 "${provider.name}" の取り直しに失敗しました: ${String(err)}`
          );
        }
      })
    );
  }

  /** id で1つ引く。I2: 未登録は黙って既定へ落とさずエラーにする。 */
  async require(id: string): Promise<Place> {
    const found = (await this.list()).find((p) => p.id === id);
    if (found) return found;

    // 手元の一覧に無いだけかもしれない（たった今作られたワークツリー等）。
    // **断る前に取り直す**——「作った直後に使えない」を起こさないため
    const places = await this.listFresh();
    const fresh = places.find((p) => p.id === id);
    if (!fresh) {
      const known = places.map((p) => p.id).join(", ");
      throw new Error(
        `Unknown place "${id}". Registered: ${known || "(none)"}` +
          (places.length > 0
            ? ` — **引数 "place" にはこの中の id を渡してください**（例: place: "${places[0]!.id}"）`
            : " — 場所が1つも登録されていません")
      );
    }
    return fresh;
  }

  /**
   * 場所を1つ選ぶ。`id` 省略時は**1つしか無ければそれ**。
   *
   * I2: 複数あるのに省略されたら決めない——黙って先頭を選ぶと、番頭が言わなかった
   *     ときに別の場所を触る。「どこでやりますか」と聞き返させる。
   *
   * **断るときは直し方まで書く**（inc-0054）。「複数あります」だけだと、読んだ側は
   * どの引数に何を入れれば通るのか分からず、同じ呼び出しを繰り返して空回りする。
   */
  async resolve(id?: string): Promise<Place> {
    if (id !== undefined) return this.require(id);
    const places = await this.list();
    if (places.length === 1) return places[0]!;
    if (places.length === 0) {
      throw new Error(
        "No place is registered. 場所が1つも登録されていないので、file.* / git.* は使えません。" +
          "place.list で確認してください"
      );
    }
    const ids = places.map((p) => p.id);
    throw new Error(
      `Multiple places are registered (${ids.join(", ")}). Specify one.` +
        ` — どの場所か決まらないので実行していません。**引数 "place" に id を1つ渡して呼び直してください**` +
        `（例: place: "${ids[0]}"）。それぞれの用途は place.list で読めます`
    );
  }

  /** 登録されている場所のうち、与えられた絶対パスを含むものを返す。 */
  async placeContaining(absolutePath: string): Promise<Place | undefined> {
    const real = realPathOfNearestExisting(absolutePath);
    const inside = (places: readonly Place[]): Place | undefined =>
      places.find((place) => isInside(real, place.path));
    // 見つからないときだけ取り直す。砦の判定（決定36g）が、写しの古さで
    // 「登録された場所の外」と誤判定しないようにする
    return inside(await this.list()) ?? inside(await this.listFresh());
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
    // 直し方まで書く（inc-0054）。**どちらを直せばいいのかが分かれ目**——
    // パスが悪いのか、場所の指定が悪いのかは、根を見せないと読んだ側に決められない
    throw new Error(
      `Path "${relativePath}" is outside the place "${place.id}".` +
        ` — "${place.id}" の根は ${place.path} です。**根からの相対パスを渡す**か、` +
        `別の場所なら引数 "place" をそちらの id に変えてください（place.list で一覧できます）`
    );
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
        ? "\x00DEEP\x00"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
    )
    .join("/");
  // `a/**` は a 自身にも a 配下にも当てる
  const source = escaped
    .replace(/\/\x00DEEP\x00/g, "(?:/.*)?")
    .replace(/\x00DEEP\x00/g, ".*");
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
