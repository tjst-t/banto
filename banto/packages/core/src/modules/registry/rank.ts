// **一覧の並び順**（決定・2026-09-21、ユーザー要望「Stripe なら Stripe が出している
// ものを優先、Google サービスなら Google が出しているものを最優先」）。
//
// **registry は「公式かどうか」を持っていない。** 全件の `_meta` にあるのは
// `status` / `isLatest` / 日付だけで、verified や publisher の欄は無い
// （2026-09-21、API リファレンスと実データの両方で確認）。
//
// **唯一の出所の手がかりは名前空間**で、そこは registry が公開時に検証している：
//   - `io.github.<account>/…` … GitHub の**アカウント**を確認しただけ
//   - `com.stripe/…` のような独自ドメイン … **そのドメインの所有者**であることを
//     DNS/HTTP チャレンジで確認済み
//
// つまり「Stripe が出している Stripe のサーバ」は、**名前空間のドメインがその
// 製品の名前と一致するもの**として導ける。**ブランド名の一覧は持たない**
// （規則3——持つと、増えるたびに書き足す当番ができ、書き忘れが静かな誤りになる）。
//
// **これは近似**（正直に書いておく）。Google は `com.google/gmail` ではなく
// `com.googleapis.<api>/mcp` で出しているので、「gmail」で検索しても名前が
// 一致せず上がらない。**上がらないことは「無い」と同じに見える**ので、
// 画面は出所（ベンダー／GitHub アカウント）をそのまま札で出す——
// 並び順だけに判断を預けない（規則13）。

import type { RegistryEntry } from "./server-json.js";

/** GitHub アカウントの名前空間。**ドメインの所有者ではない**。 */
const GITHUB_NAMESPACE = "io.github.";

export type Provenance =
  /** その製品のドメインの所有者が出している（＝公式と見なす） */
  | "vendor"
  /** ドメインは確認済みだが、その製品のドメインではない（再梱包・集約など） */
  | "third-party-domain"
  /** GitHub アカウントの確認だけ */
  | "github-account";

/** `com.stripe/mcp` → `stripe`、`com.googleapis.bigtableadmin/mcp` → `googleapis`。 */
export function brandLabel(serverName: string): string {
  const namespace = serverName.split("/")[0] ?? "";
  const labels = namespace.split(".");
  // 逆 DNS なので `com.stripe` → `stripe.com`。登録可能な名前は**2番目のラベル**
  return (labels[1] ?? "").toLowerCase();
}

/**
 * **一覧に出す名前**（追加・2026-09-21、実ブラウザで発覚）。
 *
 * `server.json` の `title` は任意で、**公式ほど書いていない**
 * ——Stripe の `com.stripe/mcp` には無い。`/` の後ろをそのまま出すと
 * **見出しが「mcp」になる**（実際そう出た）。人が最初に読むところなので、
 * そこが製品名になっていないと、どれがどれだか分からない。
 *
 * `title` が在ればそれ。無くて、`/` の後ろが**どれにでも付く語**なら、
 * 名前空間のドメイン名を使う（`com.stripe/mcp` → `stripe`）。
 * **作り話はしない**——どちらも server.json に書いてあるものから採る。
 */
const GENERIC_NAME_PARTS = new Set(["mcp", "server", "mcp-server", "mcpserver", "api"]);

export function displayLabel(server: { name: string; title?: string }): string {
  if (server.title?.trim()) return server.title.trim();
  const part = server.name.split("/")[1] ?? server.name;
  if (GENERIC_NAME_PARTS.has(part.toLowerCase())) {
    const brand = brandLabel(server.name);
    if (brand) return brand;
  }
  return part;
}

/** 検索語・サーバ名を、比べられる語に割る。 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * ブランドの名前と、人が打った語が同じものを指しているか。
 *
 * 完全一致だけだと `googleapis` が「google」で拾えない。**4文字以上のときだけ
 * 前方一致も認める**——短い語で認めると、無関係なものが公式の顔で上に出る。
 */
function brandMatches(brand: string, token: string): boolean {
  if (brand === "" || token === "") return false;
  if (brand === token) return true;
  if (token.length >= 4 && brand.startsWith(token)) return true;
  if (brand.length >= 4 && token.startsWith(brand)) return true;
  return false;
}

/**
 * その1件の出所。**検索語が要る。**
 *
 * 「**その製品**の提供元か」は、どの製品の話かが決まって初めて言える。
 * `com.stripe/mcp` は「stripe」の提供元であり、`ai.smithery/smithery-notion` は
 * （Smithery 自身のものではあっても）**Notion の提供元ではない**。
 *
 * **検索していないときは、誰も提供元を名乗らない。**
 *
 * 一度、検索が無いときは「自分のブランドで出しているか」（名前空間のドメインが
 * そのサーバ自身の名前・題に出てくるか）で代用しようとした。**実データで測って
 * 取りやめた**（2026-09-21）：公開者のほとんどが自分のブランドで出している
 * （`ac.snag/snag`・`ai.aard/aard`…）ので、**先頭12件が全部「提供元」になった**。
 * 常に点く札は何も教えないうえ、**並びは実際には名前順なのに、優先が効いて
 * いるように見える**——見えているものが繋がっていない状態（規則13）。
 *
 * 一覧側は「検索してください」と言う形にした（`registry-module-picker.tsx`）。
 * **答えられない問いに、それらしい答えを返さない**（規則2）。
 */
export function provenanceOf(entry: RegistryEntry, query: string): Provenance {
  const name = entry.server.name;
  if (name.startsWith(GITHUB_NAMESPACE)) return "github-account";
  const brand = brandLabel(name);
  if (tokens(query).some((t) => brandMatches(brand, t))) return "vendor";
  return "third-party-domain";
}

const PROVENANCE_RANK: Record<Provenance, number> = {
  vendor: 0,
  "third-party-domain": 1,
  "github-account": 2,
};

/**
 * 並べ替える。**元の配列は変えない。**
 *
 * order:
 *   1. **使えるもの**が先（`deprecated` / `deleted` は下へ——消さないが、上にも置かない）
 *   2. **出所**（ベンダー → 確認済みドメイン → GitHub アカウント）
 *   3. 名前（決定的にする。同点のものが実行のたびに入れ替わらないため）
 */
export function rankEntries(entries: readonly RegistryEntry[], query: string): RegistryEntry[] {
  return [...entries].sort((a, b) => {
    const usableA = a.status === "active" ? 0 : 1;
    const usableB = b.status === "active" ? 0 : 1;
    if (usableA !== usableB) return usableA - usableB;
    const pa = PROVENANCE_RANK[provenanceOf(a, query)];
    const pb = PROVENANCE_RANK[provenanceOf(b, query)];
    if (pa !== pb) return pa - pb;
    return a.server.name.localeCompare(b.server.name);
  });
}
