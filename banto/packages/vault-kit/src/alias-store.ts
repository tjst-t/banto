// alias のメタデータ（kind/scope/note/expiresAt/lastUsedAt）は値と分離して持つ
// ——値を復号せずに読める必要がある（docs/specs/v4-modules.md §2.1 D節）。
//
// **置き場は backend が選ぶ**（決定・2026-09-12、Infisical を作って分かった）。
// 組み込み（SOPS）は banto がメタデータの持ち方を決められるのでローカルの
// ファイルでよい。しかし **Infisical のように「複数台のホストが同じ backend を
// 共有する」ことが眼目の backend では、メタデータをローカルに置くと共有が
// 半分しか成立しない**——2台目からは値はあるのに名前も用途も分からない
// （仕様 §2.1「Project ↔ backend グループの紐付け」が想定している形が崩れる）。
// Infisical は秘密に注記（`secretComment`）を付けられるので、そちらへ置く。
//
// **だから読み書きは非同期にする。** 遠くにある置き場を同期では読めない。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AliasKind } from "./backend.js";

interface AliasCommon {
  name: string;
  /**
   * **`scope` / `projectId` は持たない**（訂正・2026-09-13、ユーザー指摘）。
   *
   * 「誰が使えるか」を**2箇所**に持っていた——alias の `scope` と、実際に
   * 置かれているグループ（`backendPath`）。すでに食い違っていた：
   * `generateKeypair` は `scope` を無視して `ssh-identities` に置くので、
   * `scope: "instance"` の鍵が共通グループに居ない。
   *
   * **グループが唯一の真実**（規則3）。`scope` は `group-bindings` から
   * 導出する（`scopeOf`）——共通グループなら「どこからでも」、Project に
   * 紐付いたグループならその Project、どちらでもなければ「誰も使えない」。
   */
  note?: string;
  /** backend内のパス（"group/key"）。値そのものではない。 */
  backendPath: string;
  /**
   * **持ち主**（追加・2026-10-06、仕様 §2.1 C節「banto が置く秘密の持ち主」）。banto が置く秘密（種別 `oauth-token`）を
   * `putSecret` で新しく置いた Module の宣言の名前（host が刻んだ呼び元の Module）。置き換えは持ち主と同じ Module からだけ。
   * 人が預けた秘密・参照には付かない。**記録が無いもの**（この記録を始める前に置かれたもの・Module を介さずに置かれたもの）は、
   * 次に置き換えた Module が持ち主になる
   */
  owner?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  /**
   * **値を最後に置き換えた日時**（追加・2026-10-07、仕様 §2.1 C節 `replaceSecretValue`）。人が管理画面から値を変えたときだけ
   * 書く。値の中身の履歴は持たない。作ったときは付けない（作った日時ではない——付いていなければ「置き換えていない」）
   */
  valueUpdatedAt?: string;
  /**
   * **値が空と分かっている**（一覧を読んだときだけ付く、保存しない。2026-10-06）。台帳が値を知らない
   * backend（SOPS）は付けない——「付いていない」は「空でない」ではなく「分からない」
   */
  empty?: boolean;
}

/** 値を持つ秘密（ふつうの alias）。 */
export interface SecretAliasMeta extends AliasCommon {
  kind: AliasKind;
  linkTo?: undefined;
}

/**
 * **参照**（決定・2026-10-04、ユーザー。仕様 §2.1 C節「参照」）。
 *
 * 同じ Vault の別の置き場の秘密を、**値を写さずに**この置き場から使えるようにする行。
 * `linkTo` は元の `backendPath`。**種別は持たない**——元から導く（規則3。写すと、元を
 * 作り直したときに食い違う）。誰が使えるかは**この行の置き場**で決まる。
 */
export interface LinkAliasMeta extends AliasCommon {
  linkTo: string;
  kind?: undefined;
}

export type AliasMeta = SecretAliasMeta | LinkAliasMeta;

export function isLink(meta: AliasMeta): meta is LinkAliasMeta {
  return typeof meta.linkTo === "string";
}

/**
 * `update` に渡す差分。`undefined` は「触らない」、`null` は「消す」。
 * 名前と backend 内のパスは差し替えの対象にしない——名前が変わったら別の
 * alias、置き場が変わるのは移行（`migrateTo`）の仕事。種別と参照の指す先も
 * ここでは変えない（指す先は `retargetLink`）。
 */
export type AliasPatch = {
  [K in keyof Omit<AliasCommon, "name" | "backendPath">]?: AliasCommon[K] | null;
};

/**
 * 人に見せてよい形（**backend 内のパスを外に出さない**）。参照の `linkTo` も
 * backend 内のパスなので落とす——見せる形（グループと名前）は kit が元から導いて足す。
 */
export type PublicAliasMeta = Omit<AliasCommon, "backendPath"> & { kind?: AliasKind };

export function toPublic(meta: AliasMeta): PublicAliasMeta {
  const { backendPath: _internal, linkTo: _link, ...rest } = meta;
  return rest;
}

/**
 * alias のメタデータの置き場。**backend ごとに実装が変わる**（上記）。
 * 値そのものは扱わない——ここが持つのは「どんな名前の何が、どこにあるか」まで。
 */
/**
 * alias の**鍵は置き場**（`backendPath`）（改訂・2026-09-13）。
 *
 * 以前は名前を鍵にしていたが、**名前だけでは一意にならなくなった**
 * ——同じ名前が「共通」と「その Project」の両方に在るのは正しい状態で、
 * 素の名前と修飾名で引き分ける（§2.1）。名前から1つに決めるのは kit の仕事
 * （呼び出し元の Project が要る）で、置き場の管理はここの仕事。
 */
export interface AliasListOptions {
  alsoGroups?: readonly string[];
}

export interface AliasStore {
  /** 立ち上がりの読み込み。 */
  load(): Promise<void>;
  /**
   * `alsoGroups`：**一覧に含めてほしい版付きのグループ**（`<グループ>@<版>`、2026-10-06）。kit が台帳の
   * 紐付けから渡す。版を名乗らない backend は無視してよい。版付きの行の backendPath は渡された
   * グループ名そのままで始める（`g@prod/KEY`）
   */
  list(opts?: AliasListOptions): Promise<AliasMeta[]>;
  create(meta: SecretAliasMeta): Promise<void>;
  update(backendPath: string, patch: AliasPatch): Promise<void>;
  delete(backendPath: string): Promise<void>;
  markUsed(backendPath: string): Promise<void>;
  /**
   * **参照を置く**（追加・2026-10-04）。値は写さない。**持ち方は backend ごと**なので、
   * ここに口を置く——組み込みは台帳に行を足すだけ、Infisical は参照の置き場に
   * 「元を指す秘密」を1つ置く（台帳がフォルダの秘密とその注記だから）。
   * 置き場が空いていることは呼び出し側（kit）が確かめてから呼ぶ。
   */
  createLink(link: LinkAliasMeta): Promise<void>;
  /** 参照の指す先を変える（元が同じ Vault の中で動いたとき）。 */
  retargetLink(backendPath: string, linkTo: string): Promise<void>;
  /** **参照だけ**を消す。元には触らない。 */
  deleteLink(backendPath: string): Promise<void>;
  /**
   * **その置き場を参照で指せるか**（追加・2026-10-04、レビュー）。指せなければ理由つきで投げる。
   * 参照の書き方に制約がある backend（Infisical は `.` を区切りに使う）のため——kit は参照を作る前と、
   * 指されている元を移す（写す）前に聞く。後から断られると、空のグループや2か所の元が残る。
   * 制約の無い backend は何もしない。
   */
  assertCanLinkTo(backendPath: string): Promise<void>;
}

/**
 * banto が自分で持つ置き場（組み込み Vault 向け）。
 * **1台のホストの中でしか見えない**——共有したい backend はこれを使わない。
 */
export class LocalFileAliasStore implements AliasStore {
  private readonly filePath: string;
  private aliases = new Map<string, AliasMeta>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "aliases.json");
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(await readFile(this.filePath, "utf8")) as AliasMeta[];
    this.aliases = new Map(raw.map((a) => [a.backendPath, a]));
  }

  /**
   * **書きかけを残さない**（改訂・2026-09-12）。`writeFile` で直接上書きすると、
   * 途中で落ちたときに**中途半端な JSON が残って、次の起動で alias 一覧を
   * 丸ごと失う**——値は backend に残っているのに、それを指す名前が消える
   * （どの秘密がどれだか分からなくなる）。tmp → rename で置き換える。
   *
   * 書き込み自体も1本に並べる。同時に2つの admin 操作が来ると、後から書いた
   * ほうが前の変更を消す（sops-backend の `withGroupLock` と同じ理由）。
   */
  private async save(): Promise<void> {
    const write = this.saveChain.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    this.saveChain = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(Array.from(this.aliases.values())), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  async list(_opts?: AliasListOptions): Promise<AliasMeta[]> {
    return Array.from(this.aliases.values());
  }

  async create(meta: SecretAliasMeta): Promise<void> {
    await this.add(meta);
  }

  /** **秘密は置かない**——台帳に「この置き場は元を指す」の行があるだけ。 */
  async createLink(link: LinkAliasMeta): Promise<void> {
    await this.add(link);
  }

  /** 台帳に書くだけなので、どこでも指せる。 */
  async assertCanLinkTo(_backendPath: string): Promise<void> {}

  async retargetLink(backendPath: string, linkTo: string): Promise<void> {
    const existing = this.aliases.get(backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    this.aliases.set(backendPath, { ...existing, linkTo });
    await this.save();
  }

  async deleteLink(backendPath: string): Promise<void> {
    const existing = this.aliases.get(backendPath);
    if (!existing || !isLink(existing)) throw new Error(`"${backendPath}" は参照ではありません`);
    await this.delete(backendPath);
  }

  private async add(meta: AliasMeta): Promise<void> {
    if (this.aliases.has(meta.backendPath)) {
      throw new Error(`"${meta.backendPath}" には既に別の秘密があります`);
    }
    this.aliases.set(meta.backendPath, meta);
    await this.save();
  }

  /**
   * **渡された項目だけを変える。** 素の spread だと、呼び出し元が触るつもりの
   * 無い項目に `undefined` が入っていただけで**既にある値が消える**
   * （`note` を変えたいだけの呼び出しで `projectId` が飛ぶ）。
   *
   * **消したいときは `null`**——「触らない」と「空にする」は別の意思なので、
   * 同じ `undefined` で表さない（規則2）。
   */
  async update(backendPath: string, patch: AliasPatch): Promise<void> {
    const existing = this.aliases.get(backendPath);
    if (!existing) throw new Error(`alias "${backendPath}" not found`);
    const next: AliasMeta = { ...existing };
    // 差し替え可能な項目は AliasPatch が絞っているので、必須の項目は消えない
    const fields = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
    this.aliases.set(backendPath, next);
    await this.save();
  }

  async delete(backendPath: string): Promise<void> {
    this.aliases.delete(backendPath);
    await this.save();
  }

  async markUsed(backendPath: string): Promise<void> {
    const existing = this.aliases.get(backendPath);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }
}
