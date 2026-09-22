// **banto が選んだ目録**（決定・2026-09-22、ユーザー）。
//
// **なぜ要るか**（実測・2026-09-22）。MCP Registry の全 34,815 件を数えたら：
//
// | | |
// |---|---|
// | `io.github.*`（GitHub アカウント確認だけ） | 23,473 件・67.4% |
// | repository URL が無い（中身を読めない） | 8,048 件・23.1% |
// | 1名前空間から10件以上のまとめ公開 | 11,303 件・32.5% |
//
// **これをそのまま人に見せるのは、伴走ではない。** かといって「提供元だけ」に
// 絞る自動判定も成立しない——よく使う20サービスで試すと**11件が0件**になり
// （GitHub・Slack・Sentry・Postgres…公式を出していない会社が多い）、画面が
// 壊れて見える。さらに自動判定は**ブランド名が同じだけの別物を拾う**：
//
//   - `app.elasticflow/mcp` は Elastic ではない
//   - `io.astrotune/…`（占星術）は Astro ではない
//   - `com.microsoft.esrp/esrp-oss-mcp-test` は Microsoft のものだが**社内の試験用**
//
// **だから人が固定する。** ここに載っているものは、**載せる時点で人が実物を
// 確かめた**もの。自動で増えない——増やすときは、この配列に足す。
//
// **載せる基準**（満たさないものは載せない）：
//   1. **その製品のドメインの持ち主が出している**（registry が DNS で確認した
//      名前空間。`io.github.*` は**アカウントの確認だけ**なので基準を満たさない）
//   2. **その会社の本番向けのもの**（社内の試験用・実験は除く）
//   3. `active` で、公開の場所（repository か websiteUrl）がある
//
// **banto はコードを監査していない。** 保証しているのは**出所**だけ
// ——「Stripe のサーバは Stripe が出している」まで。中で何をするかは相手の責任で、
// そこは画面でも言う（規則2——言えないことを言えるふりをしない）。
//
// **起動の指定はここに書かない**（規則3）。持つのは「registry のどれか」だけで、
// 実際の繋ぎ方は **host が `server.json` を引き直して**組み立てる
// （`to-declaration.ts`）——写しを持つと、相手が版を上げたときに食い違う。

export interface CuratedEntry {
  /** 画面が送る id。 */
  id: string;
  /** registry のサーバ名（`server.json` の `name`）。**引き直す鍵はこれだけ**。 */
  registryName: string;
  /** 人に出す名前。 */
  label: string;
  /** 何をするものか（1行）。 */
  description: string;
  /** **なぜ載っているか**——人が確かめた根拠をそのまま残す（規則2）。 */
  why: string;
}

/**
 * **確かめた日：2026-09-22。** 追加・削除するときは、上の基準に照らして
 * 実物を引いてから。**「たぶん公式だろう」で足さない。**
 */
export const CURATED_REGISTRY_CATALOG: readonly CuratedEntry[] = [
  {
    id: "stripe",
    registryName: "com.stripe/mcp",
    label: "Stripe",
    description: "決済・顧客・請求・商品を扱う",
    why: "stripe.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "notion",
    registryName: "com.notion/mcp",
    label: "Notion",
    description: "ページ・データベースを読み書きする",
    why: "notion.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "linear",
    registryName: "app.linear/linear",
    label: "Linear",
    description: "課題・プロジェクト・サイクルを扱う",
    why: "linear.app の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "figma",
    registryName: "com.figma.mcp/mcp",
    label: "Figma",
    description: "デザインファイルの中身を読む",
    why: "figma.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "atlassian",
    registryName: "com.atlassian/atlassian-mcp-server",
    label: "Atlassian（Jira・Confluence）",
    description: "課題・ページを検索して読み書きする",
    why: "atlassian.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "cloudflare-docs",
    registryName: "com.cloudflare.mcp/mcp",
    label: "Cloudflare（ドキュメント）",
    description: "Cloudflare の公式ドキュメントを引く",
    why: "cloudflare.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "supabase",
    registryName: "com.supabase/mcp",
    label: "Supabase",
    description: "プロジェクト・データベース・テーブルを扱う",
    why: "supabase.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "neon",
    registryName: "com.neon/mcp",
    label: "Neon（Postgres）",
    description: "Neon のプロジェクトとデータベースを扱う",
    why: "neon.tech の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "huggingface",
    registryName: "co.huggingface/hf-mcp-server",
    label: "Hugging Face",
    description: "モデル・データセット・Space を検索する",
    why: "huggingface.co の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "azure",
    registryName: "com.microsoft/azure",
    label: "Azure（Microsoft）",
    description: "Azure の資源を扱う（このサーバはこの machine で動きます）",
    why: "microsoft.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "paypal",
    registryName: "com.paypal.mcp/mcp",
    label: "PayPal",
    description: "請求・注文・支払いを扱う",
    why: "paypal.com の持ち主が公開（registry が DNS で確認）",
  },
  {
    id: "globalping",
    registryName: "io.globalping/mcp",
    label: "Globalping",
    description: "世界中の観測点から ping・traceroute・DNS を試す",
    why: "globalping.io の持ち主が公開（registry が DNS で確認）",
  },
];
