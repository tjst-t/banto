// アカウントの秘密の置き場——**Vault**（docs/specs/v4-modules.md §2.1・§2.4）。この Module は秘密の値を持たない：
// 台帳・設定に書くのは alias の在りか（Vault・置き場・名前）だけで、値は使うたびに Vault から引く（写さない、規則3）。
//
// 呼ぶのはどれも中継（`relayCallTool`）で、**人の画面からの呼び出しを処理している間だけ**呼ぶ。人が押した、同梱どうしの
// 呼び出しなので承認ゲートは通らない（docs/specs/v4-security.md §3。値を返す `resolveAlias` も）。AI のターンからは呼ばない。
//
// - 窓口（`vault-directory`）：目録・在りかを引く・人が貼った PAT を預ける（`createAlias`）・消す
// - 金庫（在りかの `implementation`）：値を引く（`resolveAlias`）・**banto が置く秘密を置き換える**（`putSecret`——
//   種別 `oauth-token` だけ。人が預けた秘密には、この口から届かない。MCP の OAuth のログイン情報と同じ置き方）

import type { ModuleCaller } from "./relay-client.js";

/** 窓口の接続の名前（subagent の設定と同じ決め方——窓口は banto に1本） */
const DIRECTORY = "vault-directory";

/** 秘密の在りか。alias の同一性は (Vault, 置き場, 名前) の三つ組（§2.1）——**運ぶときも三つ組のまま** */
export interface AliasPlace {
  implementation: string;
  name: string;
  group?: string;
}

export interface AliasEntry extends AliasPlace {
  kind: string;
}

export interface VaultAccess {
  /** 目録（名前・種別・在りかだけ。値は通らない）。読めなかった Vault は `failures` */
  listAliases(callId?: string): Promise<{ aliases: AliasEntry[]; failures: Array<{ implementation: string; error: string }> }>;
  /** 値を引く */
  resolve(place: AliasPlace, callId?: string): Promise<string>;
  /** 人が貼った秘密を預ける（既にあれば断られる——人の秘密を黙って上書きしない）。在りかを返す */
  createSecret(input: { name: string; value: string; note: string }, callId?: string): Promise<AliasPlace>;
  /**
   * banto が置く秘密（`oauth-token`）を置く。`place` があればそこを置き換え（更新で回った refresh token）、
   * 無ければ既定の Vault の共通の置き場に作る。在りかを返す
   */
  putOwned(input: { name: string; value: string; note: string }, place: AliasPlace | undefined, callId?: string): Promise<AliasPlace>;
  /** 消す（人の管理操作のときだけ Vault が受け付ける） */
  remove(place: AliasPlace, callId?: string): Promise<void>;
  /** その SSH 鍵を持った ssh-agent の窓口（Vault が立てる。鍵の値はこの Module を通らない） */
  startSshAgent(place: AliasPlace, callId?: string): Promise<{ socketPath: string }>;
}

function placeOf(raw: unknown, name: string): AliasPlace {
  const r = raw as { implementation?: unknown; name?: unknown; group?: unknown };
  // 在りかが分からないまま既定へ落とすと、別の金庫の同名を開けてしまう（規則2）
  if (typeof r?.implementation !== "string" || typeof r.name !== "string") throw new Error(`alias "${name}" の在りかが分かりません`);
  return { implementation: r.implementation, name: r.name, ...(typeof r.group === "string" ? { group: r.group } : {}) };
}

export class RelayVault implements VaultAccess {
  constructor(private readonly relay: ModuleCaller) {}

  async listAliases(callId?: string) {
    const body = JSON.parse(await this.relay.callTool(DIRECTORY, "listAliases", {}, callId)) as {
      aliases?: Array<Record<string, unknown>>;
      failures?: Array<{ implementation: string; error: string }>;
    };
    const aliases: AliasEntry[] = [];
    for (const a of body.aliases ?? []) {
      if (typeof a.name !== "string" || typeof a.implementation !== "string" || typeof a.kind !== "string") continue;
      aliases.push({ ...placeOf(a, a.name), kind: a.kind });
    }
    return { aliases, failures: body.failures ?? [] };
  }

  private async lookup(name: string, callId?: string): Promise<AliasPlace> {
    return placeOf(JSON.parse(await this.relay.callTool(DIRECTORY, "lookupAlias", { name }, callId)), name);
  }

  resolve(place: AliasPlace, callId?: string): Promise<string> {
    return this.relay.callTool(place.implementation, "resolveAlias", { name: place.name, ...(place.group ? { group: place.group } : {}) }, callId);
  }

  async createSecret(input: { name: string; value: string; note: string }, callId?: string): Promise<AliasPlace> {
    await this.relay.callTool(DIRECTORY, "createAlias", { name: input.name, kind: "secret", value: input.value, note: input.note }, callId);
    return this.lookup(input.name, callId);
  }

  async putOwned(input: { name: string; value: string; note: string }, place: AliasPlace | undefined, callId?: string): Promise<AliasPlace> {
    if (place) {
      // **在りかへ直接**——窓口の putSecret は既定の Vault・既定の置き場にしか置かない。既定が変わっても、
      // 更新したトークンは元の場所に戻す（別の場所に2つ目を作ると、古い refresh token が残る）
      await this.relay.callTool(
        place.implementation,
        "putSecret",
        { name: place.name, value: input.value, note: input.note, ...(place.group ? { group: place.group } : {}) },
        callId,
      );
      return place;
    }
    await this.relay.callTool(DIRECTORY, "putSecret", { name: input.name, value: input.value, note: input.note }, callId);
    return this.lookup(input.name, callId);
  }

  async startSshAgent(place: AliasPlace, callId?: string): Promise<{ socketPath: string }> {
    const body = JSON.parse(
      await this.relay.callTool(place.implementation, "startSshAgent", { identity: place.name, ...(place.group ? { group: place.group } : {}) }, callId),
    ) as { socketPath?: unknown };
    if (typeof body.socketPath !== "string" || body.socketPath === "") throw new Error(`SSH 鍵 ${place.name} の ssh-agent の窓口が返ってきませんでした`);
    return { socketPath: body.socketPath };
  }

  async remove(place: AliasPlace, callId?: string): Promise<void> {
    await this.relay.callTool(
      DIRECTORY,
      "deleteAlias",
      { implementation: place.implementation, name: place.name, ...(place.group ? { group: place.group } : {}) },
      callId,
    );
  }
}
