/**
 * 公開している環境を**実際に叩いて**確かめる（imp-0033）。
 *
 * **困っていたこと。** 「使えます」と答えた環境が 502 を返した（2026-08-15・PO が実地で）。
 * docker ドライバの healthcheck は `docker compose ps` を見ていて、これは
 * **「コンテナが動いている」ことしか言えない**——それが*この*環境のコンテナかどうかを
 * 言えない。compose プロジェクトを共有していた2つの env のうち、実体を奪われた側も
 * 「作り直された新しいコンテナ」を見て `ok: true` を返していた。
 *
 * プロジェクト名を envId 由来にした（→ `docker-driver.ts` の `projectName`）ことで
 * その原因は塞がるが、**コンテナがすり替わる道は他にもある**（人が `docker rm` した・
 * 別の何かが同じ番号を bind した・ホストが再起動した）。だからこれは独立した防壁として
 * 置く：**公開している番号に本当に実体があるかを、台帳の側から見る**。
 *
 * ## なぜ TCP の接続までで、HTTP を喋らないのか
 *
 * 公開している中身は HTTP とは限らない（DB を公開するプロファイルもありうる）。
 * HTTP の応答を要求すると、**正常な非HTTPの環境を「壊れている」と誤診する**。
 * 一方いま塞ぎたい壊れ方（コンテナが作り直されて公開ポートが実体を失う）では、
 * docker の port publish ごと消えるので**接続が拒まれる**——接続の可否で捕まえられる。
 *
 * ## 分からないときは分からないと言う（I1）
 *
 * 「叩けなかった」を「使えます」に丸めない。接続が拒まれた（＝実体が無い）のか、
 * 時間内に判らなかったのかは**区別して**返す。どちらも `ok: false` だが、理由は違う。
 *
 * D6: node:net だけ（依存を足さない）。
 */

import * as net from "node:net";

/** 公開ポートを叩くときの待ち時間。疎通は「すぐ返るはず」のもの（spec §8 の裁定と同じ考え）。 */
export const EXPOSED_PROBE_TIMEOUT_MS = 3_000;

/**
 * 繋がったあと、切られないことを見届ける時間。
 *
 * **接続できた＝使える、ではない。** docker はポートの中継役（docker-proxy）を
 * ホスト側に置くので、**コンテナの中で誰も listen していなくても TCP の握手は通る**
 * ——中継役は受け取ってから上流に繋げず、すぐ切る。この「受けてすぐ切る」を
 * 「応答した」と数えると、また嘘をつくことになる。
 */
const SETTLE_MS = 250;

export interface ExposedProbeResult {
  /** 実体があると**言い切れた**か。分からないときは false（I1）。 */
  ok: boolean;
  /** 何を見てそう言うか。呼び出し側はこれをそのまま人に見せてよい。 */
  detail: string;
}

/**
 * 公開しているホスト側の番号に、いま実体があるか。
 *
 * 中継（caddy）が上流として dial するのと同じ相手を、同じやり方で叩く
 * ——ここが繋がらないなら、人がURLを開いたときに 502 になる。
 */
export function probeExposedPort(
  port: number,
  options: { host?: string; timeoutMs?: number } = {}
): Promise<ExposedProbeResult> {
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? EXPOSED_PROBE_TIMEOUT_MS;

  return new Promise<ExposedProbeResult>((resolve) => {
    // 一度しか答えない（error と timeout が続けて来ることがある）
    let done = false;
    let settle: NodeJS.Timeout | undefined;
    const finish = (result: ExposedProbeResult): void => {
      if (done) return;
      done = true;
      if (settle) clearTimeout(settle);
      socket.destroy();
      resolve(result);
    };

    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);

    let connected = false;
    socket.on("connect", () => {
      connected = true;
      // 繋がったあと、切られずに保つかを見届ける（SETTLE_MS のコメント）
      settle = setTimeout(() => {
        finish({
          ok: true,
          detail: `公開ポート ${port} は応答します（${host}:${port} へ接続でき、保たれています）`,
        });
      }, SETTLE_MS);
    });

    socket.on("close", () => {
      // 繋がった直後に相手から切られた＝ホスト側の口は在るが、その先に誰も居ない
      if (!connected) return;
      finish({
        ok: false,
        detail:
          `公開ポート ${port} は繋がった直後に切られました（${host}:${port}）。` +
          "口は空いていますが、その先にサービスが居ません。URL を開いても 502 になります",
      });
    });

    socket.on("timeout", () => {
      // I1: 判らなかったことを「使えます」にも「壊れています」にもしない。判らないと言う
      finish({
        ok: false,
        detail:
          `公開ポート ${port} を ${timeoutMs}ms 以内に確かめられませんでした` +
          `（${host}:${port} へ接続を試みたが応答なし）。使えるかどうか分かりません`,
      });
    });

    socket.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const refused = code === "ECONNREFUSED" || code === "ECONNRESET";
      finish({
        ok: false,
        detail: refused
          ? `公開ポート ${port} に繋がりません（${code}）。この環境の実体は失われています` +
            "（コンテナが作り直された・畳まれた等）。URL を開いても 502 になります"
          : `公開ポート ${port} を確かめられませんでした（${code || String(err)}）。` +
            "使えるかどうか分かりません",
      });
    });
  });
}
