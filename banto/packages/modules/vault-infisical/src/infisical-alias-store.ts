// alias のメタデータを **Infisical 自身の中**に置く（決定・2026-09-12）。
//
// **なぜローカルのファイルではないのか。** 仕様 §2.1 は「複数台のホストで動く
// banto インストールが、**同じ backend を共有できる**ようにする」ことを
// Infisical（の Folder）を名指しして決めている。ところがメタデータを
// ローカルのファイルに置くと、**2台目のホストからは値はあるのに名前も種別も
// 用途も分からない**——共有が半分しか成立しない（規則13 の親戚：繋がっている
// ように見えて、繋がっているのは値だけ）。
//
// Infisical は秘密に注記（`secretComment`）を付けられ、**値を読まずに一覧で
// 取れる**（実測・2026-09-12）。仕様 D節の「メタデータは値と分離して持つ。
// 値を復号・解錠せずに読める必要がある」をそのまま満たす。
//
// **banto の注記が無い秘密も読む**（訂正・2026-09-13）。Infisical を既に
// フォルダで分けて使っている人にとって、そこに在る秘密は「混ざりもの」ではなく
// **本体**である。注記があればそれを使い、無ければ置き場の名前を alias 名に、
// 種別は `secret` として扱う（**中身を見て推測しない**）。
// **banto は注記を書き足さない**——読むだけ。
//
// **持ち方**：メタデータは「その秘密の注記」として、秘密と同じところに住む。
//   秘密 `/{group}/{key}`  ← 値
//     secretComment        ← {"kind":…,"scope":…,"projectId":…,"note":…,"lastUsedAt":…}
//
// **参照**（決定・2026-10-04）も同じ形で持つ——参照の置き場に秘密を1つ置き、注記に
// 元の置き場（`linkTo`）を書く。値は Infisical 自身の参照の書き方
// `${環境.フォルダ.キー}` にするので、banto の外の道具がそのフォルダを読んでも
// 元の値が取れる（banto 自身は `linkTo` を辿って元を引く）。種別は書かない（元から導く）。
//
// **正は注記の `linkTo`**（2026-10-04、レビュー）。秘密の値（`${…}`）は banto の外の道具のための写しで、
// banto はそれを読まない（backend の getSecret は展開もさせない）。人が Infisical 側で値だけ書き換えると
// 2つが食い違うが、**検出はしない**——banto の振る舞いは注記だけで決まる。
//   秘密 `/{group}/{key}`  ← ${dev.{元のフォルダ}.{元のキー}}
//     secretComment        ← {"name":…,"linkTo":"{元のフォルダ}/{元のキー}","note":…}
//
// したがって**別の台帳ファイルを持たない**（規則3——真実は一箇所）。alias を
// 消せばメタデータも一緒に消える。ホストを増やしても同じものが見える。

import { isLink, type AliasListOptions, type AliasMeta, type AliasPatch, type AliasStore, type LinkAliasMeta } from "@banto/vault-kit";
import type { InfisicalConnection } from "./client.js";
import { backendPathOf, ensureFolders, nameWithinGroup, parseGroupId, placeOf } from "./place.js";
import { isFolderMissing } from "./infisical-backend.js";

/**
 * 注記に書く中身。**`backendPath` は置き場そのものなので書かない**（規則3）。
 *
 * **`name` は書く**（訂正・2026-09-13、ユーザー指摘）。当初は「置き場から
 * 導ける」として省いていたが、**その前提が成り立たない**——秘密鍵は
 * `generateKeypair` が置き場を決めるので（`ssh/<公開鍵の先頭>`）、
 * 名前と置き場が一致しない。実際、`github-ssh` として作った鍵が
 * **`AAAAC3NzaC1lZDI1` という名前の alias として一覧に出た**。
 * 人が Infisical 側で鍵名を変えても、alias 名は alias 名のまま残る。
 */
type StoredMeta = DistributiveOmit<AliasMeta, "backendPath">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class InfisicalAliasStore implements AliasStore {
  constructor(private readonly conn: InfisicalConnection) {}

  /** 遠くにあるので、立ち上がりで読み込むものは無い。 */
  async load(): Promise<void> {}

  /**
   * 全フォルダの秘密を、**注記つきで**列挙する。
   *
   * **写しを持たない**（規則3）——手元に貯めると、別のホストが変えたときに
   * 古いものを見せることになる。共有できることが眼目なので、毎回聞く。
   *
   * **聞くのは1回**（改訂・2026-09-26、実測）。以前はフォルダの一覧を取ってから
   * フォルダごとに `listSecrets` を投げていた（N+1）。Infisical Cloud への往復が
   * フォルダの数だけ直列に並び、**1回の一覧が 1.7〜3.0 秒**かかっていた。
   * `recursive: true` で1回にすると **0.2〜0.9 秒**（同じ 34 件）。
   *
   * **値は空かどうかを見るためだけに読む**（改訂・2026-10-06、ユーザー了承）。以前は
   * `viewSecretValue: false` で値を取らなかったが、それだと名前だけの空欄を一覧で示せない。
   * 値は行に入れず、手元にも残さない（`toMeta`）。
   *
   * **版付きのグループ**（`g@prod`、2026-10-06）は、kit が `alsoGroups` で渡したものだけ、
   * その環境のそのフォルダを読む。
   *
   * 再帰で返るもののうち、根に直接置かれた秘密は数えない（banto のグループではない）。
   * **フォルダの中のフォルダの秘密も数える**（改訂・2026-10-06、ユーザー）——グループは直下の
   * フォルダのまま、名前はグループからの相対の道（`sub/KEY`）にする。以前は直下のフォルダの
   * 秘密だけを数え、`infisical run --recursive` で読む人のサブフォルダの秘密が一覧に出なかった。
   */
  async list(opts?: AliasListOptions): Promise<AliasMeta[]> {
    // **値も読み、空かどうかだけ残す**（決定・2026-10-06、ユーザー了承）——Infisical の一覧は値を隠すと
    // 空かどうかも分からない。値は toMeta の中で使い切り、返す行にも手元にも残さない
    const reads: Array<Promise<AliasMeta[]>> = [
      this.listIn(undefined, "/"),
      // **紐付けた版付きのグループ**（`g@prod`）は、その環境のそのフォルダだけを読む——環境の数だけ
      // 全部を読まない（kit が台帳の紐付けから渡す、2026-10-06）
      ...(opts?.alsoGroups ?? []).map((id) => {
        const { group, env } = parseGroupId(id);
        // 既定の環境は上の一覧で読んでいる——もう一度読むと同じ秘密が `g/X` と `g@<既定>/X` の2行になる
        if (env === undefined || env === this.conn.scope.environment) return Promise.resolve([]);
        return this.listIn(env, `/${group}`).catch((err) => {
          // 紐付けた環境にまだフォルダが無いのは「空の置き場」（作るのは最初に保存したとき）
          if (isFolderMissing(err)) return [];
          throw err;
        });
      }),
    ];
    return (await Promise.all(reads)).flat();
  }

  /** 1つの環境の、1つのフォルダから下を読む。`env` が無ければ接続設定の環境（版を付けない）。 */
  private async listIn(env: string | undefined, secretPath: string): Promise<AliasMeta[]> {
    const read = (viewSecretValue: boolean) =>
      this.conn.secrets().listSecrets({
        ...this.conn.scopeFor(env),
        secretPath,
        recursive: true,
        viewSecretValue,
        // **参照を展開させない**——元が消えた参照の展開でしくじると一覧ごと読めなくなる
        // （「元がありません」と出すのは kit の仕事）
        expandSecretReferences: false,
      });
    let listed: Awaited<ReturnType<typeof read>>;
    try {
      listed = await read(true);
    } catch (err) {
      // **値を読む権限が無い Machine Identity でも一覧は出す**（2026-10-06、レビュー）——以前は値を読まずに
      // 一覧を出していたので、値を読むようにしただけで一覧ごと失敗させない。空かどうかは「分からない」になる
      if (!isPermissionDenied(err)) throw err;
      listed = await read(false);
    }
    const out: AliasMeta[] = [];
    for (const s of listed.secrets ?? []) {
      const backendPath = backendPathOf(secretPathOf(s.secretPath), s.secretKey, env);
      if (backendPath === undefined) continue;
      out.push(toMeta(s, backendPath));
    }
    return out;
  }

  /**
   * 1件だけ引く（注記の書き直しの前など）。**そのフォルダだけを読む**——版付きのグループの行は、
   * 引数なしの一覧には出てこないので、一覧から探すと見つからない
   */
  private async find(backendPath: string): Promise<AliasMeta | undefined> {
    const place = placeOf(backendPath);
    const listed = await this.conn.secrets().listSecrets({
      ...this.conn.scopeFor(place.env),
      secretPath: place.folder,
      viewSecretValue: false,
      expandSecretReferences: false,
    });
    const hit = (listed.secrets ?? []).find((s) => s.secretKey === place.key);
    return hit ? toMeta(hit, backendPath) : undefined;
  }

  /**
   * **値は先に置かれている前提**（`putSecret` のあとに呼ばれる）。ここは
   * その秘密に注記を付けるだけ——値には触らない。
   */
  async create(meta: AliasMeta): Promise<void> {
    await this.writeComment(meta.backendPath, stored(meta));
  }

  async update(backendPath: string, patch: AliasPatch): Promise<void> {
    const existing = await this.find(backendPath);
    if (!existing) throw new Error(`alias "${backendPath}" not found`);
    const next: Record<string, unknown> = { ...stored(existing) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    await this.writeComment(existing.backendPath, next as StoredMeta);
  }

  /** 値ごと消える（`deleteSecret` が呼ばれる）ので、**ここでやることは無い**。 */
  async delete(_backendPath: string): Promise<void> {}

  /**
   * **参照の置き場に、元を指す秘密を1つ置く**（2026-10-04）。値は Infisical の参照の
   * 書き方なので、**秘密の値ではない**（元の値は一度もここを通らない）。
   * フォルダは呼び出し側（kit）が作ってから呼ぶ。
   */
  async createLink(link: LinkAliasMeta): Promise<void> {
    const place = placeOf(link.backendPath);
    const target = this.referenceTo(link.linkTo);
    // グループのフォルダは kit が作る。**その中のフォルダはここで作る**（kit はグループしか知らない）
    if (place.subfolders.length > 0) await ensureFolders(this.conn, place);
    await this.conn.secrets().createSecret(place.key, {
      ...this.conn.scopeFor(place.env),
      secretPath: place.folder,
      secretValue: target,
      secretComment: JSON.stringify(stored(link)),
    });
  }

  /** 指す先を変える——注記と、Infisical の参照の書き方の両方を（片方だけだと食い違う）。 */
  async retargetLink(backendPath: string, linkTo: string): Promise<void> {
    const existing = await this.find(backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    const { folder, key, env } = placeOf(backendPath);
    await this.conn.secrets().updateSecret(key, {
      ...this.conn.scopeFor(env),
      secretPath: folder,
      secretValue: this.referenceTo(linkTo),
      secretComment: JSON.stringify(stored({ ...existing, linkTo })),
    });
  }

  /** 参照の秘密（元を指す書き方が入っているだけ）を消す。**元には触らない**。 */
  async deleteLink(backendPath: string): Promise<void> {
    const existing = await this.find(backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    const { folder, key, env } = placeOf(backendPath);
    await this.conn.secrets().deleteSecret(key, { ...this.conn.scopeFor(env), secretPath: folder });
  }

  /** その置き場を `${環境.フォルダ.キー}` で表せるか（kit が参照を作る前・指されている元を写す前に聞く）。 */
  async assertCanLinkTo(backendPath: string): Promise<void> {
    this.referenceTo(backendPath);
  }

  /**
   * Infisical の参照の書き方 `${環境.フォルダ.キー}`。**区切りが `.` なので、`.` を含む
   * フォルダ名・キーは指せない**——書くと別の場所を指す参照になるので、作らずに断る（規則2）
   */
  private referenceTo(linkTo: string): string {
    const { group, subfolders, key, env: variant } = placeOf(linkTo);
    // 環境は**指す先の置き場の版**（無ければ接続設定の環境、2026-10-06）
    const env = variant ?? this.conn.scope.environment;
    const parts: Array<readonly [string, string]> = [
      ["環境", env],
      ["フォルダ", group],
      ...subfolders.map((sub) => ["フォルダ", sub] as const),
      ["キー", key],
    ];
    for (const [label, part] of parts) {
      if (part.includes(".")) {
        throw new Error(
          `Infisical の参照の書き方（\${環境.フォルダ.キー}）では、"." を含む${label}名を指せません: ${part}`,
        );
      }
    }
    // サブフォルダは `.` でつなぐ（`${dev.g.sub.KEY}`——Infisical の参照の書き方）
    return `\${${parts.map(([, part]) => part).join(".")}}`;
  }

  async markUsed(backendPath: string): Promise<void> {
    const existing = await this.find(backendPath);
    if (!existing) return;
    await this.writeComment(existing.backendPath, { ...stored(existing), lastUsedAt: new Date().toISOString() });
  }

  /** 注記だけを書き換える。**値は渡さない**——渡すと上書きしてしまう。 */
  private async writeComment(backendPath: string, meta: StoredMeta): Promise<void> {
    const { folder, key, env } = placeOf(backendPath);
    await this.conn.secrets().updateSecret(key, {
      ...this.conn.scopeFor(env),
      secretPath: folder,
      secretComment: JSON.stringify(meta),
    });
  }
}

/**
 * 一覧の1件の置き場。**置き場が返ってこないなら止まる**（規則2）——黙って飛ばすと、alias が
 * 一覧から理由なく消える。SDK の型では任意だが、`recursive` の応答には必ず載る
 */
function secretPathOf(secretPath: string | undefined): string {
  if (secretPath === undefined) {
    throw new Error("Infisical の一覧に秘密の置き場（secretPath）が入っていません");
  }
  return secretPath;
}

/**
 * 一覧の1件を alias の行にする。**値は空かどうかを見るだけで、行には入れない**（2026-10-06）。
 * 値を読んでいない一覧（`find`）では空かどうかは付けない（分からないものを「空でない」と言わない）
 */
function toMeta(
  s: { secretKey: string; secretComment?: string; secretValue?: string; secretValueHidden?: boolean },
  backendPath: string,
): AliasMeta {
  const meta = parseComment(s.secretComment);
  if (meta && isLink(meta as AliasMeta)) {
    return { ...(meta as Omit<LinkAliasMeta, "backendPath">), backendPath };
  }
  const known = typeof s.secretValue === "string" && s.secretValueHidden !== true;
  return {
    // **banto の注記が無い秘密も alias として数える**（訂正・2026-09-13、ユーザー指摘）。
    // 既に Infisical をフォルダで分けて使っている人にとって、そこに在る秘密は混ざりものではなく本体。
    //
    // **中身を見て推測しない**（規則2）：種別は `secret` として扱う（鍵かどうかは読まないと分からない）。
    // 用途は Infisical 側の注記をそのまま出す。**banto は注記を書き足さない**——読むだけ
    kind: (meta && meta.kind) ?? "secret",
    note: meta?.note ?? (meta ? undefined : s.secretComment || undefined),
    lastUsedAt: meta?.lastUsedAt,
    expiresAt: meta?.expiresAt,
    // 注記に名前が無いのは、banto 以外が置いたものか、名前を書く前の形——どちらも**置き場の名前を
    // そのまま使う**（推測で直さない）。サブフォルダの秘密はグループからの相対の道（`sub/KEY`）が名前
    name: meta?.name ?? nameWithinGroup(backendPath),
    backendPath,
    ...(known && s.secretValue === "" ? { empty: true } : {}),
  };
}

/** 注記に書く形。**`empty` は書かない**——一覧を読んだときだけの印（保存すると古くなる）。 */
function stored(meta: AliasMeta): StoredMeta {
  const { backendPath: _b, empty: _e, ...rest } = meta;
  return rest as StoredMeta;
}

/** 壊れた注記を「たぶんこう」で読まない（規則2）——読めなければ alias ではない。 */
function parseComment(comment: string | undefined): StoredMeta | undefined {
  if (!comment) return undefined;
  try {
    const parsed = JSON.parse(comment) as Partial<StoredMeta>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    // **参照の注記は種別を持たない**（元から導く）——`linkTo` を落とさずに読む。
    // `kind` まで書かれていても**参照として読み、kind は捨てる**（2026-10-04、レビュー）——種別は元が正で、
    // 写しを読むと元を作り直したときに食い違う
    if (typeof parsed.linkTo === "string") {
      if (typeof parsed.name !== "string") return undefined;
      const { kind: _ignored, ...link } = parsed;
      return link as StoredMeta;
    }
    if (parsed.kind !== "secret" && parsed.kind !== "ssh-identity" && parsed.kind !== "file") return undefined;
    // **`scope` はもう見ない**（改訂・2026-09-13）——使える範囲は置き場
    // （グループ）から導くので、注記に書かれた古い `scope` は無視する。
    // 消さずに無視するだけ（規則2——推測で書き換えない）
    return parsed as StoredMeta;
  } catch {
    return undefined;
  }
}

/** 権限が無くて断られた（値を読む権限が無い等）。文言か状態符号 403 で見る。 */
function isPermissionDenied(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /StatusCode=403|permission|forbidden/i.test(message);
}
