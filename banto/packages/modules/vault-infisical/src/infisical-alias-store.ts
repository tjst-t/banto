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
//   秘密 `/{group}/{key}`  ← ${dev.{元のフォルダ}.{元のキー}}
//     secretComment        ← {"name":…,"linkTo":"{元のフォルダ}/{元のキー}","note":…}
//
// したがって**別の台帳ファイルを持たない**（規則3——真実は一箇所）。alias を
// 消せばメタデータも一緒に消える。ホストを増やしても同じものが見える。

import { isLink, type AliasMeta, type AliasPatch, type AliasStore, type LinkAliasMeta } from "@banto/vault-kit";
import type { InfisicalConnection } from "./client.js";

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
   * **値は取らない**（`viewSecretValue: false`）——名前と注記しか使わないのに、
   * 以前は一覧のたびに全部の値が手元に届いていた。
   *
   * 再帰で返るもののうち、alias として数えるのは**直下のフォルダの秘密だけ**
   * （以前と同じ範囲）。根に直接置かれた秘密と、フォルダの中のフォルダは
   * banto のグループではない。
   */
  async list(): Promise<AliasMeta[]> {
    const listed = await this.conn.secrets().listSecrets({
      ...this.conn.scope,
      secretPath: "/",
      recursive: true,
      viewSecretValue: false,
      // **参照を展開させない**——値は使わないうえ、元が消えた参照の展開でしくじると
      // 一覧ごと読めなくなる（「元がありません」と出すのは kit の仕事）
      expandSecretReferences: false,
    });
    const out: AliasMeta[] = [];
    for (const s of listed.secrets ?? []) {
      const group = groupOf(s.secretPath);
      if (group === undefined) continue;
      const meta = parseComment(s.secretComment);
      if (meta && isLink(meta as AliasMeta)) {
        out.push({ ...(meta as Omit<LinkAliasMeta, "backendPath">), backendPath: `${group}/${s.secretKey}` });
        continue;
      }
      out.push({
        // **banto の注記が無い秘密も alias として数える**（訂正・2026-09-13、
        // ユーザー指摘）。当初は「人が別の用途で置いた秘密が混ざる」として
        // 飛ばしていたが、**その前提が逆だった**——既に Infisical をフォルダで
        // 分けて使っている人にとって、そこに在る秘密は混ざりものではなく本体。
        //
        // **中身を見て推測しない**（規則2）：種別は `secret` として扱う
        // （鍵かどうかは読まないと分からない）。用途は Infisical 側の注記を
        // そのまま出す。**banto は注記を書き足さない**——読むだけで、
        // 人の秘密に勝手に印を付けない
        kind: (meta && meta.kind) ?? "secret",
        note: meta?.note ?? (meta ? undefined : s.secretComment || undefined),
        lastUsedAt: meta?.lastUsedAt,
        expiresAt: meta?.expiresAt,
        // 注記に名前が無いのは、banto 以外が置いたものか、名前を書く前の形
        // ——どちらも**置き場の名前をそのまま使う**（推測で直さない）
        name: meta?.name ?? s.secretKey,
        backendPath: `${group}/${s.secretKey}`,
      });
    }
    return out;
  }

  /**
   * **値は先に置かれている前提**（`putSecret` のあとに呼ばれる）。ここは
   * その秘密に注記を付けるだけ——値には触らない。
   */
  async create(meta: AliasMeta): Promise<void> {
    await this.writeComment(meta.backendPath, stored(meta));
  }

  async update(backendPath: string, patch: AliasPatch): Promise<void> {
    const existing = (await this.list()).find((a) => a.backendPath === backendPath);
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
    const { group, key } = split(link.backendPath);
    await this.conn.secrets().createSecret(key, {
      ...this.conn.scope,
      secretPath: `/${group}`,
      secretValue: this.referenceTo(link.linkTo),
      secretComment: JSON.stringify(stored(link)),
    });
  }

  /** 指す先を変える——注記と、Infisical の参照の書き方の両方を（片方だけだと食い違う）。 */
  async retargetLink(backendPath: string, linkTo: string): Promise<void> {
    const existing = (await this.list()).find((a) => a.backendPath === backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    const { group, key } = split(backendPath);
    await this.conn.secrets().updateSecret(key, {
      ...this.conn.scope,
      secretPath: `/${group}`,
      secretValue: this.referenceTo(linkTo),
      secretComment: JSON.stringify(stored({ ...existing, linkTo })),
    });
  }

  /** 参照の秘密（元を指す書き方が入っているだけ）を消す。**元には触らない**。 */
  async deleteLink(backendPath: string): Promise<void> {
    const existing = (await this.list()).find((a) => a.backendPath === backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    const { group, key } = split(backendPath);
    await this.conn.secrets().deleteSecret(key, { ...this.conn.scope, secretPath: `/${group}` });
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
    const { group, key } = split(linkTo);
    const env = this.conn.scope.environment;
    for (const [label, part] of [["環境", env], ["フォルダ", group], ["キー", key]] as const) {
      if (part.includes(".")) {
        throw new Error(
          `Infisical の参照の書き方（\${環境.フォルダ.キー}）では、"." を含む${label}名を指せません: ${part}`,
        );
      }
    }
    return `\${${env}.${group}.${key}}`;
  }

  async markUsed(backendPath: string): Promise<void> {
    const existing = (await this.list()).find((a) => a.backendPath === backendPath);
    if (!existing) return;
    await this.writeComment(existing.backendPath, { ...stored(existing), lastUsedAt: new Date().toISOString() });
  }

  /** 注記だけを書き換える。**値は渡さない**——渡すと上書きしてしまう。 */
  private async writeComment(backendPath: string, meta: StoredMeta): Promise<void> {
    const { group, key } = split(backendPath);
    await this.conn.secrets().updateSecret(key, {
      ...this.conn.scope,
      secretPath: `/${group}`,
      secretComment: JSON.stringify(meta),
    });
  }
}

/**
 * 秘密の置き場（`/group`）からグループ名を取る。直下のフォルダでなければ無い。
 *
 * **置き場が返ってこないなら止まる**（規則2）——黙って飛ばすと、alias が
 * 一覧から理由なく消える。SDK の型では任意だが、`recursive` の応答には必ず載る
 */
function groupOf(secretPath: string | undefined): string | undefined {
  if (secretPath === undefined) {
    throw new Error("Infisical の一覧に秘密の置き場（secretPath）が入っていません");
  }
  const m = /^\/([^/]+)\/?$/.exec(secretPath);
  return m ? m[1] : undefined;
}

function split(backendPath: string): { group: string; key: string } {
  const idx = backendPath.indexOf("/");
  return { group: backendPath.slice(0, idx), key: backendPath.slice(idx + 1) };
}

function stored(meta: AliasMeta): StoredMeta {
  const { backendPath: _b, ...rest } = meta;
  return rest;
}

/** 壊れた注記を「たぶんこう」で読まない（規則2）——読めなければ alias ではない。 */
function parseComment(comment: string | undefined): StoredMeta | undefined {
  if (!comment) return undefined;
  try {
    const parsed = JSON.parse(comment) as Partial<StoredMeta>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    // **参照の注記は種別を持たない**（元から導く）——`linkTo` を落とさずに読む
    if (typeof parsed.linkTo === "string" && parsed.kind === undefined) {
      return typeof parsed.name === "string" ? (parsed as StoredMeta) : undefined;
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
