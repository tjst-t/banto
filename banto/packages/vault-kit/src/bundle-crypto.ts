// **書き出しの束を合言葉で包む・開く**（決定・2026-10-22、仕様 v4-modules.md §2.1「書き出しと取り込み」）。
//
// 合言葉から scrypt で鍵を導き、AES-256-GCM で包む。見出し（形式・版・KDF の値・塩・IV）は認証付きの追加データ（AAD）に
// 入れるので、どこを書き換えても開けない。依存は Node の crypto だけ。
//
// **開けなかった理由は1つの文にまとめる**——合言葉違いか書き換えかを教えない（どちらも「開けません」）。

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";

export const BUNDLE_FORMAT = "banto-vault-export";
export const BUNDLE_VERSION = 1;
/** 合言葉の最短の長さ（文字数） */
export const MIN_PASSPHRASE_LENGTH = 12;

/** 書き出すときの scrypt の値（OWASP の勧める最小：N=2^17・r=8・p=1） */
const KDF_DEFAULT = { N: 2 ** 17, r: 8, p: 1 } as const;
/** 取り込むときに受ける上限——細工したファイルでメモリと時間を食い潰させない */
const KDF_MAX_N = 2 ** 20;
const KDF_MAX_R = 16;
const KDF_MAX_P = 4;

export const BUNDLE_OPEN_FAILED = "ファイルを開けません（合言葉が違うか、ファイルが壊れているか書き換えられています）";

export interface BundleFile {
  format: typeof BUNDLE_FORMAT;
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  data: string;
}

function scrypt(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  // scrypt が使うメモリはおよそ 128 * N * r バイト。既定の上限（32MB）では N=2^17 が通らないので、値から決める
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scryptCb(passphrase.normalize("NFC"), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** 見出しを AAD の文字列にする（並びを固定する——JSON の並びに頼らない） */
function aadOf(file: Pick<BundleFile, "format" | "version" | "kdf" | "cipher">): Buffer {
  const { kdf, cipher } = file;
  return Buffer.from(
    [file.format, String(file.version), kdf.name, String(kdf.N), String(kdf.r), String(kdf.p), kdf.salt, cipher.name, cipher.iv].join("|"),
    "utf8",
  );
}

export function assertPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string" || passphrase === "") throw new Error("合言葉を入れてください");
  // 長さは文字で数える（サロゲートペアを2つと数えない）。合言葉そのものは文言に出さない
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`合言葉は ${MIN_PASSPHRASE_LENGTH} 文字以上にしてください`);
  }
  return passphrase;
}

/** 中身（JSON にできるもの）を合言葉で包み、ファイルの文字列にする */
export async function sealBundle(payload: unknown, passphrase: string, kdfParams: { N: number; r: number; p: number } = KDF_DEFAULT): Promise<string> {
  assertPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, kdfParams);
  const head = {
    format: BUNDLE_FORMAT as typeof BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: { name: "scrypt" as const, ...kdfParams, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm" as const, iv: iv.toString("base64") },
  };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadOf({ ...head, cipher: { ...head.cipher, tag: "" } }));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const file: BundleFile = {
    ...head,
    cipher: { ...head.cipher, tag: cipher.getAuthTag().toString("base64") },
    data: data.toString("base64"),
  };
  key.fill(0);
  return JSON.stringify(file, null, 2) + "\n";
}

function isBase64(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/** ファイルの文字列を合言葉で開き、中身を返す */
export async function openBundle(text: unknown, passphrase: string): Promise<unknown> {
  if (typeof passphrase !== "string" || passphrase === "") throw new Error("合言葉を入れてください");
  if (typeof text !== "string" || text.trim() === "") throw new Error("ファイルが空です");
  let file: Partial<BundleFile>;
  try {
    file = JSON.parse(text) as Partial<BundleFile>;
  } catch {
    throw new Error("banto の Vault から書き出したファイルではありません（JSON として読めません）");
  }
  if (!file || typeof file !== "object" || file.format !== BUNDLE_FORMAT) {
    throw new Error("banto の Vault から書き出したファイルではありません");
  }
  if (typeof file.version !== "number" || file.version > BUNDLE_VERSION) {
    throw new Error(`このファイルの版（${String(file.version)}）はこの banto では読めません。banto を新しくしてから取り込んでください`);
  }
  if (file.version !== BUNDLE_VERSION) throw new Error(`知らない版のファイルです（${String(file.version)}）`);
  const kdf = file.kdf;
  const c = file.cipher;
  if (
    !kdf ||
    kdf.name !== "scrypt" ||
    !Number.isInteger(kdf.N) ||
    !Number.isInteger(kdf.r) ||
    !Number.isInteger(kdf.p) ||
    !isBase64(kdf.salt) ||
    !c ||
    c.name !== "aes-256-gcm" ||
    !isBase64(c.iv) ||
    !isBase64(c.tag) ||
    !isBase64(file.data)
  ) {
    throw new Error(BUNDLE_OPEN_FAILED);
  }
  // 細工した値でメモリと時間を食い潰させない（N は 2 の冪）
  if (kdf.N < 2 || kdf.N > KDF_MAX_N || (kdf.N & (kdf.N - 1)) !== 0 || kdf.r < 1 || kdf.r > KDF_MAX_R || kdf.p < 1 || kdf.p > KDF_MAX_P) {
    throw new Error(BUNDLE_OPEN_FAILED);
  }
  const iv = Buffer.from(c.iv, "base64");
  const tag = Buffer.from(c.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error(BUNDLE_OPEN_FAILED);
  const key = await scrypt(passphrase, Buffer.from(kdf.salt, "base64"), { N: kdf.N, r: kdf.r, p: kdf.p });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aadOf({ format: BUNDLE_FORMAT, version: file.version, kdf, cipher: { ...c, tag: "" } }));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error(BUNDLE_OPEN_FAILED);
  } finally {
    key.fill(0);
  }
}
