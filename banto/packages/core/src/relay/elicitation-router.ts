// **Module からの問いを、正しい会話に届ける**（`relay-lifecycle-and-elicitation`、
// 決定・2026-09-10）。
//
// host は実 Module への接続を**1本だけ**持つ（アーキ仕様 §2.5）。その1本に
// Elicit のハンドラを付けると、**最後に作った代理サーバが上書きする**——つまり
// 並行して2つのターンが走っているとき、Vault の「この alias が無い」が
// **別の会話に出る**（コード内 TODO として残っていた）。
//
// 直し方は、Module 間中継の承認と同じ考え方（relay/module-calls.ts）：
// **いまその Module がどのターンの仕事をしているか**を台帳で引き、そのターンの
// 代理サーバへ渡す。**決められないなら渡さない**——推測で別の会話に出さない（規則2）。

import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CALL_ID_META_KEY } from "@banto/module-contract";
import type { ModuleCallTracker } from "./module-calls.js";

export class ElicitationRouteError extends Error {}

interface ConnectionState {
  /** そのターン（Thread）向けに立っている代理サーバ。 */
  byThread: Map<string, Server>;
  /** 実 Module への接続に、ハンドラを1回だけ付けたか。 */
  installed: boolean;
}

export class ElicitationRouter {
  private readonly connections = new Map<string, ConnectionState>();

  constructor(private readonly moduleCalls: ModuleCallTracker) {}

  /**
   * その接続の Elicit をこの代理サーバでも受けられるようにする。
   * ハンドラは**接続ごとに1回だけ**付ける（上書き合戦をしない）。
   */
  register(conn: { name: string; client: Client }, threadId: string | undefined, server: Server): void {
    const state = this.connections.get(conn.name) ?? { byThread: new Map(), installed: false };
    this.connections.set(conn.name, state);
    // Thread が分からない接続（画面から開いた Canvas 等）は宛先になれない
    if (threadId) state.byThread.set(threadId, server);

    if (state.installed) return;
    state.installed = true;
    conn.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      // **問いの答えを待つ間、その呼び出しは人を待っている**（追加・2026-10-05、アーキ仕様 §2.5「画面から banto を
      // 更新する」の待つ段）。中継の承認と同じ印——起こし直しの「待つ」はこの呼び出しを待たない（待つと人が答えるまで
      // どこまでも待つ）。外側の呼び出しの上限もこの間は数えない（`agent-proxy.ts`、承認と同じ）。
      // **印を立てる呼び出しは絞る**（改訂・2026-10-05、Fable のレビュー）：Module が問いの `_meta` に呼び出しの印
      // （`dev.banto/callId`、中継と同じ契約）を返せばその1件、返さなければ問いを出す会話の呼び出しだけ
      const meta = (request.params._meta as Record<string, unknown> | undefined)?.[CALL_ID_META_KEY];
      const callId = typeof meta === "string" && meta !== "" ? meta : undefined;
      // 印があれば、出す会話もその1件の会話で決める（別の会話の呼び出しと並んでいても決まる）
      const target = this.resolve(conn.name, callId);
      const release =
        callId !== undefined
          ? this.moduleCalls.holdForElicitation(conn.name, { callId })
          : target.threadId !== undefined
            ? this.moduleCalls.holdForElicitation(conn.name, { threadId: target.threadId })
            : () => undefined;
      try {
        return await target.server.elicitInput(request.params);
      } finally {
        release();
      }
    });
  }

  /** そのターンの代理サーバを外す（ターンの接続が閉じたとき）。 */
  unregister(connName: string, threadId: string | undefined): void {
    if (!threadId) return;
    this.connections.get(connName)?.byThread.delete(threadId);
  }

  /** その Module ごと外す（Module を畳んだとき）。 */
  forget(connName: string): void {
    this.connections.delete(connName);
  }

  /** 問いを届ける代理サーバと、その会話（走っている呼び出しで決めたとき。決めずに唯一の宛先へ渡したときは無い） */
  private resolve(connName: string, callId?: string): { server: Server; threadId?: string } {
    const state = this.connections.get(connName);
    if (!state || state.byThread.size === 0) {
      throw new ElicitationRouteError(
        `${connName}: 問いを届ける先の会話がありません（走行中のターンがない）`,
      );
    }
    const where = this.moduleCalls.threadFor(connName, callId);
    if (where.kind === "thread") {
      const server = state.byThread.get(where.threadId);
      if (server) return { server, threadId: where.threadId };
      throw new ElicitationRouteError(
        `${connName}: 走行中のターン（${where.threadId}）の代理サーバが見つかりません`,
      );
    }
    if (where.kind === "ambiguous") {
      // **推測しない。** 別の会話に出すくらいなら、この呼び出しを失敗させる
      throw new ElicitationRouteError(
        `${connName}: 複数のターンが同時にこの Module を使っているため、` +
          `どの会話に問いを出すか決められません（${where.threadIds.join(", ")}）`,
      );
    }
    // 走行中の tool 呼び出しが無い＝この問いは誰の仕事でもない。
    // 1つしか繋がっていなければ、それが唯一の宛先になる（曖昧さが無い）
    if (state.byThread.size === 1) return { server: [...state.byThread.values()][0]! };
    throw new ElicitationRouteError(
      `${connName}: どのターンからの問いか特定できません（走行中の tool 呼び出しがありません）`,
    );
  }
}
