// **画面と Module の間の流れ——Module の側の共通部品**（決定・2026-10-08、アーキ仕様 §5.8「共通の部品」）。
//
// Module の置き場の `s/stream.sock` に WebSocket の待ち受けを立て、host が入れた刻印（`X-Banto-Stream`）を読んで、
// 流れの名前ごとの受け口へ渡す。Terminal・Browser が各自で書かない。
//
// - 繋いでくるのは host だけ（置き場は 0700 で、host は host の側のパスへ直接繋ぐ）。**刻印だけを信じる**
// - 古いソケットのファイルが残っていれば消してから立てる（Module が落ちたあとに残る）
// - 名乗っていない名前の流れは「もう無い」（4404）で閉じる——画面は繋ぎ直しをやめる
// - 流れは1本ずつ別の相手。同じ名前が同時にいくつ来てもよい（パソコンと携帯で同じ画面を開く）

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  decodeStreamStamp,
  STREAM_CLOSE_GONE,
  STREAM_MAX_MESSAGE_BYTES,
  STREAM_SOCKET_RELATIVE_PATH,
  STREAM_STAMP_HEADER,
  viaDirectoryFd,
  type StreamStamp,
} from "@banto/module-contract";

export type { WebSocket } from "ws";
export type { StreamStamp } from "@banto/module-contract";

/** 流れ1本を受ける。`socket` は host との WebSocket（文字と2進はそのまま届く） */
export type StreamHandler = (socket: WebSocket, stamp: StreamStamp) => void;

export interface StreamServerOptions {
  /** Module の置き場。省略すると `BANTO_MODULE_DATA_DIR` */
  dataDir?: string;
  /** 受け口が投げたときに知らせる（その流れは 1011 で閉じる。省略してよい） */
  onError?: (err: Error) => void;
}

export interface StreamServer {
  /** 待ち受けのパス */
  readonly path: string;
  /** 待ち受けを閉じ、開いている流れを閉じる（1001） */
  close(): Promise<void>;
}

/** Module の置き場から、待ち受けのパスを出す（host も同じ決まりで引く） */
export function streamSocketPathOf(dataDir: string): string {
  return join(dataDir, STREAM_SOCKET_RELATIVE_PATH);
}

/**
 * **待ち受けを立てる。** `handlers` は流れの名前 → 受け口。立ったら返る（立てられなければ投げる——黙って
 * 立たないままにしない）
 */
export async function listenStreams(
  handlers: Record<string, StreamHandler>,
  options: StreamServerOptions = {},
): Promise<StreamServer> {
  const dataDir = options.dataDir ?? process.env.BANTO_MODULE_DATA_DIR;
  if (!dataDir) throw new Error("流れの待ち受けを立てる置き場がありません（BANTO_MODULE_DATA_DIR）");
  const path = streamSocketPathOf(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 前の自分が落ちて残したファイル。残っていると listen が EADDRINUSE で失敗する
  rmSync(path, { force: true });

  const http: Server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8" }).end("WebSocket で繋いでください");
  });
  // 圧縮しない（JPEG は縮まず CPU だけ食う。端末の文字は小さい）・1通 1MiB まで（超えたら 1009）
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: STREAM_MAX_MESSAGE_BYTES });
  http.on("upgrade", (req, socket, head) => {
    const stamp = decodeStreamStamp(req.headers[STREAM_STAMP_HEADER]);
    if (!stamp) {
      // 刻印の無い相手とは話さない
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handler = handlers[stamp.name];
      if (!handler) {
        ws.close(STREAM_CLOSE_GONE, "この流れはありません");
        return;
      }
      try {
        handler(ws, stamp);
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        ws.close(1011, "受け口が失敗しました");
      }
    });
  });

  // パスが 107 バイトを越えても立てられるように、フォルダの番号を通して立てる（`viaDirectoryFd`）
  await viaDirectoryFd(path, (shortPath) =>
    new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(shortPath, () => {
        http.off("error", reject);
        resolve();
      });
    }),
  );
  // 置き場が 0700 でも、ファイルそのものも持ち主だけにしておく
  chmodSync(path, 0o600);

  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.close(1001, "Module が止まります");
        wss.close();
        http.close(() => {
          // フォルダの番号を通して立てたので、閉じてもファイルは残る——自分で消す
          rmSync(path, { force: true });
          resolve();
        });
        http.closeAllConnections();
      }),
  };
}
