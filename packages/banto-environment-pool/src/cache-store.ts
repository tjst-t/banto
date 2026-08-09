/**
 * 環境より長生きする置き場の帳簿と掃除（`spec-environment` §5.2・PO裁定 2026-08-08）。
 *
 * **上限の仕組みが先**という条件で採った決めなので、ここが機構そのもの。
 * 置き場を作る側（ドライバ）ではなく**数える側**に上限を置く——ドライバごとに上限を
 * 書かせると、書き忘れたドライバから漏れる。
 *
 * 分担：
 *   - **在るかどうかはドライバが真**（`cache-list`）。§5 の照合と同じ向き
 *   - **最後に使った時刻は台帳が持つ**。ボリュームに「最後に使った」は無いので導出できない
 *   - 台帳に無い置き場は「時刻が分からない」＝**最初に落とす**
 *
 * D3: 鍵の一覧を台帳の真実にしない（ドライバが真）。台帳が持つのは導出できない時刻だけ。
 * D6: node:crypto / node:fs / node:path のみ。
 * I2: 消せなかったことを黙らせない。理由を呼び出し側へ返す。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 台帳の1件。**鍵ごとに1つ**。 */
export interface CacheUseRecord {
  /** 置き場の鍵（内容から作ったハッシュ）。 */
  key: string;
  /** どのドライバが持っているか。掃除はドライバごとに回すので要る。 */
  driver: string;
  /** どのプロファイル由来か（人が読むため。掃除の判断には使わない）。 */
  profile: string;
  /** 最後に使った時刻（ISO-8601）。LRU の並べ替えはこれで決まる。 */
  lastUsedAt: string;
}

/** ドライバが `cache-list` で返す1件。 */
export interface DriverCacheEntry {
  key: string;
  sizeBytes?: number;
}

/** 掃除の結果。呼び出し側が出来事として残す。 */
export interface SweepResult {
  removed: string[];
  /** 消せなかったもの（I2: 黙らせない）。 */
  failed: Array<{ key: string; reason: string }>;
  /** 消さずに残した数。 */
  kept: number;
}

/**
 * 置き場の鍵を作る。
 *
 * **ドライバ名とプロファイル名を必ず混ぜる**——同じ `package-lock.json` でも、別の
 * プロファイル（別の土台イメージ）で作った `node_modules` は別物。ここを混ぜないと
 * 衝突して、片方が他方のバイナリを掴む。
 *
 * **それ以外に混ぜるのは、プロファイルが `cache.key` に挙げたファイルの中身だけ。**
 * ブランチ名・タスクID・時刻は混ぜない（混ぜた瞬間に鍵の意味が消える）。
 *
 * @param files 中身を決めるファイル（絶対パス）。読めないものがあれば undefined を返す
 *   ——**鍵の一部が欠けたまま作らない**。欠けた鍵は「別のものを同じ鍵で指す」ことになる
 */
export function computeCacheKey(opts: {
  driver: string;
  profile: string;
  files: readonly string[];
}): { ok: true; key: string } | { ok: false; reason: string } {
  const hash = crypto.createHash("sha256");
  hash.update(`driver:${opts.driver}\nprofile:${opts.profile}\n`);
  for (const file of opts.files) {
    let content: Buffer;
    try {
      content = fs.readFileSync(file);
    } catch (err) {
      // I2: 読めないものを空として混ぜない。鍵が壊れるより、置き場を使わない方がよい
      return {
        ok: false,
        reason: `cache.key に挙げた ${file} が読めません（${err instanceof Error ? err.message : String(err)}）`,
      };
    }
    hash.update(`file:${path.basename(file)}:${content.length}\n`);
    hash.update(content);
  }
  return { ok: true, key: hash.digest("hex").slice(0, 32) };
}

/**
 * 置き場の台帳。`<dataDir>/env-cache.json` に丸ごと書く（`env-ledger.json` と同じ作法）。
 *
 * 件数は上限（既定8）で抑えるので、丸ごと書き換えても大きくならない。
 */
export class CacheLedger {
  private readonly file: string;
  private records = new Map<string, CacheUseRecord>();
  /** 読み込みで落とした件（I2: 黙って捨てない）。 */
  readonly loadWarnings: string[] = [];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "env-cache.json");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      const entries = (raw as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const rec = entry as Partial<CacheUseRecord>;
        if (
          typeof rec.key !== "string" ||
          typeof rec.driver !== "string" ||
          typeof rec.lastUsedAt !== "string"
        ) {
          this.loadWarnings.push(`env-cache.json に壊れた行があります（飛ばしました）`);
          continue;
        }
        this.records.set(rec.key, {
          key: rec.key,
          driver: rec.driver,
          profile: typeof rec.profile === "string" ? rec.profile : "(不明)",
          lastUsedAt: rec.lastUsedAt,
        });
      }
    } catch (err) {
      // I2: 壊れていても動く。ただし黙らない——時刻が分からない置き場は先に落ちるだけ
      this.loadWarnings.push(
        `env-cache.json を読めませんでした（空として続けます）: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private save(): void {
    const json = JSON.stringify({ entries: [...this.records.values()] }, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, json, "utf-8");
    fs.renameSync(tmp, this.file);
  }

  /** 使ったことを記録する（LRU の基準を進める）。 */
  touch(rec: Omit<CacheUseRecord, "lastUsedAt">, now = new Date()): void {
    this.records.set(rec.key, { ...rec, lastUsedAt: now.toISOString() });
    this.save();
  }

  forget(keys: readonly string[]): void {
    let changed = false;
    for (const key of keys) changed = this.records.delete(key) || changed;
    if (changed) this.save();
  }

  get(key: string): CacheUseRecord | undefined {
    return this.records.get(key);
  }

  list(): CacheUseRecord[] {
    return [...this.records.values()];
  }
}

/**
 * 落とすものを決める（`spec-environment` §5.2.3）。
 *
 * **在るかどうかはドライバが真**なので、判断の材料はドライバの一覧。台帳は時刻を添えるだけ。
 * 台帳に無い＝時刻が分からないものは、**最初に落とす**（いつ使われたか言えないものを
 * 抱え続ける理由が無い）。
 *
 * @param keep 消してはいけない鍵（いま使っている置き場）。**使用中を落とさない**
 */
export function planSweep(opts: {
  present: readonly DriverCacheEntry[];
  ledger: CacheLedger;
  maxEntries: number;
  maxAgeMs: number;
  keep?: string | undefined;
  now?: number;
}): { remove: string[]; kept: number } {
  const now = opts.now ?? Date.now();
  const scored = opts.present.map((entry) => {
    const rec = opts.ledger.get(entry.key);
    const at = rec ? Date.parse(rec.lastUsedAt) : Number.NaN;
    return { key: entry.key, lastUsed: Number.isNaN(at) ? -Infinity : at };
  });

  const remove = new Set<string>();

  // ① 古すぎるもの。時刻が分からないものはここでは落とさない（②の並びで落ちる）
  for (const item of scored) {
    if (item.lastUsed !== -Infinity && now - item.lastUsed > opts.maxAgeMs) remove.add(item.key);
  }

  // ② 件数の上限。**新しい順に残す**。時刻が分からないものは末尾＝先に落ちる
  const survivors = scored
    .filter((item) => !remove.has(item.key))
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const item of survivors.slice(Math.max(0, opts.maxEntries))) remove.add(item.key);

  // 使用中のものは落とさない。**いま立てた環境の足元を外さない**
  if (opts.keep !== undefined) remove.delete(opts.keep);

  return { remove: [...remove], kept: opts.present.length - remove.size };
}
