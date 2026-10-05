#!/usr/bin/env node
// **publish-directory——動いているものに届く URL を生やす窓口**（docs/specs/v4-modules.md §4.3）。
//
// 自分では道を張らない。`publish` 役割を名乗る実装（最初は Caddy のサブドメイン）を横断して、
// AI に3つの道具と、人に**承認の画面**を見せる：
//
//   publishService   AI が頼む。**公開はしない**——Service の登録と待ち受けを確かめ、承認の画面を会話に出すだけ
//   （人が画面で押す） 実装に渡して道を張る。結果は札で呼び出し元の Thread に届く（AI が起きる）
//   unpublishService やめる（狭める向きなので承認は要らない）
//   listPublished    公開の一覧（実装から毎回組む——窓口は写しを持たない）
//
// **なぜ窓口が banto 本体で動くか**（docs/specs/v4-security.md §1「AI に host を変えさせたいときの形」の②）：
// 承認の画面を出すコードがコンテナの中にあると、中で root の AI がそれを偽れる。host で動く banto 自身の
// コードが画面を出し、人が押した操作だけが実装に届く（実装も人の刻印を確かめる）。
//
// **設定項目は実装が名乗る**（JSON Schema）。窓口はそれを画面にそのまま出して実装に渡すだけで、中身を解釈しない
// ——出し方ごとに合った守り方が違う（Caddy なら Basic 認証、cloudflared なら Cloudflare Access）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_META_KEY,
  DELIVERS_LATER_META_KEY,
  MODULE_META_KEY,
  PENDING_REPLY_META_KEY,
  WAITING_ON_META_KEY,
  AUDIT_ARGS_META_KEY,
  VALUE_FREE_META_KEY,
  VISIBILITY_META_KEY,
  autoApproveOf,
  callIdOf,
  callerOf,
  replyToOf,
} from "@banto/module-contract";
import { APPROVAL_APP_HTML, APPROVAL_APP_URI, UI_APP_MIME } from "./approval-app.js";
import { PUBLISHED_APP_URI, publishedAppHtml } from "./published-app.js";
import type { RelayLike, RelayTargets } from "./relay-client.js";
import { RequestStore, WithdrawalLog, type PublishRequest, type Reach, type Withdrawal } from "./requests.js";

const SELF_REPORT_URI = "publish-directory://module";
const PUBLISH_ROLE = "publish";
const SERVICE_ROLE = "service";

/** 画面と AI への返事で使う、届く範囲の言い方（承認の画面の一番目立つところに出す） */
export const REACH_LABEL: Record<Reach, string> = {
  machine: "この機械だけ",
  lan: "LAN の中",
  internet: "インターネット（URL を知っている誰でも）",
};

/** 会話の中の画面が、AI の呼び出しの結果から頼みの id を読む印（本文に書く——structuredContent は会話の記録で落ちる） */
export const REQUEST_ID_LABEL = "公開の承認の id：";

export class PublishDirectoryError extends Error {}

interface ServiceStatus {
  name: string;
  ports: number[];
  state: string;
  listening: number[];
  notListening: number[];
  note?: string;
}

interface MethodInfo {
  title: string;
  reach: Reach;
  ready: boolean;
  problem?: string;
  configSchema: Record<string, unknown>;
}

interface RouteStatus {
  projectId: string;
  service: string;
  port: number;
  url: string;
  reach: Reach;
  auth: string;
  username?: string;
  state: string;
  problem?: string;
  createdAt: string;
}

export interface PublishDirectoryDeps {
  relay: RelayLike;
  requests: RequestStore;
  /** 自分でやめた公開の記録（Service の登録が消されたとき）。人に見せるため */
  withdrawals: WithdrawalLog;
}

/**
 * **その呼び出しの印を添えて中継を呼ぶ口**（追加・2026-09-28）。host がこの窓口を呼んだときの印（`dev.banto/callId`）を、
 * その処理の中の中継すべてに添える——host は出所（人の画面か AI のターンか）と Project を1件ずつ引く。窓口は banto 全体で
 * 1接続なので、添えないと同時に走っている別の呼び出し（ある Project の AI のターンと人の画面）と混ざる
 */
interface Scoped {
  listTargets(): Promise<RelayTargets>;
  /** 相手の口を呼んで JSON を読む。**断りは理由ごと上げる**（黙って空にしない——規則2） */
  callJson<T>(target: string, name: string, args: Record<string, unknown>): Promise<T>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createPublishDirectoryServer(deps: PublishDirectoryDeps) {
  const { relay, requests, withdrawals } = deps;
  const server = new Server({ name: "banto-module-publish-directory", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  function scoped(callId: string | undefined): Scoped {
    return {
      listTargets: () => relay.listTargets(callId),
      async callJson<T>(target: string, name: string, args: Record<string, unknown>): Promise<T> {
        const r = await relay.callTool(target, name, args, callId);
        if (r.isError) throw new PublishDirectoryError(r.text || `${target} の ${name} が失敗しました`);
        try {
          return JSON.parse(r.text) as T;
        } catch {
          throw new PublishDirectoryError(`${target} の ${name} の返事を読めません`);
        }
      },
    };
  }

  const withRole = (targets: RelayTargets, role: string) => targets.targets.filter((t) => t.roles.includes(role)).map((t) => t.name);

  /**
   * **Service の宛先が1本も無いときの理由**（追加・2026-09-28、Fable のレビュー）。中継は「その Project に Service が無い」と
   * 「どの Project のための呼び出しか決められない（だから Project の Module を1本も見せない）」を同じ空の一覧で返すので、
   * 中継が添える `onBehalfOf` で分ける——以前は後者でも「Service を入れてください」と嘘の案内を出していた
   */
  function noServiceReason(targets: RelayTargets, projectId: string): string {
    if (targets.onBehalfOf === projectId) {
      return "この Project に Service の Module がありません。公開するものは Service に登録したものから選びます（Project の設定の「Module を追加」から Service を入れてください）";
    }
    return (
      "banto の中継が、この呼び出しをどの Project のためのものか決められませんでした" +
      (targets.onBehalfOf ? `（中継は別の Project ${targets.onBehalfOf} のための呼び出しとして扱っています）` : "（同時に走っている呼び出しが混ざった等）") +
      "。もう一度試してください"
    );
  }

  /** 出し方を選ぶ。**名前が無ければ、1つしか無いときだけそれ**（推測で選ばない） */
  function pickMethod(targets: RelayTargets, method: unknown): string {
    const methods = withRole(targets, PUBLISH_ROLE);
    if (methods.length === 0) throw new PublishDirectoryError("公開の出し方（publish 役割の Module）が1つも繋がっていません。banto 全体の設定の「Module を追加」から入れてください");
    if (typeof method === "string" && method !== "") {
      if (!methods.includes(method)) throw new PublishDirectoryError(`出し方「${method}」はありません（あるもの：${methods.join("、")}）`);
      return method;
    }
    if (methods.length > 1) throw new PublishDirectoryError(`出し方が複数あります。method で選んでください（${methods.join("、")}）`);
    return methods[0]!;
  }

  /** Service の登録から名前で引く（その Project の Service だけが見える——中継が絞る） */
  async function findService(r: Scoped, targets: RelayTargets, name: string, projectId: string): Promise<ServiceStatus> {
    const services = withRole(targets, SERVICE_ROLE);
    if (services.length === 0) {
      const reason = noServiceReason(targets, projectId);
      throw new PublishDirectoryError(targets.onBehalfOf === projectId ? reason : `Service の登録を読めませんでした：${reason}`);
    }
    const known: string[] = [];
    for (const target of services) {
      const { services: list } = await r.callJson<{ services: ServiceStatus[] }>(target, "listServices", {});
      const hit = list.find((s) => s.name === name);
      if (hit) return hit;
      known.push(...list.map((s) => s.name));
    }
    throw new PublishDirectoryError(`サービス「${name}」は登録されていません（登録済み：${known.join("、") || "無し"}）。startService で登録してから`);
  }

  function projectOf(meta: Record<string, unknown> | undefined): string {
    const stamp = callerOf(meta);
    if (!stamp || !("project" in stamp)) throw new PublishDirectoryError("Project の会話からだけ使えます（どの Project の公開か決められません）");
    return stamp.project;
  }

  async function publishService(r: Scoped, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) {
    const projectId = projectOf(meta);
    const name = typeof args.service === "string" ? args.service : "";
    if (!name) throw new PublishDirectoryError("service（Service に登録した名前）が要ります");
    const targets = await r.listTargets();
    const svc = await findService(r, targets, name, projectId);

    let port: number;
    if (args.port === undefined) {
      if (svc.ports.length !== 1) {
        throw new PublishDirectoryError(`port を選んでください（${name} の登録：${svc.ports.join("、") || "ポート無し"}）`);
      }
      port = svc.ports[0]!;
    } else {
      if (typeof args.port !== "number" || !svc.ports.includes(args.port)) {
        throw new PublishDirectoryError(`${name} の登録に無いポートです：${String(args.port)}（登録：${svc.ports.join("、") || "無し"}）`);
      }
      port = args.port;
    }
    // **実際に待ち受けていなければ断る**（決定・2026-09-27）。調べられなかったときも「待ち受けていない」とは言わない
    if (svc.note && !svc.listening.includes(port)) throw new PublishDirectoryError(`${name} の待ち受けを確かめられません：${svc.note}`);
    if (!svc.listening.includes(port)) {
      throw new PublishDirectoryError(`${name} は ${port} で待ち受けていません（状態：${svc.state}）。起きているか・ポートが合っているかを readServiceLogs で確かめてください`);
    }

    const implementation = pickMethod(targets, args.method);
    const info = await r.callJson<MethodInfo>(implementation, "describePublishMethod", {});
    if (!info.ready) throw new PublishDirectoryError(`出し方「${info.title}」はまだ使えません：${info.problem ?? "理由不明"}`);
    const { routes } = await r.callJson<{ routes: RouteStatus[] }>(implementation, "listRoutes", { projectId });
    const already = routes.find((r) => r.service === name && r.port === port);
    if (already) throw new PublishDirectoryError(`${name}:${port} はもう公開しています（${already.url}）`);
    // **承認をすべて自動で許可する**（追加・2026-10-05、ユーザー。v4-frontend.md §6.4）。窓口は Project の設定を知らない
    // ——host が刻んだ印だけを見る。立っていれば承認画面の既定の値（設定は `{}`＝出し方の既定）でそのまま公開する。
    // 実装も同じ印を確かめてから道を張る（人の刻印の代わり）。結果はその場で返す（札で後から届けるものは無い）
    if (autoApproveOf(meta)) {
      const out = await r.callJson<{ url: string; reach: Reach }>(implementation, "publishRoute", { projectId, service: name, port, config: {} });
      const done = await requests.addPublished({ projectId, service: name, port, implementation, plannedUrl: out.url, reach: out.reach }, out.url);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `公開しました：${name}:${port} を「${info.title}」で ${out.url} に（届く範囲：${REACH_LABEL[out.reach]}）。` +
              "この Project は「承認をすべて自動で許可する」がオンなので、人に聞かずに既定の設定で公開しました。" +
              `\n${REQUEST_ID_LABEL}${done.id}`,
          },
        ],
      };
    }
    const plan = await r.callJson<{ url: string; reach: Reach }>(implementation, "planPublish", { projectId, service: name, port, config: {} });

    const replyTo = replyToOf(meta);
    const req = await requests.add({
      projectId,
      service: name,
      port,
      implementation,
      plannedUrl: plan.url,
      reach: plan.reach,
      ...(replyTo ? { replyTo } : {}),
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `公開の承認を、この会話に出しました（${name}:${port} を「${info.title}」で ${plan.url} に。届く範囲：${REACH_LABEL[plan.reach]}）。` +
            "**公開するかは人が決めます**——まだ公開していません。ターンを終えて人に知らせてください。" +
            (replyTo ? "人が答えたら、この会話に結果が届きます（URL は人が変えることがあります）。" : "結果は listPublished で見えます。") +
            `\n${REQUEST_ID_LABEL}${req.id}`,
        },
      ],
      // **人の答えを待っている**と名乗る（追加・2026-10-04）——サイドバーが「あなたの番」として出す
      ...(replyTo
        ? { _meta: { [PENDING_REPLY_META_KEY]: true, [WAITING_ON_META_KEY]: { on: "human", title: `公開の承認：${name}:${port}` } } }
        : {}),
    };
  }

  async function unpublishService(r: Scoped, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) {
    const projectId = projectOf(meta);
    const name = typeof args.service === "string" ? args.service : "";
    if (!name) throw new PublishDirectoryError("service が要ります");
    const targets = await r.listTargets();
    const methods = typeof args.method === "string" && args.method !== "" ? [pickMethod(targets, args.method)] : withRole(targets, PUBLISH_ROLE);
    const removed: { url: string; method: string; note?: string }[] = [];
    for (const m of methods) {
      const { routes } = await r.callJson<{ routes: RouteStatus[] }>(m, "listRoutes", { projectId });
      for (const route of routes.filter((x) => x.service === name && (args.port === undefined || x.port === args.port))) {
        const out = await r.callJson<{ removed: boolean; url?: string; note?: string }>(m, "unpublishRoute", { projectId, service: route.service, port: route.port });
        if (out.removed) removed.push({ url: out.url ?? route.url, method: m, ...(out.note ? { note: out.note } : {}) });
      }
    }
    if (removed.length === 0) throw new PublishDirectoryError(`${name}${args.port !== undefined ? `:${String(args.port)}` : ""} は公開していません`);
    return { removed };
  }

  async function listPublished(r: Scoped, meta: Record<string, unknown> | undefined) {
    const projectId = projectOf(meta);
    const targets = await r.listTargets();
    const methods: Array<{ name: string } & Partial<MethodInfo> & { problem?: string }> = [];
    const published: Array<RouteStatus & { method: string }> = [];
    for (const m of withRole(targets, PUBLISH_ROLE)) {
      // 1本が壊れていても他は見せる。壊れていることは隠さない（規則2）
      try {
        const info = await r.callJson<MethodInfo>(m, "describePublishMethod", {});
        methods.push({ name: m, title: info.title, reach: info.reach, ready: info.ready, ...(info.problem ? { problem: info.problem } : {}) });
        const { routes } = await r.callJson<{ routes: RouteStatus[] }>(m, "listRoutes", { projectId });
        for (const route of routes) published.push({ ...route, method: m });
      } catch (err) {
        methods.push({ name: m, problem: errText(err) });
      }
    }
    const pending = (await requests.pending(projectId)).map((r) => ({
      requestId: r.id,
      service: r.service,
      port: r.port,
      method: r.implementation,
      plannedUrl: r.plannedUrl,
      createdAt: r.createdAt,
    }));
    return {
      published: published.map(({ projectId: _p, ...rest }) => rest),
      pending,
      methods,
      withdrawn: withdrawnView(await withdrawals.forProject(projectId)),
    };
  }

  /** 自分でやめた公開（Service の登録が消されたので）を、画面と AI に見せる形に */
  function withdrawnView(list: Withdrawal[]) {
    return list.map(({ projectId: _p, ...rest }) => rest);
  }

  // ---- 人が画面で押す口（刻印 {admin:true} があるときだけ）----------------------------------------

  /** 画面に出す形（札は出さない） */
  function view(req: PublishRequest) {
    const { replyTo: _r, ...rest } = req;
    return { ...rest, reachLabel: REACH_LABEL[req.reach] };
  }

  /** 画面が開いたときに引く：頼みの中身・出し方の設定項目・（入れた設定での）URL の見積もり */
  async function getRequest(r: Scoped, args: Record<string, unknown>) {
    const req = await requests.get(String(args.requestId ?? ""));
    if (!req) throw new PublishDirectoryError("その公開の頼みはありません（24時間を過ぎたか、id が違います）");
    if (req.state !== "pending") return { request: view(req) };
    const method = await r.callJson<MethodInfo>(req.implementation, "describePublishMethod", {});
    let plan: { url: string; reach: Reach } | undefined;
    let planProblem: string | undefined;
    try {
      plan = await r.callJson<{ url: string; reach: Reach }>(req.implementation, "planPublish", {
        projectId: req.projectId,
        service: req.service,
        port: req.port,
        config: (args.config as Record<string, unknown> | undefined) ?? {},
      });
    } catch (err) {
      planProblem = errText(err);
    }
    return {
      request: view(req),
      method: { ...method, reachLabel: REACH_LABEL[method.reach] },
      ...(plan ? { plan: { ...plan, reachLabel: REACH_LABEL[plan.reach] } } : {}),
      ...(planProblem ? { planProblem } : {}),
    };
  }

  /**
   * **入口の画面（launcher）が引く、その Project の公開の様子**（追加・2026-09-28、ユーザー「Launcher で Publish の状況を見たい」）。
   * 人の画面なので Project は引数で受ける（画面は banto が渡す `dev.banto/project` から知る）。
   * 1つが読めなくても他は見せ、読めなかったことは隠さない（規則2）
   */
  async function overview(r: Scoped, args: Record<string, unknown>, stamp: ReturnType<typeof callerOf>) {
    const projectId = typeof args.projectId === "string" ? args.projectId : "";
    if (!projectId) throw new PublishDirectoryError("projectId が要ります");
    assertSameProject(stamp, projectId);
    const targets = await r.listTargets();
    const methods: Array<{ name: string; title?: string; reach?: Reach; reachLabel?: string; ready?: boolean; problem?: string }> = [];
    const published: Array<RouteStatus & { method: string; methodTitle?: string; reachLabel: string }> = [];
    for (const m of withRole(targets, PUBLISH_ROLE)) {
      try {
        const info = await r.callJson<MethodInfo>(m, "describePublishMethod", {});
        methods.push({ name: m, title: info.title, reach: info.reach, reachLabel: REACH_LABEL[info.reach], ready: info.ready, ...(info.problem ? { problem: info.problem } : {}) });
        const { routes } = await r.callJson<{ routes: RouteStatus[] }>(m, "listRoutes", { projectId });
        for (const route of routes) published.push({ ...route, method: m, methodTitle: info.title, reachLabel: REACH_LABEL[route.reach] });
      } catch (err) {
        methods.push({ name: m, problem: errText(err) });
      }
    }
    // **まだ公開していないが、待ち受けているサーバ**——「何を公開できるか」を人が見て、AI に頼めるように
    const services: Array<{ name: string; port: number; listening: boolean; state: string }> = [];
    let servicesProblem: string | undefined;
    // **Service の宛先が0本なら、読めなかったと言う**（追加・2026-09-28、Fable のレビュー）。以前は黙って空にしていたので、
    // 中継が Project を決められなかったとき、画面は「まだ公開していないサーバ」が無いように見えた（規則2）
    if (withRole(targets, SERVICE_ROLE).length === 0) servicesProblem = noServiceReason(targets, projectId);
    try {
      for (const t of withRole(targets, SERVICE_ROLE)) {
        const { services: list } = await r.callJson<{ services: ServiceStatus[] }>(t, "listServices", {});
        for (const svc of list) for (const port of svc.ports) services.push({ name: svc.name, port, listening: svc.listening.includes(port), state: svc.state });
      }
    } catch (err) {
      servicesProblem = errText(err);
    }
    const pending = (await requests.pending(projectId)).map((r) => ({
      requestId: r.id,
      service: r.service,
      port: r.port,
      method: r.implementation,
      plannedUrl: r.plannedUrl,
      reach: r.reach,
      reachLabel: REACH_LABEL[r.reach],
      createdAt: r.createdAt,
    }));
    return {
      published: published.map(({ projectId: _p, ...rest }) => rest),
      pending,
      methods,
      unpublished: services.filter((s) => !published.some((p) => p.service === s.name && p.port === s.port)),
      ...(servicesProblem ? { servicesProblem } : {}),
      withdrawn: withdrawnView(await withdrawals.forProject(projectId)),
    };
  }

  /**
   * **画面が言う Project と、banto が刻んだ Project が違えば断る**（追加・2026-09-28）。人の画面の呼び出しには banto が
   * その画面の Project を `forProject` で刻む（`CallerStamp`）。画面が渡す引数と食い違うと、Service は刻まれた Project の
   * ものが見え、公開は引数の Project のものが見える——別々の Project の中身を1枚に混ぜない
   */
  function assertSameProject(stamp: ReturnType<typeof callerOf>, projectId: string): void {
    if (stamp && "admin" in stamp && stamp.forProject !== undefined && stamp.forProject !== projectId) {
      throw new PublishDirectoryError(`画面の Project（${projectId}）と、banto が渡した Project（${stamp.forProject}）が違います`);
    }
  }

  /** 入口の画面から、人が公開をやめる（狭める向きなので確かめは画面の中の二度押しだけ） */
  async function unpublishFromCanvas(r: Scoped, args: Record<string, unknown>, stamp: ReturnType<typeof callerOf>) {
    const projectId = typeof args.projectId === "string" ? args.projectId : "";
    const method = typeof args.method === "string" ? args.method : "";
    if (!projectId || !method || typeof args.service !== "string" || typeof args.port !== "number") {
      throw new PublishDirectoryError("projectId・method・service・port が要ります");
    }
    assertSameProject(stamp, projectId);
    const targets = await r.listTargets();
    if (!withRole(targets, PUBLISH_ROLE).includes(method)) throw new PublishDirectoryError(`出し方「${method}」はありません`);
    return r.callJson<{ removed: boolean; url?: string; note?: string }>(method, "unpublishRoute", { projectId, service: args.service, port: args.port });
  }

  /**
   * **入口の画面から、人がワンクリックで公開する**（追加・2026-10-01、ユーザー要望）。押したのが人なので、それが承認そのもの
   * ——承認の頼みは作らない。設定は出し方の既定のまま（認証は既定の「無し」・サブドメインは既定）。変えたいときは会話で頼めば
   * 承認の画面が出る。AI の publishService と同じく、Service の登録にあって**実際に待ち受けているものだけ**
   */
  async function publishFromCanvas(r: Scoped, args: Record<string, unknown>, stamp: ReturnType<typeof callerOf>) {
    const projectId = typeof args.projectId === "string" ? args.projectId : "";
    const name = typeof args.service === "string" ? args.service : "";
    if (!projectId || !name || typeof args.port !== "number") throw new PublishDirectoryError("projectId・service・port が要ります");
    assertSameProject(stamp, projectId);
    const port = args.port;
    const targets = await r.listTargets();
    const svc = await findService(r, targets, name, projectId);
    if (!svc.ports.includes(port)) throw new PublishDirectoryError(`${name} の登録に無いポートです：${port}`);
    if (!svc.listening.includes(port)) {
      throw new PublishDirectoryError(`${name} は ${port} で待ち受けていません（状態：${svc.state}）。サーバが起きてから押してください`);
    }
    const implementation = pickMethod(targets, args.method);
    const info = await r.callJson<MethodInfo>(implementation, "describePublishMethod", {});
    if (!info.ready) throw new PublishDirectoryError(`出し方「${info.title}」はまだ使えません：${info.problem ?? "理由不明"}`);
    const out = await r.callJson<{ url: string; reach: Reach }>(implementation, "publishRoute", { projectId, service: name, port, config: {} });
    return { ...out, reachLabel: REACH_LABEL[out.reach] };
  }

  async function approve(r: Scoped, args: Record<string, unknown>) {
    const config = (args.config ?? {}) as Record<string, unknown>;
    const { request: req, result } = await requests.decide(String(args.requestId ?? ""), async (req) => {
      const target = { projectId: req.projectId, service: req.service, port: req.port };
      let out: { url: string; reach: Reach };
      try {
        // **設定は中身を見ずにそのまま渡す**。実装が断ったら（パスワードが短い等）頼みは待ったまま——人が直して押し直せる
        out = await r.callJson<{ url: string; reach: Reach }>(req.implementation, "publishRoute", { ...target, config });
      } catch (err) {
        // **道は張れたのに返事だけ落ちた**（2026-09-28、Fable のレビュー）——押し直すと「もう公開しています」で断られ、
        // 頼みは永遠に待ったままになる。実装の一覧にその公開があれば、公開したと確定させる（実装が真実、規則3）
        const { routes } = await r
          .callJson<{ routes: RouteStatus[] }>(req.implementation, "listRoutes", { projectId: req.projectId })
          .catch(() => ({ routes: [] as RouteStatus[] }));
        const live = routes.find((x) => x.service === req.service && x.port === req.port);
        if (!live) throw err;
        out = { url: live.url, reach: live.reach };
      }
      return { state: "published", url: out.url, result: { state: "published", url: out.url, reach: out.reach, reachLabel: REACH_LABEL[out.reach] } };
    });
    // **決めたことを書いてから届ける**——届けてから書くと、書けなかったとき会話と頼みが食い違う
    await notify(req, `公開しました：${req.service}:${req.port}`, `人が承認し、${req.service}:${req.port} を ${result.url} で公開しました（届く範囲：${result.reachLabel}）。`);
    return result;
  }

  async function decline(args: Record<string, unknown>) {
    const { request: req, result } = await requests.decide(String(args.requestId ?? ""), async () => ({ state: "declined", result: { state: "declined" } }));
    await notify(req, `公開を断られました：${req.service}:${req.port}`, `人が ${req.service}:${req.port} の公開を断りました。公開していません。`);
    return result;
  }

  /**
   * **Service の登録が消されたので、その公開をやめる**（追加・2026-09-28、Fable のレビュー、ユーザー決定の案A）。
   *
   * Service の `removeService` が中継で呼ぶ。以前は公開が残り、同じ名前で別の中身を登録し直すと、人の承認なしに
   * 同じ URL の中身が替わった（Service が「上書きは断る」と決めた理由そのもの）。やめるのは狭める向きなので承認は要らない。
   * **呼べるのは Project の刻印だけ**——その Project の公開だけ触れる。承認待ちの頼みも取り下げる（人が見て承認するのは
   * 前の中身なので、登録し直した後の中身を、その承認で出さない）。
   * **1つでもやめられなければ投げる**——Service はそれを見て登録を消すのを断る（消したのに公開が残る、を作らない）
   */
  async function serviceRemoved(r: Scoped, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) {
    const stamp = callerOf(meta);
    if (!stamp || !("project" in stamp)) throw new PublishDirectoryError("serviceRemoved は Project の Module（Service）からだけ呼べます");
    const projectId = stamp.project;
    const name = typeof args.service === "string" ? args.service : "";
    if (!name) throw new PublishDirectoryError("service が要ります");
    const reason = `Service の登録「${name}」が消されたので、公開もやめました`;
    const targets = await r.listTargets();
    const stopped: Omit<Withdrawal, "at">[] = [];
    const problems: string[] = [];
    for (const m of withRole(targets, PUBLISH_ROLE)) {
      try {
        const { routes } = await r.callJson<{ routes: RouteStatus[] }>(m, "listRoutes", { projectId });
        for (const route of routes.filter((x) => x.service === name)) {
          const out = await r.callJson<{ removed: boolean; url?: string; note?: string }>(m, "unpublishRoute", { projectId, service: name, port: route.port });
          if (out.removed) stopped.push({ projectId, service: name, port: route.port, url: out.url ?? route.url, method: m, reason, ...(out.note ? { note: out.note } : {}) });
        }
      } catch (err) {
        problems.push(`${m}：${errText(err)}`);
      }
    }
    const cancelled = await requests.withdraw(projectId, name);
    // やめられた分は、やめられなかったものがあっても記録する（人に見せる）
    await withdrawals.add(stopped);
    if (problems.length > 0) throw new PublishDirectoryError(`「${name}」の公開をやめられなかった出し方があります：${problems.join(" / ")}`);
    return {
      unpublished: stopped.map(({ projectId: _p, reason: _r, ...rest }) => rest),
      withdrawnRequests: cancelled.map((c) => ({ requestId: c.id, port: c.port, plannedUrl: c.plannedUrl })),
    };
  }

  /** 結果を呼び出し元の Thread に届ける。**届かなくても公開の結果は変えない**（公開はもう済んでいる）——理由は残す */
  async function notify(req: PublishRequest, title: string, text: string): Promise<void> {
    if (!req.replyTo) return;
    try {
      await relay.deliver({ replyTo: req.replyTo, title, text, final: true });
    } catch (err) {
      console.error(`[publish-directory] 結果を会話に届けられませんでした（${req.id}）：${errText(err)}`);
    }
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: APPROVAL_APP_URI,
        name: "公開の承認",
        mimeType: UI_APP_MIME,
        // AI の tool（publishService）の画面なので agent
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { prefersBorder: true } },
      },
      {
        // **入口**（launcher、追加・2026-09-28）——Command Palette の「Module の入口」から、AI を介さずに開く
        uri: PUBLISHED_APP_URI,
        name: "公開",
        description: "この Project で外から届くようにしたもの（URL・届く範囲・届いているか）を見る",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "launcher", ui: { prefersBorder: false } },
      },
      {
        uri: SELF_REPORT_URI,
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["publish-directory"],
            dependsOn: [
              { role: PUBLISH_ROLE, required: true },
              // Service は Project ごと。その Project のための呼び出しの中でだけ呼べる（中継が決める）
              { role: SERVICE_ROLE, required: false },
            ],
            isolation: "subprocess",
            scope: "instance",
            // 人が承認の画面で打った設定（Basic 認証のパスワード等）がここを通って実装へ行く
            handlesSecrets: true,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === SELF_REPORT_URI) return { contents: [{ uri, mimeType: "application/json", text: "{}" }] };
    if (uri === APPROVAL_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: APPROVAL_APP_HTML }] };
    if (uri === PUBLISHED_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: publishedAppHtml() }] };
    throw new Error(`unknown resource: ${uri}`);
  });

  const admin = { [VISIBILITY_META_KEY]: "admin" };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "publishService",
        description:
          "**Service で動かしているサーバに、人のブラウザから届く URL を生やす**（コンテナの中のポートは、そのままでは外から届かない）。" +
          "**この tool は公開しない**——Service の登録と待ち受けを確かめて、承認の画面を会話に出すだけ。公開するか・前に置く認証・URL は人が画面で決める。" +
          "呼んだらターンを終えて人に知らせること。人が答えると結果（URL）がこの会話に届く。" +
          "サーバは 0.0.0.0 で待ち受けること（127.0.0.1 だけだとコンテナの外から届かない。Vite なら --host）。" +
          "開発サーバが知らないホスト名を断る場合（Vite の server.allowedHosts 等）は、届いた URL のホスト名を許すこと",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service に登録した名前（startService の name）" },
            port: { type: "number", description: "公開するポート。登録にポートが1つなら省略可" },
            method: { type: "string", description: "出し方（listPublished の methods の name）。1つしか無ければ省略可" },
          },
          required: ["service"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent", [DELIVERS_LATER_META_KEY]: true, ui: { resourceUri: APPROVAL_APP_URI } },
      },
      {
        name: "unpublishService",
        description: "公開をやめる（URL が届かなくなる）。承認は要らない",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string" },
            port: { type: "number", description: "省略するとそのサービスの公開を全部やめる" },
            method: { type: "string", description: "省略するとすべての出し方から探す" },
          },
          required: ["service"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        name: "listPublished",
        description:
          "この Project の公開の一覧（URL・届く範囲・認証・状態）と、承認待ちのもの、使える出し方。" +
          "state は active（届いている）／not-listening（サーバに届かない）／project-stopped（コンテナが止まっている）／" +
          "address-unknown（コンテナのアドレスを一時的に確かめられない。道はそのまま）／caddy-unreachable 等。" +
          "withdrawn は Service の登録が消されたので banto が自分でやめた公開（24時間）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
      {
        name: "get_publish_request",
        description: "承認の画面が引く：頼みの中身・出し方の設定項目・URL の見積もり",
        inputSchema: { type: "object", properties: { requestId: { type: "string" }, config: { type: "object" } }, required: ["requestId"] },
        _meta: admin,
      },
      {
        name: "approve_publish",
        description: "人が承認の画面で「公開する」を押した",
        inputSchema: { type: "object", properties: { requestId: { type: "string" }, config: { type: "object" } }, required: ["requestId"] },
        _meta: admin,
      },
      {
        name: "get_publish_overview",
        description: "入口の画面が引く：その Project の公開・承認待ち・まだ公開していないサーバ・出し方",
        inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
        _meta: admin,
      },
      {
        name: "publish_route",
        description: "入口の画面で人が「公開する」を押した（ワンクリック。押したことが承認、設定は出し方の既定）",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" }, service: { type: "string" }, port: { type: "number" }, method: { type: "string" } },
          required: ["projectId", "service", "port"],
        },
        _meta: admin,
      },
      {
        name: "unpublish_route",
        description: "入口の画面で人が「やめる」を押した",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" }, method: { type: "string" }, service: { type: "string" }, port: { type: "number" } },
          required: ["projectId", "method", "service", "port"],
        },
        _meta: admin,
      },
      {
        // **Service の登録が消されたら、その公開もやめる**（追加・2026-09-28）。Service が removeService の中で中継で呼ぶ。
        // 値を返さない（やめた URL だけ）ので初回の承認を聞かない——登録を消すたびに人を止めない
        name: "serviceRemoved",
        description: "Service の登録が消された。そのサービスの公開をやめ、承認待ちの頼みを取り下げる（Project の Module からだけ）",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
        _meta: { [VISIBILITY_META_KEY]: "module", [VALUE_FREE_META_KEY]: true, [AUDIT_ARGS_META_KEY]: ["service"] },
      },
      {
        name: "decline_publish",
        description: "人が承認の画面で「公開しない」を押した",
        inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] },
        _meta: admin,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    const name = request.params.name;
    // この呼び出しの中の中継には、host が渡した呼び出しの印を必ず添える（`Scoped`）
    const r = scoped(callIdOf(meta));
    try {
      switch (name) {
        case "publishService":
          return await publishService(r, args, meta);
        case "unpublishService":
          return json(await unpublishService(r, args, meta));
        case "listPublished":
          return json(await listPublished(r, meta));
        case "serviceRemoved":
          return json(await serviceRemoved(r, args, meta));
      }
      // ここから下は**人の操作だけ**。可視性で AI からは見えないが、呼び出しの刻印でも確かめる
      const stamp = callerOf(meta);
      if (!stamp || !("admin" in stamp)) throw new PublishDirectoryError(`${name} は人の操作からだけ呼べます`);
      switch (name) {
        case "get_publish_request":
          return json(await getRequest(r, args));
        case "approve_publish":
          return json(await approve(r, args));
        case "decline_publish":
          return json(await decline(args));
        case "get_publish_overview":
          return json(await overview(r, args, stamp));
        case "unpublish_route":
          return json(await unpublishFromCanvas(r, args, stamp));
        case "publish_route":
          return json(await publishFromCanvas(r, args, stamp));
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (err) {
      // 理由をそのまま返す——AI と画面はこれを人に見せる（黙って失敗しない、規則2）
      return { content: [{ type: "text", text: errText(err) }], isError: true };
    }
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const hostUrl = process.env.BANTO_HOST_MCP_URL;
  const hostToken = process.env.BANTO_HOST_MCP_TOKEN;
  if (!dataDir || !hostUrl || !hostToken) {
    console.error("BANTO_MODULE_DATA_DIR, BANTO_HOST_MCP_URL, BANTO_HOST_MCP_TOKEN が必要です");
    process.exit(1);
  }
  const { HostRelayClient } = await import("./relay-client.js");
  await createPublishDirectoryServer({
    relay: new HostRelayClient(hostUrl, hostToken),
    requests: new RequestStore(dataDir),
    withdrawals: new WithdrawalLog(dataDir),
  }).connect(new StdioServerTransport());
}
