// Caddy のサブドメインで出すときの、決まりごと（純粋な関数だけ）。
//
// - **URL の決め方**：`<サブドメイン>.<基のドメイン>`。サブドメインの既定は `<サービス名>-<Project の id の先頭8文字>`
//   （Project の id は UUID で、名前は変わりうる——変わらないものから決める）。人は承認の画面で変えられる
// - **ルートの印（`@id`）**：`banto-publish-<持ち主>-<Project・サービス・ポートの印>`。持ち主はこの Module の置き場から
//   決まる——同じ Caddy を2つの banto（や2本の実装）が使っても、互いのルートを片付けない

import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

export type Reach = "machine" | "lan" | "internet";

export interface PublishTarget {
  projectId: string;
  service: string;
  port: number;
}

export type AuthRecord = { kind: "banto" } | { kind: "none" } | { kind: "basic"; username: string; passwordHash: string };

/**
 * **banto のログイン**で守るときの決まりごと（決定・2026-10-03、`docs/specs/v4-security.md`「公開したものの前の
 * 認証」）。banto 本体（host）に問い合わせ、その公開先だけの通行証を確かめる。通行証の Cookie は、確かめたあと
 * サービスへ渡す要求から外し、サービスが返す同じ名前の Set-Cookie も落とす（サービスは AI が作ったもの）
 */
export const PASS_COOKIE = "__Host-banto-pass";
export const BANTO_AUTH_PATH = "/.banto-auth/*";

/** 覚えておく公開（**マスター**。Caddy のルートはここから作る写し） */
export interface RouteRecord extends PublishTarget {
  hostname: string;
  /** Basic 認証なら bcrypt のハッシュだけ（パスワードそのものは持たない） */
  auth: AuthRecord;
  createdAt: string;
}

export class PublishError extends Error {}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertTarget(raw: Record<string, unknown>): PublishTarget {
  const projectId = typeof raw.projectId === "string" ? raw.projectId : "";
  if (!projectId) throw new PublishError("projectId が要ります");
  const service = typeof raw.service === "string" ? raw.service : "";
  if (!SERVICE.test(service)) throw new PublishError(`サービス名が不正です：${JSON.stringify(raw.service)}`);
  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PublishError(`ポートが不正です：${JSON.stringify(raw.port)}`);
  }
  return { projectId, service, port };
}

/** サブドメインの既定。ラベルの長さ（63）を超えないように、サービス名の側を切る */
export function defaultSubdomain(t: PublishTarget): string {
  const suffix = `-${t.projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
  return `${t.service.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

export function hostnameFor(subdomain: string, baseDomain: string): string {
  return `${subdomain}.${baseDomain}`;
}

export function routeIdPrefix(owner: string): string {
  return `banto-publish-${createHash("sha256").update(owner).digest("hex").slice(0, 8)}-`;
}

export function routeIdFor(prefix: string, t: PublishTarget): string {
  return prefix + createHash("sha256").update(`${t.projectId}\n${t.service}\n${t.port}`).digest("hex").slice(0, 16);
}

/**
 * **公開ごとの設定項目**（承認の画面にそのまま出る。窓口は中身を解釈しない——docs/specs/v4-modules.md §4.3）。
 * 語彙は JSON Schema（MCP の elicitation の `requestedSchema` と同じ平たい形）。パスワードは `writeOnly`
 * ——「書くだけで、読み返されない」の JSON Schema の印。画面はこれを見て伏せ字の欄にする
 */
export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    auth: {
      type: "string",
      title: "認証",
      // **既定は banto のログイン**（改訂・2026-10-03、ユーザー。2026-09-28 の「既定は無し」を改めた）
      enum: ["banto", "none", "basic"],
      enumNames: [
        "banto のログイン（banto にログインしている端末だけが開ける）",
        "無し（URL を知っていれば誰でも届く）",
        "Basic 認証（ユーザー名とパスワード）",
      ],
      default: "banto",
    },
    username: { type: "string", title: "Basic 認証のユーザー名", default: "banto", minLength: 1, maxLength: 64 },
    password: {
      type: "string",
      title: "Basic 認証のパスワード",
      description: "12文字以上。banto はハッシュ（bcrypt）だけを覚え、ここに書いたものは二度と表示しません",
      minLength: 12,
      maxLength: 72,
      writeOnly: true,
    },
    subdomain: {
      type: "string",
      title: "サブドメイン",
      description: "空なら <サービス名>-<Project の id の先頭8文字>",
      pattern: LABEL.source,
    },
  },
  required: ["auth"],
} as const;

export interface PublishConfig {
  subdomain?: string;
  auth: { kind: "banto" } | { kind: "none" } | { kind: "basic"; username: string; password?: string };
}

/**
 * 設定を検める。**知らない項目は断る**（打ち間違いで認証が外れる、を起こさない）。
 * `forPlan` なら、まだ打っていないパスワードは問わない（承認の前の見積もり）
 */
export function parseConfig(raw: unknown, opts: { forPlan?: boolean } = {}): PublishConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c !== "object" || Array.isArray(c)) throw new PublishError("config はオブジェクトです");
  for (const k of Object.keys(c)) {
    if (!(k in CONFIG_SCHEMA.properties)) throw new PublishError(`知らない設定項目です：${k}`);
  }
  let subdomain: string | undefined;
  if (c.subdomain !== undefined && c.subdomain !== "") {
    if (typeof c.subdomain !== "string" || !LABEL.test(c.subdomain)) {
      throw new PublishError("サブドメインは英小文字・数字・ハイフン（63文字まで、端はハイフン以外）です");
    }
    subdomain = c.subdomain;
  }
  const kind = c.auth ?? CONFIG_SCHEMA.properties.auth.default;
  if (kind === "none") return { ...(subdomain ? { subdomain } : {}), auth: { kind: "none" } };
  if (kind === "banto") return { ...(subdomain ? { subdomain } : {}), auth: { kind: "banto" } };
  if (kind !== "basic") throw new PublishError(`認証の種類が不正です：${JSON.stringify(c.auth)}`);
  const username = c.username === undefined || c.username === "" ? CONFIG_SCHEMA.properties.username.default : c.username;
  if (typeof username !== "string" || username.length > 64 || /[:\s]/.test(username)) {
    throw new PublishError("Basic 認証のユーザー名は 64 文字までで、空白と「:」を含まないこと");
  }
  const password = c.password;
  if (password === undefined || password === "") {
    if (opts.forPlan) return { ...(subdomain ? { subdomain } : {}), auth: { kind: "basic", username } };
    throw new PublishError("Basic 認証のパスワードが要ります");
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 72) {
    // 72 は bcrypt が読む上限（それより後ろは黙って捨てられる）
    throw new PublishError("Basic 認証のパスワードは 12〜72 文字です");
  }
  return { ...(subdomain ? { subdomain } : {}), auth: { kind: "basic", username, password } };
}

/** bcrypt の強さ。Caddy はリクエストのたびに照合する（`hash_cache` で覚えさせる）ので、重くしすぎない */
const BCRYPT_COST = 10;

export async function authRecordOf(auth: PublishConfig["auth"]): Promise<AuthRecord> {
  if (auth.kind === "none" || auth.kind === "banto") return { kind: auth.kind };
  if (!auth.password) throw new PublishError("Basic 認証のパスワードが要ります");
  return { kind: "basic", username: auth.username, passwordHash: await bcrypt.hash(auth.password, BCRYPT_COST) };
}

/**
 * **Caddy のルート**（JSON 設定の `apps.http.servers.<名前>.routes[]` の1件）。
 *
 * 行き先が分からない（コンテナが止まっている等）ときは **中継せず 503 を返す**——前のアドレスを残すと、
 * そのアドレスを DHCP で受け取った**別の Project のコンテナ**へ届けてしまう
 */
export function buildRoute(
  id: string,
  rec: RouteRecord,
  upstream: string | undefined,
  /** banto 本体（host）の口（例 `127.0.0.1:4737`）。banto のログインで守るときに Caddy が問い合わせる先 */
  bantoUpstream?: string,
): Record<string, unknown> {
  const handle: Record<string, unknown>[] = [];
  const routes: Record<string, unknown>[] = [];
  if (rec.auth.kind === "banto") {
    if (!bantoUpstream) {
      // 問い合わせ先が分からないなら通さない（守らずに開けない）
      return {
        "@id": id,
        match: [{ host: [rec.hostname] }],
        handle: [{ handler: "static_response", status_code: 503, body: "banto: banto 本体の住所が分からないので、ログインを確かめられません" }],
        terminal: true,
      };
    }
    const banto = { handler: "reverse_proxy", upstreams: [{ dial: bantoUpstream }] };
    // 1. banto から戻ってくる道（札を通行証に引き換える）。サービスへは渡さない
    routes.push({ match: [{ path: [BANTO_AUTH_PATH] }], handle: [banto] });
    // 2. Caddyfile の forward_auth と同じ形——banto に問い合わせ、2xx なら次へ。それ以外（302・401・403）は
    //    banto の答えをそのまま返す
    handle.push({
      ...banto,
      rewrite: { method: "GET", uri: "/api/auth/publish-check" },
      headers: {
        request: {
          set: { "X-Forwarded-Method": ["{http.request.method}"], "X-Forwarded-Uri": ["{http.request.uri}"] },
        },
      },
      handle_response: [{ match: { status_code: [2] }, routes: [] }],
    });
    // 3. 通行証をサービスに見せない（要求から外す）。サービスが同じ名前の Cookie を書けないようにする
    handle.push({
      handler: "headers",
      request: { replace: { Cookie: [{ search_regexp: `${PASS_COOKIE}=[^;]*(;\\s*)?`, replace: "" }] } },
      response: { replace: { "Set-Cookie": [{ search_regexp: `^\\s*${PASS_COOKIE}=.*$`, replace: "" }] }, deferred: true },
    });
  }
  if (rec.auth.kind === "basic") {
    handle.push({
      handler: "authentication",
      providers: {
        http_basic: {
          // Caddy の JSON は bcrypt のハッシュを base64 で受け取る（新しい版は生のハッシュも読むが、両方で通る形にする）
          accounts: [{ username: rec.auth.username, password: Buffer.from(rec.auth.passwordHash).toString("base64") }],
          hash: { algorithm: "bcrypt" },
          hash_cache: {},
          realm: "banto",
        },
      },
    });
  }
  handle.push(
    upstream
      ? { handler: "reverse_proxy", upstreams: [{ dial: `${upstream}:${rec.port}` }] }
      : {
          handler: "static_response",
          status_code: 503,
          body: "banto: この公開先はいま動いていません（Project のコンテナが止まっている）",
        },
  );
  routes.push({ handle });
  return {
    "@id": id,
    match: [{ host: [rec.hostname] }],
    handle: [{ handler: "subroute", routes }],
    terminal: true,
  };
}

/** キーの順を問わずに比べる（Caddy は受け取った JSON を並べ替えて返しうる） */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
