// **試験用の偽の登録簿**（アーキ仕様 §4.1「試験」）。小さな tarball を作り、HTTP で出す——単体テストと E2E（`e2e/start-core.ts`）
// が使う。本番では使わない（core はこれを import しない）

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  type?: "file" | "dir" | "symlink" | "hardlink";
  body?: string | Buffer;
  /** symlink・hardlink の先 */
  linkname?: string;
  mode?: number;
}

function header(name: string, size: number, typeflag: string, mode: number, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(typeflag, 156, 1, "ascii");
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

/** tar（ustar）を組んで gzip する。名前は 100 字まで */
export function tgzOf(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    const body = type === "file" ? Buffer.from(e.body ?? "") : Buffer.alloc(0);
    const flag = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[type];
    parts.push(header(e.name, body.length, flag, e.mode ?? (type === "dir" ? 0o755 : 0o644), e.linkname), body, pad(body.length));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** npm の integrity の形（`sha512-<base64>`） */
export function integrityOfBytes(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export interface FakeRegistry {
  url(path: string): string;
  /** その道を何回頼まれたか */
  hits(path: string): number;
  close(): Promise<void>;
  server: Server;
}

/**
 * 道ごとに中身を出す。`stallAfter` を付けた道は、その数のバイトを出したあと黙る（進まない登録簿）。`delayMs` は出し始める前に待つ
 */
export async function startFakeRegistry(routes: Record<string, { body: Buffer; stallAfter?: number; delayMs?: number }>): Promise<FakeRegistry> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    // 頼まれた回数（別のプロセスの試験が「二度目は取らない」を確かめる）
    if (path === "/__hits") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Object.fromEntries(hits)));
      return;
    }
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end("not found");
      return;
    }
    const send = () => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(route.body.length) });
      if (route.stallAfter === undefined) {
        res.end(route.body);
        return;
      }
      // 少し出して黙る（接続は開けたまま）
      res.write(route.body.subarray(0, route.stallAfter));
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
