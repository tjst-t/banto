/**
 * 番頭ホストへのWSクライアント（task-0009）。
 *
 * CLI と受け入れテストが共有する。WebUI も同じプロトコルを話すが、ブラウザ側は
 * 標準の WebSocket を使うためこのクラス自体は使わない（契約は protocol.ts が正典）。
 *
 * D6: ws（Node 20 にはクライアント WebSocket も無い）。
 * I2: 接続失敗・プロトコル違反は握りつぶさず呼び出し側へ渡す。
 */

import { WebSocket } from "ws";
import { BANTO_WS_PATH, type ClientMessage, type ServerEvent } from "./protocol.js";

export type ServerEventHandler = (event: ServerEvent) => void;

export class BantoHostClient {
  private constructor(private readonly ws: WebSocket) {}

  /** 接続が確立するまで待って返す。 */
  static async connect(url: string, onEvent: ServerEventHandler): Promise<BantoHostClient> {
    const ws = new WebSocket(url.endsWith(BANTO_WS_PATH) ? url : `${url}${BANTO_WS_PATH}`);

    ws.on("message", (data: Buffer) => {
      // I2: サーバからの壊れたJSONは黙って捨てず例外にする（プロトコル不整合の早期発見）
      onEvent(JSON.parse(data.toString("utf-8")) as ServerEvent);
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.off("error", reject);
        resolve();
      });
      ws.once("error", reject);
    });

    return new BantoHostClient(ws);
  }

  /** 番頭に発話する。ターンの完了は turn_end イベントで判る。 */
  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** 発話し、turn_end が来るまで待つ。 */
  async prompt(text: string, waitForTurnEnd: () => Promise<void>): Promise<void> {
    const done = waitForTurnEnd();
    this.send({ type: "prompt", text });
    await done;
  }

  close(): void {
    this.ws.close();
  }
}
