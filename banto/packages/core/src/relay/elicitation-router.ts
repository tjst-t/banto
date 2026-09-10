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
      const target = this.resolve(conn.name);
      return target.elicitInput(request.params);
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

  private resolve(connName: string): Server {
    const state = this.connections.get(connName);
    if (!state || state.byThread.size === 0) {
      throw new ElicitationRouteError(
        `${connName}: 問いを届ける先の会話がありません（走行中のターンがない）`,
      );
    }
    const where = this.moduleCalls.threadFor(connName);
    if (where.kind === "thread") {
      const server = state.byThread.get(where.threadId);
      if (server) return server;
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
    if (state.byThread.size === 1) return [...state.byThread.values()][0]!;
    throw new ElicitationRouteError(
      `${connName}: どのターンからの問いか特定できません（走行中の tool 呼び出しがありません）`,
    );
  }
}
