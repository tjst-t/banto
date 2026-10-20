// Caddy のサブドメインで公開する（docs/specs/v4-modules.md §4.3 Publish の最初の実装）。
//
// **マスターはこの Module、Caddy のルートはその写し**（Service の「systemd の定義は写し」と同じ形）。
// 突き合わせ（`reconcile`）で写しをマスターに合わせる——
//   - 無いルートは足す（Caddyfile から読み込み直すと、API で足したルートは消えうる）
//   - Project のコンテナのアドレスが変わったら（DHCP）行き先を直す
//   - 行き先に確かに届かない（コンテナが止まっている・無い）ときは中継をやめて 503 にする
//   - 行き先を**確かめられない**（host が Incus から答えを得られない等の一時の失敗）ときは、その道に触らない
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
  /**
   * host からその Project のコンテナに届くアドレス（host の中継 `relayProjectAddress`）。
   * **確かに届かない**（止まっている・無い・他人のもの）なら `{unavailable}` を返し、**確かめられない**（一時の失敗）なら投げる。
   * `port`（サービスのポート）を渡すと、host がそのポートに届く道を用意し、別の番号で届くならその番号を `port` で返す
   * （別のサーバの Project ごとのコンテナ——VM のポートからコンテナの中へ。追加・2026-10-20）
   */
  resolveAddress(projectId: string, port?: number): Promise<AddressLookup>;
  /**
   * 公開をやめたとき、`resolveAddress(projectId, port)` が用意させた道を外させる（host の中継 `relayProjectPortRelease`。
   * 追加・2026-10-20）。無ければ何もしない
   */
  releasePort?(projectId: string, port: number): Promise<void>;
  /** host からそのアドレスとポートに TCP で届くか */
  probe(address: string, port: number): Promise<boolean>;
  /** この Module の置き場——ルートの印の持ち主になる */
  owner: string;
  /** banto 本体（host）の口（例 `127.0.0.1:4737`）。banto のログインで守るとき、Caddy がここに問い合わせる */
  bantoUpstream?: string;
  now?: () => Date;
}

/**
 * アドレスを引いた結果。投げたら「確かめられない」。
 * `exposedOnLan`：Project が別のサーバで動き、そのアドレスは LAN に直に出ている（`docs/specs/v4-security.md` §1
 * 「Project の実行場所——別のサーバ」）——向こうで `0.0.0.0` に待ち受けたものは、この公開の認証を通らずに LAN から届く
 */
export type AddressLookup = { address: string; port?: number; exposedOnLan?: true } | { unavailable: string };

/** 承認の前の見積もり。`exposedOnLan` は承認画面で「向こうのサービスは LAN から直に届く」と出すため */
export interface PublishPlan {
  url: string;
  hostname: string;
  reach: Reach;
  exposedOnLan?: true;
}

export type RouteState =
  /** 行き先に届いている */
  | "active"
  /** ルートはあるが、行き先のポートに届かない（止まっている・127.0.0.1 だけで待っている） */
  | "not-listening"
  /** Project のコンテナが止まっている・無い等で、行き先に確かに届かない——503 を返している */
  | "project-stopped"
  /**
   * 行き先を**確かめられない**（host が Incus から答えを得られない等、一時の失敗）——Caddy の道には触っていない
   * （追加・2026-09-28、Fable のレビュー。以前は理由を問わず 503 に書き換えていたので、一時の失敗で全部の公開が止まった）
   */
  | "address-unknown"
  /** Caddy の admin に届かない・断られた——写しがいまどうなっているか分からない */
  | "caddy-unreachable"
  /** この Module の設定がまだ（基のドメインが無い） */
  | "not-configured";

export interface RouteStatus extends PublishTarget {
  url: string;
  reach: Reach;
  auth: "banto" | "basic" | "none";
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

/**
 * host に外させ損ねた道を、突き合わせで外し直す間隔（追加・2026-10-20）。外し直すには host が別のサーバに繋ぐので、繋がらない間に
 * 15 秒ごとに繋ぎに行かない
 */
const RELEASE_RETRY_MS = 5 * 60_000;

export class CaddyPublisher {
  private readonly prefix: string;
  /** 外させ損ねた道を最後に外し直そうとした時刻（`<Project>:<ポート>` ごと、メモリだけ） */
  private readonly lastReleaseTry = new Map<string, number>();
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

  /**
   * 承認の前の見積もり：どの URL になり、どこまで届くか。**何も変えない**。
   * 行き先が LAN に直に出ている（別のサーバ）なら添える。アドレスを引けない・届かないことは、ここでは断らない
   * （見積もりは URL を見せるためのもの。届かなければ公開するときに理由つきで断る）
   */
  async plan(rawTarget: Record<string, unknown>, rawConfig: unknown): Promise<PublishPlan> {
    const t = assertTarget(rawTarget);
    const s = await this.readySettings();
    const config = parseConfig(rawConfig, { forPlan: true });
    const hostname = hostnameFor(config.subdomain ?? defaultSubdomain(t), s.baseDomain);
    const found = await this.deps.resolveAddress(t.projectId).catch(() => undefined);
    const exposedOnLan = found !== undefined && "address" in found && found.exposedOnLan === true;
    return { url: urlOf(hostname), hostname, reach: s.reach, ...(exposedOnLan ? { exposedOnLan: true as const } : {}) };
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
      let found: AddressLookup;
      try {
        found = await this.deps.resolveAddress(t.projectId, t.port);
      } catch (err) {
        throw new PublishError(`公開先のアドレスを確かめられません（しばらくしてからもう一度）：${errText(err)}`);
      }
      if (!("address" in found)) throw new PublishError(`公開先に届きません：${found.unavailable}`);
      try {
        return await this.establish(t, s, config, records, hostname, found);
      } catch (err) {
        // **host が用意した道を残さない**（レビュー M1）：別の番号で届く（host がこの公開のために道を張った）のに公開できなかったら、
        // 外させる——残すと記録の無い道が LAN に 0.0.0.0 で待ち受けたまま、認証なしで届き続ける。同じ Project の同じポートの公開が
        // 残っていれば、そちらが使っているので外さない
        if (found.port !== undefined && !records.some((r) => r.projectId === t.projectId && r.port === t.port)) {
          await this.releaseOrQueue(t.projectId, t.port);
        }
        throw err;
      }
    });
  }

  /** 公開の後半（届くかを確かめ、Caddy に道を張り、記録する）。失敗したら投げる——host が張った道は呼び元が外させる */
  private async establish(
    t: PublishTarget,
    s: CaddySettings & { baseDomain: string },
    config: ReturnType<typeof parseConfig>,
    records: RouteRecord[],
    hostname: string,
    found: { address: string; port?: number; exposedOnLan?: true },
  ): Promise<{ url: string; hostname: string; reach: Reach }> {
    const upstream = { address: found.address, port: found.port ?? t.port };
    if (!(await this.deps.probe(upstream.address, upstream.port))) {
      throw new PublishError(
        found.port !== undefined
          ? // 別のサーバの Project ごとのコンテナ：VM のポートからコンテナの中の 127.0.0.1 へ繋いでいる（中では 127.0.0.1 で待ち受けてよい）
            `host から別のサーバの ${upstream.address}:${upstream.port}（コンテナの中の ${t.port} へ繋ぐ口）に届きません。別のサーバが host と同じ LAN にあり、` +
              `向こうのファイアウォールがそのポートを通しているか、サービスがコンテナの中で ${t.port} を待ち受けているか確かめてください`
          : found.exposedOnLan
            ? `host から別のサーバの ${upstream.address}:${t.port} に届きません。別のサーバが host と同じ LAN にあり、サービスが 0.0.0.0` +
                "（すべてのアドレス）で待ち受けていて、向こうのファイアウォールがそのポートを通しているか確かめてください" +
                "——127.0.0.1（localhost）だけで待っていると向こうの外から届きません（Vite なら --host）"
            : `host から ${upstream.address}:${t.port} に届きません。サービスが 0.0.0.0（すべてのアドレス）で待ち受けているか確かめてください` +
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
    await caddy.put(`${routesPath(server)}/0`, buildRoute(id, rec, upstream, this.deps.bantoUpstream));
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
  }

  /**
   * host に道を外させる。外せなければ「外させ損ねた道」に記録し、突き合わせで外し直す（レビュー M1——記録が消えて道だけ残ると、
   * LAN から認証なしで届き続ける）。返すのは外せなかった理由（外せたら undefined）
   */
  private async releaseOrQueue(projectId: string, port: number): Promise<string | undefined> {
    if (!this.deps.releasePort) return undefined;
    try {
      await this.deps.releasePort(projectId, port);
      return undefined;
    } catch (err) {
      const pending = await this.deps.store.pendingReleases();
      if (!pending.some((p) => p.projectId === projectId && p.port === port)) {
        await this.deps.store.setPendingReleases([...pending, { projectId, port, since: (this.deps.now?.() ?? new Date()).toISOString() }]);
      }
      console.error(`[publish-caddy] 公開先の道（${projectId} のポート ${port}）を外させられませんでした（突き合わせで外し直します）：${errText(err)}`);
      return errText(err);
    }
  }

  /**
   * **外させ損ねた道を外し直す**（突き合わせのたびに。同じものは `RELEASE_RETRY_MS` に1回）。同じ Project の同じポートがまた公開されて
   * いれば、その公開が使っているので外さずに記録から消す
   */
  private async retryPendingReleases(records: RouteRecord[]): Promise<void> {
    const release = this.deps.releasePort;
    if (!release) return;
    const pending = await this.deps.store.pendingReleases();
    if (pending.length === 0) return;
    const now = Date.now();
    const keep: typeof pending = [];
    for (const p of pending) {
      if (records.some((r) => r.projectId === p.projectId && r.port === p.port)) continue;
      const key = `${p.projectId}:${p.port}`;
      const last = this.lastReleaseTry.get(key);
      if (last !== undefined && now - last < RELEASE_RETRY_MS) {
        keep.push(p);
        continue;
      }
      this.lastReleaseTry.set(key, now);
      try {
        await release(p.projectId, p.port);
        this.lastReleaseTry.delete(key);
      } catch (err) {
        keep.push(p);
        console.error(`[publish-caddy] 公開先の道（${key}）をまだ外させられません：${errText(err)}`);
      }
    }
    if (keep.length !== pending.length) await this.deps.store.setPendingReleases(keep);
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
      const notes: string[] = [];
      try {
        await deleteRoute(this.deps.caddyFor(s), routeIdFor(this.prefix, t));
      } catch (err) {
        notes.push(`Caddy のルートはまだ消せていません（届いたら消します）：${errText(err)}`);
      }
      // host が用意した道（別のサーバの Project ごとのコンテナの、VM のポート）を外させる。外せなくても公開はやめている——黙らない。
      // 道は Project とサービスのポートで決まる——同じ Project の別の Service が同じポートで公開されていれば、そちらが使うので外さない
      const stillUsed = records.some((r) => r !== rec && r.projectId === t.projectId && r.port === t.port);
      if (!stillUsed) {
        const why = await this.releaseOrQueue(t.projectId, t.port);
        if (why) notes.push(`公開先の道（別のサーバのポート）はまだ外せていません（突き合わせで外し直します）：${why}`);
      }
      return { removed: true, url: urlOf(rec.hostname), ...(notes.length > 0 ? { note: notes.join("／") } : {}) };
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
    // host に外させ損ねた道を外し直す（Caddy の設定に依らない——道は別のサーバの LAN に出ている）
    await this.retryPendingReleases(records);
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

    // 公開（Project とサービスのポート）ごとに1回だけ引く。確かめられなかったら `unknown`
    const addresses = new Map<string, Promise<AddressLookup | { unknown: string }>>();
    const addressOf = (projectId: string, port: number) => {
      const key = `${projectId}:${port}`;
      let p = addresses.get(key);
      if (!p) {
        p = this.deps.resolveAddress(projectId, port).catch((err: unknown) => ({ unknown: errText(err) }));
        addresses.set(key, p);
      }
      return p;
    };

    const out: RouteStatus[] = [];
    const wanted = new Set<string>();
    for (const rec of records) {
      const id = routeIdFor(this.prefix, rec);
      wanted.add(id);
      const found = await addressOf(rec.projectId, rec.port);
      const current = routes.find((r) => r["@id"] === id);
      // **確かめられないときは、今の道に触らない**——一時の失敗で 503 に書き換えると、Incus が一瞬答えないだけで全部の
      // 公開が止まる。前のアドレスのまま残すのは、確かめられるまでの間だけ（次の突き合わせで直る）
      if ("unknown" in found) {
        out.push(status(rec, "address-unknown", `公開先のアドレスを確かめられません（道はそのまま）：${found.unknown}`));
        continue;
      }
      const upstream = "address" in found ? { address: found.address, port: found.port ?? rec.port } : undefined;
      const desired = buildRoute(id, rec, upstream, this.deps.bantoUpstream);
      try {
        if (!current) await caddy.put(`${routesPath(server)}/0`, desired);
        else if (!sameJson(current, desired)) await caddy.patch(`/id/${id}`, desired);
      } catch (err) {
        out.push(status(rec, "caddy-unreachable", errText(err)));
        continue;
      }
      if (!upstream) {
        out.push(status(rec, "project-stopped", "unavailable" in found ? found.unavailable : undefined));
        continue;
      }
      const reachable = await this.deps.probe(upstream.address, upstream.port);
      out.push(
        reachable
          ? status(rec, "active")
          : status(rec, "not-listening", `host から ${upstream.address}:${upstream.port} に届きません（止まっている・127.0.0.1 だけで待っている）`),
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
