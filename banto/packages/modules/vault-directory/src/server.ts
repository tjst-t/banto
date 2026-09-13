#!/usr/bin/env node
// **vault-directory——名前から在りかを引く窓口**（決定・2026-09-12。
// 旧 VaultUI を発展させた。docs/specs/v4-modules.md §2.1）。
//
// **これは vault backend ではない。秘密を1つも保管しない。** `vault` 役割を
// 名乗る実装を**全部横断して**、AI と人と他 Module に**1つの窓口**を見せる。
//
// **非対称にする**のが要——値が通る道と通らない道を分ける：
//
//   通らない（窓口が持つ）        通る（backend へ直行のまま）
//   ─────────────────────       ──────────────────────────
//   requestAlias（AI 向け）       resolveAlias
//   vault://aliases（横断）        startSshAgent
//   lookupAlias（名前→在りか）
//   人の管理操作（admin）
//
// **なぜ値を通さないか**：仕様 §2.1 冒頭が単一 Module 方式を選んだ理由は
// 「Module を分けると**値**が余分な1ホップを通り、D5 が弱まる」。窓口に値を
// 通すとこれに当たるが、**メタデータだけなら当たらない**——だから
// `resolveAlias` は今までどおり呼び出し元 → host → backend の直行に保つ。
// 名前を引いてから直接話す形は DNS と同じ（規則12——名前のある解）。
//
// **なぜ窓口が要るか**（実測・2026-09-12、2本目を足して分かった）：
// backend が2本になると AI には `requestAlias` が2つ・`vault://aliases` が
// 2つ並び、**AI はどちらを選ぶ材料を持たない**（走らせるたびに選ぶ先が変わる）。
// 入力欄も backend の数だけ要る——MCP Apps の仕様上、tool の画面は
// **その tool を持つサーバのもの**だから（`visibility: "app"` の定義）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callerOf, VISIBILITY_META_KEY, MODULE_META_KEY, CANVAS_META_KEY } from "@banto/module-contract";
import { MANAGE_APP_HTML, MANAGE_APP_URI, UI_APP_MIME } from "./manage-app.js";
import { REQUEST_APP_HTML, requestAppUri } from "@banto/vault-kit";

/** 会話の中の入力欄。**窓口が1枚だけ持つ**——backend ごとに同じ画面を持たない */
const REQUEST_APP_URI = requestAppUri("vault-directory");
import type { RelayLike } from "./relay-client.js";

/** 横断のために使う role。**1つ選ばない**——名乗っている実装は全部相手にする。 */
const VAULT_ROLE = "vault";

export interface VaultDirectoryDeps {
  relay: RelayLike;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} が要ります`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} は文字列です`);
  return value;
}

/** その alias が「どの backend のものか」を必ず添える——横断すると名前だけでは足りない。 */
interface TaggedAlias extends Record<string, unknown> {
  implementation: string;
}

export function createVaultDirectoryServer(deps: VaultDirectoryDeps) {
  const server = new Server(
    { name: "banto-module-vault-directory", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  /** `vault` を名乗っている Module の名前。**host に聞く**（決め打ちしない）。 */
  async function vaultImplementations(): Promise<string[]> {
    const targets = await deps.relay.listTargets();
    return targets.filter((t) => t.roles.includes(VAULT_ROLE)).map((t) => t.name);
  }

  /**
   * 全実装に同じ問い合わせを投げ、**答えられなかった実装も結果に残す**。
   *
   * 1本が落ちているときに一覧を空にするのも、黙って飛ばすのも違う（規則2）
   * ——「この backend は今こういう理由で読めていない」を画面に出せる形で返す。
   */
  async function acrossVaults<T>(
    fn: (implementation: string) => Promise<T>,
  ): Promise<Array<{ implementation: string; ok: true; value: T } | { implementation: string; ok: false; error: string }>> {
    const impls = await vaultImplementations();
    return Promise.all(
      impls.map(async (implementation) => {
        try {
          return { implementation, ok: true as const, value: await fn(implementation) };
        } catch (err) {
          return {
            implementation,
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  /**
   * 繋がっている Vault を横断した alias の一覧。**値は含まない。**
   *
   * **読めなかった backend を黙って消さない**（規則2）——一覧が短く見えた
   * 理由を、呼び出し側が出せる形で返す。
   */
  async function crossAliases(): Promise<{
    aliases: TaggedAlias[];
    failures: Array<{ implementation: string; error: string }>;
  }> {
    const results = await acrossVaults(async (implementation) => {
      const body = await deps.relay.callTool(implementation, "listAliases", {});
      return JSON.parse(body) as Array<Record<string, unknown>>;
    });
    const aliases: TaggedAlias[] = [];
    const failures: Array<{ implementation: string; error: string }> = [];
    for (const r of results) {
      if (r.ok) aliases.push(...r.value.map((a) => ({ ...a, implementation: r.implementation })));
      else failures.push({ implementation: r.implementation, error: r.error });
    }
    return { aliases, failures };
  }

  /**
   * **窓口も絞る**（決定・2026-09-13）。backend の `listAliases` は人の管理面
   * （admin）なので**全部返す**——窓口がそれをそのまま AI に渡すと、
   * せっかくの制限を素通りする。横断した目録を出すのは窓口の仕事なので、
   * **絞るのも窓口の仕事**。
   *
   * 判定の材料は backend が導出して返している（`scope` / `projects`）
   * ——ここで紐付けを引き直さない（規則3）。
   */
  function usableBy(alias: Record<string, unknown>, caller: ReturnType<typeof callerOf>): boolean {
    if (!caller) return false; // 誰のためか分からないなら見せない（規則2）
    if ("admin" in caller) return true;
    if (alias.scope === "shared") return true;
    return Array.isArray(alias.projects) && (alias.projects as string[]).includes(caller.project);
  }

  /** AI に見せる形。**金庫の名前も置き場も見せない**——選ばせる材料にしない。 */
  function forAgent(alias: Record<string, unknown>): Record<string, unknown> {
    const { implementation: _i, group: _g, projects: _p, scope: _s, ...rest } = alias;
    return rest;
  }

  function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
    return {
      name,
      description,
      inputSchema: { type: "object", properties, required },
      // 人専用——AI には1つも見せない
      _meta: { [VISIBILITY_META_KEY]: "admin" },
    };
  }

  const IMPL = { implementation: { type: "string", description: "どの vault 実装に対してか" } };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ---- AI に見せるのはこの1本だけ（§2.1 A）------------------------------
      {
        name: "requestAlias",
        description:
          "必要な秘密（トークン・鍵）が無いとき、人に登録を頼む。**値は受け取らない**" +
          "——あなたが秘密の中身を見ることはない。秘密は「alias 名」で扱う：" +
          "登録済みの一覧は resource `vault://aliases`（**繋がっている Vault を横断した1つ**）、" +
          "実際に使うときは値ではなく alias 名を Shell の envSecrets / secretFiles / sshIdentity に渡す。" +
          "まず `vault://aliases` を見て、必要なものが無いときだけこれを呼ぶ。",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "登録してほしい alias の名前（例 github-token）" },
            hint: { type: "string", description: "何に使うのか。人はこれを見て判断する" },
            kind: {
              type: "string",
              enum: ["secret", "ssh-identity", "file"],
              description: "secret＝汎用の文字列／ssh-identity＝SSH 鍵／file＝ファイルの中身",
            },
          },
          required: ["name"],
        },
        // **入力欄は1枚**（窓口が持つ）。どの Vault に入れるかは人が画面で選ぶ
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { resourceUri: REQUEST_APP_URI } },
      },
      // ---- 他の Module 向け（§2.1 B）：**名前 → 在りか。値は返さない** -------
      {
        name: "lookupAlias",
        description:
          "alias の名前から、**どの Vault にあるか**を引く（値は返さない）。" +
          "引いたあとは、その Vault の resolveAlias / startSshAgent を**直接**呼ぶ" +
          "——値はこの窓口を通らない",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        _meta: { [VISIBILITY_META_KEY]: "module" },
      },
      tool("listVaults", "繋がっている vault 実装の一覧", {}),
      tool("listAliases", "全実装を横断した alias の一覧（値は含まない）", {}),
      tool(
        "createAlias",
        "alias を新規登録する",
        {
          ...IMPL,
          name: { type: "string" },
          kind: { type: "string", enum: ["secret", "ssh-identity", "file"] },
          value: { type: "string" },
          note: { type: "string" },
          group: { type: "string", description: "置き場（グループ）を直に指定する" },
          forProject: { type: "string", description: "この Project から使えるようにする。省略すると共通グループ" },
        },
        ["name", "kind", "value"],
      ),
      tool(
        "generateSecret",
        "新しい秘密を Vault の中で作って登録する（秘密の値は返らない。SSH なら公開鍵だけ返る）",
        {
          ...IMPL,
          name: { type: "string" },
          kind: { type: "string", enum: ["secret", "ssh-identity"] },
          group: { type: "string", description: "置き場（グループ）を直に指定する" },
          forProject: { type: "string", description: "この Project から使えるようにする。省略すると共通グループ" },
          note: { type: "string" },
          format: { type: "string", enum: ["base64url", "hex"] },
          bytes: { type: "number" },
        },
        ["name"],
      ),
      tool(
        "updateAlias",
        "alias の覚え書き・対象を変える（値は変えない）",
        { ...IMPL, name: { type: "string" }, note: { type: "string" } },
        ["implementation", "name"],
      ),
      tool("deleteAlias", "alias を削除する", { ...IMPL, name: { type: "string" } }, ["implementation", "name"]),
      tool("listGroups", "その実装のグループ一覧と、Project との紐付け", IMPL, ["implementation"]),
      tool("createGroup", "その実装に新しいグループを作る", { ...IMPL, name: { type: "string" } }, [
        "implementation",
        "name",
      ]),
      tool(
        "setGroupBinding",
        "この Project が使うグループを決める",
        { ...IMPL, projectId: { type: "string" }, group: { type: "string" } },
        ["implementation", "projectId", "group"],
      ),
      tool(
        "setSharedGroup",
        // **共通グループも選べる**（追加・2026-09-13）。以前は決め打ちで、
        // そこだけ紐付けが無かった——2台目の banto が同じ backend を指すと、
        // 人が何も割り当てていないのに共通の秘密が共有されていた
        "どの Project からでも使えるグループ（共通グループ）を決める",
        { ...IMPL, group: { type: "string" } },
        ["implementation", "group"],
      ),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    /** host が刻んだ「誰のための呼び出しか」。**Module の自己申告ではない**。 */
    const callMeta = request.params._meta as Record<string, unknown> | undefined;
    const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

    /**
     * 宛先の実装を、**host が許した一覧の中から**確かめて選ぶ（fail closed）。
     *
     * **1本しか繋がっていなければ、指定は要らない**（追加・2026-09-12）
     * ——選択肢が1つのときに選ばせない（規則13）。人の画面もそのときは
     * 「どの Vault に入れるか」を出さない。
     */
    async function target(): Promise<string> {
      const known = await vaultImplementations();
      const implementation = optionalString(args.implementation, "implementation");
      if (!implementation) {
        if (known.length === 1) return known[0]!;
        throw new Error(
          `どの Vault に入れるか決まりません（繋がっているもの: ${known.join(", ") || "無し"}）`,
        );
      }
      if (!known.includes(implementation)) {
        throw new Error(`"${implementation}" は vault を名乗っていないか、繋がっていません`);
      }
      return implementation;
    }

    /**
     * **alias の名前は instance 全体で一意**（決定・2026-09-12）。
     *
     * 名前で引いて使う（`lookupAlias` → その Vault へ直行）以上、同じ名前が
     * 2つあると**どちらの秘密か決められない**。登録の入口は窓口1本なので、
     * ここで止められる。**データに掛かる制約は、後から入れるほど高い。**
     */
    async function assertNameIsFree(name: string): Promise<void> {
      const taken = (await crossAliases()).aliases.find((a) => a.name === name);
      if (taken) {
        throw new Error(`alias "${name}" は既に ${taken.implementation} にあります（名前は全体で一意）`);
      }
    }

    switch (request.params.name) {
      case "requestAlias": {
        const name = requiredString(args.name, "name");
        // **すぐ返す**（人を待って呼び出しを止めない）。戻り値そのものが
        // 会話の中の入力欄を開く（`_meta.ui.resourceUri`）
        const existing = (await crossAliases()).aliases.find((a) => a.name === name);
        if (existing) {
          return {
            content: [{ type: "text", text: `alias "${name}" は既に登録されています（${existing.implementation}）` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `"${name}" を登録するための入力欄を、この会話に出しました。人が入れるまで待ってください。` +
                `**値はあなたには渡りません。** 登録されたかどうかは vault://aliases で確かめられます` +
                `（この時点ではまだ存在しません）。`,
            },
          ],
        };
      }

      case "lookupAlias": {
        const name = requiredString(args.name, "name");
        const { aliases, failures } = await crossAliases();
        // **呼び出し元から使えるものだけ**——使えない alias の在りかを
        // 教えても、その先で backend に断られるだけ（先に、理由の分かる形で止める）
        const caller = callerOf(callMeta);
        const found = aliases.filter((a) => a.name === name && usableBy(a, caller));
        if (found.length === 0) {
          // **読めなかった backend があるなら、それを言う**（規則2）。
          // 「どこにもありません」と「片方が読めていません」は別の事実で、
          // 混ぜると**設定の壊れが「そんな名前は無い」に化ける**
          if (failures.length > 0) {
            throw new Error(
              `alias "${name}" は見つかりませんでしたが、読めていない Vault があります：` +
                failures.map((f) => `${f.implementation}（${f.error}）`).join("、"),
            );
          }
          throw new Error(`alias "${name}" はどの Vault にもありません`);
        }
        if (found.length > 1) {
          // **どちらか分からないなら通さない**（規則2）——人が名前を直すか、
          // 紐付けで解くべきところ
          throw new Error(
            `alias "${name}" が複数の Vault にあります（${found.map((f) => f.implementation).join(", ")}）。` +
              "名前は instance 全体で一意にしてください",
          );
        }
        const { implementation, ...meta } = found[0]!;
        // **値は返さない**——在りかと、値を使わずに分かることまで
        return text({ implementation, ...meta });
      }

      case "listVaults":
        return text(await vaultImplementations());

      case "listAliases":
        return text(await crossAliases());

      case "createAlias": {
        const implementation = await target();
        await assertNameIsFree(requiredString(args.name, "name"));
        // **値はここを通過するだけ**——変数として受け取るので、この Module は
        // `handlesSecrets: true`／`isolation: "subprocess"` を名乗っている
        // （要件 C8c。仕様は当初 in-process でよいとしていたが、画面が呼び先を
        //  選べない実装の形に合わせて訂正した——`docs/notes/2026-09-12-vault-directory.md`）
        const body = await deps.relay.callTool(implementation, "createAlias", {
          name: requiredString(args.name, "name"),
          kind: requiredString(args.kind, "kind"),
          group: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
          value: requiredString(args.value, "value"),
          note: optionalString(args.note, "note"),
        });
        return text({ ok: true, message: body });
      }

      case "generateSecret": {
        const implementation = await target();
        await assertNameIsFree(requiredString(args.name, "name"));
        // **ここには値が一度も来ない**——作るのも持つのも Vault の中だけ
        const body = await deps.relay.callTool(implementation, "generateSecret", {
          name: requiredString(args.name, "name"),
          kind: optionalString(args.kind, "kind"),
          group: optionalString(args.group, "group"),
          forProject: optionalString(args.forProject, "forProject"),
          note: optionalString(args.note, "note"),
          format: optionalString(args.format, "format"),
          bytes: args.bytes === undefined ? undefined : Number(args.bytes),
        });
        // **backend の返事をそのまま返す**（訂正・2026-09-13、ユーザー報告）。
        // 包んでいたせいで公開鍵が1段下に沈み、**会話の中の入力欄には空の箱**が
        // 出ていた。同じ入力欄は backend にも直接繋がる（kit が配れば両方で使う）
        // ので、**tool の返しの形は窓口でも backend でも同じでなければならない**
        // （規則3——同じ tool に2つの形を作らない）
        return { content: [{ type: "text", text: body }] };
      }
      case "updateAlias": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "updateAlias", {
          name: requiredString(args.name, "name"),
          note: optionalString(args.note, "note"),

        });
        return text({ ok: true, message: body });
      }

      case "deleteAlias": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "deleteAlias", {
          name: requiredString(args.name, "name"),
        });
        return text({ ok: true, message: body });
      }

      case "listGroups": {
        const implementation = await target();
        const [groups, bindings] = await Promise.all([
          deps.relay.callTool(implementation, "listGroups", {}),
          deps.relay.callTool(implementation, "listGroupBindings", {}),
        ]);
        return text({ groups: JSON.parse(groups), bindings: JSON.parse(bindings) });
      }

      case "createGroup": {
        const implementation = await target();
        await deps.relay.callTool(implementation, "createGroup", { name: requiredString(args.name, "name") });
        return text({ ok: true });
      }

      case "setSharedGroup": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "setSharedGroup", {
          group: requiredString(args.group, "group"),
        });
        return text({ ok: true, shared: JSON.parse(body) });
      }

      case "setGroupBinding": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "setGroupBinding", {
          projectId: requiredString(args.projectId, "projectId"),
          group: requiredString(args.group, "group"),
        });
        return text({ ok: true, binding: JSON.parse(body) });
      }

      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **人が直接開ける入口**（launcher、§6.2）——「鍵を確かめたい」は
        // AI に頼む用事ではない
        uri: MANAGE_APP_URI,
        name: "Vault を管理",
        description: "複数の Vault 実装を横断して alias を確認・編集する（値は表示しない）",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        // **AI に見せる目録は、これ1つだけ**（横断済み）。実装名は**載せない**
        // ——AI に「どの金庫か」を選ぶ材料を与えない（選ぶのは人か、窓口）
        uri: "vault://aliases",
        name: "使える秘密の一覧（alias）",
        description:
          "この banto が預かっている秘密の**名前だけ**の一覧（値は含まない）。" +
          "繋がっている Vault を横断した1つの一覧。" +
          "秘密を使うときは、この name を Shell の envSecrets / secretFiles / sshIdentity に渡す。" +
          "欲しいものが無ければ requestAlias で人に頼む。",
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        // 会話の中の入力欄（`requestAlias` の結果が開く）
        uri: REQUEST_APP_URI,
        name: "秘密の登録",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { prefersBorder: true } },
      },
      {
        uri: "vault-directory://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["vault-directory"],
            dependsOn: [{ role: VAULT_ROLE, required: true }],
            isolation: "subprocess",
            scope: "instance",
            handlesSecrets: true,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "vault://aliases") {
      // **実装名は落とす**（上記）。人向けの画面は `listAliases` を使う
      const { aliases, failures } = await crossAliases();
      // **読めなかった金庫があるなら、空の一覧を返さない**（規則2。追加・2026-09-12
      // ——横断が承認ゲートで止まったとき、AI には「alias が1つも無い」に
      // 見えていた。「無い」と「読めていない」は別の事実で、混ぜると
      // **配線の壊れが「まだ何も登録されていません」に化ける**）
      if (failures.length > 0) {
        throw new Error(
          "一覧を横断できませんでした：" +
            failures.map((f) => `${f.implementation}（${f.error}）`).join("、"),
        );
      }
      // **使えないものは名前も見せない**（決定・2026-09-13）。backend の
      // `listAliases` は人の管理面なので全部返す——**絞るのは横断した側の仕事**
      const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
      const visible = aliases.filter((a) => usableBy(a, caller));
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(visible.map(forAgent)),
          },
        ],
      };
    }
    if (request.params.uri === REQUEST_APP_URI) {
      return { contents: [{ uri: REQUEST_APP_URI, mimeType: UI_APP_MIME, text: REQUEST_APP_HTML }] };
    }
    if (request.params.uri === MANAGE_APP_URI) {
      return { contents: [{ uri: MANAGE_APP_URI, mimeType: UI_APP_MIME, text: MANAGE_APP_HTML }] };
    }
    throw new Error(`unknown resource: ${request.params.uri}`);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const url = process.env.BANTO_HOST_MCP_URL;
  const token = process.env.BANTO_HOST_MCP_TOKEN;
  // **繋がる先が無いなら立たない**（規則2）——横断する相手に届かない
  // vault-directory は、空の一覧を出して「alias が無い」ように見せるだけになる
  if (!url || !token) {
    throw new Error("vault-directory には BANTO_HOST_MCP_URL と BANTO_HOST_MCP_TOKEN が要ります");
  }
  const { HostRelayClient } = await import("./relay-client.js");
  const server = createVaultDirectoryServer({ relay: new HostRelayClient(url, token) });
  await server.connect(new StdioServerTransport());
}
