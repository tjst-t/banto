/**
 * 別プロセスで立っているモジュールを、番頭ホストに載せる（task-0066・ADR-0013 決定61）。
 *
 * **なぜ要るか。** Worker Pool と Environment Pool は番頭ホストの中で作られていた。
 * そのままだと Kobo が職人を起こすのに番頭の稼働が要り、決定27b が避けた「Banto が単一
 * 障害点になり依存の向きが逆転する」形になる。独立サービスへ出すのが決定61 で、
 * **出した先を番頭ホストがどう載せるか**がここ。
 *
 * Kobo で先に踏んだ形（`kobo-module.ts`）の一般化：
 *
 *   - 契約（名前・説明・引数）は**持ち主のパッケージから**そのまま取る。2箇所に書くと、
 *     番頭が読む説明と実際の振る舞いが静かにずれる
 *   - `execute` だけを HTTP 越しに差し替える（`{remoteUrl}/tools/{名前}`）
 *   - `endpoint.baseUrl` は**相対パス**。ブラウザは別の機械で動き、127.0.0.1 の
 *     サービスへは届かない——ホストが自分の面に生やして中継する
 *   - Tool の規約に乗らない面（検証環境への中継 `/env/<id>/`）も**そのまま素通し**する。
 *     ここに判断は無い（D5）——経路を渡すだけで中身は解釈しない
 *
 * D6: node:http / node:net のみ。
 * I2: 到達できないことを「結果なし」と混同しない。中継先が居なければ 502 で返す。
 */

import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { MODULE_TOOL_PATH, createModuleClient, longCallFetch } from "@banto/core";
import type { ModuleSettingsSpec, NamespacedToolDefinition } from "@banto/core";

/** 実装を持たない写し。触られたら投げる——`execute` は必ず差し替わるので、来たら配線の誤り。 */
export function contractOnly<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      throw new Error(
        `${what} の写しは実装を持ちません（${String(prop)} が呼ばれました）。到達先へ HTTP で聞いてください。`
      );
    },
  });
}

/** モジュールの Tool を、到達先へ投げるだけの写しに差し替える。 */
export function createRemoteTools(
  moduleName: string,
  specs: NamespacedToolDefinition[],
  remoteUrl: string,
  fetchImpl = longCallFetch()
): NamespacedToolDefinition[] {
  const client = createModuleClient({ modules: { [moduleName]: { baseUrl: remoteUrl } } }, fetchImpl);
  return specs.map((spec) => ({
    ...spec,
    async execute(args: unknown) {
      const result = await client.invoke(
        moduleName,
        spec.name,
        (args ?? {}) as Record<string, unknown>
      );
      return { content: result.content, ...(result.details ? { details: result.details } : {}) };
    },
  })) as NamespacedToolDefinition[];
}

/**
 * 設定の区画（決定41）を、到達先の `<domain>.settings_read` / `settings_write` へ繋ぐ。
 *
 * 項目の宣言（`fields` / `title`）は写しから取る——**画面の見え方は変わらない**。
 * 変わるのは読み書きの届く先だけ。
 */
export function createRemoteSettings(
  spec: ModuleSettingsSpec,
  domain: string,
  moduleName: string,
  remoteUrl: string,
  fetchImpl = longCallFetch()
): ModuleSettingsSpec {
  const client = createModuleClient({ modules: { [moduleName]: { baseUrl: remoteUrl } } }, fetchImpl);
  return {
    ...spec,
    /**
     * **項目の宣言は到達先から取る**（PO要望 2026-08-10）。写しが持っている宣言は
     * 静的なので、選択肢が動く区画（採用済みのモデル・使えるバックエンド）では
     * 「画面に並ぶもの」と「実際に選べるもの」が食い違う。届かないときだけ写しに落ちる。
     */
    async fields() {
      try {
        const result = await client.invoke(moduleName, `${domain}.settings_read`, {});
        const remote = (result.details as { fields?: unknown })?.fields;
        if (Array.isArray(remote)) return remote as ModuleSettingsSpec["fields"] & [];
      } catch {
        // I2 の例外: 届かないことを「項目なし」にしない。写しの宣言で描く
        // （値の読み出しは同じ呼びで別に失敗し、そちらが画面に理由を出す）
      }
      return typeof spec.fields === "function" ? await spec.fields() : spec.fields;
    },
    async read() {
      const result = await client.invoke(moduleName, `${domain}.settings_read`, {});
      return ((result.details as { values?: Record<string, unknown> })?.values ?? {}) as Record<
        string,
        unknown
      >;
    },
    async write(values) {
      const result = await client.invoke(moduleName, `${domain}.settings_write`, { values });
      const details = (result.details ?? {}) as { applied?: boolean; message?: string };
      return {
        applied: details.applied ?? true,
        ...(details.message ? { message: details.message } : {}),
      };
    },
  };
}

/** Tool の規約に乗らない面を、到達先へそのまま流す口。 */
export interface RemoteRelay {
  serve(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/**
 * 到達先の面を、番頭ホストの同じパスの下へ中継する。
 *
 * **Tool の口（`/tools/`）は中継しない**——そちらは写しの `execute` が呼ぶ（同じ結果に
 * 2つの経路を作らない・D3）。中継するのはモジュールが自分で生やしている面だけで、
 * いま実際に使うのは検証環境への中継（`/api/environment-pool/env/<id>/`）。
 *
 * ブラウザは別の機械で動くので、127.0.0.1 のサービスへは直接届かない。この中継があると、
 * **banto を守っている前段の認証をそのまま継承**したまま検証環境に触れる（決定39 の利点は
 * サービスを外へ出しても失われない）。
 */
export function createRemoteRelay(remoteUrl: string): RemoteRelay {
  const target = new URL(remoteUrl);
  const prefix = target.pathname.replace(/\/$/, "");
  const host = target.hostname;
  const port = Number.parseInt(target.port || (target.protocol === "https:" ? "443" : "80"), 10);
  const toolPrefix = `${prefix}${MODULE_TOOL_PATH}`;

  const mine = (url: string): boolean => url.startsWith(`${prefix}/`) && !url.startsWith(toolPrefix);

  return {
    serve(req, res): boolean {
      const url = req.url ?? "";
      if (!mine(url)) return false;

      const upstream = http.request(
        {
          host,
          port,
          method: req.method ?? "GET",
          path: url,
          headers: { ...req.headers, host: `${host}:${port}` },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );
      upstream.on("error", (err) => {
        // I2: 立っていないことを 200 で包まない
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`${prefix} のサービスへ中継できません（${host}:${port}）: ${err.message}\n`);
      });
      req.pipe(upstream);
      return true;
    },

    handleUpgrade(req, socket, head): boolean {
      const url = req.url ?? "";
      if (!mine(url)) return false;

      // `http.request` の 'upgrade' は head の書き込み順が前後する罠がある
      // （proxy-exposer.ts で実測済み）。raw ヘッダを組み立てて順に書く
      const upstream = net.connect(port, host, () => {
        const lines = [`${req.method ?? "GET"} ${url} HTTP/${req.httpVersion}`];
        const raw = req.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) {
          const name = raw[i]!;
          lines.push(
            name.toLowerCase() === "host" ? `host: ${host}:${port}` : `${name}: ${raw[i + 1]}`
          );
        }
        upstream.write(Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"));
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => {
        // I2: 届かない upgrade を黙って生かし続けない
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
      return true;
    },
  };
}
