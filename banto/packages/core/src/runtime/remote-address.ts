// **別のサーバの Project の、外から中のサービスに届くアドレス**（Publish。決定・2026-10-08、`docs/specs/v4-security.md` §1
// 「Publish」、Backlog `remote-runtime-publish`）。
//
// 登録した宛先の LAN のアドレス。名前なら host で引く（IPv4——Caddy の行き先に `アドレス:ポート` の形で入れるので、
// コンテナと同じく IPv4 に揃える）。同じ LAN にあることが前提で、実際にそのポートへ届くかは公開の実装が TCP で確かめる。
//
// 断りは `Runtime.address` と同じく2通り：**確かに届かない**（登録が無い・名前が無い・IPv4 が無い）は値で、
// **分からない**（名前引きの一時の失敗）は投げる——公開の実装が、一時の失敗で道を止めないように。

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PlaceAddress } from "./runtime.js";

/** 名前を引く口（試験で差し替える） */
export type LookupIPv4 = (host: string) => Promise<string>;

const defaultLookup: LookupIPv4 = async (host) => (await dnsLookup(host, { family: 4 })).address;

/** 名前が確かに無い（一時の失敗ではない）ときの、名前引きの失敗の符号 */
const NAME_MISSING = new Set(["ENOTFOUND", "ENODATA"]);

export async function remoteAddress(
  runtimeName: string,
  host: string | undefined,
  lookup: LookupIPv4 = defaultLookup,
): Promise<PlaceAddress> {
  if (host === undefined) return { unavailable: `実行場所「${runtimeName}」の登録がありません` };
  const kind = isIP(host);
  if (kind === 4) return { address: host, exposedOnLan: true };
  if (kind === 6) return { unavailable: `別のサーバ「${runtimeName}」の宛先が IPv6（${host}）です——公開は IPv4 の宛先にだけ繋ぎます` };
  try {
    return { address: await lookup(host), exposedOnLan: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && NAME_MISSING.has(code)) {
      return { unavailable: `別のサーバ「${runtimeName}」の宛先 ${host} の IPv4 のアドレスを、この banto の host で引けません（${code}）` };
    }
    throw new Error(`別のサーバ「${runtimeName}」の宛先 ${host} を引けませんでした：${err instanceof Error ? err.message : String(err)}`);
  }
}
