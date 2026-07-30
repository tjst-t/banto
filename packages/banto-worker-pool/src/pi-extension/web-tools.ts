/**
 * web-tools: 職人に「外を読む口」を渡す pi Extension（imp-0005）。
 *
 * 職人が調べものをするのに、ドキュメントや仕様を自分で引けないと、番頭が全部読んで
 * 渡すことになり D10（番頭は細かい仕事をしない）が空回りする。
 *
 * **既定では載らない**（PO裁定 2026-07-30）。`worker.delegate` に `network: true` を
 * 渡したときだけ Worker Pool がこの拡張を職人に載せる。載せなければ Tool 自体が存在しない
 * ——許可リストで隠すより強い。
 *
 * ただし**これは職人を外から遮断する機構ではない**：`bash` を持った職人は curl で外へ出られる。
 * ここで得られるのは「番頭が web を渡す/渡さないを選べること」であって、砂箱ではない。
 * 本当に遮断したいなら `tools` から bash を外す（imp-0004 でそれができるようになった）。
 *
 * 検索は鍵の要らない経路を使う（PO裁定）：DuckDuckGo lite の HTML を読み、
 * 取れなければ Wikipedia の全文検索に落とす。参照実装は loamium の
 * `web-search-provider.ts`（同じ手法・同じ壊れやすさ）。
 *
 * D6: node 標準（fetch / URL / AbortSignal）だけ。HTML パーサも入れない——タグを落として
 *     読める程度で足り、依存を増やす理由がない。
 * I2: 取得失敗・拒否は握りつぶさず、職人に見える文言で返す（黙って空を返さない）。
 * I4: pi の型は import しない（worker-report.ts と同じ判断。実行時に渡される）。
 */

// ── 定数 ────────────────────────────────────────────────────────────────────

/** 取得・検索の待ち時間の上限。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 1回の取得で読む上限（バイト）。職人の文脈を1ページで埋めないため。 */
const MAX_FETCH_BYTES = 1024 * 1024;
/** 返す検索結果の上限。 */
const MAX_SEARCH_RESULTS = 10;
/** 名乗り。相手側のログに何が来たか分かるようにしておく。 */
const USER_AGENT = "Mozilla/5.0 (compatible; BantoWorker/1.0)";

/** 論理名 → wire名（決定22）。ドットを通さないプロバイダがあるため職人側でも変換する。 */
function toWireName(logical: string): string {
  return logical.replace(/\./g, "__");
}

/**
 * この拡張が職人に足す Tool の wire名。
 *
 * `--tools` で道具を絞るときに書き落とすと、network を許したのに web が消える——
 * 報告経路と同じ理由で、絞りの合成は WorkerPool 側が持つ（imp-0004）。
 */
export const WEB_TOOL_NAMES: readonly string[] = ["web.fetch", "web.search"].map(toWireName);

// ── URL の門番（SSRF）───────────────────────────────────────────────────────

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * 取得してよい公開 URL かを判定する。
 *
 * **職人は Kobo・Worker Pool・番頭ホストと同じマシンに居る。** 門番が無いと、職人は
 * `web.fetch` で `http://localhost:4110/tools/...` を叩けてしまい、報告経路を通らずに
 * モジュールの Tool を呼べる。外を読む口が内側への抜け道になってはいけない。
 *
 * 名前解決はしない（DNS を引かない）。ホスト名が数値IPのときだけ範囲で弾く——
 * DNS リバインドまでは見ない。参照実装（loamium `web-guard.ts`）と同じ割り切り。
 */
export function isPublicHttpUrl(rawUrl: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `URL の形式が不正です: ${rawUrl}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `http/https だけ取得できます（渡されたのは ${url.protocol}）` };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "") return { ok: false, reason: "ホストがありません" };

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: `手元（localhost）は取得できません: ${hostname}` };
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null) {
    return isPrivateIpv4(ipv4)
      ? { ok: false, reason: `内側のアドレスは取得できません: ${hostname}` }
      : { ok: true, url };
  }
  if (isPrivateIpv6(hostname)) {
    return { ok: false, reason: `内側のアドレス（IPv6）は取得できません: ${hostname}` };
  }
  return { ok: true, url };
}

/** IPv4 ドット表記なら4オクテットに分解する。違えば null。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** ループバック・プライベート・リンクローカル・0.0.0.0 なら true。 */
function isPrivateIpv4(octets: number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // ループバック
  if (a === 10) return true; // プライベート
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // リンクローカル
  return false;
}

/**
 * IPv6 リテラルを 8 グループの数値に開く。IPv6 でなければ null。
 *
 * 文字列の見た目で判定してはいけない——`new URL()` は `[::ffff:127.0.0.1]` を
 * `[::ffff:7f00:1]` に**正規化する**ので、埋め込みIPv4を10進のまま探す正規表現は
 * すり抜ける（参照実装の loamium も同じ穴を持っている。テストで見つけた）。
 */
function expandIpv6(literal: string): number[] | null {
  const bare = (literal.split("%")[0] ?? literal).toLowerCase();
  if (!bare.includes(":")) return null;

  const halves = bare.split("::");
  if (halves.length > 2) return null; // "::" は1回まで

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        // 末尾を IPv4 表記で書く形（::ffff:127.0.0.1 等）
        const octets = parseIpv4(piece);
        if (octets === null) return null;
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = toGroups(halves[1] ?? "");
  if (tail === null) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 0) return null;
  return [...head, ...Array<number>(zeros).fill(0), ...tail];
}

/** IPv6 リテラルで、ループバック・ULA・リンクローカル・埋め込みIPv4が内側なら true。 */
function isPrivateIpv6(hostname: string): boolean {
  const groups = expandIpv6(hostname.replace(/^\[/, "").replace(/\]$/, ""));
  if (groups === null) return false;

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル

  // ::ffff:a.b.c.d（IPv4-mapped）と ::a.b.c.d（IPv4-compatible）。
  // 後者は `::` と `::1` も含む——0.0.0.0 / 0.0.0.1 として IPv4 側の判定に乗る
  const leadingZeros = groups.slice(0, 5).every((g) => g === 0);
  const mapped = leadingZeros && groups[5] === 0xffff;
  const compatible = leadingZeros && groups[5] === 0;
  if (mapped || compatible) {
    const a = groups[6] ?? 0;
    const b = groups[7] ?? 0;
    return isPrivateIpv4([(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff]);
  }
  return false;
}

// ── HTML を読める形に落とす ─────────────────────────────────────────────────

/** よく出る実体参照だけ戻す。網羅はしない（読めれば足りる）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** タグを落として空白を詰めるだけ。DOM は組み立てない。 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decodeEntities(withoutScripts.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** タグ除去＋空白の圧縮（1行に潰す）。検索結果の見出し・抜粋向け。 */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

// ── 検索（鍵の要らない経路）─────────────────────────────────────────────────

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo lite の HTML から結果を取り出す（純関数）。
 *
 * 属性の順に依存しないよう、開始タグ全体を取ってから href を抜く。href が
 * `//duckduckgo.com/l/?uddg=<encoded>` の転送形式なら実URLに戻す。
 *
 * **壊れやすい**——相手の HTML が変われば動かなくなる。壊れたときに黙って
 * 「該当なし」にならないよう、呼び出し側で Wikipedia に落とす。
 */
export function parseDuckDuckGoLite(html: string): SearchHit[] {
  const links: Array<{ title: string; url: string }> = [];
  const linkRe = /<a\b([^>]*\bclass=["']result-link["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const startTag = m[1] ?? "";
    const inner = m[2] ?? "";
    const href = /\bhref=["']([^"']+)["']/.exec(startTag)?.[1];
    if (href === undefined) continue;
    let resolved = decodeEntities(href);
    const encoded = /[?&]uddg=([^&]+)/.exec(resolved)?.[1];
    if (encoded !== undefined) {
      try {
        resolved = decodeURIComponent(encoded);
      } catch {
        // 戻せなければ転送URLのまま渡す。捨てるよりは辿れる
      }
    } else if (resolved.startsWith("//")) {
      resolved = `https:${resolved}`;
    }
    links.push({ title: stripTags(inner), url: resolved });
  }

  const snippets: string[] = [];
  const snippetRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1] ?? ""));
  }

  return links.slice(0, MAX_SEARCH_RESULTS).map((link, i) => ({
    title: link.title || "(no title)",
    url: link.url,
    snippet: snippets[i] ?? "",
  }));
}

/** Wikipedia 全文検索の JSON から結果を取り出す（純関数）。壊れた形は空配列。 */
export function parseWikipedia(json: unknown): SearchHit[] {
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  const search = record(record(json)?.["query"])?.["search"];
  if (!Array.isArray(search)) return [];

  const hits: SearchHit[] = [];
  for (const entry of search) {
    const item = record(entry);
    const title = typeof item?.["title"] === "string" ? item["title"] : "";
    if (title === "") continue;
    const snippet = typeof item?.["snippet"] === "string" ? item["snippet"] : "";
    hits.push({
      title,
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: stripTags(snippet),
    });
    if (hits.length >= MAX_SEARCH_RESULTS) break;
  }
  return hits;
}

/**
 * 鍵の要らない検索。DuckDuckGo lite を先に試し、駄目なら Wikipedia に落とす。
 *
 * 片方が壊れても全滅しないようにするための二段。両方0件なら空配列を返し、
 * 呼び出し側が「見つからなかった」と言う（I2: 失敗と0件を混ぜない）。
 */
export async function keylessSearch(
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ hits: SearchHit[]; via: "duckduckgo" | "wikipedia" | "none" }> {
  const ddg = await fetchDuckDuckGo(query, fetchImpl);
  if (ddg.length > 0) return { hits: ddg, via: "duckduckgo" };
  const wiki = await fetchWikipedia(query, fetchImpl);
  if (wiki.length > 0) return { hits: wiki, via: "wikipedia" };
  return { hits: [], via: "none" };
}

async function fetchDuckDuckGo(query: string, fetchImpl: typeof fetch): Promise<SearchHit[]> {
  try {
    const res = await fetchImpl(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      {
        headers: { "user-agent": USER_AGENT, accept: "text/html" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return [];
    return parseDuckDuckGoLite(await res.text());
  } catch {
    // 片方の失敗で検索そのものを失敗にしない。落とし先がある
    return [];
  }
}

async function fetchWikipedia(query: string, fetchImpl: typeof fetch): Promise<SearchHit[]> {
  try {
    const api =
      "https://ja.wikipedia.org/w/api.php?action=query&list=search&format=json" +
      `&srsearch=${encodeURIComponent(query)}&srlimit=${MAX_SEARCH_RESULTS}`;
    const res = await fetchImpl(api, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseWikipedia(await res.json());
  } catch {
    return [];
  }
}

/** 検索結果を職人が読む形に整える。 */
export function renderSearchHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `"${query}" に当てはまるものは見つかりませんでした`;
  const lines = hits.map((hit, i) => {
    const head = hit.url ? `${hit.title} — ${hit.url}` : hit.title;
    return hit.snippet ? `${i + 1}. ${head}\n   ${hit.snippet}` : `${i + 1}. ${head}`;
  });
  return `"${query}" の検索結果:\n\n${lines.join("\n")}`;
}

// ── 取得 ────────────────────────────────────────────────────────────────────

export interface FetchOutcome {
  text: string;
  /** 取れなかった（門番に弾かれた・HTTPエラー・例外）。 */
  error: boolean;
  url: string;
  bytes?: number;
  truncated?: boolean;
}

/**
 * 公開URLを1つ取ってテキストにする。
 *
 * 上限を超えた分は切り捨て、切ったことを本文に書く——黙って途中までを全部に見せない（I2）。
 */
export async function fetchPublicUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes = MAX_FETCH_BYTES
): Promise<FetchOutcome> {
  const verdict = isPublicHttpUrl(rawUrl);
  if (!verdict.ok) {
    return { text: `取得できません: ${verdict.reason}`, error: true, url: rawUrl };
  }
  const url = verdict.url.toString();

  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { text: `取得に失敗しました (HTTP ${res.status}): ${url}`, error: true, url };
    }
    const raw = await res.text();
    const buf = Buffer.from(raw, "utf8");
    const truncated = buf.byteLength > maxBytes;
    const body = truncated ? buf.subarray(0, maxBytes).toString("utf8") : raw;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const text = contentType.includes("html") ? htmlToText(body) : body;
    const note = truncated ? `\n\n（${maxBytes} バイトで打ち切りました）` : "";
    return {
      text: `${url}:\n\n${text}${note}`,
      error: false,
      url,
      bytes: truncated ? maxBytes : buf.byteLength,
      truncated,
    };
  } catch (err) {
    return { text: `取得エラー: ${String(err)}`, error: true, url };
  }
}

// ── pi への登録 ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される (I4)
export default function (pi: any): void {
  pi.registerTool({
    name: toWireName("web.fetch"),
    label: "web.fetch",
    description:
      "公開されている web ページ（http/https）を取ってテキストで返す。HTML はタグを落として渡す。" +
      "手元（localhost）や内側のアドレスは取れない。まず手元のファイルで足りないか確かめてから使うこと。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "取得する http/https の公開URL" },
      },
      required: ["url"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const outcome = await fetchPublicUrl(String(params["url"] ?? ""));
      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          url: outcome.url,
          ...(outcome.error ? { error: true } : {}),
          ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
          ...(outcome.truncated ? { truncated: true } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: toWireName("web.search"),
    label: "web.search",
    description:
      "web を検索して、見出し・URL・抜粋を返す。読みたいページが決まったら web.fetch で本文を取る。" +
      "鍵の要らない経路（DuckDuckGo、駄目なら Wikipedia）を使うので、結果は限定的なことがある。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索する語" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = String(params["query"] ?? "");
      const { hits, via } = await keylessSearch(query);
      return {
        content: [{ type: "text", text: renderSearchHits(query, hits) }],
        details: { query, via, count: hits.length },
      };
    },
  });
}
