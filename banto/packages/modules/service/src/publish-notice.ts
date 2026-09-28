// **登録を消すとき、公開の窓口に知らせる**（追加・2026-09-28、docs/specs/v4-modules.md §4.2・§4.3）。
//
// 公開中のサービスを消したまま公開が残ると、同じ名前で別の中身を登録し直したとき、人の承認なしに同じ URL の中身が
// 替わる（Service が「上書きは断る」と決めた理由そのもの）。Service から窓口（`publish-directory` 役割、banto 全体に1本）を
// 中継で呼び、その Project の公開をやめてもらう。中継が刻む Project の刻印で、窓口はこの Project の公開だけを触る。
//
// Shell の中継の口（`host-relay-client.js`）は値を引く道具しか持たないので、ここに小さな写しを置く
// ——共有にするかは `module-kit-extract`（docs/tasks.json）で決める。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DIRECTORY_ROLE = "publish-directory";

export type RelayCall = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

/**
 * そのサービスの公開をやめてもらう。**窓口が繋がっていなければ何もしない**（公開の仕組みを入れていない Project）。
 * 窓口が断ったら投げる——呼び出し元（`ServiceManager.remove`）は登録を消さない
 */
export async function withdrawPublications(call: RelayCall, name: string): Promise<{ unpublished: { url: string; port: number }[] }> {
  const listed = await call("relayListTargets", {});
  if (listed.isError) throw new Error(listed.text || "中継が相手の一覧を返しませんでした");
  const directories = (JSON.parse(listed.text) as { name: string; roles: string[] }[]).filter((t) => t.roles.includes(DIRECTORY_ROLE));
  const unpublished: { url: string; port: number }[] = [];
  for (const d of directories) {
    const r = await call("relayCallTool", { targetModule: d.name, name: "serviceRemoved", arguments: { service: name } });
    if (r.isError) throw new Error(r.text || `${d.name} が公開をやめられませんでした`);
    const out = JSON.parse(r.text) as { unpublished?: { url: string; port: number }[] };
    unpublished.push(...(out.unpublished ?? []).map((u) => ({ url: u.url, port: u.port })));
  }
  return { unpublished };
}

/** host の中継を呼ぶ口。**失敗したら次は繋ぎ直す**（一度切れたセッションを覚え続けない） */
export function hostRelayCall(url: string, token: string): RelayCall {
  let client: Promise<Client> | undefined;
  const connect = () => {
    if (!client) {
      const c = new Client({ name: "banto-module-service", version: "0.1.0" });
      client = c
        .connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        .then(() => c);
    }
    return client;
  };
  return async (name, args) => {
    try {
      const c = await connect();
      // 中継の初回は host が人に承認を聞くことがある——進捗で待つ上限を延ばす
      const result = await c.callTool({ name, arguments: args }, undefined, { resetTimeoutOnProgress: true, onprogress: () => undefined });
      return { text: (result.content as { type: string; text: string }[])[0]?.text ?? "", isError: result.isError === true };
    } catch (err) {
      const old = client;
      client = undefined;
      void old?.then((c) => c.close()).catch(() => undefined);
      throw err;
    }
  };
}
