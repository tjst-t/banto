// **画面と Module の間の流れ**（決定・2026-10-08、アーキ仕様 §5.8）——host と Module の間の約束。
//
// - Module は画面の資源（`ui://`）の `_meta["dev.banto/streams"]` に、その画面が開いてよい流れの名前を並べる
// - 待ち受けは Module の置き場の中の UNIX ソケット `$BANTO_MODULE_DATA_DIR/s/stream.sock`（その上で WebSocket）
// - host が繋ぐときは、最初の要求のヘッダ `X-Banto-Stream` に刻印を入れる。**Module はこの刻印だけを信じる**
//   （画面の申告は host が確かめてから組み立て直している）
//
// 刻印は JSON を base64url にしたもの——`params` に日本語が入ると、HTTP のヘッダにそのまま載せられないため

import { closeSync, openSync } from "node:fs";
import { dirname, basename } from "node:path";
import { VENDOR_PREFIX } from "./meta.js";

/** 画面の資源が名乗る、開いてよい流れの名前の一覧 */
export const STREAMS_META_KEY = `${VENDOR_PREFIX}/streams`;

/** host が Module へ繋ぐときの刻印のヘッダ（Node の受け口では小文字で見える） */
export const STREAM_STAMP_HEADER = "x-banto-stream";

/** Module の置き場の中の、待ち受けのソケット（置き場からの相対） */
export const STREAM_SOCKET_RELATIVE_PATH = "s/stream.sock";

/** 1通の上限。超えたら 1009 で閉じる */
export const STREAM_MAX_MESSAGE_BYTES = 1024 * 1024;

/** 画面が渡す引数（`params`）の上限 */
export const STREAM_PARAMS_MAX_BYTES = 4 * 1024;

/** Module が「もう無い」と言って閉じる番号——画面は繋ぎ直しをやめる */
export const STREAM_CLOSE_GONE = 4404;

/** host が Module に渡す刻印 */
export interface StreamStamp {
  /** 流れの名前（画面の資源が名乗ったもの） */
  name: string;
  /** 画面が渡した引数（JSON、4KiB まで）。渡さなければ空のオブジェクト */
  params: Record<string, unknown>;
  /** どの Project の画面か（banto 全体の設定画面から開いたものには無い） */
  projectId?: string;
  /** 会話の中の画面なら、その Thread */
  threadId?: string;
  /** 流れを開いた画面の資源 */
  resourceUri: string;
  /** 人の画面からの流れ（いまは必ず true） */
  human: true;
}

export function encodeStreamStamp(stamp: StreamStamp): string {
  return Buffer.from(JSON.stringify(stamp), "utf8").toString("base64url");
}

/** 読めない・形が違う刻印は undefined（Module は断る） */
export function decodeStreamStamp(value: string | string[] | undefined): StreamStamp | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const s = parsed as Record<string, unknown>;
  if (typeof s.name !== "string" || typeof s.resourceUri !== "string" || s.human !== true) return undefined;
  if (typeof s.params !== "object" || s.params === null || Array.isArray(s.params)) return undefined;
  if (s.projectId !== undefined && typeof s.projectId !== "string") return undefined;
  if (s.threadId !== undefined && typeof s.threadId !== "string") return undefined;
  return {
    name: s.name,
    params: s.params as Record<string, unknown>,
    ...(typeof s.projectId === "string" ? { projectId: s.projectId } : {}),
    ...(typeof s.threadId === "string" ? { threadId: s.threadId } : {}),
    resourceUri: s.resourceUri,
    human: true,
  };
}

/**
 * **長いパスのソケットに、フォルダの番号を通して繋ぐ・立てる**（実測・2026-10-08）。
 *
 * UNIX ソケットのパスは 107 バイトまで（sun_path）。Module の置き場は `<banto の置き場>/modules/<名前>-<Project の id>`
 * で、E2E の置き場では `s/stream.sock` まで足すと 115 バイトを越えた（本番でも名前が 16 字を越えると届かない）。
 * フォルダを開いて、その番号の `/proc/self/fd/<番号>/<ファイル名>` で bind・connect すれば、パスの長さに縛られない
 * （Linux の決まった逃げ道。155 バイトのパスで立てて繋げることを測った）。`use` が返したら番号を閉じる
 * ——connect・listen の呼び出しが済んでから閉じること（パスは呼び出しの時点で引かれる）
 */
export async function viaDirectoryFd<T>(socketPath: string, use: (shortPath: string) => Promise<T>): Promise<T> {
  const fd = openSync(dirname(socketPath), "r");
  try {
    return await use(`/proc/self/fd/${fd}/${basename(socketPath)}`);
  } finally {
    closeSync(fd);
  }
}

/** 画面の資源の `_meta` から、名乗っている流れの名前を読む（形が違えば空） */
export function streamNamesOf(meta: unknown): string[] {
  if (typeof meta !== "object" || meta === null) return [];
  const value = (meta as Record<string, unknown>)[STREAMS_META_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}
