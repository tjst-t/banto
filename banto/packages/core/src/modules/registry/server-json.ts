// **MCP Registry の `server.json` を、banto が読む形にする**（追加・2026-09-21、ユーザー要望）。
//
// **独自形式を作らない**（`docs/specs/v4-architecture.md` §5.1）——公式のスキーマ
// （`https://static.modelcontextprotocol.io/schemas/*/server.schema.json`）の欄を
// そのまま持つ。banto の語彙へ翻訳するのは `to-declaration.ts` の仕事で、ここは
// **受け取った形を保つ**だけ。
//
// **全部の欄は持たない。** banto が実際に読むものだけを型にする——読まない欄を
// 型に並べると、「対応しているつもり」が生まれる（規則13）。

/** その入力が何を求めているか（`Input` / `KeyValueInput`）。 */
export interface RegistryInput {
  /** 環境変数名・ヘッダ名。`KeyValueInput` のときだけ在る。 */
  name?: string;
  description?: string;
  isRequired?: boolean;
  /** **秘密なら Vault へ**（`to-declaration.ts`）——画面もここを見て入力欄を変える。 */
  isSecret?: boolean;
  /** 既に値が決まっているもの（人に聞かない）。`{変数}` を含むことがある。 */
  value?: string;
  default?: string;
  /** 選択肢があるなら、人には選ばせる（自由入力にしない）。 */
  choices?: string[];
  format?: "string" | "number" | "boolean" | "filepath";
  placeholder?: string;
}

/** `packages[].runtimeArguments` / `packageArguments`。 */
export interface RegistryArgument extends RegistryInput {
  type?: "positional" | "named";
  /** `named` のときの旗（`--port` など）。 */
  isRepeated?: boolean;
  valueHint?: string;
}

export interface RegistryPackage {
  /** `npm` | `pypi` | `oci` | `nuget` | `mcpb`。**banto が対応するのは一部**。 */
  registryType: string;
  registryBaseUrl?: string;
  identifier: string;
  version?: string;
  /** `npx` | `uvx` | `docker` など。無いこともある。 */
  runtimeHint?: string;
  transport: { type: string; url?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryInput[];
  /** MCPB と直接ダウンロードでは必須。**検証に使う**（いまは対応しない）。 */
  fileSha256?: string;
}

export interface RegistryRemote {
  /** `streamable-http` | `sse`。 */
  type: string;
  url: string;
  headers?: RegistryInput[];
}

export interface RegistryServer {
  /** 逆 DNS。**`/` の前が名前空間**——これが唯一の出所の手がかり（`rank.ts`）。 */
  name: string;
  title?: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

/** 一覧の1件（`server` ＋ registry 自身が付ける `_meta`）。 */
export interface RegistryEntry {
  server: RegistryServer;
  /** `active` | `deprecated` | `deleted`。**deprecated を黙って混ぜない**（規則2）。 */
  status: string;
  isLatest: boolean;
  updatedAt?: string;
}

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

/**
 * registry の応答1件を読む。**読めないものは落とす**（`undefined` を返す）。
 *
 * 一覧の途中に形の違うものが混ざっても、**そこだけ落として残りは出す**
 * ——1件のせいで検索結果が空になるほうが、人にとっては壊れている。
 * ただし**黙って形を補わない**（規則2）：必須の欄が無いものは「無い」として扱う。
 */
export function parseEntry(raw: unknown): RegistryEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const server = (raw as { server?: unknown }).server;
  if (typeof server !== "object" || server === null) return undefined;
  const s = server as Record<string, unknown>;
  if (typeof s.name !== "string" || typeof s.version !== "string") return undefined;
  const meta = (raw as { _meta?: Record<string, unknown> })._meta?.[OFFICIAL_META] as
    | { status?: unknown; isLatest?: unknown; updatedAt?: unknown }
    | undefined;
  return {
    server: {
      name: s.name,
      title: typeof s.title === "string" ? s.title : undefined,
      description: typeof s.description === "string" ? s.description : "",
      version: s.version,
      websiteUrl: typeof s.websiteUrl === "string" ? s.websiteUrl : undefined,
      repository:
        typeof s.repository === "object" && s.repository !== null
          ? (s.repository as RegistryServer["repository"])
          : undefined,
      packages: Array.isArray(s.packages) ? (s.packages as RegistryPackage[]) : undefined,
      remotes: Array.isArray(s.remotes) ? (s.remotes as RegistryRemote[]) : undefined,
    },
    // **書かれていなければ active と決めつけない**——分からないことは分からないまま
    status: typeof meta?.status === "string" ? meta.status : "unknown",
    isLatest: meta?.isLatest === true,
    updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : undefined,
  };
}
