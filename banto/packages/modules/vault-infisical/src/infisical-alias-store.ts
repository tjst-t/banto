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
// したがって**別の台帳ファイルを持たない**（規則3——真実は一箇所）。alias を
// 消せばメタデータも一緒に消える。ホストを増やしても同じものが見える。

import type { AliasMeta, AliasPatch, AliasStore } from "@banto/vault-kit";
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
type StoredMeta = Omit<AliasMeta, "backendPath">;

export class InfisicalAliasStore implements AliasStore {
  constructor(private readonly conn: InfisicalConnection) {}

  /** 遠くにあるので、立ち上がりで読み込むものは無い。 */
  async load(): Promise<void> {}

  /**
   * 全フォルダの秘密を、**注記つきで**列挙する。
   *
   * **写しを持たない**（規則3）——手元に貯めると、別のホストが変えたときに
   * 古いものを見せることになる。共有できることが眼目なので、毎回聞く。
   */
  async list(): Promise<AliasMeta[]> {
    const folders = await this.conn.folders().listFolders({ ...this.conn.scope, path: "/" });
    const out: AliasMeta[] = [];
    for (const folder of folders) {
      const listed = await this.conn
        .secrets()
        .listSecrets({ ...this.conn.scope, secretPath: `/${folder.name}` });
      for (const s of listed.secrets ?? []) {
        const meta = parseComment(s.secretComment);
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
          kind: meta?.kind ?? "secret",
          note: meta?.note ?? (meta ? undefined : s.secretComment || undefined),
          lastUsedAt: meta?.lastUsedAt,
          expiresAt: meta?.expiresAt,
          // 注記に名前が無いのは、banto 以外が置いたものか、名前を書く前の形
          // ——どちらも**置き場の名前をそのまま使う**（推測で直さない）
          name: meta?.name ?? s.secretKey,
          backendPath: `${folder.name}/${s.secretKey}`,
        });
      }
    }
    return out;
  }

  async get(name: string): Promise<AliasMeta | undefined> {
    return (await this.list()).find((a) => a.name === name);
  }

  /**
   * **値は先に置かれている前提**（`putSecret` のあとに呼ばれる）。ここは
   * その秘密に注記を付けるだけ——値には触らない。
   */
  async create(meta: AliasMeta): Promise<void> {
    await this.writeComment(meta.backendPath, stored(meta));
  }

  async update(name: string, patch: AliasPatch): Promise<void> {
    const existing = await this.get(name);
    if (!existing) throw new Error(`alias "${name}" not found`);
    const next: Record<string, unknown> = { ...stored(existing) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    await this.writeComment(existing.backendPath, next as StoredMeta);
  }

  /** 値ごと消える（`deleteSecret` が呼ばれる）ので、**ここでやることは無い**。 */
  async delete(_name: string): Promise<void> {}

  async markUsed(name: string): Promise<void> {
    const existing = await this.get(name);
    if (!existing) return;
    await this.writeComment(existing.backendPath, { ...stored(existing), lastUsedAt: new Date().toISOString() });
  }

  /** 注記だけを書き換える。**値は渡さない**——渡すと上書きしてしまう。 */
  private async writeComment(backendPath: string, meta: StoredMeta): Promise<void> {
    const idx = backendPath.indexOf("/");
    const group = backendPath.slice(0, idx);
    const key = backendPath.slice(idx + 1);
    await this.conn.secrets().updateSecret(key, {
      ...this.conn.scope,
      secretPath: `/${group}`,
      secretComment: JSON.stringify(meta),
    });
  }
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
    if (parsed.kind !== "secret" && parsed.kind !== "ssh-identity" && parsed.kind !== "file") return undefined;
    // **`scope` はもう見ない**（改訂・2026-09-13）——使える範囲は置き場
    // （グループ）から導くので、注記に書かれた古い `scope` は無視する。
    // 消さずに無視するだけ（規則2——推測で書き換えない）
    return parsed as StoredMeta;
  } catch {
    return undefined;
  }
}
