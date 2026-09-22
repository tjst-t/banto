// **試験用の npm registry**（追加・2026-09-21）。
//
// **本物の npm を叩かない**（規則6）——外の都合（繋がらない・版が変わる・
// 消される）で落ちる試験は、機構が壊れた合図と見分けが付かなくなる。
//
// npm が要求するのは2つだけなので、そこだけ返す：
//   `GET /<name>`        … packument（版の一覧と、それぞれの tarball の場所）
//   `GET /<name>/-/<f>`  … tarball 本体
//
// tarball は `npm pack` で作る——**tar を自前で書かない**（規則12——名前の
// ある道具がある）。作るのは1回だけで、あとは配るだけ。

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** 配るパッケージ（`fixtures/mcp-npm-module/`）。 */
export const NPM_FIXTURE_NAME = "banto-e2e-mcp-module";
export const NPM_FIXTURE_VERSION = "1.2.3";

export interface NpmRegistryFixture {
  url: string;
  close(): Promise<void>;
}

export async function startNpmRegistryFixture(port: number): Promise<NpmRegistryFixture> {
  const packDir = mkdtempSync(join(tmpdir(), "banto-e2e-npmpack-"));
  const source = join(here, "fixtures", "mcp-npm-module");
  // `npm pack` は `<name>-<version>.tgz` を作る
  await execFileAsync("npm", ["pack", "--pack-destination", packDir, source], { timeout: 120_000 });
  const tarballPath = join(packDir, `${NPM_FIXTURE_NAME}-${NPM_FIXTURE_VERSION}.tgz`);
  const tarball = await readFile(tarballPath);
  // npm は取得したものをこれで検める——**合わなければ npm が落ちる**ので、
  // 「配ったつもりで壊れていた」が静かに通ることはない
  const shasum = createHash("sha1").update(tarball).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

  const filename = `${NPM_FIXTURE_NAME}-${NPM_FIXTURE_VERSION}.tgz`;
  const base = `http://127.0.0.1:${port}`;

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (path === `/${NPM_FIXTURE_NAME}/-/${filename}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(tarball);
      return;
    }
    if (path === `/${NPM_FIXTURE_NAME}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: NPM_FIXTURE_NAME,
          "dist-tags": { latest: NPM_FIXTURE_VERSION },
          versions: {
            [NPM_FIXTURE_VERSION]: {
              name: NPM_FIXTURE_NAME,
              version: NPM_FIXTURE_VERSION,
              type: "module",
              bin: { [NPM_FIXTURE_NAME]: "server.js" },
              dist: {
                tarball: `${base}/${NPM_FIXTURE_NAME}/-/${filename}`,
                shasum,
                integrity,
              },
            },
          },
        }),
      );
      return;
    }
    // **知らないものは 404**——本物へ落ちない（黙って別の経路へ行かない・規則2）
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found in the e2e npm registry", path }));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: base,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
