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
import {
  AUDIT_ARGS_META_KEY,
  callerOf,
  VISIBILITY_META_KEY,
  MODULE_META_KEY,
  CANVAS_META_KEY,
} from "@banto/module-contract";
import { MANAGE_APP_HTML, MANAGE_APP_URI, UI_APP_MIME } from "./manage-app.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { REQUEST_APP_HTML, joinVariant, requestAppUri, splitVariant, type VariantAxis } from "@banto/vault-kit";

/** 会話の中の入力欄。**窓口が1枚だけ持つ**——backend ごとに同じ画面を持たない */
const REQUEST_APP_URI = requestAppUri("vault-directory");
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RelayLike } from "./relay-client.js";

/** 横断のために使う role。**1つ選ばない**——名乗っている実装は全部相手にする。 */
const VAULT_ROLE = "vault";

export interface VaultDirectoryDeps {
  relay: RelayLike;
  /** 「既定の Vault」を覚えておく置き場（窓口のデータ置き場）。 */
  dataDir?: string;
}

/**
 * **人が何も決めていないときの置き場**（決定・2026-09-13）。
 *
 * 秘密が**黙って外（クラウド）へ出ない**ほうを既定にする。外に置くのは、
 * 人が「既定は Infisical」と決めたときだけ。
 */
const FALLBACK_DEFAULT_VAULT = "vault-local";

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

  /**
   * **新しい秘密をどこに置くか**の既定。人が決める（`setDefaultVault`）。
   *
   * これがあるので、画面は**毎回「どの Vault に入れるか」を聞かない**
   * ——決めていないことを人に押し付けない。変えたいときだけ選ばせる。
   */
  const defaultVaultFile = deps.dataDir ? join(deps.dataDir, "default-vault.json") : undefined;
  let defaultVaultCache: string | undefined;

  async function defaultVault(): Promise<string> {
    if (defaultVaultCache) return defaultVaultCache;
    if (defaultVaultFile && existsSync(defaultVaultFile)) {
      try {
        const raw = JSON.parse(await readFile(defaultVaultFile, "utf8")) as { vault?: string };
        if (raw.vault) return (defaultVaultCache = raw.vault);
      } catch {
        // 壊れていたら既定に戻る（推測で直さない、規則2）
      }
    }
    // **繋がっている中に既定が居なければ、繋がっているものから選ぶ**
    // ——居ないものを既定と言い張らない
    const impls = await vaultImplementations();
    return impls.includes(FALLBACK_DEFAULT_VAULT) ? FALLBACK_DEFAULT_VAULT : (impls[0] ?? FALLBACK_DEFAULT_VAULT);
  }

  async function setDefaultVault(vault: string): Promise<void> {
    const impls = await vaultImplementations();
    if (!impls.includes(vault)) {
      throw new Error(`"${vault}" は vault を名乗っていないか、繋がっていません`);
    }
    if (!defaultVaultFile) throw new Error("この窓口はデータ置き場を持っていません");
    await mkdir(join(defaultVaultFile, ".."), { recursive: true, mode: 0o700 });
    await writeFile(defaultVaultFile, JSON.stringify({ vault }), { mode: 0o600 });
    defaultVaultCache = vault;
  }

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
    // **banto 全体のための呼び出しは、共通だけ**（追加・2026-09-16）
    if ("instance" in caller) return false;
    return Array.isArray(alias.projects) && (alias.projects as string[]).includes(caller.project);
  }

  /**
   * **見える名前を決める**（決定・2026-09-13、設計し直し）。
   *
   * 素の名前で引けるのは **Project のグループ**と**共通の「既定の」グループ**に
   * 居るものだけ。それ以外は **`<vault>:<name>` の修飾名**でだけ引ける。
   *
   * こうすると**曖昧さが構造的に消える**：素の名前の候補は最大2つで、
   * そこには「狭い文脈が広い文脈を上書きする」という本当の包含関係があるので
   * 優先順位が正当化できる。共通どうしには包含関係が無いので、順序を持ち込まない。
   *
   * **一覧に出る名前が、そのまま使える名前**——AI は `vault://aliases` で
   * 見た名前しか知らないので、見たとおりに書けば必ず引ける（余計な機構が要らない）。
   */
  function visibleNameOf(alias: Record<string, unknown>, bare: boolean): string {
    return bare ? String(alias.name) : `${alias.implementation}:${alias.name}`;
  }

  /**
   * 素の名前で引けるか。**Project のもの**か、**共通の既定**に居るものだけ。
   *
   * 「共通の既定」は **既定の Vault の共通グループ**——共通グループは Vault ごとに
   * あるので、どれが「既定」かは `defaultVault` が決める。
   */
  function isBare(alias: Record<string, unknown>, caller: ReturnType<typeof callerOf>, defaultVault: string): boolean {
    if (alias.scope === "project") return true;
    return alias.scope === "shared" && alias.implementation === defaultVault;
  }

  /**
   * AI に見せる形。**金庫の名前も置き場も見せない**——選ばせる材料にしない。
   * **参照の指す先も見せない**（2026-10-04）——元のグループの見え方を変えないため。
   * 元が無い参照は `broken: true` のまま残す（使えないことを人に伝えられるように）。
   */
  function forAgent(alias: Record<string, unknown>, name: string): Record<string, unknown> {
    // **版も見せない**（置き場の一部。2026-10-06）。空の印（empty）は残す——渡そうとする前に AI が知れるように
    const { implementation: _i, group: _g, projects: _p, scope: _s, name: _n, linkTo: _l, variant: _v, ...rest } = alias;
    return { name, ...rest };
  }

  /**
   * **Vault をまたいで動かせないもの**（決定・2026-10-04）。参照は値を持たないので、
   * 別の Vault へ動かすには値を写すことになる（＝参照ではなくなる）。参照に指されている
   * 元を動かすと、指している参照が切れる。**どちらも理由つきで断る**——
   * 置き場の変更（planProjectPlacement）でも事前に出して、1つでもあれば何もしない。
   */
  function crossVaultBlockers(
    moving: TaggedAlias[],
    aliases: TaggedAlias[],
  ): Array<{ name: string; group: string; reason: string }> {
    const out: Array<{ name: string; group: string; reason: string }> = [];
    for (const a of moving) {
      const linkTo = a.linkTo as { group?: unknown; name?: unknown } | undefined;
      // **空の秘密は Vault をまたいで運べない**（2026-10-06、レビュー）——値を窓口が運ぶので、空なら
      // 運ぶ途中で「値が空です」と断られ、置き場の変更が途中で止まる。事前に出す（all-or-nothing）
      if (a.empty === true && !linkTo) {
        out.push({
          name: String(a.name),
          group: String(a.group),
          reason: "値が空なので別の Vault へは運べません（先に値を入れるか、移さずに変えてください）",
        });
        continue;
      }
      if (linkTo) {
        out.push({
          name: String(a.name),
          group: String(a.group),
          reason: `参照です（元は ${String(linkTo.group)} / ${String(linkTo.name)}）。参照は同じ Vault の中でしか動かせません`,
        });
        continue;
      }
      const pointing = aliases.filter((x) => {
        const to = x.linkTo as { group?: unknown; name?: unknown } | undefined;
        return x.implementation === a.implementation && !!to && to.group === a.group && to.name === a.name;
      });
      if (pointing.length > 0) {
        out.push({
          name: String(a.name),
          group: String(a.group),
          reason:
            `この秘密を指す参照が ${pointing.length} 件あります（` +
            pointing.map((x) => `${String(x.group)} / ${String(x.name)}`).join("、") +
            `）。別の Vault へ移すと参照が切れます`,
        });
      }
    }
    return out;
  }

  /**
   * 名前（素でも修飾でも）から、その alias を引く。**見つからなければ止まる**。
   *
   * 素の名前は **Project ＞ 共通の既定**。この順序に根拠があるのは、
   * Project が「狭い文脈」だから（§2.1）。
   */
  function resolveName(
    name: string,
    aliases: TaggedAlias[],
    caller: ReturnType<typeof callerOf>,
    defaultVault: string,
  ): TaggedAlias | undefined {
    const usable = aliases.filter((a) => usableBy(a, caller));
    const qualified = usable.find((a) => `${a.implementation}:${a.name}` === name);
    if (qualified) return qualified;
    const bare = usable.filter((a) => a.name === name && isBare(a, caller, defaultVault));
    // **Project が共通に勝つ**——候補は最大2つで、必ずどちらかに決まる
    return bare.find((a) => a.scope === "project") ?? bare.find((a) => a.scope === "shared");
  }

  /**
   * 1つの alias を移す。**同じ Vault の中なら backend に任せる**（値が外に出ない）。
   *
   * **Vault をまたぐときだけ、値が窓口を通る**（決定・2026-09-14）。窓口は既に
   * `handlesSecrets: true`（人が画面で打った登録の値が通る）なので新しい
   * category ではないが、**値が流れる場所が1つ増える**ことは意識して扱う。
   *
   * どちらの経路も **写す → 確かめる → 消す**——途中で落ちても「両方にある」
   * で済み、値は失われない。
   */
  async function migrateOne(
    name: string,
    fromImpl: string,
    fromGroup: string,
    toImpl: string,
    toGroup: string,
  ): Promise<void> {
    if (fromImpl === toImpl) {
      await deps.relay.callTool(fromImpl, "migrateAlias", { name, group: fromGroup, toGroup });
      return;
    }
    // 別の Vault へ：窓口が値を運ぶ
    const all = await crossAliases();
    const meta = all.aliases.find(
      (a) => a.implementation === fromImpl && a.group === fromGroup && a.name === name,
    );
    if (!meta) throw new Error(`alias "${name}" が ${fromImpl} の ${fromGroup} に見つかりません`);
    const blocked = crossVaultBlockers([meta], all.aliases);
    if (blocked.length > 0) throw new Error(`"${name}" は別の Vault へ移せません：${blocked[0]!.reason}`);
    const value = await deps.relay.callTool(fromImpl, "resolveAlias", { name, group: fromGroup });
    const note = meta.note ? String(meta.note) : undefined;
    if (meta.kind === "oauth-token") {
      // **banto が置く秘密は持ち主ごと移す**（2026-10-06、レビュー）。`createAlias` は人が手で作る口で、これを受けない
      // ——写すと持ち主が消え、置いた Module が回った鍵を書き戻せなくなる（同じ Vault の中の移動は行ごと移るので保つ）
      await deps.relay.callTool(toImpl, "importOwnedSecret", {
        name,
        value,
        note,
        group: toGroup,
        ...(typeof meta.owner === "string" && meta.owner !== "" ? { owner: meta.owner } : {}),
      });
    } else {
      await deps.relay.callTool(toImpl, "createAlias", { name, kind: String(meta.kind ?? "secret"), value, note, group: toGroup });
    }
    // **確かめてから消す**——写せていないのに消したら秘密が消える
    const copied = await deps.relay.callTool(toImpl, "resolveAlias", { name, group: toGroup });
    if (copied !== value) throw new Error(`"${name}" を写せませんでした（${fromImpl} → ${toImpl}）。元は残っています`);
    await deps.relay.callTool(fromImpl, "deleteAlias", { name, group: fromGroup });
  }

  /** **監査に残してよい引数**（識別子だけ。値は決して含めない）。 */
  const AUDIT_IDENTIFIERS = ["name", "group", "identity", "toGroup", "toName", "implementation", "projectId"];

  function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
    return {
      name,
      description,
      inputSchema: { type: "object", properties, required },
      // 人専用——AI には1つも見せない
      _meta: { [VISIBILITY_META_KEY]: "admin", [AUDIT_ARGS_META_KEY]: AUDIT_IDENTIFIERS },
    };
  }

  const IMPL = { implementation: { type: "string", description: "どの vault 実装に対してか" } };
  /** 版（2026-10-06）。版を名乗る Vault（Infisical の環境）だけが受ける。省くと既定の版。 */
  const VARIANT = { type: "string", description: "版（Infisical なら環境）。省くと既定の版" };

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
      {
        // **公開鍵は秘密ではない**（追加・2026-09-13、ユーザー指摘）。
        // 相手方に登録するためのものなので、AI が読めてよい——むしろ
        // 「この鍵を GitHub に登録して」と頼めないと、鍵を作った意味が薄い。
        // **秘密鍵は通らない**（backend が `ssh-keygen -y` で導いて公開鍵だけ返す）
        name: "getPublicKey",
        description:
          "ssh-identity の**公開鍵**を読む（秘密鍵は返らない）。" +
          "相手方（GitHub の Settings → SSH and GPG keys など）に登録するのに使う。" +
          "使える alias の一覧は resource `vault://aliases`",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "alias の名前" } },
          required: ["name"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
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
      // **banto 自身が置く秘密**（追加・2026-09-18、OAuth）。窓口は既定の金庫へ
      // 中継するだけ——どの金庫かを host に選ばせない（規則3、他の口と同じ）
      tool(
        "putSecret",
        "banto 自身が保管する秘密（OAuth のログイン情報）を置く。既にあれば置き換える",
        {
          name: { type: "string" },
          value: { type: "string" },
          note: { type: "string" },
          forProject: { type: "string" },
        },
        ["name", "value"],
      ),
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
        {
          ...IMPL,
          name: { type: "string" },
          group: { type: "string", description: "置き場（省略すると既定の解決に落ちる）" },
          note: { type: "string" },
        },
        ["implementation", "name"],
      ),
      tool(
        "deleteAlias",
        "alias を削除する。**置き場（group）まで指す**——同じ名前が複数の置き場に在るのは普通のこと",
        { ...IMPL, name: { type: "string" }, group: { type: "string", description: "置き場（省略すると既定の解決に落ちる）" } },
        ["implementation", "name"],
      ),
      tool("listGroups", "その実装のグループ一覧と、Project との紐付け", IMPL, ["implementation"]),
      tool("createGroup", "その実装に新しいグループを作る", { ...IMPL, name: { type: "string" } }, [
        "implementation",
        "name",
      ]),
      tool(
        "setGroupBinding",
        "この Project が使うグループを決める",
        { ...IMPL, projectId: { type: "string" }, group: { type: "string" }, variant: VARIANT },
        ["implementation", "projectId", "group"],
      ),
      tool(
        "countVariants",
        // **版を選ぶ欄に添える数**（2026-10-06）——値は返さない
        "グループの版（Infisical なら環境）ごとの「値が入っている秘密の数／全部の数」",
        { ...IMPL, group: { type: "string" } },
        ["implementation", "group"],
      ),
      tool(
        "getPlacements",
        // **置き場は「Vault とグループの組」で1つ**（決定・2026-09-13）。
        // backend ごとに別々に選ばせると、「この Project の秘密は結局どこに
        // 行くのか」が画面から読めない——1つの問いには1つの答えを出す
        "置き場を読む——共通の既定（Vault・グループ）と、この Project の置き場",
        { projectId: { type: "string" } },
      ),
      tool(
        "setProjectPlacement",
        "この Project の秘密の置き場を決める（Vault とグループを一緒に）。" +
          "**migrate: true なら、いまの置き場にある秘密も一緒に移す**",
        {
          projectId: { type: "string" },
          implementation: { type: "string" },
          group: { type: "string" },
          variant: VARIANT,
          migrate: { type: "boolean", description: "いまの秘密も移すか（既定 false＝紐付けだけ変える）" },
        },
        ["projectId", "implementation", "group"],
      ),
      tool(
        "planProjectPlacement",
        // **変える前に、何が起きるかを見せる**（規則2——黙って使えなくしない）
        "置き場を変えたら何が起きるかを調べる（移す対象・名前の衝突・移さない場合に使えなくなるもの）",
        { projectId: { type: "string" }, implementation: { type: "string" }, group: { type: "string" }, variant: VARIANT },
        ["projectId", "implementation", "group"],
      ),
      tool(
        "migrateAlias",
        "alias を別の置き場へ移す（Vault をまたいでもよい）。移す元は implementation / group で指定する——省くと既定の解決（Project ＞ 共通の既定）で引く",
        {
          name: { type: "string" },
          implementation: { type: "string", description: "移す元の Vault（省略可）" },
          group: { type: "string", description: "移す元のグループ（省略可）" },
          toImplementation: { type: "string" },
          toGroup: { type: "string" },
        },
        ["name", "toGroup"],
      ),
      tool(
        "linkAlias",
        // **参照**（決定・2026-10-04、ユーザー）。値を写さずに、別の置き場からも使えるようにする。
        // **同じ Vault の中だけ**——置く先の Vault は元の Vault（toImplementation は受けない）
        "alias を同じ Vault の別のグループからも使えるようにする参照を作る（値は写さない）。" +
          "元は implementation / group で指定する——省くと既定の解決（Project ＞ 共通の既定）で引く",
        {
          name: { type: "string", description: "元の alias の名前" },
          implementation: { type: "string", description: "元の Vault（省略可）" },
          group: { type: "string", description: "元のグループ（省略可）" },
          toGroup: { type: "string", description: "参照を置くグループ（元と同じ Vault の中）" },
          toName: { type: "string", description: "参照の名前（省略すると元と同じ）" },
        },
        ["name", "toGroup"],
      ),
      tool(
        "setSharedPlacement",
        "共通の秘密の置き場（既定）を決める（Vault とグループを一緒に）",
        { implementation: { type: "string" }, group: { type: "string" } },
        ["implementation", "group"],
      ),
      tool(
        "getDefaultVault",
        // **新しい秘密をどこに置くか**の既定。これがあるので、画面は毎回
        // 「どの Vault に入れるか」を聞かない（決めていないことを人に押し付けない）
        "新しい秘密を置く既定の Vault を読む",
        {},
      ),
      tool(
        "setDefaultVault",
        "新しい秘密を置く既定の Vault を決める（既定は vault-local——黙って外へ出さない）",
        { vault: { type: "string" } },
        ["vault"],
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
    /**
     * 宛先の Vault。**省略されたら既定へ**（改訂・2026-09-13）。
     *
     * 以前は2本以上あると「決まりません」と断っていたので、画面は毎回
     * 人に選ばせるしかなかった——**決めていないことを人に押し付けていた**。
     * 既定を1つ持てば、**変えたいときだけ選べばよい**。
     */
    /**
     * その Vault の版（2026-10-06）。**版を名乗らない Vault は null**。名乗るのに読めなかった
     * （Infisical に環境の一覧を聞けなかった等）ときは理由を添える——黙って「版が無い」にしない（規則2）。
     * 古い Vault（describeVariants を持たない）も null
     */
    async function variantsOf(impl: string): Promise<{ variants: VariantAxis | null; variantsError?: string }> {
      try {
        return { variants: JSON.parse(await deps.relay.callTool(impl, "describeVariants", {})) as VariantAxis | null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/unknown tool/i.test(message)) return { variants: null };
        return { variants: null, variantsError: message };
      }
    }

    /** 置き場を版付きにする。既定の版なら `@` を付けない（kit と同じ書き方。確かめるのは kit の紐付けの口）。 */
    async function placeWithVariant(impl: string, group: string, variant: string | undefined): Promise<string> {
      if (!variant) return group;
      const { variants, variantsError } = await variantsOf(impl);
      if (!variants) throw new Error(variantsError ?? `${impl} には版がありません`);
      if (!variants.options.includes(variant)) {
        throw new Error(`${variants.label}「${variant}」はありません（選べるのは ${variants.options.join(" / ")}）`);
      }
      return joinVariant(group, variant, variants.default);
    }

    async function target(): Promise<string> {
      const known = await vaultImplementations();
      const implementation = optionalString(args.implementation, "implementation");
      if (!implementation) {
        if (known.length === 1) return known[0]!;
        const dv = await defaultVault();
        if (known.includes(dv)) return dv;
        throw new Error(
          `どの Vault に入れるか決まりません（既定 "${dv}" が繋がっていません。繋がっているもの: ${known.join(", ") || "無し"}）`,
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

    switch (request.params.name) {
      case "requestAlias": {
        const name = requiredString(args.name, "name");
        // **すぐ返す**（人を待って呼び出しを止めない）。戻り値そのものが
        // 会話の中の入力欄を開く（`_meta.ui.resourceUri`）
        //
        // **「既に在る」は、呼び出し元から使えるときだけ**（訂正・2026-09-15）。
        // 以前は名前が一致するだけで断っていたので、**他の Project の同名が
        // あるだけで入力欄が開かず**、AI は「使えないのに頼めない」袋小路に
        // 入っていた（一覧にも出ないので、人に届く導線も無かった）。
        // 置き場が違えば衝突しないので、断る理由も無い。
        // **実装名も返さない**——金庫の名前を AI に見せないと決めたのに、
        // ここだけ自分で破っていた。
        const { aliases, failures } = await crossAliases();
        const caller = callerOf(callMeta);
        const usable = aliases.filter((a) => usableBy(a, caller));
        const existing = usable.find(
          (a) => a.name === name || `${a.implementation}:${a.name}` === name,
        );
        if (existing && existing.broken === true) {
          // **在るのに使えない**（参照の元が無い）——「使えます」と言わない（規則2）
          return {
            content: [
              {
                type: "text",
                text:
                  `"${name}" は登録されていますが、指している元の秘密が無いので使えません。` +
                  "ターンを終えて人に伝えてください（管理画面で直せます）",
              },
            ],
          };
        }
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: `"${name}" は既に登録されていて、いま使えます。vault://aliases で確かめてください`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `"${name}" を登録するための入力欄を、この会話に出しました。` +
                `**値はあなたには渡りません。**\n` +
                // **待ち方まで書く**（追加・2026-09-15）。ターンの途中で人を待つ
                // 手段は AI に無いので、「待ってください」だけだと目録を
                // ポーリングし始める。正解（ターンを終えて人に知らせる）を書く
                `このターンではこれ以上進めません。**ターンを終えて人に知らせてください。**\n` +
                `人が入れたあと、次のターンの初めに vault://aliases を読めば使えるようになっています` +
                (failures.length > 0
                  ? `\n（なお、読めていない Vault があります：` +
                    failures.map((f) => f.implementation).join("、") +
                    `。同じ名前が既にそちらに在るかもしれません——人に伝えてください）`
                  : ""),
            },
          ],
        };
      }

      case "getPublicKey": {
        const name = requiredString(args.name, "name");
        const { aliases } = await crossAliases();
        const found = resolveName(name, aliases, callerOf(callMeta), await defaultVault());
        if (!found) throw new Error(`alias "${name}" はどの Vault にもありません`);
        // **backend には素の名前で聞く**——修飾名は窓口の中だけの表現
        // **置き場まで渡す**（2026-10-04）——参照は既定で元と同じ名前なので、名前だけだと
        // backend の既定解決が同名の別の行（元や別の参照）を掴む
        const body = await deps.relay.callTool(found.implementation, "getPublicKey", {
          name: String(found.name),
          group: String(found.group),
        });
        return { content: [{ type: "text", text: body }] };
      }

      case "lookupAlias": {
        const name = requiredString(args.name, "name");
        const { aliases, failures } = await crossAliases();
        // **呼び出し元から使えるものだけ**——使えない alias の在りかを
        // 教えても、その先で backend に断られるだけ（先に、理由の分かる形で止める）。
        // **素の名前は Project ＞ 共通の既定、既定の外は修飾名**（決定・2026-09-13）
        // ——候補が複数になって止まる、という状態がここで無くなった
        const found = resolveName(name, aliases, callerOf(callMeta), await defaultVault());
        if (!found) {
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
        // 参照の指す先は渡さない（呼び出し元は参照の置き場のまま resolveAlias すればよい）
        const { implementation, linkTo: _linkTo, ...meta } = found;
        // **値は返さない**——在りかと、値を使わずに分かることまで。
        // **`name` は backend での本当の名前**（修飾名で引かれても、その先の
        // `resolveAlias` は素の名前で呼ぶ必要がある）
        return text({ implementation, ...meta });
      }

      case "listVaults":
        return text(await vaultImplementations());

      case "listAliases":
        return text(await crossAliases());

      case "createAlias": {
        const implementation = await target();

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

      case "putSecret": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "putSecret", {
          name: requiredString(args.name, "name"),
          value: requiredString(args.value, "value"),
          note: optionalString(args.note, "note"),
          forProject: optionalString(args.forProject, "forProject"),
        });
        return text({ ok: true, message: body });
      }

      case "generateSecret": {
        const implementation = await target();

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
          // **置き場まで渡す**（2026-10-04）——参照は既定で元と同じ名前なので、名前だけだと
          // 一覧で選んだ行とは別の行の用途を書き換える（deleteAlias で直したのと同じ穴）
          group: optionalString(args.group, "group"),
          note: optionalString(args.note, "note"),
        });
        return text({ ok: true, message: body });
      }

      case "deleteAlias": {
        const implementation = await target();
        // **置き場まで指して消す**（訂正・2026-09-15）。同じ名前が同一 Vault の
        // 2つの置き場に在るのは**正しい状態**と決めたのに、名前だけで渡すと
        // backend の既定解決に落ちて**一覧で選んだ行と別の秘密が消える**
        // ——`migrateAlias` で直したのと同じ穴が、ここに残っていた
        const body = await deps.relay.callTool(implementation, "deleteAlias", {
          name: requiredString(args.name, "name"),
          group: optionalString(args.group, "group"),
        });
        return text({ ok: true, ...JSON.parse(body) });
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

      case "getPlacements": {
        const projectId = optionalString(args.projectId, "projectId");
        const dv = await defaultVault();
        // 各 Vault に「自分のところの紐付け」を聞いて、1つの答えに畳む
        const perVault = (await acrossVaults(async (impl) => ({
          impl,
          bindings: JSON.parse(await deps.relay.callTool(impl, "listGroupBindings", {})) as {
            shared: string;
            projects: Array<{ projectId: string; group: string }>;
          },
          groups: JSON.parse(await deps.relay.callTool(impl, "listGroups", {})) as string[],
          // 紐付けが指している名前も候補に入れる（**まだ作られていないことがある**
          // ——SOPS は使うときに作るので、`listGroups` に出てこない）
          ...(await variantsOf(impl)),
        }))).filter((r): r is { implementation: string; ok: true; value: { impl: string; bindings: { shared: string; projects: Array<{ projectId: string; group: string }> }; groups: string[]; variants: VariantAxis | null; variantsError?: string } } => r.ok);

        const mine = projectId
          ? perVault
              .map((r) => {
                const group = r.value.bindings.projects.find((b) => b.projectId === projectId)?.group;
                // **版付きのグループは、グループと版に分けても添える**（画面が別々に出せるように、2026-10-06）。
                // `group` は今までどおり置き場そのもの（`g@prod`）——比べるときはこちらを使う
                return { implementation: r.value.impl, group, ...(group ? placeParts(group) : {}) };
              })
              .find((x) => x.group)
          : undefined;
        return text({
          // **共通の置き場は「既定の Vault のその共通グループ」**——どの Vault
          // にも共通グループはあるが、素の名前で引けるのは既定のものだけ
          shared: { implementation: dv, group: perVault.find((r) => r.value.impl === dv)?.value.bindings.shared },
          project: mine ?? null,
          // 画面が選べるように、Vault ごとのグループ一覧も添える。
          // **紐付けが指している名前も足す**（改訂・2026-09-14、実測で空だった）
          // ——backend によってはグループを「使うときに作る」ので、まだ
          // `listGroups` に出てこない。**出ていないものを「無い」と見せない**（規則2）
          vaults: perVault.map((r) => ({
            implementation: r.value.impl,
            // **グループの選択肢は版を外した名前**（2026-10-06）——版は別の欄で選ぶ。版の数だけ並べない
            groups: [
              ...new Set(
                [...r.value.groups, r.value.bindings.shared, ...r.value.bindings.projects.map((b) => b.group)]
                  .filter(Boolean)
                  .map((g) => splitVariant(g).group),
              ),
            ],
            // **紐付けた版付きの置き場**（`g@prod`）——一覧に出る版付きの置き場はこれだけ（仕様 §2.1「グループの『版』」）。
            // 画面は「移す」「参照を作る」で、ここに無い版付きの置き場を選ぶと「一覧に出なくなる」と先に言う（2026-10-07）
            variantGroups: [
              ...new Set(
                [r.value.bindings.shared, ...r.value.bindings.projects.map((b) => b.group)].filter(
                  (g) => !!g && splitVariant(g).variant !== undefined,
                ),
              ),
            ],
            // 版を名乗る Vault だけ中身がある（無ければ null——画面は版の選択を出さない）
            variants: r.value.variants,
            ...(r.value.variantsError ? { variantsError: r.value.variantsError } : {}),
          })),
        });
      }

      case "planProjectPlacement":
      case "setProjectPlacement": {
        const projectId = requiredString(args.projectId, "projectId");
        const implementation = requiredString(args.implementation, "implementation");
        const baseGroup = requiredString(args.group, "group");
        const variant = optionalString(args.variant, "variant");
        // **比べるのは置き場そのもの**（版付きなら `g@prod`、既定の版なら `g`。2026-10-06）
        const group = await placeWithVariant(implementation, baseGroup, variant);
        const migrate = args.migrate === true;
        const planOnly = request.params.name === "planProjectPlacement";

        // いまの置き場と、そこに在るもの
        const { aliases } = await crossAliases();
        // **移す先が版付きのグループなら、その行も読む**（2026-10-06、レビュー）——まだ紐付いていない版付きの
        // グループは一覧に出ないので、読まずに見積もると、その版に既にある本物の値との衝突を見落とす
        if (splitVariant(group).variant !== undefined) {
          const rows = JSON.parse(
            await deps.relay.callTool(implementation, "listAliases", { alsoGroups: [group] }),
          ) as Array<Record<string, unknown>>;
          for (const r of rows) {
            if (r.group !== group) continue;
            if (aliases.some((x) => x.implementation === implementation && x.group === group && x.name === r.name)) continue;
            aliases.push({ ...r, implementation } as TaggedAlias);
          }
        }
        const bindings = (
          await acrossVaults(async (impl) => ({
            impl,
            projects:
              (
                JSON.parse(await deps.relay.callTool(impl, "listGroupBindings", {})) as {
                  projects?: Array<{ projectId: string; group: string }>;
                }
              ).projects ?? [],
          }))
        ).filter((r): r is { implementation: string; ok: true; value: { impl: string; projects: Array<{ projectId: string; group: string }> } } => r.ok);
        const current = bindings
          .map((r) => ({ implementation: r.value.impl, group: r.value.projects.find((b) => b.projectId === projectId)?.group }))
          .find((x) => x.group) as { implementation: string; group: string } | undefined;

        const moving =
          current && !(current.implementation === implementation && current.group === group)
            ? aliases.filter((a) => a.implementation === current.implementation && a.group === current.group)
            : [];
        // **古いグループが他の Project にも紐付いているなら、移さない**
        // ——他人のものまで動かすことになる
        const sharedWith = current
          ? bindings
              .find((r) => r.value.impl === current.implementation)!
              .value.projects.filter((b) => b.group === current.group && b.projectId !== projectId)
              .map((b) => b.projectId)
          : [];
        // **名前の衝突は事前に全部調べる**（all-or-nothing、規則2）
        const conflicts = moving
          .filter((a) => aliases.some((x) => x.implementation === implementation && x.group === group && x.name === a.name))
          .map((a) => String(a.name));
        // **Vault をまたぐなら、参照と参照に指されている元は動かせない**（2026-10-04）
        // ——事前に全部出す（1つでもあれば移さない、all-or-nothing）
        const crossVault = !!current && current.implementation !== implementation;
        const blockedAcrossVaults = crossVault ? crossVaultBlockers(moving, aliases) : [];

        const plan = {
          current: current ?? null,
          to: { implementation, group },
          moving: moving.map((a) => String(a.name)),
          conflicts,
          /** Vault をまたいで移せないもの（参照・参照に指されている元）と、その理由。 */
          blockedAcrossVaults,
          sharedWith,
          /** 移さない場合、ここに挙がるものは**どこにも紐付かなくなる**（unbound）。 */
          strandedIfNotMigrated: moving.map((a) => String(a.name)),
        };
        if (planOnly) return text(plan);

        if (migrate) {
          if (sharedWith.length > 0) {
            throw new Error(
              `いまの置き場は他の Project（${sharedWith.length} 件）も使っています。移すと他人のものまで動くので、移行なしで進めてください`,
            );
          }
          if (conflicts.length > 0) {
            // **1つでもぶつかったら何もしない**——途中まで進めない（規則2）
            throw new Error(`移す先に同じ名前があります：${conflicts.join(", ")}。名前を直してからやり直してください`);
          }
          if (blockedAcrossVaults.length > 0) {
            throw new Error(
              "別の Vault へは移せないものがあります（何も移していません）：" +
                blockedAcrossVaults.map((b) => `${b.name}——${b.reason}`).join(" / "),
            );
          }
          for (const a of moving) {
            await migrateOne(String(a.name), current!.implementation, String(a.group), implementation, group);
          }
        }

        // 紐付けを付け替える（他の Vault に在れば先に外す——1つの Project は1つの Vault）
        for (const r of bindings) {
          if (r.value.impl === implementation) continue;
          if (r.value.projects.some((b) => b.projectId === projectId)) {
            await deps.relay.callTool(r.value.impl, "clearGroupBinding", { projectId });
          }
        }
        await deps.relay.callTool(implementation, "setGroupBinding", {
          projectId,
          group: baseGroup,
          ...(variant ? { variant } : {}),
        });
        return text({ ok: true, placement: { implementation, group }, migrated: migrate ? plan.moving : [] });
      }

      case "migrateAlias": {
        const name = requiredString(args.name, "name");
        const toGroup = requiredString(args.toGroup, "toGroup");
        const fromImpl = optionalString(args.implementation, "implementation");
        const fromGroup = optionalString(args.group, "group");
        const { aliases } = await crossAliases();
        // **移す元を指定したら、そこだけを見る**（既定解決に落とさない）。
        // 同じ名前が複数の置き場に在るのは普通のこと——落としてしまうと、
        // 一覧で選んだ行とは**別の秘密**を動かす（実測で踏んだ・2026-09-14）
        const found =
          fromImpl || fromGroup
            ? aliases.find(
                (a) =>
                  a.name === name &&
                  (fromImpl === undefined || a.implementation === fromImpl) &&
                  (fromGroup === undefined || a.group === fromGroup),
              )
            : resolveName(name, aliases, callerOf(callMeta), await defaultVault());
        if (!found) {
          const where = [fromImpl, fromGroup].filter(Boolean).join(" / ");
          throw new Error(
            where ? `alias "${name}" は ${where} にありません` : `alias "${name}" はどの Vault にもありません`,
          );
        }
        const toImpl = optionalString(args.toImplementation, "toImplementation") ?? found.implementation;
        // **動かないなら、動いたと言わない**（規則1）——同じ置き場を指した場合
        if (toImpl === found.implementation && toGroup === found.group) {
          return text({ ok: true, moved: false, reason: "もう その置き場に在ります" });
        }
        await migrateOne(String(found.name), found.implementation, String(found.group), toImpl, toGroup);
        return text({
          ok: true,
          moved: true,
          from: { implementation: found.implementation, group: found.group },
          to: { implementation: toImpl, group: toGroup },
        });
      }

      case "linkAlias": {
        const name = requiredString(args.name, "name");
        const toGroup = requiredString(args.toGroup, "toGroup");
        // **同じ Vault の中だけ**——別の Vault を指されたら、黙って元の Vault に置かない（規則2）
        if (args.toImplementation !== undefined) {
          throw new Error("参照は同じ Vault の中にしか作れません（toImplementation は指定できません）");
        }
        const fromImpl = optionalString(args.implementation, "implementation");
        const fromGroup = optionalString(args.group, "group");
        const { aliases } = await crossAliases();
        // **元は置き場で指す**（migrateAlias と同じ引き方）——指定したら既定解決に落ちない
        const candidates =
          fromImpl || fromGroup
            ? aliases.filter(
                (a) =>
                  a.name === name &&
                  (fromImpl === undefined || a.implementation === fromImpl) &&
                  (fromGroup === undefined || a.group === fromGroup),
              )
            : [];
        // **Vault だけ・グループだけで指して候補が2つ以上なら、選ばずに断る**（2026-10-04、レビュー）
        // ——最初の1つを掴むと、一覧で選んだ行とは別の秘密を指す参照ができる
        if (candidates.length > 1) {
          throw new Error(
            `alias "${name}" は ${candidates.length} か所にあります（` +
              candidates.map((a) => `${a.implementation} / ${String(a.group)}`).join("、") +
              "）。Vault とグループの両方で指してください",
          );
        }
        const found =
          fromImpl || fromGroup
            ? candidates[0]
            : resolveName(name, aliases, callerOf(callMeta), await defaultVault());
        if (!found) {
          const where = [fromImpl, fromGroup].filter(Boolean).join(" / ");
          throw new Error(
            where ? `alias "${name}" は ${where} にありません` : `alias "${name}" はどの Vault にもありません`,
          );
        }
        const body = await deps.relay.callTool(found.implementation, "linkAlias", {
          name: String(found.name),
          group: String(found.group),
          toGroup,
          toName: optionalString(args.toName, "toName"),
        });
        return text({ implementation: found.implementation, ...JSON.parse(body) });
      }

      case "setSharedPlacement": {
        const implementation = requiredString(args.implementation, "implementation");
        const group = requiredString(args.group, "group");
        // **既定の Vault と、その中の共通グループ**——2つで1つの置き場
        await deps.relay.callTool(implementation, "setSharedGroup", { group });
        await setDefaultVault(implementation);
        return text({ ok: true, placement: { implementation, group } });
      }

      case "getDefaultVault":
        return text({ vault: await defaultVault(), fallback: FALLBACK_DEFAULT_VAULT });

      case "setDefaultVault": {
        await setDefaultVault(requiredString(args.vault, "vault"));
        return text({ ok: true, vault: await defaultVault() });
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
        const projectId = requiredString(args.projectId, "projectId");
        // **Project の秘密は1つの Vault にだけ置く**（決定・2026-09-13、
        // ユーザー指摘）。1つの Project の秘密を2つの秘密管理に分ける理由が
        // 無い。**構造的にそうする**ので、Project 層では名前の衝突が起こりえない。
        //
        // 紐付けそのものは各 Vault が持ったまま（backend が自分でアクセス制限を
        // 判定できる必要がある）。**不変条件だけを窓口が守る**——写しは持たず、
        // 必要なときに全 Vault へ聞いて確かめる（規則3）
        const elsewhere = (
          await acrossVaults(async (impl) =>
            impl === implementation
              ? []
              : (
                  JSON.parse(await deps.relay.callTool(impl, "listGroupBindings", {})) as {
                    projects?: Array<{ projectId: string; group: string }>;
                  }
                ).projects ?? [],
          )
        )
          .filter((r): r is { implementation: string; ok: true; value: Array<{ projectId: string; group: string }> } => r.ok)
          .find((r) => r.value.some((b) => b.projectId === projectId));
        if (elsewhere) {
          throw new Error(
            `この Project は既に ${elsewhere.implementation} に紐付いています。` +
              "1つの Project の秘密は1つの Vault にまとめてください（移すなら、先にそちらの紐付けを外す）",
          );
        }
        const variant = optionalString(args.variant, "variant");
        const body = await deps.relay.callTool(implementation, "setGroupBinding", {
          projectId,
          group: requiredString(args.group, "group"),
          ...(variant ? { variant } : {}),
        });
        return text({ ok: true, binding: JSON.parse(body) });
      }

      case "countVariants": {
        const implementation = await target();
        const body = await deps.relay.callTool(implementation, "countVariants", { group: requiredString(args.group, "group") });
        return text(JSON.parse(body));
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
        // **共通の置き場は設定画面で決める**（決定・2026-09-14、ユーザー指摘
        // 「こういうのは Canvas よりも設定画面でやったほうがいい」）。
        // 窓口は `scope: "instance"` なので、banto 全体の設定にちょうど出る
        uri: CONFIG_APP_URI,
        name: "Vault の置き場",
        description: "共通の秘密を新しく作るときの保存先（Vault とグループ）を決める",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config" },
      },
      {
        // **AI に見せる目録は、これ1つだけ**（横断済み）。実装名は**載せない**
        // ——AI に「どの金庫か」を選ぶ材料を与えない（選ぶのは人か、窓口）
        uri: "vault://aliases",
        name: "使える秘密の一覧（alias）",
        description:
          "この banto が預かっている秘密の一覧。**値は含まない**（名前・種別・用途・最終使用まで）。" +
          "繋がっている Vault を横断した1つの一覧。" +
          "形は { aliases: [...] }。読めていない Vault があるときは warning も入る" +
          "——その場合この一覧は全部ではないので、人に伝えること。" +
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
      // **使えないものは名前も見せない**（決定・2026-09-13）。backend の
      // `listAliases` は人の管理面なので全部返す——**絞るのは横断した側の仕事**
      const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
      const dv = await defaultVault();
      // **一覧に出る名前が、そのまま使える名前**（決定・2026-09-13）。素の名前で
      // 引けるものは素の名前、既定の外に居るものは修飾名（`<vault>:<name>`）
      const visible = aliases
        .filter((a) => usableBy(a, caller))
        .map((a) => forAgent(a, visibleNameOf(a, isBare(a, caller, dv))));
      // **読めなかった金庫を、読めた分ごと巻き添えにしない**
      // （訂正・2026-09-15、レビューで発覚）。
      //
      // 「無い」と「読めていない」を混ぜない（規則2）は正しいが、
      // **throw にすると読める側まで封鎖される**。`vault-infisical` は既定で
      // 宣言されており未設定でも立つので、**素のインストールでは AI が
      // 一覧を読むたびに必ず失敗していた**——vault-local に使える秘密が
      // 在っても。しかも直せるのは人だけで、AI には手が無い。
      //
      // **事実は落とさず、仕事は止めない**：使える分を返し、読めていない金庫が
      // あることを同じ答えの中で明示する（AI が人に伝えられる形で）。
      const body: Record<string, unknown> = { aliases: visible };
      if (failures.length > 0) {
        // **金庫の名前は AI に見せない**（訂正・2026-09-15、E2E が捕まえた）。
        // 読めていないことは伝えるが、**どの金庫かは言わない**——AI に
        // 選ぶ材料を渡さない、という窓口の存在理由がここで崩れる。
        // 名前と理由が要るのは人なので、**人の画面（`listAliases`）には
        // 今までどおり全部出る**
        body.unreadable = failures.length;
        body.warning =
          `読めていない Vault が ${failures.length} 件あります。この一覧は全部ではありません` +
          "——人に伝えてください（設定できるのは人だけです）";
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(body),
          },
        ],
      };
    }
    if (request.params.uri === REQUEST_APP_URI) {
      return { contents: [{ uri: REQUEST_APP_URI, mimeType: UI_APP_MIME, text: REQUEST_APP_HTML }] };
    }
    if (request.params.uri === CONFIG_APP_URI) {
      return { contents: [{ uri: CONFIG_APP_URI, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
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
  const server = createVaultDirectoryServer({
    relay: new HostRelayClient(url, token),
    dataDir: process.env.BANTO_VAULT_DIRECTORY_DATA_DIR,
  });
  await server.connect(new StdioServerTransport());
}

/** 置き場（`g` か `g@prod`）をグループと版に分けて添える形（画面が別々に出せるように、2026-10-06）。 */
function placeParts(groupId: string): { baseGroup: string; variant?: string } {
  const { group, variant } = splitVariant(groupId);
  return { baseGroup: group, ...(variant !== undefined ? { variant } : {}) };
}
