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

export interface AliasMeta {
  name: string;
  kind: AliasKind;
  scope: "instance" | "project";
  /**
   * `scope: "project"` のとき、**どの Project のものか**（追加・2026-09-12）。
   *
   * 以前は scope だけを持っていたので、「Project のもの」とは言えても
   * **どの Project かが分からなかった**——横断管理の画面（VaultUI）は
   * 対象で絞り込めず、backend のグループも決められない。
   */
  projectId?: string;
  note?: string;
  /** backend内のパス（"group/key"）。値そのものではない。 */
  backendPath: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

/**
 * `update` に渡す差分。`undefined` は「触らない」、`null` は「消す」。
 * 名前と backend 内のパスは差し替えの対象にしない——名前が変わったら別の
 * alias、置き場が変わるのは移行（`migrateTo`）の仕事。
 */
export type AliasPatch = {
  [K in keyof Omit<AliasMeta, "name" | "backendPath">]?: AliasMeta[K] | null;
};

/** 人に見せてよい形（**backend 内のパスを外に出さない**）。 */
export type PublicAliasMeta = Omit<AliasMeta, "backendPath">;

export function toPublic(meta: AliasMeta): PublicAliasMeta {
  const { backendPath: _internal, ...rest } = meta;
  return rest;
}

/**
 * alias のメタデータの置き場。**backend ごとに実装が変わる**（上記）。
 * 値そのものは扱わない——ここが持つのは「どんな名前の何が、どこにあるか」まで。
 */
export interface AliasStore {
  /** 立ち上がりの読み込み。 */
  load(): Promise<void>;
  list(): Promise<AliasMeta[]>;
  get(name: string): Promise<AliasMeta | undefined>;
  create(meta: AliasMeta): Promise<void>;
  update(name: string, patch: AliasPatch): Promise<void>;
  delete(name: string): Promise<void>;
  markUsed(name: string): Promise<void>;
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
    this.aliases = new Map(raw.map((a) => [a.name, a]));
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

  async list(): Promise<AliasMeta[]> {
    return Array.from(this.aliases.values());
  }

  async get(name: string): Promise<AliasMeta | undefined> {
    return this.aliases.get(name);
  }

  async create(meta: AliasMeta): Promise<void> {
    if (this.aliases.has(meta.name)) throw new Error(`alias "${meta.name}" already exists`);
    this.aliases.set(meta.name, meta);
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
  async update(name: string, patch: AliasPatch): Promise<void> {
    const existing = this.aliases.get(name);
    if (!existing) throw new Error(`alias "${name}" not found`);
    const next: AliasMeta = { ...existing };
    // 差し替え可能な項目は AliasPatch が絞っているので、必須の項目は消えない
    const fields = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
    this.aliases.set(name, next);
    await this.save();
  }

  async delete(name: string): Promise<void> {
    this.aliases.delete(name);
    await this.save();
  }

  async markUsed(name: string): Promise<void> {
    const existing = this.aliases.get(name);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }
}
