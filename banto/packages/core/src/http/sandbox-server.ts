// Module の Canvas を隔離するサンドボックスの配信口（決定・2026-09-06、Phase 1）。
//
// **なぜ別の口が要るか**：MCP Apps の仕様は **Host と Sandbox が別オリジンである
// こと**を要求する（`docs/specs/v4-frontend.md` §6.2 の訂正）。内側の iframe は
// `allow-same-origin` を持つが、**そのオリジンが banto でなければ** banto の
// cookie・localStorage・DOM には届かない。同一オリジンで中継すると前提が崩れる。
//
// **なぜ静的配信では足りないか**：CSP を**リクエストごとに**組み立てる必要がある
// （Module が `_meta.ui.csp` で申告した接続先から作る）。しかも **HTTP ヘッダで**
// 与える——meta タグは中に入ったコードから改竄されうる（参照実装も同じ理由で
// ヘッダを使っている）。
//
// この口は **sandbox.html と sandbox.js しか配らない**。他は 404。

import { createServer, type Server } from "node:http";

export interface SandboxServerOptions {
  /** この画面から埋め込まれることだけを許す（`frame-ancestors`）。
   *  環境ごとに変わる（Caddy 経由・LAN 直・E2E）ので設定から受け取る。 */
  allowedEmbedderOrigins: string[];
}

/** Module が `_meta.ui.csp` で申告できる接続先。仕様の語彙をそのまま使う。 */
interface DeclaredCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * 申告されたドメインのうち、**素性の確かなものだけ**を通す。
 * `*` や `'unsafe-inline'`・`javascript:` を書かれても CSP に混ぜない
 * ——ここを緩めると、隔離そのものが無意味になる（規則2：緩い方へ倒れない）。
 */
function safeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => {
    if (typeof v !== "string") return false;
    // スキーム付きの素直な origin だけ。空白（＝別のディレクティブの注入）も弾く
    return /^https?:\/\/[A-Za-z0-9.:_-]+$/.test(v);
  });
}

function parseDeclaredCsp(raw: string | null): DeclaredCsp {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as DeclaredCsp;
  } catch {
    // **壊れた申告は無視して既定（最も厳しい）に落とす**。通してはいけない
    return {};
  }
}

export function buildCsp(declared: DeclaredCsp, allowedEmbedderOrigins: string[]): string {
  const connect = safeDomains(declared.connectDomains);
  const resource = safeDomains(declared.resourceDomains);
  const frame = safeDomains(declared.frameDomains);
  const baseUri = safeDomains(declared.baseUriDomains);

  const list = (values: string[]): string => (values.length > 0 ? values.join(" ") : "'none'");

  return [
    "default-src 'none'",
    // 中身（Module の HTML）は srcdoc 相当で流し込まれるので self とインラインが要る
    `script-src 'self' 'unsafe-inline'${resource.length > 0 ? " " + resource.join(" ") : ""}`,
    `style-src 'self' 'unsafe-inline'${resource.length > 0 ? " " + resource.join(" ") : ""}`,
    `img-src 'self' data: blob:${resource.length > 0 ? " " + resource.join(" ") : ""}`,
    `font-src 'self' data:${resource.length > 0 ? " " + resource.join(" ") : ""}`,
    `connect-src ${list(connect)}`,
    `frame-src ${list(frame)}`,
    `base-uri ${list(baseUri)}`,
    "form-action 'none'",
    // **埋め込めるのは決めた相手だけ**——`*` は使わない
    `frame-ancestors ${allowedEmbedderOrigins.join(" ")}`,
  ].join("; ");
}

const SANDBOX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark" />
    <title>banto sandbox</title>
    <style>
      html, body { margin: 0; height: 100vh; width: 100vw; background: transparent; }
      body { display: flex; flex-direction: column; }
      iframe { flex-grow: 1; border: 0 none transparent; background: transparent; color-scheme: inherit; }
    </style>
  </head>
  <body><script type="module" src="/sandbox.js"></script></body>
</html>
`;

/**
 * 外側プロキシの中身。**動く前に自分を検査して、危なければ止まる**（規則2）。
 * 参照実装（modelcontextprotocol/ext-apps の basic-host）と同じ骨格。
 */
function sandboxScript(allowedEmbedderOrigins: string[]): string {
  return `// banto のサンドボックス・プロキシ（自動生成、docs/specs/v4-frontend.md §6.2）
const ALLOWED = ${JSON.stringify(allowedEmbedderOrigins)};

if (window.self === window.top) {
  throw new Error("このページは iframe の中でしか動きません");
}
if (!document.referrer) {
  throw new Error("埋め込み元が分からないので動きません");
}
const HOST_ORIGIN = new URL(document.referrer).origin;
if (!ALLOWED.includes(HOST_ORIGIN)) {
  throw new Error("許可されていない埋め込み元です: " + HOST_ORIGIN);
}

// **自己診断**——ここで例外にならないなら隔離が壊れている。黙って動かない
try {
  window.top.location.href;
  throw "SANDBOX_BROKEN";
} catch (e) {
  if (e === "SANDBOX_BROKEN") {
    throw new Error("サンドボックスが安全に組めていません（親に触れてしまう）");
  }
}

const inner = document.createElement("iframe");
// 既定は参照実装と同じ。host が指定してきたらそれを使う（下の resource-ready）
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
inner.style.cssText = "width:100%;height:100%;border:none;";
document.body.appendChild(inner);

const PROXY_READY = "ui/notifications/sandbox-proxy-ready";
const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

// host（親） ↔ ここ ↔ 内側 の中継。親と内側は別オリジンで直接は話せない
window.addEventListener("message", (event) => {
  if (event.source === window.parent && event.origin === HOST_ORIGIN) {
    const msg = event.data;
    if (msg && msg.method === RESOURCE_READY) {
      const params = msg.params ?? {};
      if (typeof params.sandbox === "string") inner.setAttribute("sandbox", params.sandbox);
      if (params.allow) inner.setAttribute("allow", params.allow);
      // 内側へは document.write で流す——このページの CSP をそのまま継ぐ
      const doc = inner.contentDocument;
      doc.open();
      doc.write(params.html ?? "");
      doc.close();
      return;
    }
    inner.contentWindow?.postMessage(msg, "*");
    return;
  }
  if (event.source === inner.contentWindow) {
    window.parent.postMessage(event.data, HOST_ORIGIN);
  }
});

window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, HOST_ORIGIN);
`;
}

export function createSandboxServer(options: SandboxServerOptions): Server {
  const { allowedEmbedderOrigins } = options;
  if (allowedEmbedderOrigins.length === 0) {
    throw new Error("サンドボックスを埋め込める相手が1つも設定されていません");
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sandbox.invalid");
    const csp = buildCsp(parseDeclaredCsp(url.searchParams.get("csp")), allowedEmbedderOrigins);

    if (url.pathname === "/sandbox.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        // 中身は毎回 CSP が変わりうるので、取り違えないように
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(SANDBOX_HTML);
      return;
    }
    if (url.pathname === "/sandbox.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(sandboxScript(allowedEmbedderOrigins));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}
