// **試験のための GitHub**（追加・2026-09-23、`skill-import`）。
//
// **本物の GitHub を叩かない**（規則6）——未認証の API は1時間に60回までで、
// 中身も持ち主の都合で変わる。skills Module が使う口（commit の解決・木を辿る・
// raw で中身）だけを、1つのリポジトリぶん返す。
//
// core と同じプロセスで立てる（core が落ちれば一緒に落ちる）。port は空いている
// ものを OS に選ばせ、URL を env で Module に渡す（`start-core.ts`）。

import { createServer, type Server } from "node:http";

export const GITHUB_FIXTURE_REPO = "e2e-org/e2e-skills";
export const GITHUB_FIXTURE_SKILL = "e2e-sakura";
export const GITHUB_FIXTURE_COMMIT = "5a4e2e5a4e2e5a4e2e5a4e2e5a4e2e5a4e2e5a4e";
/** 説明にだけ書いた事実 */
export const GITHUB_FIXTURE_DESCRIPTION = "サクラの扱い方。開花の目安は 600 度日";

const FILES: Record<string, string> = {
  "SKILL.md": [
    "---",
    `name: ${GITHUB_FIXTURE_SKILL}`,
    `description: ${GITHUB_FIXTURE_DESCRIPTION}。サクラを扱う仕事のときに使う。`,
    "---",
    "# サクラの扱い",
    "",
    "剪定は落葉期に行う。",
    "",
    "開花予想は `python scripts/forecast.py` で出す。",
    "",
  ].join("\n"),
  "scripts/forecast.py": "print('600')\n",
  "references/pruning.md": "# 剪定\n\n太い枝は切らない。\n",
};

export async function startGithubFixture(): Promise<{ api: string; raw: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const api = `/api/repos/${GITHUB_FIXTURE_REPO}`;
    const p = url.pathname;
    if (p.startsWith(`${api}/commits/`)) {
      return send(200, { sha: GITHUB_FIXTURE_COMMIT, commit: { tree: { sha: "root" } } });
    }
    if (p === `${api}/git/trees/root`) return send(200, { tree: [{ path: "skills", type: "tree", sha: "t-skills" }] });
    if (p === `${api}/git/trees/t-skills`) {
      return send(200, { tree: [{ path: GITHUB_FIXTURE_SKILL, type: "tree", sha: "t-skill" }] });
    }
    if (p === `${api}/git/trees/t-skill` && url.searchParams.get("recursive") === "1") {
      return send(200, {
        tree: Object.entries(FILES).map(([path, body]) => ({ path, type: "blob", sha: path, size: Buffer.byteLength(body) })),
      });
    }
    const raw = `/raw/${GITHUB_FIXTURE_REPO}/${GITHUB_FIXTURE_COMMIT}/skills/${GITHUB_FIXTURE_SKILL}/`;
    if (p.startsWith(raw)) {
      const path = decodeURIComponent(p.slice(raw.length));
      if (path in FILES) return send(200, FILES[path]!);
    }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    api: `http://127.0.0.1:${port}/api`,
    raw: `http://127.0.0.1:${port}/raw`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
