// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// のModule側実装。BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKENはhostが起動時に
// envで渡す（決定・2026-09-03）。
//
// **待つ側の上限を、進捗で更新し続ける**（追加・2026-09-10）。中継の初回は
// host が人に承認を聞くので、返事が来るまでこの呼び出しは待つ——既定の60秒で
// 切れると「人が答えたのに、その回のコマンドは失敗している」になる。
// host からの `notifications/progress` を受けたらタイムアウトを引き延ばし、
// **さらに自分の呼び出し元（＝AI のターン）へも中継する**——さもないと、
// この呼び出しが生きていても外側の tool 呼び出しが先に切れる。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BATCH_MAX_ITEMS } from "@banto/module-contract";

export interface HostRelayClientOptions {
  url: string;
  token: string;
}

/** 待っている間の合図（host から届いた進捗を、そのまま上へ流すため）。 */
export type RelayProgressListener = (note: string) => void;

/**
 * **秘密の在りか**。alias の同一性は (Vault, グループ, 名前) の三つ組
 * （`v4-modules.md` §2.1）なので、**運ぶときも三つ組のまま運ぶ**。
 *
 * 平たくして名前だけにすると、受け取った側が自分の既定解決で復元することになり、
 * **別の秘密を開ける／見つからない**が起きる（実際に起きていた・2026-09-15）。
 */
export interface AliasPlace {
  implementation: string;
  /** backend での本当の名前（修飾名ではない） */
  name: string;
  /** 置き場。省くと backend の既定解決に落ちるので、**引けたなら必ず入れる** */
  group?: string;
}

/** 宛先がまとめて引く口（`resolveAliases`）を持っていない（第三者の Vault）。呼び手は1件ずつの `resolveAlias` に落とす */
export class NoBatchToolError extends Error {
  constructor(readonly implementation: string, cause: Error) {
    super(`${implementation} は resolveAliases を持っていません（${cause.message}）`);
  }
}

/**
 * 「その tool は無い」で断られたか。Shell は宛先の tool の一覧を引けないので、断りの文で見分ける
 * ——vault-kit（低レベルの Server）は `unknown tool: <名前>`、SDK の McpServer は `Tool <名前> not found`、
 * JSON-RPC の「無いメソッド」は -32601。**ほかの理由は拾わない**（落とすと、断られた理由が1件ずつの呼び出しの理由に化ける）
 */
function isNoSuchTool(err: unknown, tool: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/Method not found|-32601/.test(message)) return true;
  return message.includes(tool) && new RegExp(`unknown tool:? ${tool}\\b|Tool ${tool} not found`, "i").test(message);
}

type LookedUp = { implementation?: string; name?: string; group?: string };

/** 窓口の答えを在りかにする。分からなければ投げる */
function placeOf(asked: string, found: LookedUp): AliasPlace {
  // 在りかが分からないまま既定の Vault へ落とすと、**別の金庫の同名を
  // 開けてしまう**。黙って別の経路へ行かない（規則2）
  if (!found.implementation) throw new Error(`alias "${asked}" の在りかが分かりません`);
  // **窓口が返した名前と置き場をそのまま運ぶ**（訂正・2026-09-15）。
  // 以前は implementation だけを読み、`resolveAlias` には AI が書いた文字列を
  // そのまま渡していた——**修飾名（`vault-infisical:npm-token`）だと backend に
  // その名前は無く、一覧に出た名前が使えない**という形で壊れていた。
  // 窓口自身が「name は backend での本当の名前」と言っているのに、捨てていた。
  if (!found.name) throw new Error(`alias "${asked}" の本当の名前が分かりません`);
  return { implementation: found.implementation, name: found.name, group: found.group };
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += BATCH_MAX_ITEMS) out.push(xs.slice(i, i + BATCH_MAX_ITEMS));
  return out;
}

export class HostRelayClient {
  private client?: Client;

  constructor(private readonly opts: HostRelayClientOptions) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { authorization: `Bearer ${this.opts.token}` } },
    });
    const client = new Client({ name: "banto-module-shell", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /** 中継を1本呼ぶ。**進捗を受け取れる形**で呼ぶのはここ1箇所（規則3）。 */
  private async callRelayResult(
    args: Record<string, unknown>,
    onProgress?: RelayProgressListener,
  ): Promise<{ text: string | undefined; isError: boolean }> {
    const client = await this.ensureConnected();
    // `onprogress` を渡すと、SDK が progressToken を付けてくれる（host は
    // それを見て進捗を送れる）。**渡さないと host は送りようがない**
    const result = await client.callTool({ name: "relayCallTool", arguments: args }, undefined, {
      resetTimeoutOnProgress: true,
      onprogress: (progress) => {
        onProgress?.(progress.message ?? "host の返事を待っています");
      },
    });
    return { text: (result.content as { type: string; text: string }[])[0]?.text, isError: result.isError === true };
  }

  private async callRelay(args: Record<string, unknown>, onProgress?: RelayProgressListener): Promise<string | undefined> {
    return (await this.callRelayResult(args, onProgress)).text;
  }

  /** 中継を1本呼び、宛先が断ったら（`isError`）その文で投げる。 */
  private async callRelayOrThrow(args: Record<string, unknown>, onProgress?: RelayProgressListener): Promise<string | undefined> {
    const { text, isError } = await this.callRelayResult(args, onProgress);
    if (isError) throw new Error(text ?? `${String(args.targetModule)} の ${String(args.name)} が断りました`);
    return text;
  }

  /**
   * 名前から**在りか**を1件引く（`vault-directory` の窓口）。**値は通らない**——返るのは「どの Vault にあるか」だけ
   * （アーキ仕様 §2.5、DNS と同じ形）。Shell の runCommand はまとめて引く（`lookupAliases`）——これは1件ずつで足りる
   * 呼び手（Service の envSecrets）のための口
   */
  async lookupAlias(directoryModule: string, name: string, onProgress?: RelayProgressListener): Promise<AliasPlace> {
    const text = await this.callRelay(
      { targetModule: directoryModule, name: "lookupAlias", arguments: { name } },
      onProgress,
    );
    return placeOf(name, JSON.parse(text ?? "{}") as LookedUp);
  }

  /**
   * 名前から**在りか**をまとめて引く（`vault-directory` の窓口の `lookupAliases`。2026-10-18、仕様 §2.1「秘密をまとめて引く」）。
   * **値は通らない**——返るのは「どの Vault にあるか」だけで、値は引いたあと backend を直接呼んで受け取る
   * （アーキ仕様 §2.5、DNS と同じ形）。名前ごとに在りかか、引けない理由を返す（並びは `names` と同じ）。
   * 1回に `BATCH_MAX_ITEMS` 件まで——超えたら分けて呼ぶ
   */
  async lookupAliases(
    directoryModule: string,
    names: string[],
    onProgress?: RelayProgressListener,
  ): Promise<Array<{ place: AliasPlace } | { error: string }>> {
    const out: Array<{ place: AliasPlace } | { error: string }> = [];
    for (const chunk of chunks(names)) {
      const text = await this.callRelayOrThrow(
        { targetModule: directoryModule, name: "lookupAliases", arguments: { items: chunk.map((name) => ({ name })) } },
        onProgress,
      );
      const { results } = JSON.parse(text ?? "{}") as {
        results?: Array<{ name?: string; found?: LookedUp; error?: string }>;
      };
      if (!Array.isArray(results) || results.length !== chunk.length) {
        throw new Error(`${directoryModule} の lookupAliases の答えが頼んだ数と合いません`);
      }
      for (const [i, name] of chunk.entries()) {
        const r = results[i]!;
        if (r.error !== undefined) {
          out.push({ error: r.error });
          continue;
        }
        try {
          out.push({ place: placeOf(name, r.found ?? {}) });
        } catch (e) {
          out.push({ error: (e as Error).message });
        }
      }
    }
    return out;
  }

  /**
   * 1つの Vault から値をまとめて引く（`resolveAliases`、全部か何もなし。並びは `places` と同じ）。1回に `BATCH_MAX_ITEMS` 件まで
   * ——超えたら分けて呼ぶ。**宛先がその口を持たなければ `NoBatchToolError`**（第三者の Vault——呼び手は1件ずつに落とす）。
   * ほかの理由で断られたら、そのまま投げる
   */
  async resolveAliases(implementation: string, places: AliasPlace[], onProgress?: RelayProgressListener): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunks(places)) {
      let text: string | undefined;
      try {
        text = await this.callRelayOrThrow(
          {
            targetModule: implementation,
            name: "resolveAliases",
            arguments: { items: chunk.map((p) => (p.group === undefined ? { name: p.name } : { name: p.name, group: p.group })) },
          },
          onProgress,
        );
      } catch (err) {
        if (isNoSuchTool(err, "resolveAliases")) throw new NoBatchToolError(implementation, err as Error);
        throw err;
      }
      const { values } = JSON.parse(text ?? "{}") as { values?: Array<{ value?: unknown }> };
      if (!Array.isArray(values) || values.length !== chunk.length || values.some((v) => typeof v?.value !== "string")) {
        throw new Error(`${implementation} の resolveAliases の答えが頼んだ数と合いません`);
      }
      out.push(...values.map((v) => v.value as string));
    }
    return out;
  }

  async resolveAlias(place: AliasPlace, onProgress?: RelayProgressListener): Promise<string> {
    const text = await this.callRelay(
      {
        targetModule: place.implementation,
        name: "resolveAlias",
        arguments: { name: place.name, group: place.group },
      },
      onProgress,
    );
    if (typeof text !== "string") throw new Error(`alias "${place.name}" の解決に失敗しました`);
    return text;
  }

  async startSshAgent(place: AliasPlace, onProgress?: RelayProgressListener): Promise<{ socketPath: string }> {
    const text = await this.callRelay(
      {
        targetModule: place.implementation,
        name: "startSshAgent",
        arguments: { identity: place.name, group: place.group },
      },
      onProgress,
    );
    return JSON.parse(text ?? "{}") as { socketPath: string };
  }

  /**
   * **返信用の札で、呼び出し元の Thread に届ける**（host の口、アーキ仕様 §4.2。追加・2026-10-07——待たずに流した
   * コマンドの終わり）。宛先は札でしか指せない——札は host がこの Module の tool 呼び出しに渡したもの
   */
  async deliverToThread(input: { replyTo: string; title: string; text: string; final?: boolean }): Promise<{ deliveryId: string; wake: string }> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name: "relayDeliverToThread", arguments: input });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    if (result.isError) throw new Error(text ?? "呼び出し元の Thread に届けられませんでした");
    return JSON.parse(text ?? "{}");
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
