// **vault 役割の共通部分**（`@banto/vault-kit`、切り出し・2026-09-12）。
//
// docs/specs/v4-modules.md §2.1 が最初から言っていた形——「共通ロジック
// （alias 管理・A/B/C の tool/resource 配線）は npm ライブラリで共有し、
// **Module 間の MCP 契約にはしない**」。Module を分けると値が余分な1ホップを
// 通るので、ライブラリで共有する。
//
// **2本目（Infisical）を書く段になって切り出した。** 1本しか無いうちに
// 共通化すると、抜き出す境界を1つの実装から推測することになる（規則12 の逆）
// ——2本目の実物が、どこが同じでどこが違うかを教えてくれた。
//
// 各 backend が書くのは `VaultBackend`（D節）と `AliasStore` だけ。
// A(agent)/B(module)/C(admin) の3段可視性は `_meta["dev.banto/visibility"]` に載る。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AUDIT_ARGS_META_KEY,
  callerOf,
  socketDirOf,
  VALUE_FREE_META_KEY,
  VISIBILITY_META_KEY,
  MODULE_META_KEY,
  CANVAS_META_KEY,
} from "@banto/module-contract";
import { REQUEST_APP_HTML, requestAppUri } from "./request-app.js";
import {
  isLink,
  toPublic,
  type AliasMeta,
  type AliasStore,
  type LinkAliasMeta,
  type SecretAliasMeta,
} from "./alias-store.js";
import { GroupBindings } from "./group-bindings.js";
import type { VaultBackend } from "./backend.js";

/** 一覧の resource（§2.1 A節）。**単体の `vault://aliases/{name}` と対**。 */
const ALIASES_URI = "vault://aliases";

/** instance 全体の alias を置く既定のグループ。 */
const INSTANCE_GROUP = "instance";

const ALIAS_KINDS = ["secret", "ssh-identity", "file", "oauth-token"] as const;
/** **banto 自身が置くもの**（人は手で作らない）。`putSecret` はこれしか扱わない。 */
const BANTO_OWNED_KIND = "oauth-token";
const ALIAS_SCOPES = ["instance", "project"] as const;

/**
 * 生成した秘密の見た目（`generateSecret`）。
 *
 * **`base64url` を既定にする**——`A-Za-z0-9_-` だけなので、シェルの引用符・
 * URL・環境変数のどれに入れても壊れない。強さは `bytes` が決めるので、
 * 見た目の選択は「入れ先で壊れないか」だけの話になる。
 */
const SECRET_FORMATS = ["base64url", "hex"] as const;

/**
 * `generateSecret` が作れる種類（統合・2026-09-12、ユーザー指摘）。
 *
 * 以前は SSH 鍵だけ `generateKeypair` という別の tool に切り出してあったが、
 * そちらは `module` 可視性で**呼び出し元が1つも無かった**——「作る」という
 * 同じ行為なのに入口が2つに割れていたせいで、人の画面からは一生届かなかった。
 * **1つの tool の `kind` にする**と、既にある「ランダムに作る」の導線に
 * そのまま乗る（規則3——同じことをする道を2本持たない）。
 *
 * `file` は作れない——「ファイルの中身をランダムに作る」に意味が無い。
 */
const GENERATABLE_KINDS = ["secret", "ssh-identity"] as const;
const DEFAULT_SECRET_BYTES = 32;
const MIN_SECRET_BYTES = 16;
const MAX_SECRET_BYTES = 256;

/**
 * **語彙の外の値を、黙って既定に倒さない**（規則2、可視性の `_meta` と同じ姿勢）。
 * `kind: "secrets"`（複数形の書き間違い）を `secret` として受けると、
 * 画面の絞り込みからは消えるのに解決はできる alias ができる。
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return (() => {
    throw new Error(`${label} は ${allowed.join(" / ")} のどれかです（${JSON.stringify(value)} が来ました）`);
  })();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} が要ります`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} は文字列です`);
  return value;
}

export interface VaultModuleOptions {
  /** この Module の名前（`vault` / `vault-infisical`）。画面の URI にも使う。 */
  moduleName: string;
  /** 秘密そのものを持つ実装（§2.1 D節）。 */
  backend: VaultBackend;
  /** alias のメタデータの置き場。**backend が選ぶ**（共有したいなら backend 側へ）。 */
  aliasStore: AliasStore;
  /** Project ↔ グループの紐付けを置く場所（banto 側の割り当て表）。 */
  dataDir: string;
  /** 設定 Canvas（`ui://<id>/config`）。持たない Module もあってよい。
   *  `name` は**人に見える名前**——設定画面の左メニューに出る。 */
  configApp?: { uri: string; html: string; name: string };
  /** 立ち上がりにやること（鍵の用意・ログインなど）。 */
  init?(): Promise<void>;
  /**
   * **まだ使える状態か**（追加・2026-09-13、ユーザー要望「接続先と資格情報を
   * 画面から入れたい」）。
   *
   * 外の金庫を使う backend は、**人が設定するまで繋がれない**。それでも
   * **Module 自体は立たないといけない**——立たないと設定画面に辿り着けないし、
   * host は毎回「繋げませんでした」を受信箱に出す（実際そうなっていた）。
   *
   * `ready: false` のときは、値を触る口が**理由つきで断る**。黙って空の
   * 一覧を返さない（規則2——「無い」と「まだ設定していない」は別の事実）。
   */
  readiness?(): Promise<{ ready: boolean; reason?: string }>;
  /**
   * **この Module だけが持つ口**（追加・2026-09-13）。外の金庫を使う backend は
   * 「繋ぎ方の設定」を自分で持つので、その読み書きをここから足す。
   *
   * **未設定でも呼べる**（`readiness` のゲートを通さない）——通すと、
   * 設定する口が設定されるまで使えないという堂々巡りになる。
   */
  extraTools?: Array<{
    definition: Record<string, unknown>;
    handle(args: Record<string, unknown>): Promise<{ content: { type: "text"; text: string }[] }>;
  }>;
  /**
   * **AI に直接見せるか**（決定・2026-09-12、窓口の導入）。
   *
   * `vault` は役割で、実装は複数ありうる。実装が2本になった瞬間、AI には
   * `requestAlias` が2つ・`vault://aliases` が2つ並び、**AI はどちらを選ぶ
   * 材料を持たない**（実測：走らせるたびに選ぶ先が変わる）。
   *
   * なので **A 面（`requestAlias` と `vault://aliases`）は窓口（`vault-directory`）
   * が1本だけ持ち、backend 側は `module` に降格する**——AI の一覧から消えるが、
   * 窓口からは今までどおり呼べる。
   *
   * **`true` にするのは窓口だけ。** 既定は `false`（＝backend）。
   */
  agentFacing?: boolean;
}

export function createVaultModuleServer(opts: VaultModuleOptions) {
  const { backend, aliasStore: registry, moduleName } = opts;
  const bindings = new GroupBindings(opts.dataDir);
  const REQUEST_APP_URI = requestAppUri(moduleName);

  const server = new Server(
    { name: `banto-module-${moduleName}`, version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  const initPromise = (async () => {
    await opts.init?.();
    await registry.load();
    await bindings.load();
  })();
  /**
   * **一覧（tool・資源）は起動を待たずに返す**（決定・2026-10-03、ユーザー）。中身は起動で変わらない
   * 決まった形なので、待つ理由が無い。以前は待っていたので、vault-infisical が接続先に届かないと
   * 起動に 16 秒かかり、その間 host はこの Module を「繋がった」と扱えず、banto 全体の Module の一覧
   * （設定画面・Module の画面を開く・画面からの呼び出し）が丸ごと待たされた。
   * 待つのは実際に中身を扱う呼び出しだけ。**起動に失敗したことは隠さない**——失敗が分かっていれば一覧でも
   * 断る（host が「繋がらない」と出せる）。まだ途中なら一覧は返し、呼び出しの側でその失敗を返す
   */
  let initFailure: unknown;
  initPromise.catch((err: unknown) => {
    initFailure = err;
    console.error(`[${moduleName}] 起動に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  });
  function assertInitNotFailed(): void {
    if (initFailure !== undefined) throw initFailure;
  }

  /**
   * 使える状態でなければ**理由つきで断る**。`readiness` を渡していない
   * Module（組み込みなど）は常に使える。
   */
  async function assertReady(): Promise<void> {
    if (!opts.readiness) return;
    const state = await opts.readiness();
    if (state.ready) return;
    throw new Error(
      `${opts.moduleName} はまだ使えません：${state.reason ?? "設定されていません"}` +
        "（設定画面から接続先と資格情報を入れてください）",
    );
  }

  /**
   * その alias の値をどのグループに置くか（§2.1「Project ↔ backend グループの
   * 紐付け」）。
   *
   * **既定は Project 専用のグループ**——`projectId` は衝突しない値なので
   * そのままグループ名に使える。**使った紐付けはその場で書き留める**
   * （規則3——「既定はこうなるはず」を各所で計算し直さない。画面が見るのも
   * この台帳で、暗黙の既定は台帳に載った時点で明示の紐付けになる）。
   */
  async function groupForNewAlias(input: {
    explicitGroup?: string;
    forProject?: string;
  }): Promise<string> {
    if (input.explicitGroup) {
      await backend.createGroup(input.explicitGroup); // 名前の検査もここが持つ
      return input.explicitGroup;
    }
    if (!input.forProject) {
      const shared = bindings.sharedGroup();
      await backend.createGroup(shared);
      return shared;
    }
    const bound = bindings.get(input.forProject);
    if (bound) {
      await backend.createGroup(bound);
      return bound;
    }
    await backend.createGroup(input.forProject);
    await bindings.set(input.forProject, input.forProject);
    return input.forProject;
  }

  /**
   * **その alias を誰が使えるか**（決定・2026-09-13）。保存せず、置き場から導く
   * （規則3）——グループが唯一の真実。
   *
   * `unbound` は「どのグループにも紐付いていない」＝**誰も使えない**。
   * 隠さずに人の画面へ出す（規則2——使えないものが黙って消えると、
   * 「登録したはずなのに無い」になる）。
   */
  function scopeOf(meta: { backendPath: string }): {
    scope: "shared" | "project" | "unbound";
    group: string;
    projects: string[];
  } {
    const group = meta.backendPath.slice(0, meta.backendPath.indexOf("/"));
    if (group === bindings.sharedGroup()) return { scope: "shared", group, projects: [] };
    const projects = bindings.projectsFor(group);
    if (projects.length > 0) return { scope: "project", group, projects };
    return { scope: "unbound", group, projects: [] };
  }

  /** その Project から使ってよいか。**共通グループか、紐付いたグループだけ**。 */
  function usableBy(meta: { backendPath: string }, projectId: string): boolean {
    const where = scopeOf(meta);
    return where.scope === "shared" || where.projects.includes(projectId);
  }

  /** A 面の可視性。窓口だけが `agent`、backend は `module`（上記）。 */
  const agentVisibility: "agent" | "module" = opts.agentFacing ? "agent" : "module";

  /**
   * **どの引数が「識別子」か**（追加・2026-09-15）。監査に残してよいのはこれだけ
   * ——値そのもの（`value`）は決して含めない。banto 側は名乗ったものしか拾わない
   * （`dev.banto/auditArgs`）ので、**ここに書かなければ記録は空のまま**。
   */
  const AUDIT_IDENTIFIERS = ["name", "group", "identity", "toGroup", "toName", "implementation", "projectId"];

  function tool(
    name: string,
    description: string,
    inputSchema: unknown,
    visibility: "agent" | "module" | "admin",
    meta: Record<string, unknown> = {},
  ) {
    return {
      name,
      description,
      inputSchema,
      _meta: { [VISIBILITY_META_KEY]: visibility, [AUDIT_ARGS_META_KEY]: AUDIT_IDENTIFIERS, ...meta },
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    assertInitNotFailed();
    return {
      tools: [
        // **AI に見えるのはこの1本と resource だけ**なので、使い方の説明も
        // ここに全部置く（追加・2026-09-12、ユーザー指摘「AI が Vault の
        // 使い方を分かっていない」）。system prompt は個々の tool を語らない
        // （決定・2026-09-05、規則3）ので、伝わる場所はここしかない。
        tool(
          "requestAlias",
          "必要な秘密（トークン・鍵）が Vault に無いとき、人に登録を頼む。" +
            "**値は受け取らない**——あなたが秘密の中身を見ることはない。" +
            "秘密は「alias 名」で扱う：登録済みの一覧は resource `vault://aliases` で読め、" +
            "実際に使うときは値ではなく alias 名を Shell の envSecrets / secretFiles / sshIdentity に渡す。" +
            "まず `vault://aliases` を見て、必要なものが無いときだけこれを呼ぶ。",
          {
            type: "object",
            properties: {
              name: { type: "string", description: "登録してほしい alias の名前（例 github-token）" },
              hint: { type: "string", description: "何に使うのか。人はこれを見て判断する" },
              kind: {
                type: "string",
                enum: [...ALIAS_KINDS],
                description: "secret＝汎用の文字列／ssh-identity＝SSH 鍵／file＝ファイルの中身",
              },
            },
            required: ["name"],
          },
          agentVisibility,
          // **会話の中に入力欄を出す**（MCP Apps、決定・2026-09-12）。
          // これは banto の拡張ではなく MCP Apps 自身の印なので、代理サーバを
          // 通っても落ちない（`dev.banto/*` だけが剥がされる）
          { ui: { resourceUri: REQUEST_APP_URI } },
        ),
        tool(
          "resolveAlias",
          "aliasを値に解決する",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "module",
        ),
        tool(
          "getPublicKey",
          // **公開鍵は秘密ではない**（追加・2026-09-13、ユーザー指摘）。
          // 相手方（GitHub 等）に登録するためのものなので、出せないと使えない
          // ——作った直後の1回しか返しておらず、画面を閉じたら二度と見られなかった。
          // 値を返さない口として扱う（中継の初回承認を聞かない）：秘密鍵は通らない
          "その ssh-identity の公開鍵を返す（秘密鍵は返さない）。相手方に登録するのに使う",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "module",
          { [VALUE_FREE_META_KEY]: true },
        ),
        tool(
          "startSshAgent",
          "ssh-agent経由でsocketPathを返す。秘密鍵は返さない",
          { type: "object", properties: { identity: { type: "string" } }, required: ["identity"] },
          "module",
        ),
        tool(
          "verify",
          "aliasの値をHMAC鍵として署名を検証する。値は返さない",
          { type: "object", properties: { alias: { type: "string" }, payload: { type: "string" }, signature: { type: "string" } }, required: ["alias", "payload", "signature"] },
          "module",
        ),
        tool(
          "createAlias",
          "aliasを新規登録する（人専用）",
          {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", enum: [...ALIAS_KINDS] },
              value: { type: "string" },
              note: { type: "string" },
              group: { type: "string", description: "置き場（グループ）を直に指定する。省略時は forProject／共通グループ" },
              forProject: {
                type: "string",
                description: "この Project から使えるようにする（その Project に紐付いたグループへ置く）。省略すると共通グループ",
              },
            },
            required: ["name", "kind", "value"],
          },
          "admin",
        ),
        // **人が値を考えなくてよくする**（追加・2026-09-12、ユーザー要望）。
        // 新しい秘密（DB のパスワード・署名鍵・API のトークン）は、人が
        // 思いつくより **Vault の中で乱数から作るほうが強くて安全**——
        // 作った値は**一度も Vault の外に出ない**ので、人の画面にも、
        // 受け渡しの経路にも、記録にも現れない。
        tool(
          "generateSecret",
          "新しい秘密を Vault の中で作り、alias として登録する（人専用）。" +
            "**秘密の値は返さない**——使うときは他の alias と同じく名前で参照する。" +
            "`kind: \"ssh-identity\"` なら鍵ペアを作り、**公開鍵だけ**返す（相手方に登録するのに要る）",
          {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: {
                type: "string",
                enum: [...GENERATABLE_KINDS],
                description: "secret＝汎用の文字列（既定）／ssh-identity＝SSH 鍵ペア",
              },
              note: { type: "string" },
              group: { type: "string", description: "置き場（グループ）を直に指定する。省略時は forProject／共通グループ" },
              forProject: {
                type: "string",
                description: "この Project から使えるようにする（その Project に紐付いたグループへ置く）。省略すると共通グループ",
              },
              format: {
                type: "string",
                enum: [...SECRET_FORMATS],
                description: "kind が secret のときだけ。base64url＝URL・シェルで安全な文字だけ（既定）／hex＝16進",
              },
              bytes: {
                type: "number",
                description: `kind が secret のときだけ。乱数の強さ（バイト）。既定 ${DEFAULT_SECRET_BYTES}、${MIN_SECRET_BYTES}〜${MAX_SECRET_BYTES}`,
              },
            },
            required: ["name"],
          },
          "admin",
        ),
        // **banto 自身が置く秘密**（追加・2026-09-18、OAuth のため）。
        //
        // 金庫には値を書き換える口が無い（`updateAlias` は注記だけ）。これは
        // 「人が預けたものを黙って書き換えない」という設計で、**正しい**。
        // ところが OAuth の refresh token は**回る**ので、置き換えが要る。
        //
        // そこで**置き換えてよい範囲を種別で区切る**：`oauth-token` だけ。
        // 既にその置き場に在るものが `oauth-token` でなければ**断る**
        // ——人が預けた秘密を、この口から上書きすることは構造的にできない。
        //
        // 可視性は `module`（AI には見せない）。刻印は要る（createAlias と同じ
        // ——**預ける行為は制限を広げない**ので、人専用にはしない）。
        tool(
          "putSecret",
          "banto 自身が保管する秘密（OAuth のログイン情報）を置く。既にあれば置き換える",
          {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              note: { type: "string" },
              group: { type: "string", description: "置き場（グループ）を直に指定する" },
              forProject: { type: "string", description: "この Project のものにする。省略すると共通" },
            },
            required: ["name", "value"],
          },
          "module",
        ),
        tool(
          "updateAlias",
          "aliasのメタデータ（note・対象）を変える（人専用）。値は変えない",
          {
            type: "object",
            properties: {
              name: { type: "string" },
              note: { type: "string" },
            },
            required: ["name"],
          },
          "admin",
        ),
        tool(
          "deleteAlias",
          "aliasを削除する（人専用）",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "admin",
        ),
        tool(
          "listAliases",
          "登録されている alias の一覧（人専用、値は返さない）",
          { type: "object", properties: {} },
          "admin",
          // **値は1バイトも返さない**ので、Module 間中継の初回承認は要らない
          // （アーキ仕様 §2.5「値を返さない口」）。窓口が横断して目録を組む
          // 経路がここを通る——聞くと、AI が目録を読むたびに人が止められる
          { [VALUE_FREE_META_KEY]: true },
        ),
        tool(
          "listGroups",
          "backendのグループ一覧（人専用）",
          { type: "object", properties: {} },
          "admin",
          { [VALUE_FREE_META_KEY]: true },
        ),
        tool(
          "createGroup",
          "backendに新しいグループを作る（人専用）",
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          "admin",
        ),
        tool(
          "listGroupBindings",
          "紐付けの一覧（人専用）——共通グループと、Project ↔ グループ",
          { type: "object", properties: {} },
          "admin",
          { [VALUE_FREE_META_KEY]: true },
        ),
        tool(
          "setGroupBinding",
          "この Project が使う backend のグループを決める（人専用）",
          {
            type: "object",
            properties: { projectId: { type: "string" }, group: { type: "string" } },
            required: ["projectId", "group"],
          },
          "admin",
        ),
        ...(opts.extraTools ?? []).map((t) => t.definition),
        tool(
          "migrateAlias",
          // **置き場を変えるのは設定ではなく操作**（追加・2026-09-14）。
          // 値が動くので、**写す → 確かめる → 消す**の順を守る
          "alias を別のグループへ移す（同じ Vault の中。値は外に出ない）",
          {
            type: "object",
            properties: {
              name: { type: "string" },
              group: { type: "string", description: "いまの置き場（同じ名前が複数あるとき）" },
              toGroup: { type: "string", description: "移す先のグループ" },
            },
            required: ["name", "toGroup"],
          },
          "admin",
        ),
        tool(
          "linkAlias",
          // **値を写さずに、別の置き場からも使えるようにする**（決定・2026-10-04、ユーザー）。
          // 「移す」は元を消し、「写す」は同じ値が2か所になる——元を1つのまま指す
          "alias を別のグループからも使えるようにする参照を作る（人専用。同じ Vault の中だけ。値は写さない）",
          {
            type: "object",
            properties: {
              name: { type: "string", description: "元の alias の名前" },
              group: { type: "string", description: "元の置き場（同じ名前が複数あるとき）" },
              toGroup: { type: "string", description: "参照を置くグループ" },
              toName: { type: "string", description: "参照の名前（省略すると元と同じ）" },
            },
            required: ["name", "toGroup"],
          },
          "admin",
        ),
        tool(
          "clearGroupBinding",
          // **付け替えのために要る**（追加・2026-09-13）。1つの Project の秘密は
          // 1つの Vault にまとめるので、別の Vault へ移すときはこちらを外す
          "この Project の紐付けを外す（人専用）",
          { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
          "admin",
        ),
        tool(
          "setSharedGroup",
          // **共通グループも選べる**（追加・2026-09-13、ユーザー指摘）。以前は
          // リテラルの決め打ちで、**そこだけ紐付けが無かった**——同じ backend を
          // 指した2台目の banto が現れると、人が何も割り当てていないのに
          // 共通の秘密が共有される（仕様が避けたかった「自動的な共有」）
          "どの Project からでも使えるグループ（共通グループ）を決める（人専用）",
          { type: "object", properties: { group: { type: "string" } }, required: ["group"] },
          "admin",
        ),
      ],
    };
  });

  /**
   * **その呼び出しが誰のためのものか**（決定・2026-09-13）。host が `_meta` に
   * 刻む——Module の自己申告ではない（申告なら詐称できる）。
   *
   * **刻印が無ければ「決められない」**。値を返す口はそこで止める（規則2）
   * ——既定を「全部使える」にすると、名乗らないだけで制限をすり抜けられる。
   */
  function callerFrom(meta: Record<string, unknown> | undefined) {
    return callerOf(meta);
  }

  /**
   * その置き場が空いているか。**同じ (グループ, 名前) だけを見る**
   * （改訂・2026-09-13）——同じ名前が別のグループに在るのは正しい状態で、
   * 素の名前と修飾名で引き分けられる（§2.1）。
   */
  /** その置き場のグループ名。 */
  function groupOf(meta: { backendPath: string }): string {
    return meta.backendPath.slice(0, meta.backendPath.indexOf("/"));
  }

  /**
   * **名前から alias を1つに決める**（追加・2026-09-13）。
   *
   * 同じ名前が「共通」と「その Project」の両方に在りうるので、名前だけでは
   * 決まらない。**呼び出し元の Project が分かれば決まる**——候補は最大2つで、
   * **Project が共通に勝つ**（狭い文脈が広い文脈を上書きする、§2.1）。
   *
   * 窓口が置き場まで分かっているときは `group` を渡してくる。そのときはそれが正。
   */
  async function findAlias(
    name: string,
    group: string | undefined,
    rawMeta: Record<string, unknown> | undefined,
  ): Promise<AliasMeta | undefined> {
    return pickAlias(await registry.list(), name, group, rawMeta);
  }

  /**
   * `findAlias` の中身。**読んだ一覧を渡す**——参照を辿る口は同じ一覧で元を引くので、
   * 台帳を2回読まない（遠くの台帳では1回ごとに往復が要る。2026-10-04）
   */
  function pickAlias(
    all: AliasMeta[],
    name: string,
    group: string | undefined,
    rawMeta: Record<string, unknown> | undefined,
  ): AliasMeta | undefined {
    const named = all.filter((m) => m.name === name);
    if (group) return named.find((m) => groupOf(m) === group);
    const caller = callerOf(rawMeta);
    const shared = bindings.sharedGroup();
    if (caller && "project" in caller) {
      const mine = bindings.get(caller.project);
      const own = mine && named.find((m) => groupOf(m) === mine);
      if (own) return own;
    }
    const inShared = named.find((m) => groupOf(m) === shared);
    if (inShared) return inShared;
    // 人の管理面（admin）は置き場を指定せずに引くことがある——1つなら通す
    return named.length === 1 ? named[0] : undefined;
  }

  /** 置き場の中のキー（"group/key" の key）。 */
  function keyOf(backendPath: string): string {
    return backendPath.slice(backendPath.indexOf("/") + 1);
  }

  /** 参照が指している元。**元が無い（か、元も参照）なら undefined**——辿るのは1段だけ。 */
  function linkTarget(link: LinkAliasMeta, all: AliasMeta[]): SecretAliasMeta | undefined {
    const target = all.find((m) => m.backendPath === link.linkTo);
    return target && !isLink(target) ? target : undefined;
  }

  /**
   * **値・鍵を取りに行く行**（追加・2026-10-04）。参照なら元、ふつうの alias ならそれ自身。
   * 使えるかどうかは**呼ぶ前に参照の置き場で**確かめてあること（参照の目的は、元の
   * グループが見えない Project から使わせることなので）。
   * **元が無ければ理由つきで断る**——黙って空や別のものを返さない（規則2）。
   */
  function valueSource(
    meta: AliasMeta,
    name: string,
    all: AliasMeta[],
    rawMeta: Record<string, unknown> | undefined,
  ): SecretAliasMeta {
    if (!isLink(meta)) return meta;
    const target = linkTarget(meta, all);
    if (!target) {
      // **元の置き場と名前は人の管理面にだけ言う**（2026-10-04、レビュー）——Project（AI・Module）に
      // 言うと、見えないはずのグループの中身が分かってしまう
      throw new Error(
        isAdmin(rawMeta)
          ? `alias "${name}" は参照ですが、元（${describeLink(meta)}）がありません` +
              "——元を作り直すか、管理画面でこの参照を消してください"
          : `alias "${name}" は参照ですが、参照の元がありません（人に伝えてください。管理画面で直せます）`,
      );
    }
    return target;
  }

  /** 参照が指している置き場（"グループ / キー"）。**人の管理面にだけ出す**。 */
  function describeLink(link: LinkAliasMeta): string {
    return `${groupOf({ backendPath: link.linkTo })} / ${keyOf(link.linkTo)}`;
  }

  function isAdmin(rawMeta: Record<string, unknown> | undefined): boolean {
    const caller = callerOf(rawMeta);
    return !!caller && "admin" in caller;
  }

  /**
   * 人に見せる形。**参照の行は元から種別を導き**、指す先をグループと名前で添える。
   * 元が無ければ `broken: true`（黙って一覧から消さない、規則2）。
   */
  function publicView(meta: AliasMeta, all: AliasMeta[]): Record<string, unknown> {
    if (!isLink(meta)) return { ...toPublic(meta) };
    const target = linkTarget(meta, all);
    return {
      ...toPublic(meta),
      ...(target ? { kind: target.kind } : { broken: true }),
      linkTo: { group: groupOf({ backendPath: meta.linkTo }), name: target ? target.name : keyOf(meta.linkTo) },
    };
  }

  /**
   * AI（と Module）に見せる形。**参照の指す先は出さない**——元のグループの見え方を
   * 変えないため（元が見えない Project に、元の置き場と名前を教えない）。
   */
  function agentView(meta: AliasMeta, all: AliasMeta[]): Record<string, unknown> {
    const { linkTo: _hidden, ...rest } = publicView(meta, all);
    return rest;
  }

  async function assertPlaceIsFree(backendPath: string): Promise<void> {
    const taken = (await registry.list()).find((m) => m.backendPath === backendPath);
    if (taken) throw new Error(`"${backendPath}" には既に別の秘密があります`);
  }

  /** 値を渡してよいか。**人の管理面（admin）は通す**、Project は紐付け次第。 */
  function assertUsable(meta: { backendPath: string }, name: string, rawMeta: Record<string, unknown> | undefined) {
    const caller = callerFrom(rawMeta);
    if (!caller) {
      throw new Error(
        `alias "${name}" を誰のために使うのかが分かりません（host が呼び出し元を刻んでいない）`,
      );
    }
    if ("admin" in caller) return; // 人が管理画面から直接触っている
    // **banto 全体のための呼び出しは、共通の秘密だけ**（追加・2026-09-16）
    // ——Project が決まらないので広げない（規則2）
    if ("instance" in caller) {
      if (scopeOf(meta).scope === "shared") return;
      throw new Error(
        `alias "${name}" は banto 全体からは使えません（共通の置き場にあるものだけ使えます）`,
      );
    }
    if (usableBy(meta, caller.project)) return;
    const where = scopeOf(meta);
    throw new Error(
      `alias "${name}" はこの Project からは使えません` +
        (where.scope === "unbound"
          ? "（どのグループにも紐付いていません——管理画面で紐付けてください）"
          : `（置き場 "${where.group}" はこの Project に紐付いていません）`),
    );
  }

  /**
   * **人の管理操作であることを確かめる**（追加・2026-09-15、レビューで発覚）。
   *
   * `admin` という可視性は、**「Module から呼べない」を意味していなかった**
   * ——host の中継が可視性で拒否していないため（効くのは「AI に見せない」と
   * 「人の画面からならゲートを飛ばす」の2つだけ）。つまり
   * `dependsOn: [{role:"vault"}]` を宣言した Module は、承認1回で
   * `setGroupBinding` を呼べ、**`resolveAlias` の制限判定そのものを書き換えられた**。
   *
   * 制限を守る側が、制限を書き換えられてはならない。
   * **台帳と紐付けを変える口は、人の刻印があるときだけ通す。**
   */
  function assertHuman(action: string, rawMeta: Record<string, unknown> | undefined) {
    const caller = callerFrom(rawMeta);
    if (caller && "admin" in caller) return;
    throw new Error(
      `${action} は人の管理画面からしか行えません` +
        (caller ? "（Module からの呼び出しでは変えられません）" : "（呼び出し元が分かりません）"),
    );
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await initPromise;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const callMeta = request.params._meta as Record<string, unknown> | undefined;

    // **この Module 固有の口は、未設定でも通す**——設定する口が設定を
    // 要求したら堂々巡りになる
    const ownTool = (opts.extraTools ?? []).find(
      (t) => (t.definition as { name?: string }).name === request.params.name,
    );
    if (ownTool) return ownTool.handle(args);

    // **使える状態でなければ、理由つきで断る**（規則2——黙って空を返さない）。
    // `requestAlias` は人に頼むだけで backend に触らないので、ここでは止めない
    if (request.params.name !== "requestAlias") await assertReady();

    switch (request.params.name) {
      case "requestAlias": {
        const name = requiredString(args.name, "name");
        const all = await registry.list();
        const existing = pickAlias(all, name, optionalString(args.group, "group"), callMeta);
        if (existing && isLink(existing) && !linkTarget(existing, all)) {
          // **在るのに使えない**（参照の元が無い）——「登録されています」と言わない（規則2）。
          // 窓口と同じ答え。元の置き場は言わない（見えないグループの中身を教えない）
          return {
            content: [
              {
                type: "text",
                text:
                  `"${name}" は登録されていますが、参照の元が無いので使えません。` +
                  "ターンを終えて人に伝えてください（管理画面で直せます）",
              },
            ],
          };
        }
        if (existing) {
          return { content: [{ type: "text", text: `alias "${name}" は既に登録されています` }] };
        }
        // **会話の中に入力欄を出して、その場で人に入れてもらう**
        // （改訂・2026-09-12、ユーザー提案）。戻り値そのものが画面のきっかけになる
        // （`_meta.ui.resourceUri`）ので、この tool はすぐ返す。
        //
        // **Elicitation はやめた。** 以前は「設定画面の Vault から登録してください」と
        // 頼んでいたが、(1) 人を会話の外へ追い出していた、(2) banto は Elicitation の
        // 応答を解決しない設計（アーキ仕様 §2.4.1 の帰結1）なので**人が答えても
        // Module には届かず**、呼び出し側は60秒のタイムアウトを待つだけだった。
        // 画面にもそう出ていた——正直ではあったが、繋がってはいなかった（規則13）。
        //
        // **値は AI を通らない**：人が打つのは iframe の中で、そこから host の
        // 画面 API 経由で Vault 自身の `admin` tool へ直接渡る。
        return {
          content: [
            {
              type: "text",
              text:
                `"${name}" を登録するための入力欄を、この会話に出しました。人が入れるまで待ってください。` +
                `**値はあなたには渡りません。** 登録されたかどうかは ${ALIASES_URI} で確かめられます` +
                `（この時点ではまだ存在しません）。`,
            },
          ],
        };
      }
      case "resolveAlias": {
        const name = requiredString(args.name, "name");
        const all = await registry.list();
        const meta = pickAlias(all, name, optionalString(args.group, "group"), callMeta);
        if (!meta) throw new Error(`alias "${name}" not found`);
        // **使えるかは、引いた行（参照ならその置き場）で決める。値は元から**（2026-10-04）
        assertUsable(meta, name, callMeta);
        const source = valueSource(meta, name, all, callMeta);
        const value = await backend.getSecret(source.backendPath);
        await registry.markUsed(meta.backendPath);
        return { content: [{ type: "text", text: String(value) }] };
      }
      case "getPublicKey": {
        const name = requiredString(args.name, "name");
        const all = await registry.list();
        const meta = pickAlias(all, name, optionalString(args.group, "group"), callMeta);
        if (!meta) throw new Error(`alias "${name}" not found`);
        // **公開鍵は秘密ではないが、どの鍵が在るかは使える範囲の話**
        // ——見える範囲は他の口と同じに揃える（規則3）
        assertUsable(meta, name, callMeta);
        // 種別は元から導く（参照は種別を持たない）
        const source = valueSource(meta, name, all, callMeta);
        if (source.kind !== "ssh-identity") {
          throw new Error(`alias "${name}" は ssh-identity ではありません（${source.kind}）`);
        }
        return { content: [{ type: "text", text: await backend.publicKeyOf(source.backendPath) }] };
      }
      case "startSshAgent": {
        const identity = requiredString(args.identity, "identity");
        const all = await registry.list();
        const meta = pickAlias(all, identity, optionalString(args.group, "group"), callMeta);
        if (!meta) throw new Error(`identity "${identity}" not found`);
        assertUsable(meta, identity, callMeta);
        const source = valueSource(meta, identity, all, callMeta);
        if (source.kind !== "ssh-identity") {
          throw new Error(`alias "${identity}" は ssh-identity ではありません（${source.kind}）`);
        }
        // 窓口を立てる場所は host の刻印だけから取る（コンテナの中の呼び出し元から見えるフォルダ）
        const socketDir = socketDirOf(callMeta);
        const { socketPath } = await backend.loadIntoAgent(source.backendPath, socketDir ? { socketDir } : undefined);
        return { content: [{ type: "text", text: JSON.stringify({ socketPath }) }] };
      }
      case "verify": {
        const alias = requiredString(args.alias, "alias");
        const all = await registry.list();
        const meta = pickAlias(all, alias, optionalString(args.group, "group"), callMeta);
        if (!meta) throw new Error(`alias "${alias}" not found`);
        assertUsable(meta, alias, callMeta);
        const source = valueSource(meta, alias, all, callMeta);
        const key = await backend.getSecret(source.backendPath);
        const expected = createHmac("sha256", String(key))
          .update(requiredString(args.payload, "payload"))
          .digest();
        // **`===` で比べない**（改訂・2026-09-12）。文字列比較は先頭から一致
        // する分だけ時間が延びるので、署名を1バイトずつ当てにいける
        // （HMAC 鍵そのものの推測ではないが、検証を素通りさせられる）。
        // 長さが違う時点で不一致——`timingSafeEqual` は長さが違うと投げる
        let actual: Buffer;
        try {
          actual = Buffer.from(requiredString(args.signature, "signature"), "hex");
        } catch {
          return { content: [{ type: "text", text: "false" }] };
        }
        const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
        return { content: [{ type: "text", text: String(ok) }] };
      }
      case "createAlias": {
        const name = requiredString(args.name, "name");
        const kind = oneOf(args.kind, ALIAS_KINDS, "kind");
        const value = requiredString(args.value, "value");
        // **置き場を直接受ける**（改訂・2026-09-13）。`scope` は保存せず
        // 置き場から導くので、入口でも「どこに置くか」だけを聞く
        const group = await groupForNewAlias({
          explicitGroup: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
        });
        const backendPath = `${group}/${name}`;
        // **既にあるものを黙って上書きしない**（追加・2026-09-13、実測で踏んだ）。
        // backend に既にある秘密も alias として数えるようになったので、
        // **人が別の用途で置いた秘密を上書きする**経路がここだった。
        // 見るのは**置き場ごと**——同じ名前が別のグループに在るのは正しい状態
        // （共通と Project、素の名前と修飾名で引き分けられる）
        await assertPlaceIsFree(backendPath);
        await backend.putSecret(backendPath, value);
        await registry.create({
          name,
          kind,
          note: optionalString(args.note, "note"),
          backendPath,
        });
        return { content: [{ type: "text", text: `created ${name}` }] };
      }
      case "putSecret": {
        const name = requiredString(args.name, "name");
        const value = requiredString(args.value, "value");
        const group = await groupForNewAlias({
          explicitGroup: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
        });
        const backendPath = `${group}/${name}`;
        // **人が預けたものは、この口からは触れない**（種別で区切る）
        const existing = (await registry.list()).find((a) => a.backendPath === backendPath);
        // **参照を通して元を上書きしない**（2026-10-04）——書き換えるなら元を
        if (existing && isLink(existing)) {
          // 元の置き場は人の管理面にだけ言う（見えないグループの中身を教えない）
          throw new Error(
            isAdmin(callMeta)
              ? `"${name}" は参照です（元は ${describeLink(existing)}）。値を変えるなら元を書き換えてください`
              : `"${name}" は参照なので書き換えられません`,
          );
        }
        if (existing && existing.kind !== BANTO_OWNED_KIND) {
          throw new Error(
            `"${name}" は人が預けた秘密です（${existing.kind}）。この口からは置き換えられません`,
          );
        }
        await backend.putSecret(backendPath, value);
        if (!existing) {
          await registry.create({
            name,
            kind: BANTO_OWNED_KIND,
            note: optionalString(args.note, "note"),
            backendPath,
          });
        }
        return { content: [{ type: "text", text: `stored ${name}` }] };
      }
      case "generateSecret": {
        const name = requiredString(args.name, "name");
        const kind = args.kind === undefined ? "secret" : oneOf(args.kind, GENERATABLE_KINDS, "kind");
        const note = optionalString(args.note, "note");
        const group = await groupForNewAlias({
          explicitGroup: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
        });
        const common = { name, note };
        await assertPlaceIsFree(`${group}/${name}`);

        if (kind === "ssh-identity") {
          // **秘密鍵の作り方は backend の仕事**（仕様 §2.1 D）——返るのは公開鍵と
          // 参照だけで、backend によっては秘密鍵が一度もプロセスに出てこない。
          // **ただし置き場は呼び出し側が決める**（改訂・2026-09-13）。以前は
          // backend が `ssh-identities` を決め打ちしていたので、鍵だけが
          // どのグループにも紐付かず、**alias 名が公開鍵の断片に化けてもいた**
          // ——置き場を決める主体が2つあったのが根。
          if (args.format !== undefined || args.bytes !== undefined) {
            // 鍵の強さは鍵の種類が決める。**渡されたものを黙って捨てない**（規則2）
            throw new Error("ssh-identity では format / bytes は指定できません");
          }
          const { publicKey, privateKeyRef } = await backend.generateKeypair("ssh", `${group}/${name}`);
          if (!privateKeyRef.startsWith(`${group}/`)) {
            // **言われた場所に置けなかったなら止まる**（規則2）——黙って別の
            // ところに置かれると、その鍵はどの Project からも使えなくなる
            throw new Error(
              `backend が指定した置き場に鍵を作りませんでした（頼んだ: ${group}/${name}、返った: ${privateKeyRef}）`,
            );
          }
          await registry.create({ ...common, kind: "ssh-identity", backendPath: privateKeyRef });
          // **公開鍵は秘密ではない**——むしろ返さないと使えない
          // （GitHub 等に登録するのは人）
          return {
            content: [{ type: "text", text: JSON.stringify({ ...common, kind, publicKey }) }],
          };
        }

        const format = args.format === undefined ? "base64url" : oneOf(args.format, SECRET_FORMATS, "format");
        const bytes = args.bytes === undefined ? DEFAULT_SECRET_BYTES : Number(args.bytes);
        if (!Number.isInteger(bytes) || bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
          throw new Error(`bytes は ${MIN_SECRET_BYTES}〜${MAX_SECRET_BYTES} の整数です（${String(args.bytes)} が来ました）`);
        }

        const backendPath = `${group}/${name}`;
        // **暗号論的乱数で作る**（`Math.random` ではない、規則12——名前のある
        // 解決済みのものを使う）。値はこの行から backend へ渡るだけで、
        // 戻り値にも記録にも載せない
        const value = randomBytes(bytes).toString(format === "hex" ? "hex" : "base64url");
        await backend.putSecret(backendPath, value);
        await registry.create({ ...common, kind: "secret", backendPath });
        // **返すのは「何を作ったか」まで。値は返さない**
        return { content: [{ type: "text", text: JSON.stringify({ ...common, kind, format, bytes }) }] };
      }
      case "updateAlias": {
        assertHuman("alias の書き換え", callMeta);
        // **値は変えない**——ここで変えられるのは人が付けた覚え書きと、どこの
        // ものかだけ。値の差し替えは作り直し（消して作る）にする：中途半端に
        // 上書きできると、「いつ何に変わったか」が alias の外から分からなくなる
        const name = requiredString(args.name, "name");
        const existing = await findAlias(name, optionalString(args.group, "group"), callMeta);
        if (!existing) throw new Error(`alias "${name}" not found`);
        // **置き場は動かせない**（改訂・2026-09-13）。以前は `scope` を
        // 付け替えられたが、**値は元のグループに残ったまま**だったので、
        // 画面の表示だけが変わる嘘になっていた。誰が使えるかを変えるのは
        // 「グループの紐付けを変える」か「作り直す」のどちらか
        if (args.scope !== undefined || args.projectId !== undefined) {
          throw new Error(
            "使える範囲は alias では変えられません（グループの紐付けを変えるか、作り直してください）",
          );
        }
        await registry.update(existing.backendPath, { note: optionalString(args.note, "note") });
        return { content: [{ type: "text", text: `updated ${name}` }] };
      }
      case "deleteAlias": {
        assertHuman("alias の削除", callMeta);
        const name = requiredString(args.name, "name");
        const group = optionalString(args.group, "group");
        const meta = await findAlias(name, group, callMeta);
        // **無いものを「消した」と言わない**（訂正・2026-09-15、規則1）。
        // 以前は見つからなくても `deleted <name>` を返していたので、
        // **置き場を間違えた削除が成功に見えていた**——`moved: false` で
        // 直したのと同じ形
        if (!meta) {
          throw new Error(
            group ? `alias "${name}" は ${group} にありません` : `alias "${name}" はありません`,
          );
        }
        if (isLink(meta)) {
          // **参照を消しても元は消えない**（2026-10-04）——値を持っていないので、
          // backend の秘密には触らない（組み込みでは存在しない秘密を消しにいかない）
          await registry.deleteLink(meta.backendPath);
        } else {
          // 元を消しても、それを指す参照は残す——一覧で「元がありません」と出る（規則2）
          await backend.deleteSecret(meta.backendPath);
          await registry.delete(meta.backendPath);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted: true, name, group: groupOf(meta) }) }],
        };
      }
      case "listAliases": {
        // **値は返さない**（§2.1——人が見るのは「どれが登録されているか」まで）。
        // **使える範囲は保存せず導く**（規則3）。
        //
        // **絞るのは、ここ**（訂正・2026-09-15、レビューで発覚）。以前は無条件に
        // 全部返し、「絞るのは横断した側の仕事」としていた。しかしこの口は
        // `valueFree` なので**初回承認すら出ない**——`dependsOn: [{role:"vault"}]`
        // を宣言した任意の Module が、**承認ゼロで全 Project の目録**
        // （名前・用途・グループ・紐付き）を読めていた。窓口で絞っても、
        // 窓口以外の呼び出し元には効かない。**判定は、材料が在る場所で行う。**
        const caller = callerFrom(callMeta);
        if (!caller) {
          // 刻印が無い＝誰のためか決められない。**空ではなく、断る**
          // （「無い」と「決められない」を混ぜない・規則2）
          throw new Error("一覧を誰のために読むのかが分かりません（host が呼び出し元を刻んでいない）");
        }
        // 人の管理面は全部（「どこにも紐付いていない」も——隠すと直せない）。
        // Project は、その Project から使えるものだけ
        const stored = await registry.list();
        const visible =
          "admin" in caller
            ? stored
            : "instance" in caller
              ? stored.filter((m) => scopeOf(m).scope === "shared")
              : stored.filter((m) => usableBy(m, caller.project));
        return {
          content: [
            {
              type: "text",
              // **参照の指す先は人の管理面にだけ出す**（2026-10-04）——Project から読むと、
              // 見えないはずの元の置き場と名前が分かってしまう
              text: JSON.stringify(
                visible.map((m) => ({
                  ...("admin" in caller ? publicView(m, stored) : agentView(m, stored)),
                  ...scopeOf(m),
                })),
              ),
            },
          ],
        };
      }
      case "listGroups":
        return { content: [{ type: "text", text: JSON.stringify(await backend.listGroups()) }] };
      case "createGroup":
        await backend.createGroup(requiredString(args.name, "name"));
        return { content: [{ type: "text", text: "ok" }] };
      case "listGroupBindings":
        return {
          content: [
            { type: "text", text: JSON.stringify({ shared: bindings.sharedGroup(), projects: bindings.list() }) },
          ],
        };
      case "migrateAlias": {
        assertHuman("置き場の変更", callMeta);
        const name = requiredString(args.name, "name");
        const toGroup = requiredString(args.toGroup, "toGroup");
        const meta = await findAlias(name, optionalString(args.group, "group"), callMeta);
        if (!meta) throw new Error(`alias "${name}" not found`);
        const from = meta.backendPath;
        const to = `${toGroup}/${name}`;
        if (from === to) return { content: [{ type: "text", text: JSON.stringify({ ok: true, moved: false }) }] };
        // **先に衝突を見る**（規則2——黙って上書きしない）
        await assertPlaceIsFree(to);
        await backend.createGroup(toGroup);

        if (isLink(meta)) {
          // **参照を移すと、参照だけが動く**（指す先は同じ。2026-10-04）。値は無いので写さない
          await registry.createLink({ ...meta, backendPath: to });
          await registry.deleteLink(from);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, moved: true, from, to }) }] };
        }

        // **写す → 確かめる → 消す**。途中で落ちても「両方にある」で済み、
        // **値は失われない**（先に消すと、写す前に落ちたら秘密が消える）
        const value = await backend.getSecret(from);
        await backend.putSecret(to, value);
        const copied = await backend.getSecret(to);
        if (String(copied) !== String(value)) {
          // 写せていないのに消したら秘密が消える。**確かめてから消す**
          throw new Error(`"${name}" を写せませんでした（${from} → ${to}）。元は残っています`);
        }
        await registry.create({ ...meta, backendPath: to });
        // **元を指す参照は、新しい場所を指し直す**（2026-10-04）。**消す前に**——途中で
        // 落ちても、参照は古い元（まだ在る）か新しい元のどちらかを指していて切れない
        const links = (await registry.list()).filter((m) => isLink(m) && m.linkTo === from);
        for (const link of links) await registry.retargetLink(link.backendPath, to);
        await backend.deleteSecret(from);
        await registry.delete(from);
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, moved: true, from, to, relinked: links.length }) },
          ],
        };
      }
      case "linkAlias": {
        // **作れるのは人が管理画面から押したときだけ**（2026-10-04）——作れると、
        // 見えないはずのグループの秘密を自分の見える場所へ引き込める
        assertHuman("参照を作る", callMeta);
        const name = requiredString(args.name, "name");
        const toGroup = requiredString(args.toGroup, "toGroup");
        const toName = optionalString(args.toName, "toName") ?? name;
        if (toName.trim() === "") throw new Error("toName が空です");
        const group = optionalString(args.group, "group");
        // **元は置き場で指す**（移すと同じ）——指定したら既定の解決に落ちない
        const origin = await findAlias(name, group, callMeta);
        if (!origin) {
          throw new Error(group ? `alias "${name}" は ${group} にありません` : `alias "${name}" はありません`);
        }
        // **参照の参照は作らない**——辿る段数を1に固定する
        if (isLink(origin)) {
          throw new Error(
            `"${name}" は参照です。参照の参照は作れません——元（${groupOf({ backendPath: origin.linkTo })} / ${keyOf(origin.linkTo)}）を指してください`,
          );
        }
        const to = `${toGroup}/${toName}`;
        // **置く先に同じ名前があれば上書きせずに断る**（移すと同じ）
        await assertPlaceIsFree(to);
        await backend.createGroup(toGroup); // 名前の検査もここが持つ
        await registry.createLink({ name: toName, backendPath: to, linkTo: origin.backendPath });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                name: toName,
                group: toGroup,
                linkTo: { group: groupOf(origin), name: origin.name },
              }),
            },
          ],
        };
      }
      case "clearGroupBinding": {
        assertHuman("紐付けの解除", callMeta);
        await bindings.clear(requiredString(args.projectId, "projectId"));
        return { content: [{ type: "text", text: "ok" }] };
      }
      case "setSharedGroup": {
        assertHuman("共通の置き場の変更", callMeta);
        const group = requiredString(args.group, "group");
        await backend.createGroup(group); // 名前の検査は backend が持つ（規則3）
        await bindings.setSharedGroup(group);
        return { content: [{ type: "text", text: JSON.stringify({ shared: group }) }] };
      }
      case "setGroupBinding": {
        assertHuman("置き場の紐付け", callMeta);
        const projectId = requiredString(args.projectId, "projectId");
        const group = requiredString(args.group, "group");
        // 名前の検査は backend が持つ（規則3——同じ検査を2箇所に書かない）。
        // 事前作成が要らない backend では no-op
        await backend.createGroup(group);
        await bindings.set(projectId, group);
        return { content: [{ type: "text", text: JSON.stringify({ projectId, group }) }] };
      }
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  });

  /**
   * **1件ずつの資源はテンプレートで示す**（改訂・2026-09-26、実測）。
   *
   * 以前は `resources/list` に alias を1つずつ並べていた。一覧を作るには金庫に
   * 問い合わせるしかなく、外の金庫（Infisical）では**資源の一覧1回が 1.4〜2.3 秒**
   * かかった。host は設定画面・Skill 一覧・Command Palette・会話の最初のターンの前に
   * 全 Module の `resources/list` を呼ぶので、**人のほぼすべての操作がこれを待っていた**
   * （docs/notes/2026-09-25-latency-review.md §2.1）。
   *
   * 数えきれない（数が金庫の中身で決まる）資源は `resources/templates/list` に
   * 載せるのが MCP の決まった形で、FileSystem の `file:///{path}` と同じ
   * （アーキ仕様 v4-modules.md の「パラメータ付きの資源」）。読み方は変わらない
   * ——`vault://aliases/<name>` をそのまま読めば、以前と同じ中身が返る。
   * 一覧が要るなら `vault://aliases`（1本）を読む。
   *
   * これで `resources/list` は金庫に触らない——**未設定の Module でも自分を名乗れる**
   * （2026-09-15 の訂正の意図）ことも、条件分岐なしで成り立つ。
   */
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${ALIASES_URI}/{name}`,
        name: "秘密1件のメタデータ（alias）",
        description: "vault://aliases に載っている name を1つ入れて読む。値は含まない。",
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: agentVisibility },
      },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    assertInitNotFailed();
    return {
      resources: [
        // **設定 Canvas**（決定・2026-09-07）。Vault は instance に1本なので、
        // banto 全体の設定画面に出る——置き場はこの Module の scope が決める。
        // **持たない Module もあってよい**（無いものを在るふりで出さない、規則13）
        ...(opts.configApp
          ? [
              {
                uri: opts.configApp.uri,
                name: opts.configApp.name,
                mimeType: "text/html;profile=mcp-app",
                _meta: {
                  [VISIBILITY_META_KEY]: "admin",
                  [CANVAS_META_KEY]: "config",
                  ui: { prefersBorder: false },
                },
              },
            ]
          : []),
        // **自分が何者かを名乗る**（決定・2026-09-06、アーキ仕様 §5.4
        // 「banto の拡張は _meta に載せる」）。host は宣言（Config）と
        // 突き合わせ、**より厳しい方向の申告だけ**を採る。
        // visibility は admin＝AI には見せない（host だけが読む）。
        {
          uri: `${moduleName}://module`,
          name: "この Module の申告",
          mimeType: "application/json",
          _meta: {
            [VISIBILITY_META_KEY]: "admin",
            [MODULE_META_KEY]: {
              satisfies: ["vault"],
              dependsOn: [],
              isolation: "subprocess",
              scope: "instance",
              handlesSecrets: true,
            },
          },
        },
        {
          // **会話の中に出す入力欄**（決定・2026-09-12）。`requestAlias` の
          // 結果がこれを開く。**可視性は agent**——この資源を読むのは、AI が
          // 呼んだ tool の画面として host が開くときだから（中身は空の HTML で、
          // 秘密は1つも含まない）
          uri: REQUEST_APP_URI,
          name: "秘密の登録",
          mimeType: "text/html;profile=mcp-app",
          _meta: { [VISIBILITY_META_KEY]: agentVisibility, ui: { prefersBorder: true } },
        },
        {
          // **一覧そのもの**（§2.1 A節、追加・2026-09-12）。読み取りハンドラは
          // 前から通っていたのに一覧に載せていなかったので、AI は URI を
          // 知らないと辿り着けなかった——「AI 向けの入口」が実質無い状態だった
          uri: ALIASES_URI,
          name: "使える秘密の一覧（alias）",
          description:
            "この banto が預かっている秘密の**名前だけ**の一覧（値は含まない）。" +
            "秘密を使うときは、この name を Shell の envSecrets / secretFiles / sshIdentity に渡す。" +
            "欲しいものが無ければ requestAlias で人に頼む。" +
            "項目：name / kind / scope / projectId / note / lastUsedAt",
          mimeType: "application/json",
          _meta: { [VISIBILITY_META_KEY]: agentVisibility },
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // 画面の HTML は決まった中身——起動を待たない（設定画面の見出しと中身がすぐ出る）
    if (opts.configApp && request.params.uri === opts.configApp.uri) {
      return {
        contents: [
          { uri: opts.configApp.uri, mimeType: "text/html;profile=mcp-app", text: opts.configApp.html },
        ],
      };
    }
    if (request.params.uri === REQUEST_APP_URI) {
      return {
        contents: [{ uri: REQUEST_APP_URI, mimeType: "text/html;profile=mcp-app", text: REQUEST_APP_HTML }],
      };
    }
    await initPromise;
    if (request.params.uri === ALIASES_URI) {
      await assertReady();
      // **使えないものは名前も見せない**（決定・2026-09-13）——AI に
      // 「あるが使えない」を見せても、頼める先が無い
      const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
      const all = await registry.list();
      const visible = !caller
        ? []
        : "admin" in caller
          ? all
          : "instance" in caller
            ? all.filter((m) => scopeOf(m).scope === "shared")
            : all.filter((m) => usableBy(m, caller.project));
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(visible.map((m) => agentView(m, all))),
          },
        ],
      };
    }
    const match = request.params.uri.match(/^vault:\/\/aliases\/(.+)$/);
    if (match) {
      const meta = await findAlias(match[1]!, undefined, request.params._meta as Record<string, unknown> | undefined);
      if (!meta) throw new Error("not found");
      assertUsable(meta, match[1]!, request.params._meta as Record<string, unknown> | undefined);
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(agentView(meta, await registry.list())),
          },
        ],
      };
    }
    throw new Error(`unknown resource: ${request.params.uri}`);
  });

  return server;
}
