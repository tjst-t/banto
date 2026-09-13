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
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callerOf,
  VALUE_FREE_META_KEY,
  VISIBILITY_META_KEY,
  MODULE_META_KEY,
  CANVAS_META_KEY,
} from "@banto/module-contract";
import { REQUEST_APP_HTML, requestAppUri } from "./request-app.js";
import { toPublic, type AliasStore } from "./alias-store.js";
import { GroupBindings } from "./group-bindings.js";
import type { VaultBackend } from "./backend.js";

/** 一覧の resource（§2.1 A節）。**単体の `vault://aliases/{name}` と対**。 */
const ALIASES_URI = "vault://aliases";

/** instance 全体の alias を置く既定のグループ。 */
const INSTANCE_GROUP = "instance";

const ALIAS_KINDS = ["secret", "ssh-identity", "file"] as const;
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

  function tool(
    name: string,
    description: string,
    inputSchema: unknown,
    visibility: "agent" | "module" | "admin",
    meta: Record<string, unknown> = {},
  ) {
    return { name, description, inputSchema, _meta: { [VISIBILITY_META_KEY]: visibility, ...meta } };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await initPromise;
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

  /** 値を渡してよいか。**人の管理面（admin）は通す**、Project は紐付け次第。 */
  function assertUsable(meta: { backendPath: string }, name: string, rawMeta: Record<string, unknown> | undefined) {
    const caller = callerFrom(rawMeta);
    if (!caller) {
      throw new Error(
        `alias "${name}" を誰のために使うのかが分かりません（host が呼び出し元を刻んでいない）`,
      );
    }
    if ("admin" in caller) return; // 人が管理画面から直接触っている
    if (usableBy(meta, caller.project)) return;
    const where = scopeOf(meta);
    throw new Error(
      `alias "${name}" はこの Project からは使えません` +
        (where.scope === "unbound"
          ? "（どのグループにも紐付いていません——管理画面で紐付けてください）"
          : `（置き場 "${where.group}" はこの Project に紐付いていません）`),
    );
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await initPromise;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const callMeta = request.params._meta as Record<string, unknown> | undefined;

    switch (request.params.name) {
      case "requestAlias": {
        const name = requiredString(args.name, "name");
        if (await registry.get(name)) {
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
        const meta = await registry.get(name);
        if (!meta) throw new Error(`alias "${name}" not found`);
        assertUsable(meta, name, callMeta);
        const value = await backend.getSecret(meta.backendPath);
        await registry.markUsed(name);
        return { content: [{ type: "text", text: String(value) }] };
      }
      case "startSshAgent": {
        const identity = requiredString(args.identity, "identity");
        const meta = await registry.get(identity);
        if (!meta) throw new Error(`identity "${identity}" not found`);
        if (meta.kind !== "ssh-identity") {
          throw new Error(`alias "${identity}" は ssh-identity ではありません（${meta.kind}）`);
        }
        assertUsable(meta, identity, callMeta);
        const { socketPath } = await backend.loadIntoAgent(meta.backendPath);
        return { content: [{ type: "text", text: JSON.stringify({ socketPath }) }] };
      }
      case "verify": {
        const alias = requiredString(args.alias, "alias");
        const meta = await registry.get(alias);
        if (!meta) throw new Error(`alias "${alias}" not found`);
        assertUsable(meta, alias, callMeta);
        const key = await backend.getSecret(meta.backendPath);
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
        await backend.putSecret(backendPath, value);
        await registry.create({
          name,
          kind,
          note: optionalString(args.note, "note"),
          backendPath,
        });
        return { content: [{ type: "text", text: `created ${name}` }] };
      }
      case "generateSecret": {
        const name = requiredString(args.name, "name");
        const kind = args.kind === undefined ? "secret" : oneOf(args.kind, GENERATABLE_KINDS, "kind");
        if (await registry.get(name)) throw new Error(`alias "${name}" は既にあります`);
        const note = optionalString(args.note, "note");
        const group = await groupForNewAlias({
          explicitGroup: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
        });
        const common = { name, note };

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
        // **値は変えない**——ここで変えられるのは人が付けた覚え書きと、どこの
        // ものかだけ。値の差し替えは作り直し（消して作る）にする：中途半端に
        // 上書きできると、「いつ何に変わったか」が alias の外から分からなくなる
        const name = requiredString(args.name, "name");
        const existing = await registry.get(name);
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
        await registry.update(name, { note: optionalString(args.note, "note") });
        return { content: [{ type: "text", text: `updated ${name}` }] };
      }
      case "deleteAlias": {
        const name = requiredString(args.name, "name");
        const meta = await registry.get(name);
        if (meta) await backend.deleteSecret(meta.backendPath);
        await registry.delete(name);
        return { content: [{ type: "text", text: `deleted ${name}` }] };
      }
      case "listAliases": {
        // **値は返さない**（§2.1——人が見るのは「どれが登録されているか」まで）。
        // **使える範囲は保存せず導く**（規則3）——人の画面には「どこにも
        // 紐付いていない」も含めて全部出す（隠すと直せない）
        return {
          content: [
            { type: "text", text: JSON.stringify((await registry.list()).map((m) => ({ ...toPublic(m), ...scopeOf(m) }))) },
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
      case "setSharedGroup": {
        const group = requiredString(args.group, "group");
        await backend.createGroup(group); // 名前の検査は backend が持つ（規則3）
        await bindings.setSharedGroup(group);
        return { content: [{ type: "text", text: JSON.stringify({ shared: group }) }] };
      }
      case "setGroupBinding": {
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await initPromise;
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
      ...(await registry.list()).map((a: { name: string }) => ({
        uri: `${ALIASES_URI}/${a.name}`,
        name: a.name,
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: agentVisibility },
      })),
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await initPromise;
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
    if (request.params.uri === ALIASES_URI) {
      // **使えないものは名前も見せない**（決定・2026-09-13）——AI に
      // 「あるが使えない」を見せても、頼める先が無い
      const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
      const all = await registry.list();
      const visible = !caller
        ? []
        : "admin" in caller
          ? all
          : all.filter((m) => usableBy(m, caller.project));
      return {
        contents: [
          { uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(visible.map(toPublic)) },
        ],
      };
    }
    const match = request.params.uri.match(/^vault:\/\/aliases\/(.+)$/);
    if (match) {
      const meta = await registry.get(match[1]!);
      if (!meta) throw new Error("not found");
      assertUsable(meta, match[1]!, request.params._meta as Record<string, unknown> | undefined);
      return {
        contents: [
          { uri: request.params.uri, mimeType: "application/json", text: JSON.stringify(toPublic(meta)) },
        ],
      };
    }
    throw new Error(`unknown resource: ${request.params.uri}`);
  });

  return server;
}
