/**
 * `none` 公開の core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * **これは「公開しない」実装である。** 受け取った `host:port` を URL の形にして
 * 返すだけで、経路も作らないしトンネルも掘らない。
 *
 * **公開したふりをしない。** 返す URL は本当にその宛先を指していて、
 * banto ホストの外からは届かない。届くかのように見せると、
 * 「動いているはずなのに開けない」という一番たちの悪い壊れ方になる。
 * だから `describe()` で、届く範囲を値として返す。
 */

/** `host:port` の形。ここで確かめないと、壊れた文字列がそのまま URL になる。 */
const HOST_PORT = /^(?<host>[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]):(?<port>\d{1,5})$/;

export interface Published {
  readonly url: string;
  /** どこから届くか。**「公開した」と「届く」は別物**なので、値で返す。 */
  readonly reachableFrom: 'banto-host-only';
}

export class NonePublishCore {
  /**
   * `host:port` を URL にして返す。**名前は使わない**——経路を作らないので、
   * 名前で引く先が存在しない。受け取っても黙って捨てず、無視することを説明に書く。
   */
  publish(hostPort: string): Published {
    const match = HOST_PORT.exec(hostPort.trim());
    if (!match?.groups) {
      throw new Error(`host:port の形ではない: ${hostPort}`);
    }
    const port = Number(match.groups['port']);
    if (port < 1 || port > 65535) throw new Error(`port が範囲外: ${port}`);

    return { url: `http://${match.groups['host']}:${port}`, reachableFrom: 'banto-host-only' };
  }

  /**
   * 公開を畳む。**作った経路が無いので、消すものも無い。**
   *
   * それでも口を持つ理由は、Factory が `teardown` で必ず呼ぶからである
   * ——実装ごとに「呼んでよい／いけない」が変わると、Factory が実装を知ることになる。
   */
  unpublish(name: string): string {
    return `${name}: 経路を作っていないので、畳むものは無い`;
  }
}
