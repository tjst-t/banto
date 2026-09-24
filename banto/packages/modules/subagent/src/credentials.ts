// **サブエージェントの既定の鍵**（決定・2026-09-24、ユーザー「OpenCode の Secret は設定から入れられるといい」）。
//
// 置き場は **Vault の決まった名前**（`subagent.<エージェント>.<変数>`）——banto 全体で1つで、どの
// Project でも使う。この Module は鍵を持たない（写しを持たない・規則3）。banto 全体の設定画面
// （`settings-server.ts`）から入れ、`runSubagent` で envSecrets を書かなければ、ここにあるものを使う。

import { readFile } from "node:fs/promises";
import type { AgentDefinition, AuthFile } from "./agents.js";
import { defaultAliasName, usesStoredKeys } from "./agents.js";
import type { HostRelayClient } from "./host-relay-client.js";

/** 会話の中で使う側（Project ごとの Module）に要る口。目録（listAliases）は人が開いた画面からだけ引く */
export type StoredKeysRelay = Pick<HostRelayClient, "lookupAlias" | "resolveAlias" | "listAliases">;
/** 設定画面の側（banto 全体の Module）に要る口 */
export type CredentialsRelay = Pick<HostRelayClient, "listAliases" | "createAlias" | "deleteAlias">;

const DIRECTORY = "vault-directory";

export class CredentialError extends Error {
  override name = "CredentialError";
}

/** Vault にいま在る既定の鍵（名前 → 置き場）。**値は通らない**（目録を引くだけ） */
export async function storedKeys(relay: CredentialsRelay): Promise<Map<string, { group?: string }>> {
  const aliases = await relay.listAliases(DIRECTORY);
  return new Map(aliases.filter((a) => a.name.startsWith("subagent.")).map((a) => [a.name, a.group ? { group: a.group } : {}]));
}

/**
 * その エージェントの既定の鍵を、Vault から env に入れる。**envSecrets で渡されたものは上書きしない**
 * ——AI が明示したほうが勝つ。
 *
 * **目録（listAliases）は引かない**——会話の中から引くと、値を返さない口なのに人への承認が1枚増える
 * （実測・2026-09-24。承認が3枚になると、待つ側の上限を超えた）。決まった名前を直接引き、
 * 「どの Vault にも無い」は「設定されていない」として読み飛ばす。承認は Shell の envSecrets と同じ
 * 2枚（在りかと値、Project ごとに初回だけ）
 */
export async function resolveStoredKeys(
  agent: AgentDefinition,
  explicit: ReadonlySet<string>,
  relay: StoredKeysRelay,
  onProgress?: (message: string) => void,
): Promise<{ env: Record<string, string>; notes: string[] }> {
  const env: Record<string, string> = {};
  const notes: string[] = [];
  if (!usesStoredKeys(agent)) return { env, notes };
  for (const name of agent.credentialEnv) {
    if (explicit.has(name)) continue;
    const alias = defaultAliasName(agent.id, name);
    const note = (n: string) => onProgress?.(`${name}（設定の鍵）——${n}`);
    let place: Awaited<ReturnType<StoredKeysRelay["lookupAlias"]>>;
    try {
      place = await relay.lookupAlias(DIRECTORY, alias, note);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 無いのは「設定されていない」——ふつうのこと
      if (NOT_FOUND.test(message)) continue;
      // **在るかどうか分からない**（読めていない Vault がある）——AI が明示した鍵ではないので仕事は止めず、
      // 読み飛ばしたことを返り値に書く（黙って落とさない・規則2。実測：設定の済んでいない Infisical を
      // 足した banto で、既定の鍵を引くたびに仕事ごと止まっていた）
      if (UNKNOWN.test(message)) {
        notes.push(`${name}：設定の鍵を確かめられませんでした（${message.replace(/^.*?alias /, "alias ")}）`);
        continue;
      }
      // それ以外（承認で断られた等）はそのまま止める
      throw err;
    }
    env[name] = await relay.resolveAlias(place, note);
  }
  return { env, notes };
}

/** 窓口（vault-directory の lookupAlias）が「どこにも無い」と言うときの文言 */
const NOT_FOUND = /どの Vault にもありません|在りかが分かりません/;
/** 「見つからないが、読めていない Vault がある」——在るかどうかが分からない */
const UNKNOWN = /見つかりませんでしたが、読めていない Vault があります/;

/** 取り込み元（この機械のエージェント自身の設定）にある値。**人が押したときだけ読む** */
export async function importableValue(agent: AgentDefinition, envName: string): Promise<string | undefined> {
  const source = agent.importFrom;
  const pick = source?.pick[envName];
  if (!source || !pick) return undefined;
  let raw: string;
  try {
    raw = await readFile(source.file(), "utf8");
  } catch {
    return undefined;
  }
  try {
    return pick(JSON.parse(raw) as AuthFile) || undefined;
  } catch {
    throw new CredentialError(`${source.label}の設定（${source.file()}）を読めませんでした`);
  }
}

/**
 * 既定の鍵を置く（在れば置き換える）。値は窓口を通って金庫へ——この Module は持たない。
 *
 * Vault は alias の書き換え・削除を**人の管理操作のときだけ**受け付ける（`vault-kit` の assertHuman）。
 * banto 全体の設定画面から押した操作はそれに当たる（host が `{admin}` を刻む）ので、消してから作り直す
 * ——Vault の値を置き換える口は種別 oauth-token にしか無い（v4-security.md）
 */
export async function storeKey(agent: AgentDefinition, envName: string, value: string, relay: CredentialsRelay): Promise<void> {
  assertKeyOf(agent, envName);
  const trimmed = value.trim();
  if (trimmed === "") throw new CredentialError("鍵が空です");
  const alias = defaultAliasName(agent.id, envName);
  const existing = (await storedKeys(relay)).get(alias);
  if (existing) await relay.deleteAlias(DIRECTORY, { name: alias, ...existing });
  await relay.createAlias(DIRECTORY, {
    name: alias,
    value: trimmed,
    note: `サブエージェント ${agent.title} の ${envName}（サブエージェントの設定から。どの Project でも使う）`,
  });
}

export async function deleteKey(agent: AgentDefinition, envName: string, relay: CredentialsRelay): Promise<void> {
  assertKeyOf(agent, envName);
  const alias = defaultAliasName(agent.id, envName);
  const existing = (await storedKeys(relay)).get(alias);
  if (!existing) throw new CredentialError(`${envName} は設定されていません`);
  await relay.deleteAlias(DIRECTORY, { name: alias, ...existing });
}

function assertKeyOf(agent: AgentDefinition, envName: string): void {
  if (!usesStoredKeys(agent)) throw new CredentialError(`${agent.title} は鍵を使いません（banto 本体のログインを使います）`);
  if (!agent.credentialEnv.includes(envName)) {
    throw new CredentialError(`${agent.title} の鍵に ${envName} はありません（${agent.credentialEnv.join(", ")}）`);
  }
}
