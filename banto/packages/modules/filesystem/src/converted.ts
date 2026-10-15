// **変換したものの置き場**（決定・2026-10-15、`docs/specs/v4-modules.md` §2.2「PDF・Office のファイルを読んでコメントを返す」、
// Backlog #304）。
//
// Office の文書を PDF にしたもの・表を計算し直したものは、変換役（banto 全体の Module `documents`、道具用のコンテナで
// LibreOffice）に中継で頼み、ここ（**Project ごとの Module の置き場** `BANTO_MODULE_DATA_DIR/converted/`）に残す。
//
// - **鍵は 中身の sha256・変換役の版・フォント一式の印・何にしたか**。同じ中身なら変換し直さない。日本語フォントを足すと
//   印が変わり、作り直す
// - **Project ごとに合計 1GiB**。超えたら使っていない（更新時刻の古い）ものから消す。使うたびに更新時刻を進める
// - **写しはパスで指させない**——画面は元のファイルのパス＋`converted` で読み（`readFileRange`）、ここが鍵を引き直す。
//   根の確かめを緩めない・置き場を晒さない
// - 変換役に渡せるのは 7MB まで（Module の stdio は1通 10MB——base64 で収まる大きさ）

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** 変換役に渡せる大きさ（documents の上限と同じ） */
export const CONVERT_MAX_BYTES = 7 * 1024 * 1024;
export const TOO_LARGE_MESSAGE = "大きすぎて変換できません（7MB まで）";
/** Project ごとの置き場の上限 */
export const CONVERTED_LIMIT_BYTES = 1024 ** 3;

/** 何にするか：PDF か、計算し直した表（xlsx） */
export type ConvertTarget = "pdf" | "spreadsheet";

export const SPREADSHEET_EXTENSIONS = ["xlsx", "xlsm", "xls", "ods"] as const;
export const CONVERTIBLE_EXTENSIONS = ["docx", "doc", "odt", "pptx", "ppt", "odp", ...SPREADSHEET_EXTENSIONS] as const;
/** document の画面で描く Office の文書（docx は docx-preview でも、それ以外は変換役で PDF にして）。表は別の画面（#306） */
export const DOCUMENT_CONVERTED_EXTENSIONS = ["docx", "doc", "odt", "pptx", "ppt", "odp"] as const;

export interface ConverterDescriptor {
  version: string;
  fonts: string;
}

/** 変換役（中継の向こうの `documents`）。試験では偽物 */
export interface Converter {
  describe(): Promise<ConverterDescriptor>;
  convert(target: ConvertTarget, extension: string, data: Buffer): Promise<{ data: Buffer; converter: ConverterDescriptor; ms: number }>;
}

/**
 * **変換役を用意している途中**（初めて使うときは LibreOffice を入れるので数分）。壊れているのではない——画面は
 * これを出して待ち、あとで頼み直す
 */
export class ConverterPreparingError extends Error {}

export function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

/** 拡張子から決まる、既定の変換（表は計算し直し、それ以外は PDF） */
export function defaultTarget(extension: string): ConvertTarget {
  return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(extension) ? "spreadsheet" : "pdf";
}

/** その拡張子をその形にできるか。できなければ理由 */
export function whyNotConvertible(extension: string, target: ConvertTarget): string | undefined {
  const ok = target === "pdf" ? (CONVERTIBLE_EXTENSIONS as readonly string[]) : (SPREADSHEET_EXTENSIONS as readonly string[]);
  if (ok.includes(extension)) return undefined;
  return `${extension || "拡張子の無いファイル"} は${target === "pdf" ? " PDF にできません" : "計算し直せません"}（${ok.join("・")} だけ）`;
}

export function cacheKey(fileHash: string, target: ConvertTarget, converter: ConverterDescriptor): string {
  return createHash("sha256").update([fileHash, target, converter.version, converter.fonts].join("\n")).digest("hex");
}

/** 変換役の版と印を覚えるファイル（置き場の中。消す対象に数えない） */
const DESCRIPTOR_FILE = "converter.json";

const fileExtensionOf = (target: ConvertTarget) => (target === "pdf" ? "pdf" : "xlsx");

/** 置き場（鍵 → ファイル）。ファイル名は鍵と形から決まる——別の索引を持たない（規則3） */
export class ConvertedStore {
  constructor(
    private readonly dir: string,
    private readonly limitBytes = CONVERTED_LIMIT_BYTES,
  ) {}

  pathFor(key: string, target: ConvertTarget): string {
    return join(this.dir, `${key}.${fileExtensionOf(target)}`);
  }

  /** あればそのパス（使ったので更新時刻を進める） */
  async find(key: string, target: ConvertTarget): Promise<string | undefined> {
    const p = this.pathFor(key, target);
    try {
      const now = new Date();
      await utimes(p, now, now);
      return p;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** 最後に聞いた変換役の版と印（無ければ undefined） */
  async loadDescriptor(): Promise<ConverterDescriptor | undefined> {
    try {
      const d = JSON.parse(await readFile(join(this.dir, DESCRIPTOR_FILE), "utf8")) as Partial<ConverterDescriptor>;
      return typeof d.version === "string" && typeof d.fonts === "string" ? { version: d.version, fonts: d.fonts } : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || err instanceof SyntaxError) return undefined;
      throw err;
    }
  }

  async saveDescriptor(d: ConverterDescriptor): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, DESCRIPTOR_FILE);
    await writeFile(`${p}.tmp`, JSON.stringify(d), { mode: 0o600 });
    await rename(`${p}.tmp`, p);
  }

  async put(key: string, target: ConvertTarget, data: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const p = this.pathFor(key, target);
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
    await this.evict(p);
    return p;
  }

  /** 合計が上限を超えていたら、更新時刻の古いものから消す（いま置いたものは残す） */
  private async evict(keep: string): Promise<void> {
    const names = await readdir(this.dir);
    const files = (
      await Promise.all(
        names
          .filter((n) => !n.endsWith(".tmp") && n !== DESCRIPTOR_FILE)
          .map(async (n) => {
            const p = join(this.dir, n);
            const s = await stat(p).catch(() => undefined);
            return s?.isFile() ? { p, size: s.size, mtimeMs: s.mtimeMs } : undefined;
          }),
      )
    ).filter((f): f is { p: string; size: number; mtimeMs: number } => f !== undefined);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.limitBytes) break;
      if (f.p === keep) continue;
      await rm(f.p, { force: true });
      total -= f.size;
    }
  }
}

/** ファイルの中身の sha256（流して数える） */
async function sha256Of(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type ConvertOutcome =
  | { status: "converted"; target: ConvertTarget; mimeType: string; bytes: number; cached: boolean; ms?: number }
  | { status: "preparing"; message: string };

/**
 * **変換を頼み、置き場に残す・置き場から引く**。変換役の版とフォントの印は最初に1回聞き、変換の返事に違う印が来たら
 * 覚え直す（変換役が入れ直された）
 */
export class DocumentConversions {
  private descriptor: ConverterDescriptor | undefined;
  /** 中身のハッシュ（パス・大きさ・更新時刻が同じ間は数え直さない。`readFileRange` は何度も呼ばれる） */
  private readonly hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

  constructor(
    private readonly store: ConvertedStore,
    private readonly converter: Converter | undefined,
  ) {}

  private async hashOf(absPath: string): Promise<{ hash: string }> {
    const s = await stat(absPath);
    if (!s.isFile()) throw new Error("ファイルではありません");
    const memo = this.hashes.get(absPath);
    if (memo && memo.size === s.size && memo.mtimeMs === s.mtimeMs) return { hash: memo.hash };
    const hash = await sha256Of(absPath);
    this.hashes.set(absPath, { size: s.size, mtimeMs: s.mtimeMs, hash });
    return { hash };
  }

  private need(): Converter {
    if (!this.converter) throw new Error("変換役に繋がっていません（banto の中継が渡されていません）");
    return this.converter;
  }

  /**
   * 変換役の版と印。**最後に聞いたものを置き場にも覚える**——banto を起こし直した後、変換したものを読むだけのために
   * 変換役（道具用のコンテナ）を起こさない。変換の返事に違う印が来たら覚え直す
   */
  private async currentDescriptor(): Promise<ConverterDescriptor> {
    if (this.descriptor) return this.descriptor;
    const saved = await this.store.loadDescriptor();
    if (saved) return (this.descriptor = saved);
    const fresh = await this.need().describe();
    await this.remember(fresh);
    return fresh;
  }

  private async remember(d: ConverterDescriptor): Promise<void> {
    if (this.descriptor?.version === d.version && this.descriptor.fonts === d.fonts) return;
    this.descriptor = d;
    await this.store.saveDescriptor(d);
  }

  /** 変換する（同じ中身・同じ変換役なら置き場のものを使う）。変換役を用意している途中なら `preparing` */
  async convert(absPath: string, target: ConvertTarget): Promise<ConvertOutcome> {
    const extension = extensionOf(absPath);
    const refused = whyNotConvertible(extension, target);
    if (refused) throw new Error(refused);
    // 大きすぎるものは中身を数える前に断る
    if ((await stat(absPath)).size > CONVERT_MAX_BYTES) throw new Error(TOO_LARGE_MESSAGE);
    const { hash } = await this.hashOf(absPath);
    const mimeType = target === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    try {
      const found = await this.store.find(cacheKey(hash, target, await this.currentDescriptor()), target);
      if (found) return { status: "converted", target, mimeType, bytes: (await stat(found)).size, cached: true };
      const r = await this.need().convert(target, extension, await readFile(absPath));
      await this.remember(r.converter);
      await this.store.put(cacheKey(hash, target, r.converter), target, r.data);
      return { status: "converted", target, mimeType, bytes: r.data.length, cached: false, ms: r.ms };
    } catch (err) {
      if (err instanceof ConverterPreparingError) return { status: "preparing", message: err.message };
      throw err;
    }
  }

  /** 変換したもののパス（置き場の中）。まだ変換していなければ理由つきで投げる——ここでは変換しない */
  async convertedPath(absPath: string, target: ConvertTarget): Promise<string> {
    const refused = whyNotConvertible(extensionOf(absPath), target);
    if (refused) throw new Error(refused);
    const { hash } = await this.hashOf(absPath);
    const descriptor = this.descriptor ?? (await this.store.loadDescriptor());
    const found = descriptor ? await this.store.find(cacheKey(hash, target, descriptor), target) : undefined;
    if (!found) throw new Error("まだ変換していません（convertDocument で変換してから読んでください）");
    return found;
  }
}
