// **承認待ちの公開**（AI が頼み、人がまだ押していないもの）。置き場は窓口のデータ置き場。
//
// 公開したものの一覧は**持たない**——真実は各実装（Caddy なら Caddy の実装のマスター）にあり、
// 一覧は毎回そこから組む（規則3）。ここが持つのは「人に聞いている最中のもの」と、押した後の結果だけ
// （会話を読み直したとき、画面が「公開した／断った」を言えるように。24時間で片づける）。
// **パスワード等の設定の値は持たない**——人が押した瞬間に実装へ渡すだけ。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Reach = "machine" | "lan" | "internet";

export interface PublishRequest {
  id: string;
  projectId: string;
  service: string;
  port: number;
  /** 出し方＝実装の Module の名前 */
  implementation: string;
  /** 頼まれた時点の見積もり（画面は開いたときに引き直す） */
  plannedUrl: string;
  reach: Reach;
  /** 呼び出し元の Thread に結果を届ける札（host が渡したもの。無ければ届けない） */
  replyTo?: string;
  createdAt: string;
  /**
   * `withdrawn`——人が答える前に、公開するはずだった Service の登録が消された（追加・2026-09-28）。
   * 同じ名前で別の中身が登録し直されても、この頼みでは公開しない（人が見て承認したのは前の中身）
   */
  state: "pending" | "published" | "declined" | "withdrawn";
  decidedAt?: string;
  url?: string;
}

const STATE_TEXT: Record<Exclude<PublishRequest["state"], "pending">, string> = {
  published: "公開済み",
  declined: "断った",
  withdrawn: "取り下げた——Service の登録が消された",
};

/** 押されていない頼みの上限（Project ごと）。AI が繰り返し呼んでも置き場を埋めない */
export const MAX_PENDING_PER_PROJECT = 20;
export const KEEP_MS = 24 * 60 * 60 * 1000;

export class RequestStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dir, "requests.json");
  }

  private async read(): Promise<PublishRequest[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const all = (JSON.parse(text) as { requests: PublishRequest[] }).requests ?? [];
    // 24時間を過ぎたものは片づける（押されていないものも——その頃には会話の文脈が変わっている）
    const limit = this.now().getTime() - KEEP_MS;
    return all.filter((r) => Date.parse(r.decidedAt ?? r.createdAt) > limit);
  }

  private async write(all: PublishRequest[]): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    // 札（replyTo）は Thread に届ける印なので、他人に読ませない
    await writeFile(tmp, JSON.stringify({ requests: all }, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** 読み書きを1本ずつ通す（画面と AI が同時に触っても取りこぼさない） */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  add(input: Omit<PublishRequest, "id" | "createdAt" | "state">): Promise<PublishRequest> {
    return this.serialize(async () => {
      const all = await this.read();
      const pending = all.filter((r) => r.projectId === input.projectId && r.state === "pending");
      if (pending.length >= MAX_PENDING_PER_PROJECT) {
        throw new Error(`承認待ちの公開が ${MAX_PENDING_PER_PROJECT} 件あります。人が答えるのを待ってください`);
      }
      const req: PublishRequest = { ...input, id: randomUUID(), createdAt: this.now().toISOString(), state: "pending" };
      await this.write([...all, req]);
      return req;
    });
  }

  async get(id: string): Promise<PublishRequest | undefined> {
    return (await this.read()).find((r) => r.id === id);
  }

  async pending(projectId: string): Promise<PublishRequest[]> {
    return (await this.read()).filter((r) => r.projectId === projectId && r.state === "pending");
  }

  /**
   * 押されたものを決める。**待っている状態から1回だけ**——同じ頼みで2回公開しない。
   * `fn` が投げたら待っている状態のまま（人が設定を直してもう一度押せる）。
   *
   * **決めたことを書いてから返す**（改訂・2026-09-28、Fable のレビュー）。会話に届けるのは呼び出し元がこの後で行う
   * ——以前は `fn` の中で届けてから書いていたので、書くのに失敗すると「会話には公開したと届いたのに、頼みは待ったまま」
   * になり、人がもう一度押せてしまった
   */
  decide<T>(
    id: string,
    fn: (req: PublishRequest) => Promise<{ state: "published" | "declined"; url?: string; result: T }>,
  ): Promise<{ request: PublishRequest; result: T }> {
    return this.serialize(async () => {
      const all = await this.read();
      const req = all.find((r) => r.id === id);
      if (!req) throw new Error("その公開の頼みはありません（24時間を過ぎたか、id が違います）");
      if (req.state !== "pending") throw new Error(`その頼みはもう答えが出ています（${STATE_TEXT[req.state]}）`);
      const out = await fn(req);
      const decided: PublishRequest = {
        ...req,
        state: out.state,
        decidedAt: this.now().toISOString(),
        ...(out.url ? { url: out.url } : {}),
      };
      await this.write(all.map((r) => (r.id === id ? decided : r)));
      return { request: decided, result: out.result };
    });
  }

  /** その Service の、人がまだ答えていない頼みを取り下げる（Service の登録が消されたとき）。取り下げたものを返す */
  withdraw(projectId: string, service: string): Promise<PublishRequest[]> {
    return this.serialize(async () => {
      const all = await this.read();
      const at = this.now().toISOString();
      const hit = (r: PublishRequest) => r.projectId === projectId && r.service === service && r.state === "pending";
      const withdrawn = all.filter(hit).map((r) => ({ ...r, state: "withdrawn" as const, decidedAt: at }));
      if (withdrawn.length > 0) await this.write(all.map((r) => (hit(r) ? withdrawn.find((w) => w.id === r.id)! : r)));
      return withdrawn;
    });
  }
}

/** 窓口が自分でやめた公開（Service の登録が消されたので）。人に分かるように、一覧に24時間出す */
export interface Withdrawal {
  projectId: string;
  service: string;
  port: number;
  url: string;
  /** 出し方＝実装の Module の名前 */
  method: string;
  reason: string;
  at: string;
  /** 実装の道がまだ消せていない等（消えるまでは実装の突き合わせが続ける） */
  note?: string;
}

/**
 * **自分でやめた公開の記録**（追加・2026-09-28、Fable のレビュー——公開中の Service が `removeService` されたら公開もやめる）。
 * 公開の一覧は持たない（規則3）が、**「やめた」という出来事は実装に残らない**ので、人に見せるためにここに置く。24時間で片づける
 */
export class WithdrawalLog {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dir, "withdrawn.json");
  }

  private async read(): Promise<Withdrawal[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const limit = this.now().getTime() - KEEP_MS;
    return ((JSON.parse(text) as { withdrawn: Withdrawal[] }).withdrawn ?? []).filter((w) => Date.parse(w.at) > limit);
  }

  add(entries: Omit<Withdrawal, "at">[]): Promise<Withdrawal[]> {
    const next = this.queue.then(async () => {
      if (entries.length === 0) return [];
      const at = this.now().toISOString();
      const added = entries.map((e) => ({ ...e, at }));
      const all = [...(await this.read()), ...added];
      await mkdir(join(this.path, ".."), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify({ withdrawn: all }, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
      return added;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async forProject(projectId: string): Promise<Withdrawal[]> {
    return (await this.read()).filter((w) => w.projectId === projectId);
  }
}
