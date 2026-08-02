/**
 * 検証環境を外から見えるようにする口（ADR-0010 決定39・imp-0008）。
 *
 * **なぜ差し替え可能にするか。** 公開の手段は**配置で決まる**——banto が自分の VM に常駐して
 * Caddy を持つなら route を注入できるが、いまのように別のものが管理する箱の中で動いている
 * ときは、その Caddy の admin API には届かない（Palmux の Caddy は `admin localhost:2019`
 * でホストに閉じている。実測で確認済み）。**どちらか一方に決め打つと、片方の配置で動かない。**
 *
 * `EnvDriver`（決定11・32）・`PlaceProvider`（決定36c）と同じ形。実装が2つある時点で
 * 抽象化の閾値は超えており、決定18 の「将来ニーズを見越した追加はしない」には抵触しない。
 *
 * **ポートは呼び出し側が明示する。** ドライバの `handle` と `config` は不透明で、中身を
 * 解釈しない（`spec-environment` §2・D1/D3）。`handle.port` を覗くと Environment Pool が
 * ドライバごとの内部表現に依存し始めるので、「どのポートを公開するか」は環境を頼む側が言う。
 */

/** 公開された環境の到達先。 */
export interface ExposedEnv {
  envId: string;
  /** そのポートで待っている中身へ届くURL。 */
  url: string;
  /** 公開したポート（環境の中での番号）。 */
  port: number;
  /** どの実装が公開したか。画面と記録に出す。 */
  exposer: string;
}

export interface ExposeRequest {
  envId: string;
  /** 環境の中で待っているポート。 */
  port: number;
  /** 人が見て分かる名前（サブドメイン等の材料）。 */
  label?: string;
}

/**
 * 公開の口。
 *
 * I2: 公開できなかったら黙って「公開したことにしない」。URLが返らないまま
 *     「見られます」と言われるのが一番困る。
 */
export interface EnvExposer {
  /** 実装の名前（`banto-proxy` / `caddy` 等）。 */
  name: string;
  expose(request: ExposeRequest): Promise<ExposedEnv>;
  /** 公開を取り下げる。**冪等**——公開していないものへ呼んでも成功する。 */
  unexpose(envId: string): Promise<void>;
  /** いま公開しているもの。畳み損ねた公開を見つけるために使う。 */
  list(): Promise<ExposedEnv[]>;
  /**
   * HTTP Upgrade（WebSocket）を中継できる実装だけが持つ口（案A）。
   *
   * 公開した環境の面に HTTP だけでなく WS も生やすための入り口。中継できる
   * 実装（proxy exposer）だけが実装し、できない実装（Caddy）は持たない。
   * `handle` と同じく、捌いたら true、対象外なら false を返す。
   *
   * @param req    解析済みの HTTP リクエスト（ヘッダのみ。本体は無い）
   * @param socket クライアント側の生ソケット。upgrade 応答の書き込みと双方向 pipe に使う
   * @param head   リクエストヘッダと一緒に届いた先行バイト（空でないこともある）
   */
  handleUpgrade?(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer
  ): boolean;
}
