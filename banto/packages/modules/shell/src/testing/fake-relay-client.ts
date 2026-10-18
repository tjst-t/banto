// 試験用の偽の中継（`HostRelayClient` の写し）。名前ごとの在りかと値の引き方だけを書けば、まとめて引く口
// （`lookupAliases`・`resolveAliases`）はそれを1件ずつ使って答える。**呼ばれた口を `calls` に残す**——回数を数えるため
import { NoBatchToolError, type AliasPlace, type HostRelayClient } from "../host-relay-client.js";

export interface FakeRelayOptions {
  /** 名前 → 在りか。投げたら、その名前の引けない理由になる。既定は `vault` の `instance` に同じ名前 */
  lookup?: (directoryModule: string, name: string) => AliasPlace | Promise<AliasPlace>;
  /** 在りか → 値。既定は「呼ばれるはずがない」で投げる */
  resolve?: (place: AliasPlace) => string | Promise<string>;
  /** `resolveAliases` を持たない Vault（第三者）。名前を並べたものは「その tool は無い」で断る */
  noBatch?: string[];
  startSshAgent?: (place: AliasPlace) => { socketPath: string } | Promise<{ socketPath: string }>;
}

export type RelayCall =
  | { tool: "lookupAliases"; target: string; names: string[] }
  | { tool: "resolveAliases"; target: string; places: AliasPlace[] }
  | { tool: "resolveAlias"; target: string; place: AliasPlace }
  | { tool: "startSshAgent"; target: string; place: AliasPlace };

export function fakeRelayClient(opts: FakeRelayOptions = {}): HostRelayClient & { calls: RelayCall[] } {
  const calls: RelayCall[] = [];
  const lookup = opts.lookup ?? ((_d: string, name: string) => ({ implementation: "vault", name, group: "instance" }));
  const resolve =
    opts.resolve ??
    (() => {
      throw new Error("relay should not be called for this test");
    });
  const client = {
    calls,
    async lookupAliases(directoryModule: string, names: string[]) {
      calls.push({ tool: "lookupAliases", target: directoryModule, names });
      return Promise.all(
        names.map(async (name) => {
          try {
            return { place: await lookup(directoryModule, name) };
          } catch (e) {
            return { error: (e as Error).message };
          }
        }),
      );
    },
    async resolveAliases(implementation: string, places: AliasPlace[]) {
      calls.push({ tool: "resolveAliases", target: implementation, places });
      if (opts.noBatch?.includes(implementation)) {
        throw new NoBatchToolError(implementation, new Error("MCP error -32603: unknown tool: resolveAliases"));
      }
      const out: string[] = [];
      for (const place of places) out.push(await resolve(place));
      return out;
    },
    async resolveAlias(place: AliasPlace) {
      calls.push({ tool: "resolveAlias", target: place.implementation, place });
      return resolve(place);
    },
    async startSshAgent(place: AliasPlace) {
      calls.push({ tool: "startSshAgent", target: place.implementation, place });
      if (!opts.startSshAgent) throw new Error("relay should not be called for this test");
      return opts.startSshAgent(place);
    },
    async close() {},
  };
  return client as unknown as HostRelayClient & { calls: RelayCall[] };
}
