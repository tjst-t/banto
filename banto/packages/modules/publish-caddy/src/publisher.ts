// Caddy のサブドメインで公開する（docs/specs/v4-modules.md §4.3 Publish の最初の実装）。
//
// **マスターはこの Module、Caddy のルートはその写し**（Service の「systemd の定義は写し」と同じ形）。
// 突き合わせ（`reconcile`）で写しをマスターに合わせる——
//   - 無いルートは足す（Caddyfile から読み込み直すと、API で足したルートは消えうる）
//   - Project のコンテナのアドレスが変わったら（DHCP）行き先を直す
//   - 行き先が分からない（コンテナが止まっている）ときは中継をやめて 503 にする
//   - マスターに無いのに自分の印が付いたルートは消す（やめたのに消し損ねたもの）
// 突き合わせるのは、起きたとき・一定の間隔・各操作の前。

import { CaddyAdminError, type CaddyAdmin } from "./caddy-admin.js";
import {
  CONFIG_SCHEMA,
  PublishError,
  assertTarget,
  authRecordOf,
  buildRoute,
  defaultSubdomain,
  hostnameFor,
  parseConfig,
  routeIdFor,
  routeIdPrefix,
  sameJson,
  type PublishTarget,
  type Reach,
  type RouteRecord,
} from "./route.js";
import type { CaddySettings, PublishStore } from "./store.js";

export const METHOD_TITLE = "Caddy のサブドメイン";

export interface PublisherDeps {
  store: PublishStore;
  /** 設定から Caddy の口を作る（試験では偽の Caddy に向ける） */
  caddyFor(settings: CaddySettings): CaddyAdmin;
  /** host からその Project のコンテナに届くアドレス（host の中継 `relayProjectAddress`）。引けなければ理由つきで投げる */
  resolveAddress(projectId: string): Promise<string>;
  /** host からそのアドレスとポートに TCP で届くか */
  probe(address: string, port: number): Promise<boolean>;
  /** この Module の置き場——ルートの印の持ち主になる */
  owner: string;
  now?: () => Date;
}

export type RouteState =
  /** 行き先に届いている */
  | "active"
  /** ルートはあるが、行き先のポートに届かない（止まっている・127.0.0.1 だけで待っている） */
  | "not-listening"
  /** Project のコンテナが止まっている等で行き先が分からない——503 を返している */
  | "project-stopped"
  /** Caddy の admin に届かない・断られた——写しがいまどうなっているか分からない */
  | "caddy-unreachable"
  /** この Module の設定がまだ（基のドメインが無い） */
  | "not-configured";

export interface RouteStatus extends PublishTarget {
  url: string;
  reach: Reach;
  auth: "basic" | "none";
  username?: string;
  state: RouteState;
  problem?: string;
  createdAt: string;
}

function urlOf(hostname: string): string {
  return `https://${hostname}`;
}

function sameTarget(a: PublishTarget, b: PublishTarget): boolean {
  return a.projectId === b.projectId && a.service === b.service && a.port === b.port;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CaddyPublisher {
  private readonly prefix: string;
  private running: Promise<RouteStatus[]> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PublisherDeps) {
    this.prefix = routeIdPrefix(deps.owner);
  }

  /** 変更（公開・やめる・突き合わせ）を1本ずつ通す——マスターと Caddy の読み書きが混ざらないように */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async describe(): Promise<{ title: string; reach: Reach; ready: boolean; problem?: string; configSchema: typeof CONFIG_SCHEMA }> {
    const s = await this.deps.store.settings();
    return {
      title: METHOD_TITLE,
      reach: s.reach,
      ready: Boolean(s.baseDomain),
      ...(s.baseDomain ? {} : { problem: notConfigured() }),
      configSchema: CONFIG_SCHEMA,
    };
  }

  /** 承認の前の見積もり：どの URL になり、どこまで届くか。**何も変えない** */
  async plan(rawTarget: Record<string, unknown>, rawConfig: unknown): Promise<{ url: string; hostname: string; reach: Reach }> {
    const t = assertTarget(rawTarget);
    const s = await this.readySettings();
    const config = parseConfig(rawConfig, { forPlan: true });
    const hostname = hostnameFor(config.subdomain ?? defaultSubdomain(t), s.baseDomain);
    return { url: urlOf(hostname), hostname, reach: s.reach };
  }

  async publish(rawTarget: Record<string, unknown>, rawConfig: unknown): Promise<{ url: string; hostname: string; reach: Reach }> {
    const t = assertTarget(rawTarget);
    return this.serialize(async () => {
      const s = await this.readySettings();
      const config = parseConfig(rawConfig);
      const records = await this.deps.store.routes();
      const same = records.find((r) => sameTarget(r, t));
      if (same) {
        throw new PublishError(`${t.service}:${t.port} はもう公開しています（${urlOf(same.hostname)}）。変えるなら公開をやめてから`);
      }
      const hostname = hostnameFor(config.subdomain ?? defaultSubdomain(t), s.baseDomain);
      if (records.some((r) => r.hostname === hostname)) throw new PublishError(`${hostname} はもう別の公開に使っています`);

      // **host から実際に届くか**を確かめてから道を張る。コンテナの中の `ss` が「待ち受けている」と言っても、
      // 127.0.0.1 だけで待っているものはコンテナの外（Caddy）から届かない
      let address: string;
      try {
        address = await this.deps.resolveAddress(t.projectId);
      } catch (err) {
        throw new PublishError(`公開先のアドレスが分かりません：${errText(err)}`);
      }
      if (!(await this.deps.probe(address, t.port))) {
        throw new PublishError(
          `host から ${address}:${t.port} に届きません。サービスが 0.0.0.0（すべてのアドレス）で待ち受けているか確かめてください` +
            "——127.0.0.1（localhost）だけで待っているとコンテナの外から届きません（Vite なら --host）",
        );
      }

      const caddy = this.deps.caddyFor(s);
      const server = await resolveServer(caddy, s);
      const routes = await readRoutes(caddy, server);
      const taken = routes.find((r) => !String(r["@id"] ?? "").startsWith(this.prefix) && hostsOf(r).includes(hostname));
      if (taken) throw new PublishError(`${hostname} は Caddy の別の設定がもう使っています`);

      const rec: RouteRecord = {
        ...t,
        hostname,
        auth: await authRecordOf(config.auth),
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      };
      const id = routeIdFor(this.prefix, t);
      // **前に差し込む**——Caddyfile の `*.<ドメイン>` のようなまとめたルートより後ろに置くと、そちらが先に当たる
      await caddy.put(`${routesPath(server)}/0`, buildRoute(id, rec, address));
      try {
        await this.deps.store.setRoutes([...records, rec]);
      } catch (err) {
        // 覚えられなかった公開を Caddy に残さない。消せなければ、自分の印の余りとして次の突き合わせで消える
        await deleteRoute(caddy, id).catch((e: unknown) =>
          console.error(`[publish-caddy] 覚えられなかった公開のルートを消せませんでした（次の突き合わせで消します）：${errText(e)}`),
        );
        throw err;
      }
      return { url: urlOf(hostname), hostname, reach: s.reach };
    });
  }

  /** やめる。**マスターから消し、Caddy のルートも消す**。Caddy に届かなければ、届いたときの突き合わせで消える */
  async unpublish(rawTarget: Record<string, unknown>): Promise<{ removed: boolean; url?: string; note?: string }> {
    const t = assertTarget(rawTarget);
    return this.serialize(async () => {
      const records = await this.deps.store.routes();
      const rec = records.find((r) => sameTarget(r, t));
      if (!rec) return { removed: false };
      await this.deps.store.setRoutes(records.filter((r) => r !== rec));
      const s = await this.deps.store.settings();
      try {
        await deleteRoute(this.deps.caddyFor(s), routeIdFor(this.prefix, t));
      } catch (err) {
        return { removed: true, url: urlOf(rec.hostname), note: `Caddy のルートはまだ消せていません（届いたら消します）：${errText(err)}` };
      }
      return { removed: true, url: urlOf(rec.hostname) };
    });
  }

  /** 公開の一覧（突き合わせてから）。`projectId` を渡せばその Project のものだけ */
  async list(projectId?: string): Promise<RouteStatus[]> {
    const all = await this.reconcile();
    return projectId === undefined ? all : all.filter((r) => r.projectId === projectId);
  }

  /** 写しをマスターに合わせる。同時に呼ばれたら1回にまとめる */
  reconcile(): Promise<RouteStatus[]> {
    if (!this.running) {
      this.running = this.serialize(() => this.reconcileNow()).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async reconcileNow(): Promise<RouteStatus[]> {
    const s = await this.deps.store.settings();
    const records = await this.deps.store.routes();
    const status = (rec: RouteRecord, state: RouteState, problem?: string): RouteStatus => ({
      projectId: rec.projectId,
      service: rec.service,
      port: rec.port,
      url: urlOf(rec.hostname),
      reach: s.reach,
      auth: rec.auth.kind,
      ...(rec.auth.kind === "basic" ? { username: rec.auth.username } : {}),
      state,
      ...(problem ? { problem } : {}),
      createdAt: rec.createdAt,
    });
    // 設定がまだなら Caddy に触らない（どの Caddy か分からない）
    if (!s.baseDomain) return records.map((r) => status(r, "not-configured", notConfigured()));

    const caddy = this.deps.caddyFor(s);
    let server: string;
    let routes: Record<string, unknown>[];
    try {
      server = await resolveServer(caddy, s);
      routes = await readRoutes(caddy, server);
    } catch (err) {
      return records.map((r) => status(r, "caddy-unreachable", errText(err)));
    }

    // Project ごとに1回だけ引く（同じ Project に公開が複数あっても）
    const addresses = new Map<string, Promise<{ address?: string; problem?: string }>>();
    const addressOf = (projectId: string) => {
      let p = addresses.get(projectId);
      if (!p) {
        p = this.deps.resolveAddress(projectId).then(
          (address) => ({ address }),
          (err: unknown) => ({ problem: errText(err) }),
        );
        addresses.set(projectId, p);
      }
      return p;
    };

    const out: RouteStatus[] = [];
    const wanted = new Set<string>();
    for (const rec of records) {
      const id = routeIdFor(this.prefix, rec);
      wanted.add(id);
      const { address, problem } = await addressOf(rec.projectId);
      const desired = buildRoute(id, rec, address);
      const current = routes.find((r) => r["@id"] === id);
      try {
        if (!current) await caddy.put(`${routesPath(server)}/0`, desired);
        else if (!sameJson(current, desired)) await caddy.patch(`/id/${id}`, desired);
      } catch (err) {
        out.push(status(rec, "caddy-unreachable", errText(err)));
        continue;
      }
      if (!address) {
        out.push(status(rec, "project-stopped", problem));
        continue;
      }
      const reachable = await this.deps.probe(address, rec.port);
      out.push(
        reachable
          ? status(rec, "active")
          : status(rec, "not-listening", `host から ${address}:${rec.port} に届きません（止まっている・127.0.0.1 だけで待っている）`),
      );
    }
    // マスターに無い自分のルート（やめたのに Caddy に届かなかった等）を片付ける。**他人の印には触らない**
    for (const r of routes) {
      const id = String(r["@id"] ?? "");
      if (id.startsWith(this.prefix) && !wanted.has(id)) {
        // 消せなくても一覧の他の行は返す。黙っては捨てない（次の突き合わせでもう一度消す）
        await deleteRoute(caddy, id).catch((e: unknown) =>
          console.error(`[publish-caddy] やめた公開のルート ${id} を消せませんでした：${errText(e)}`),
        );
      }
    }
    return out;
  }

  private async readySettings(): Promise<CaddySettings & { baseDomain: string }> {
    const s = await this.deps.store.settings();
    if (!s.baseDomain) throw new PublishError(notConfigured());
    return s as CaddySettings & { baseDomain: string };
  }
}

function notConfigured(): string {
  return "この Caddy の実装はまだ設定されていません（banto 全体の設定で、基のドメインを決めてください）";
}

function routesPath(server: string): string {
  return `/config/apps/http/servers/${encodeURIComponent(server)}/routes`;
}

/** 印で消す。**もう無いならそれでよい**（消したいのは「無い」状態） */
async function deleteRoute(caddy: CaddyAdmin, id: string): Promise<void> {
  try {
    await caddy.delete(`/id/${id}`);
  } catch (err) {
    if (err instanceof CaddyAdminError && err.status === 404) return;
    throw err;
  }
}

/**
 * ルートを足す server。設定で名前を決めていなければ、**443 で待ち受けている server が1つだけ**のときにそれを使う
 * ——2つ以上・0なら推測しないで断る（Caddyfile の server の名前は `srv0` のように読み込みのたびに振られる）
 */
async function resolveServer(caddy: CaddyAdmin, s: CaddySettings): Promise<string> {
  const servers = ((await caddy.get("/config/apps/http/servers")) ?? {}) as Record<string, { listen?: unknown }>;
  if (s.serverName) {
    if (!servers[s.serverName]) {
      throw new PublishError(`Caddy に server「${s.serverName}」がありません（あるもの：${Object.keys(servers).join("、") || "無し"}）`);
    }
    return s.serverName;
  }
  const https = Object.entries(servers)
    .filter(([, v]) => Array.isArray(v.listen) && v.listen.some((l) => typeof l === "string" && /:443$/.test(l)))
    .map(([k]) => k);
  if (https.length === 1) return https[0]!;
  throw new PublishError(
    https.length === 0
      ? `Caddy に 443 で待ち受けている server がありません（あるもの：${Object.keys(servers).join("、") || "無し"}）。設定で server の名前を決めてください`
      : `443 で待ち受けている server が複数あります（${https.join("、")}）。設定でどれに足すかを決めてください`,
  );
}

async function readRoutes(caddy: CaddyAdmin, server: string): Promise<Record<string, unknown>[]> {
  const routes = await caddy.get(routesPath(server));
  if (!Array.isArray(routes)) throw new PublishError(`Caddy の server「${server}」にルートの並びがありません`);
  return routes as Record<string, unknown>[];
}

/** そのルートが当たるホスト名（`match[].host[]`） */
function hostsOf(route: Record<string, unknown>): string[] {
  const match = Array.isArray(route.match) ? (route.match as Record<string, unknown>[]) : [];
  return match.flatMap((m) => (Array.isArray(m.host) ? (m.host as unknown[]).filter((h): h is string => typeof h === "string") : []));
}
