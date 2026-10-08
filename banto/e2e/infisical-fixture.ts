// **試験のための Infisical**（追加・2026-10-08）。
//
// **本物の Infisical を前提にしない**（規則6）——以前は開発用の自前ホスト（`packages/modules/vault-infisical/dev/`、
// docker）の `.identity.json` を読んでいたので、docker の無い機械では vault-infisical が「fetch failed」を出し続け、
// Infisical を使う試験が落ちる・遅くなった（SDK は繋がらないと4回待ってやり直す）。GitHub と同じく E2E の中で立てる。
//
// vault-infisical が使う口だけを、**本物と同じ話し方で**返す（道・クエリ・本文・返事の形は `@infisical/sdk` 5.0.2 の
// コードで確かめた）：
//   POST   /api/v1/auth/universal-auth/login     … Universal Auth のログイン（clientId/clientSecret が違えば 401）
//   GET    /api/v3/secrets/raw                   … 秘密の一覧（環境・フォルダ・再帰・値を見せるか・参照の展開）
//   GET    /api/v3/secrets/raw/:name             … 1件
//   POST   /api/v3/secrets/raw/:name             … 作る（既にあれば 400、フォルダが無ければ 404）
//   PATCH  /api/v3/secrets/raw/:name             … 値・注記を変える（渡さなかったものは残る）
//   DELETE /api/v3/secrets/raw/:name             … 消す
//   GET    /api/v1/folders                       … フォルダの一覧（直下だけ）
//   POST   /api/v1/folders                       … フォルダを作る（既にあれば 400）
//   GET    /api/v1/projects/:id・/api/v1/workspace/:id … 環境の一覧（SDK に口が無く、vault-infisical が直接呼ぶ）
// エラーは本物の形（`{statusCode, message, error}`）で返す——SDK はこれを `[StatusCode=…] message` に直し、
// vault-infisical は文言で「もうある」「フォルダが無い」を見分けている。
//
// 状態はメモリの中で、回の中で持ち続ける（spec をまたいで残る——本物の Infisical と同じく、spec は自分の名前で
// 書いて自分で片づける）。始まりは空の Project（環境 dev・staging・prod。本物の Project の既定と同じ）。
//
// core と同じプロセスで立てる（core が落ちれば一緒に落ちる）。port は空いているものを OS に選ばせ、行き先は env で
// Module に渡す（`start-core.ts`）。自前の host（`own-host.ts`）は置き場のファイルから同じ値を読む。
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { INFISICAL_FIXTURE_FILE } from "./config.ts";

/** 試験用の Machine Identity（Universal Auth）。本物の値ではない */
export const E2E_INFISICAL_CLIENT_ID = "e2e-infisical-client-id";
export const E2E_INFISICAL_CLIENT_SECRET = "e2e-infisical-client-secret";
export const E2E_INFISICAL_PROJECT_ID = "e2e00000-0000-4000-8000-000000000001";
/** 接続設定の環境（既定の版） */
export const E2E_INFISICAL_ENVIRONMENT = "dev";
/** Project の環境（本物の Project を作ったときの既定と同じ並び） */
export const E2E_INFISICAL_ENVIRONMENTS = [
  { name: "Development", slug: "dev" },
  { name: "Staging", slug: "staging" },
  { name: "Production", slug: "prod" },
] as const;

/** vault-infisical に渡す env（`BANTO_INFISICAL_*`）の中身 */
export interface InfisicalFixtureEnv {
  BANTO_INFISICAL_SITE_URL: string;
  BANTO_INFISICAL_CLIENT_ID: string;
  BANTO_INFISICAL_CLIENT_SECRET: string;
  BANTO_INFISICAL_PROJECT_ID: string;
  BANTO_INFISICAL_ENVIRONMENT: string;
}

interface StoredSecret {
  id: string;
  value: string;
  comment: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 本物の応答と同じ形のエラー（SDK は `message` を読む） */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const ERROR_NAMES: Record<number, string> = {
  400: "BadRequest",
  401: "UnauthorizedError",
  403: "PermissionDenied",
  404: "NotFound",
};

/** `/a//b/` を `/a/b` に（本物も道の末尾の `/` は区別しない） */
function normalizePath(path: string | undefined | null): string {
  const segments = (path ?? "/").split("/").filter((s) => s !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** 環境ひとつぶん：フォルダの道 → その中の秘密（名前 → 中身）。根 `/` は最初からある */
type Environment = Map<string, Map<string, StoredSecret>>;

class FakeInfisical {
  private readonly envs = new Map<string, Environment>(
    E2E_INFISICAL_ENVIRONMENTS.map((e) => [e.slug, new Map([["/", new Map()]])]),
  );
  private readonly tokens = new Set<string>();

  login(body: Record<string, unknown>): unknown {
    if (body.clientId !== E2E_INFISICAL_CLIENT_ID || body.clientSecret !== E2E_INFISICAL_CLIENT_SECRET) {
      throw new HttpError(401, "Invalid credentials");
    }
    const accessToken = randomBytes(24).toString("hex");
    this.tokens.add(accessToken);
    return { accessToken, expiresIn: 7200, accessTokenMaxTTL: 2592000, tokenType: "Bearer" };
  }

  authenticate(req: IncomingMessage): void {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) throw new HttpError(401, "Missing Authorization header in the request header.");
    if (!this.tokens.has(header.slice("Bearer ".length))) throw new HttpError(401, "Failed to authenticate identity access token");
  }

  /** その Project のその環境。**Project も環境も違えば本物と同じく 404** */
  private env(projectId: unknown, slug: unknown): Environment {
    if (projectId !== E2E_INFISICAL_PROJECT_ID) throw new HttpError(404, `Project with ID '${String(projectId)}' not found`);
    const env = this.envs.get(String(slug));
    if (!env) throw new HttpError(404, `Environment with slug '${String(slug)}' in project with ID ${String(projectId)} not found`);
    return env;
  }

  private folder(env: Environment, slug: string, path: string): Map<string, StoredSecret> {
    const folder = env.get(path);
    if (!folder) throw new HttpError(404, `Folder with path '${path}' in environment with slug '${slug}' not found`);
    return folder;
  }

  project(projectId: string): unknown {
    if (projectId !== E2E_INFISICAL_PROJECT_ID) throw new HttpError(404, `Project with ID '${projectId}' not found`);
    return {
      id: projectId,
      name: "banto-e2e",
      slug: "banto-e2e",
      environments: E2E_INFISICAL_ENVIRONMENTS.map((e, position) => ({ id: `env-${e.slug}`, ...e, position: position + 1 })),
    };
  }

  // ---- フォルダ -------------------------------------------------------------

  /** 直下のフォルダだけ。**道が無ければ空**（本物と同じ——一覧の口はフォルダの不在を失敗にしない） */
  listFolders(q: URLSearchParams): unknown {
    const slug = q.get("environment") ?? "";
    const env = this.env(q.get("workspaceId"), slug);
    const parent = normalizePath(q.get("path"));
    const folders = [...env.keys()]
      .filter((p) => p !== "/" && p.slice(0, p.lastIndexOf("/") || 1) === parent)
      .map((p) => ({ id: `folder-${slug}-${p}`, name: p.slice(p.lastIndexOf("/") + 1), parentId: `folder-${slug}-${parent}` }));
    return { folders };
  }

  /** 作る。**既にあれば 400**（vault-infisical は飲み込む）。親の道が無ければ、本物と同じく親から作る */
  createFolder(body: Record<string, unknown>): unknown {
    const slug = String(body.environment);
    const env = this.env(body.workspaceId, slug);
    const name = String(body.name ?? "");
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new HttpError(400, `Invalid folder name: ${name}`);
    const parent = normalizePath(body.path as string);
    const full = joinPath(parent, name);
    if (env.has(full)) throw new HttpError(400, `Folder with name '${name}' already exists in path '${parent}'`);
    let at = "/";
    for (const segment of full.split("/").filter((s) => s !== "")) {
      at = joinPath(at, segment);
      if (!env.has(at)) env.set(at, new Map());
    }
    return { folder: { id: `folder-${slug}-${full}`, name, path: full } };
  }

  // ---- 秘密 -----------------------------------------------------------------

  private view(slug: string, path: string, key: string, s: StoredSecret, viewValue: boolean, value = s.value): Record<string, unknown> {
    return {
      id: s.id,
      _id: s.id,
      workspace: E2E_INFISICAL_PROJECT_ID,
      environment: slug,
      version: s.version,
      type: "shared",
      secretKey: key,
      secretValue: viewValue ? value : "<hidden-by-infisical>",
      secretValueHidden: !viewValue,
      secretComment: s.comment,
      secretPath: path,
      secretReminderNote: null,
      secretReminderRepeatDays: null,
      skipMultilineEncoding: false,
      tags: [],
      secretMetadata: [],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  /**
   * 参照（`${KEY}`＝同じフォルダ、`${環境.フォルダ….KEY}`）を展開する。**SDK の既定は展開する**
   * （vault-infisical は展開させないので、ここを通るのは人の道具から読んだときだけ）。辿れなければ本物と同じく失敗
   */
  private expand(slug: string, path: string, value: string, depth = 0): string {
    if (depth > 5) throw new HttpError(400, "Secret reference depth exceeded");
    return value.replace(/\$\{([^}]+)\}/g, (_m, ref: string) => {
      const parts = ref.split(".");
      const [refSlug, refPath, refKey] =
        parts.length === 1 ? [slug, path, parts[0]!] : [parts[0]!, normalizePath(parts.slice(1, -1).join("/")), parts.at(-1)!];
      const env = this.envs.get(refSlug);
      const hit = env?.get(refPath)?.get(refKey);
      if (!hit) throw new HttpError(404, `Secret reference '${ref}' not found`);
      return this.expand(refSlug, refPath, hit.value, depth + 1);
    });
  }

  /**
   * 一覧。**再帰の一覧は起点のフォルダが無ければ 404**（vault-infisical は「その環境にまだフォルダが無い」として
   * 0 件に読む）、**再帰でなければ空**——本物の振る舞いに合わせる
   */
  listSecrets(q: URLSearchParams): unknown {
    const slug = q.get("environment") ?? "";
    const env = this.env(q.get("workspaceId"), slug);
    const base = normalizePath(q.get("secretPath"));
    const recursive = q.get("recursive") === "true";
    const viewValue = q.get("viewSecretValue") !== "false";
    const expand = q.get("expandSecretReferences") !== "false";
    if (!env.has(base)) {
      if (recursive) this.folder(env, slug, base);
      return { secrets: [], imports: [] };
    }
    const under = (p: string) => p === base || (recursive && (base === "/" || p.startsWith(`${base}/`)));
    const secrets: unknown[] = [];
    for (const [path, folder] of env) {
      if (!under(path)) continue;
      for (const [key, s] of folder) {
        secrets.push(this.view(slug, path, key, s, viewValue, expand && viewValue ? this.expand(slug, path, s.value) : s.value));
      }
    }
    return { secrets, imports: [] };
  }

  getSecret(name: string, q: URLSearchParams): unknown {
    const slug = q.get("environment") ?? "";
    const path = normalizePath(q.get("secretPath"));
    const folder = this.folder(this.env(q.get("workspaceId"), slug), slug, path);
    const s = folder.get(name);
    if (!s) throw new HttpError(404, `Secret with name '${name}' not found`);
    const viewValue = q.get("viewSecretValue") !== "false";
    const expand = q.get("expandSecretReferences") !== "false";
    return { secret: this.view(slug, path, name, s, viewValue, expand && viewValue ? this.expand(slug, path, s.value) : s.value) };
  }

  /** 作る。**値は空でもよい**（名前だけの欄） */
  createSecret(name: string, body: Record<string, unknown>): unknown {
    const slug = String(body.environment);
    const path = normalizePath(body.secretPath as string);
    const folder = this.folder(this.env(body.workspaceId, slug), slug, path);
    if (folder.has(name)) throw new HttpError(400, "Secret already exist");
    const now = new Date().toISOString();
    const s: StoredSecret = {
      id: randomUUID(),
      value: typeof body.secretValue === "string" ? body.secretValue : "",
      comment: typeof body.secretComment === "string" ? body.secretComment : "",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    folder.set(name, s);
    return { secret: this.view(slug, path, name, s, true) };
  }

  /** 渡したものだけ変える（`secretComment` だけなら値は残る） */
  updateSecret(name: string, body: Record<string, unknown>): unknown {
    const slug = String(body.environment);
    const path = normalizePath(body.secretPath as string);
    const folder = this.folder(this.env(body.workspaceId, slug), slug, path);
    const s = folder.get(name);
    if (!s) throw new HttpError(404, `Secret named '${name}' not found`);
    if (typeof body.secretValue === "string") s.value = body.secretValue;
    if (typeof body.secretComment === "string") s.comment = body.secretComment;
    s.version += 1;
    s.updatedAt = new Date().toISOString();
    if (typeof body.newSecretName === "string" && body.newSecretName !== name) {
      if (folder.has(body.newSecretName)) throw new HttpError(400, "Secret with the new name already exist");
      folder.delete(name);
      folder.set(body.newSecretName, s);
      name = body.newSecretName;
    }
    return { secret: this.view(slug, path, name, s, true) };
  }

  deleteSecret(name: string, body: Record<string, unknown>): unknown {
    const slug = String(body.environment);
    const path = normalizePath(body.secretPath as string);
    const folder = this.folder(this.env(body.workspaceId, slug), slug, path);
    const s = folder.get(name);
    if (!s) throw new HttpError(404, `Secret named '${name}' not found`);
    folder.delete(name);
    return { secret: this.view(slug, path, name, s, true) };
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function route(fake: FakeInfisical, req: IncomingMessage, url: URL): Promise<unknown> | unknown {
  const p = url.pathname;
  const m = req.method ?? "GET";
  if (m === "GET" && p === "/api/status") return { message: "Ok" };
  if (m === "POST" && p === "/api/v1/auth/universal-auth/login") return readJson(req).then((b) => fake.login(b));
  fake.authenticate(req);
  const project = /^\/api\/v1\/(projects|workspace)\/([^/]+)$/.exec(p);
  if (m === "GET" && project) {
    return { [project[1] === "projects" ? "project" : "workspace"]: fake.project(decodeURIComponent(project[2]!)) };
  }
  if (p === "/api/v1/folders") {
    if (m === "GET") return fake.listFolders(url.searchParams);
    if (m === "POST") return readJson(req).then((b) => fake.createFolder(b));
  }
  if (m === "GET" && p === "/api/v3/secrets/raw") return fake.listSecrets(url.searchParams);
  const secret = /^\/api\/v3\/secrets\/raw\/([^/]+)$/.exec(p);
  if (secret) {
    const name = decodeURIComponent(secret[1]!);
    if (m === "GET") return fake.getSecret(name, url.searchParams);
    if (m === "POST") return readJson(req).then((b) => fake.createSecret(name, b));
    if (m === "PATCH") return readJson(req).then((b) => fake.updateSecret(name, b));
    if (m === "DELETE") return readJson(req).then((b) => fake.deleteSecret(name, b));
  }
  // **知らない口は 404 で断り、何を呼ばれたかを残す**——vault-infisical が新しい口を使い始めたら、ここで分かる
  console.warn(`[e2e] 偽の Infisical が知らない口を呼ばれました: ${m} ${p}`);
  throw new HttpError(404, `Route ${m}:${p} not found`);
}

export async function startInfisicalFixture(): Promise<{ env: InfisicalFixtureEnv; close(): Promise<void> }> {
  const fake = new FakeInfisical();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://fixture");
    Promise.resolve()
      .then(() => route(fake, req, url))
      .then(
        (body) => send(200, body),
        (err: unknown) => {
          if (err instanceof HttpError) {
            return send(err.status, { reqId: randomUUID(), statusCode: err.status, message: err.message, error: ERROR_NAMES[err.status] ?? "Error" });
          }
          console.error("[e2e] 偽の Infisical が落ちました:", err);
          send(500, { statusCode: 500, message: String(err), error: "InternalServerError" });
        },
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env: InfisicalFixtureEnv = {
    BANTO_INFISICAL_SITE_URL: `http://127.0.0.1:${port}`,
    BANTO_INFISICAL_CLIENT_ID: E2E_INFISICAL_CLIENT_ID,
    BANTO_INFISICAL_CLIENT_SECRET: E2E_INFISICAL_CLIENT_SECRET,
    BANTO_INFISICAL_PROJECT_ID: E2E_INFISICAL_PROJECT_ID,
    BANTO_INFISICAL_ENVIRONMENT: E2E_INFISICAL_ENVIRONMENT,
  };
  writeFileSync(INFISICAL_FIXTURE_FILE, JSON.stringify(env));
  return { env, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** core のプロセスが立てた偽の Infisical への env（自前の host に渡す）。**立っていなければ止まる**（規則2） */
export function infisicalFixtureEnv(): InfisicalFixtureEnv {
  return JSON.parse(readFileSync(INFISICAL_FIXTURE_FILE, "utf8")) as InfisicalFixtureEnv;
}
