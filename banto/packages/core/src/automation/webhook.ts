// docs/specs/v4-architecture.md §4.3「Webhook」——**外から POST を受けて自動化を動かす**。
//
// - 受け口は `/hooks/<印>`。印は自動化ごとに推測できないもの（32文字）で、台帳には SHA-256 だけを残す。印そのものは
//   作ったときに1回だけ人に見せる（`issueWebhookToken`）。印が無い・合わない要求は 404（あるかどうかを漏らさない）
// - HTTP の口で**人のログイン・機械の合言葉の確かめより前**に分岐する（`http/app.ts`）
// - **Project のコンテナから来た要求は既定で断る**——core は Incus の bridge にも待ち受けていて、どの Project の
//   コンテナからも届く。URL を隠すだけに頼らない。自動化ごとに「この Project のコンテナから許す」を持てる
// - **署名**：指定のヘッダの HMAC-SHA256 を、**受けた生のバイト列**に対して `timingSafeEqual` で確かめる（JSON に起こして
//   から計算しない）。鍵は作るときに Vault から1回引いて `<dataDir>` に 0600 で置く（来るたびに Vault を起こさない）。
//   合わないものは 401 で、AI は動かさず `automation.fired { result: "rejected" }` を残す
// - 本文は全体で署名を確かめてから、先頭 64KB まで AI に渡す。速さは自動化ごとと口全体の上限、溜める件数の上限——超えたら 429
// - **まとめる**：受けたら `automation.received` に本文ごと残してから、待つ時間が過ぎたら溜まった分を1回の `deliver` に
//   まとめる。前の回が終わっていなければ溜めたまま、空いたら（ターンが終わったら）届ける。起き直したら残っている
//   `automation.received` からまとめ直す（`start`）

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Automation, AutomationSignature } from "./fold.js";
import type { AutomationStore } from "./store.js";
import type { AutomationRunner } from "./runner.js";

/** 本文のうち AI に渡す上限 */
export const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;
/** 読む本文の上限。署名は全体で確かめるので 64KB では切れない——これを超えたら 413 */
export const WEBHOOK_READ_MAX_BYTES = 1024 * 1024;

/** 速さと溜める件数の上限（仮置き・2026-10-15——困ったら変える） */
export const WEBHOOK_LIMITS = {
  /** 自動化ごとに1分あたり */
  perAutomationPerMinute: 30,
  /** 認証の要らない口全体で1分あたり（`auth/service.ts` の数え方と同じ形） */
  allPerMinute: 120,
  /** 自動化ごとに溜めておける件数（届けられない間に積もり続けない） */
  pendingMax: 100,
} as const;
export type WebhookLimits = Record<keyof typeof WEBHOOK_LIMITS, number>;

/** 前の回が終わっていなくて届けられなかったとき、次に見直すまで（ターンの終わりでも見直す） */
const RETRY_MS = 30_000;

/** 署名の鍵の置き場（`<dataDir>` の下、0600） */
const SECRETS_FILE = "automation-webhook-secrets.json";

/** 受け口の印を出す。返すのは印そのもの（人に1回だけ見せる）と、台帳に残すハッシュ */
export function issueWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashWebhookToken(token) };
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * 署名のヘッダの値（`sha256=<hex>` か `<hex>`）が、本文の HMAC-SHA256 と合うか。長さが違うもの・hex でないものは
 * 合わない（`timingSafeEqual` は長さが同じでないと比べられない）
 */
export function signatureMatches(key: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const hex = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", key).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

export interface AutomationWebhooksDeps {
  dataDir: string;
  automations: AutomationStore;
  runner: Pick<AutomationRunner, "run">;
  /** ターンが終わった（届け先が空いたかもしれない）を聞く */
  onTurnEnded(listener: (threadId: string) => void): void;
  /**
   * 送り元がどの Project のコンテナか。コンテナでなければ undefined。**分からない（Incus が答えない）は投げる**——黙って
   * 通さない
   */
  containerProjectOf(remoteAddress: string): Promise<string | undefined>;
  /** 署名の鍵の値を Vault から引く（その Project のための呼び出しとして） */
  resolveSecret(alias: string, projectId: string): Promise<string>;
  /** Project が閉じているか（閉じている間は受けない） */
  projectClosed(projectId: string): boolean;
  now?: () => Date;
  limits?: Partial<WebhookLimits>;
  log?: (message: string) => void;
}

/** 送り手に返す答え（HTTP の状態と1行） */
interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export class AutomationWebhooks {
  /** 自動化の id → 署名の鍵（Vault から引いた値） */
  private readonly secrets: Map<string, string>;
  private readonly secretsPath: string;
  private readonly timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  private readonly flushing = new Set<string>();
  /** 1分ごとの数え（口全体と自動化ごと） */
  private all = { startedAt: 0, count: 0 };
  private readonly perAutomation = new Map<string, { startedAt: number; count: number }>();
  private readonly limits: WebhookLimits;
  private started = false;

  constructor(private readonly deps: AutomationWebhooksDeps) {
    this.secretsPath = join(deps.dataDir, SECRETS_FILE);
    this.secrets = new Map(Object.entries(loadSecrets(this.secretsPath)));
    this.limits = { ...WEBHOOK_LIMITS, ...deps.limits };
  }

  /**
   * **起き直したらまとめ直す**——残っている `automation.received` を、待つ時間から数えて届ける。届けものの再開
   * （`resumeAll`）と待ち受けの開始のあとに呼ぶ
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const a of this.deps.automations.listAll()) this.consider(a.id);
    // 再開した・待つ時間を変えた・消した等。溜まったものがあれば数え直す
    this.deps.automations.onChange(({ id }) => this.consider(id));
    // 届け先が空いたかもしれない——溜まったものを届けに行く（待つ時間が過ぎていれば）
    this.deps.onTurnEnded((threadId) => {
      for (const a of this.deps.automations.listAll()) {
        if (a.source.kind === "webhook" && a.received.length > 0 && a.target.threadId === threadId) this.consider(a.id);
      }
    });
  }

  stop(): void {
    this.started = false;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * **署名の鍵を置く**（作る・確かめ方を変えるとき）。Vault から1回引いて `<dataDir>` に 0600 で置く。署名を確かめない
   * なら消す。引けなければ投げる——作る・直す口がそのまま断る（鍵の無い Webhook を作らない）
   */
  async storeSecret(id: string, projectId: string, signature: AutomationSignature | undefined): Promise<void> {
    if (!signature) {
      this.forgetSecret(id);
      return;
    }
    const value = await this.deps.resolveSecret(signature.alias, projectId);
    if (value === "") throw new Error(`Vault の ${signature.alias} が空です`);
    this.secrets.set(id, value);
    this.save();
  }

  /** 消した自動化の鍵を捨てる */
  forgetSecret(id: string): void {
    if (this.secrets.delete(id)) this.save();
  }

  /** `/hooks/<印>` に来た要求を受ける。印は `http/app.ts` が道から切り出したもの */
  async handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.receive(req, token);
    } catch (err) {
      reply = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    if (!req.complete) {
      // 読まずに断った本文は捨てる（送り手が書き終えるのを待たずに答えると、接続が切れて答えが届かないことがある）
      req.resume();
    }
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  }

  private async receive(req: IncomingMessage, token: string): Promise<Reply> {
    const now = this.now();
    // 口全体の速さ——印を当てに来る総当たりも、ここで止まる
    if (!this.count(this.all, now, this.limits.allPerMinute)) {
      return { status: 429, body: { error: "Webhook の受け口への要求が多すぎます。1分ほど待ってください" } };
    }
    const a = token ? this.deps.automations.findByWebhookTokenHash(hashWebhookToken(token)) : undefined;
    if (!a || a.source.kind !== "webhook") return { status: 404, body: { error: "not found" } };
    if (req.method !== "POST") return { status: 405, body: { error: "POST で送ってください" } };

    // **Project のコンテナからは既定で断る**
    const remote = normalizeAddress(req.socket.remoteAddress ?? "");
    let fromProject: string | undefined;
    try {
      fromProject = await this.deps.containerProjectOf(remote);
    } catch (err) {
      return { status: 503, body: { error: `送り元を確かめられませんでした：${err instanceof Error ? err.message : String(err)}` } };
    }
    if (fromProject !== undefined && !(a.source.allowProjectContainer && fromProject === a.projectId)) {
      return { status: 403, body: { error: "Project のコンテナからの要求は受けません" } };
    }

    const perAutomation = this.perAutomation.get(a.id) ?? { startedAt: 0, count: 0 };
    this.perAutomation.set(a.id, perAutomation);
    if (!this.count(perAutomation, now, this.limits.perAutomationPerMinute)) {
      return { status: 429, body: { error: "この自動化への要求が多すぎます。1分ほど待ってください" } };
    }

    const body = await readRawBody(req, WEBHOOK_READ_MAX_BYTES);
    if (!body) return { status: 413, body: { error: `本文が大きすぎます（${WEBHOOK_READ_MAX_BYTES / 1024 / 1024}MB まで）` } };

    // **署名は全体で確かめてから切る**
    const signature = a.source.signature;
    if (signature) {
      const key = this.secrets.get(a.id);
      const given = req.headers[signature.header.toLowerCase()];
      const reason = !key
        ? "署名の鍵が banto に置かれていません（自動化を作り直すか、署名の確かめ方を直してください）"
        : !given
          ? `署名のヘッダ ${signature.header} がありません`
          : !signatureMatches(key, body, Array.isArray(given) ? given[0] : given)
            ? `署名（${signature.header}）が合いません`
            : undefined;
      if (reason) {
        await this.record(a, now, "rejected", reason);
        return { status: 401, body: { error: "署名が合いません" } };
      }
    }

    if (a.paused || this.deps.projectClosed(a.projectId)) {
      const reason = a.paused ? "一時停止中に受けたので、届けませんでした" : "Project が閉じている間に受けたので、届けませんでした";
      await this.record(a, now, "skipped", reason);
      return { status: 409, body: { error: a.paused ? "この自動化は一時停止しています" : "この Project は閉じられています" } };
    }
    if (a.received.length >= this.limits.pendingMax) {
      return { status: 429, body: { error: `届けられずに溜まっているものが上限（${this.limits.pendingMax} 件）に達しています` } };
    }

    // 受けたものを先に残す——届ける前に banto が落ちても、起き直したらまとめ直せる
    const receivedId = randomUUID();
    const kept = body.subarray(0, WEBHOOK_BODY_MAX_BYTES);
    await this.deps.automations.recordReceived(a.id, {
      receivedId,
      at: now.toISOString(),
      body: kept.toString("utf8"),
      ...(body.length > kept.length ? { truncatedFrom: body.length } : {}),
    });
    this.consider(a.id);
    return { status: 202, body: { ok: true, receivedId } };
  }

  /** 溜まったものがあれば、待つ時間が過ぎたときに届けに行く（もう過ぎていればすぐ） */
  private consider(id: string): void {
    if (!this.started) return;
    const a = this.deps.automations.get(id);
    if (!a || a.source.kind !== "webhook" || a.received.length === 0 || a.paused) {
      this.cancel(id);
      return;
    }
    const due = Date.parse(a.received[0]!.at) + a.source.batchSeconds * 1000;
    this.schedule(id, Math.max(0, due - this.now().getTime()));
  }

  private schedule(id: string, delayMs: number): void {
    const at = this.now().getTime() + delayMs;
    const current = this.timers.get(id);
    if (current && current.at <= at) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.flush(id).catch((err: unknown) =>
        this.log(`[host] 自動化 ${id} の Webhook を届けられませんでした: ${err instanceof Error ? err.stack ?? err.message : String(err)}`),
      );
    }, delayMs);
    timer.unref();
    this.timers.set(id, { at, timer });
  }

  private cancel(id: string): void {
    const current = this.timers.get(id);
    if (!current) return;
    clearTimeout(current.timer);
    this.timers.delete(id);
  }

  /** 溜まった分を1回にまとめて届ける。前の回が終わっていなければ溜めたまま、あとで見直す */
  private async flush(id: string): Promise<void> {
    if (this.flushing.has(id)) return;
    this.flushing.add(id);
    try {
      const a = this.deps.automations.get(id);
      if (!a || a.source.kind !== "webhook" || a.received.length === 0 || a.paused) return;
      const due = Date.parse(a.received[0]!.at) + a.source.batchSeconds * 1000;
      if (due > this.now().getTime()) {
        this.schedule(id, due - this.now().getTime());
        return;
      }
      const started = await this.deps.runner.run(a, "webhook", {}, a.received);
      if (started.deferred) this.schedule(id, RETRY_MS);
    } finally {
      this.flushing.delete(id);
    }
    // 届けている間に受けたものは、次の回にまとめる
    this.consider(id);
  }

  private async record(a: Automation, now: Date, result: "rejected" | "skipped", reason: string): Promise<void> {
    await this.deps.automations.recordRun(a.id, { runId: randomUUID(), at: now.toISOString(), cause: "webhook", result, reason });
  }

  /** 1分の窓で数える。上限を超えたら false */
  private count(window: { startedAt: number; count: number }, now: Date, max: number): boolean {
    const t = now.getTime();
    if (t - window.startedAt > 60_000) {
      window.startedAt = t;
      window.count = 0;
    }
    return ++window.count <= max;
  }

  private save(): void {
    // 書きかけを読ませない（別名に書いて置き換える）。値は記録（Event Store）には残さない
    const tmp = `${this.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.secrets)), { mode: 0o600 });
    renameSync(tmp, this.secretsPath);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

/** 本文を生のバイト列のまま読む。上限を超えたら undefined（読み切ってから——途中で切ると答えが届かない） */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) continue;
    chunks.push(chunk as Buffer);
  }
  return total > maxBytes ? undefined : Buffer.concat(chunks);
}

function loadSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  // 壊れていたら止まる（規則2）——黙って空にすると、署名つきの Webhook が全部 401 に化ける
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new Error(`自動化の Webhook の署名の鍵の置き場が壊れています：${path}`);
  }
  return parsed as Record<string, string>;
}

/** IPv4 を IPv6 の形で受けた待ち受け（`::ffff:10.0.0.2`）でも、コンテナのアドレスと比べられる形に */
export function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
