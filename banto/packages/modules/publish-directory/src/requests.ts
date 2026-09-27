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
  state: "pending" | "published" | "declined";
  decidedAt?: string;
  url?: string;
}

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
   * `fn` が投げたら待っている状態のまま（人が設定を直してもう一度押せる）
   */
  decide<T>(id: string, fn: (req: PublishRequest) => Promise<{ state: "published" | "declined"; url?: string; result: T }>): Promise<T> {
    return this.serialize(async () => {
      const all = await this.read();
      const req = all.find((r) => r.id === id);
      if (!req) throw new Error("その公開の頼みはありません（24時間を過ぎたか、id が違います）");
      if (req.state !== "pending") throw new Error(`その頼みはもう答えが出ています（${req.state === "published" ? "公開済み" : "断った"}）`);
      const out = await fn(req);
      const decided: PublishRequest = {
        ...req,
        state: out.state,
        decidedAt: this.now().toISOString(),
        ...(out.url ? { url: out.url } : {}),
      };
      await this.write(all.map((r) => (r.id === id ? decided : r)));
      return out.result;
    });
  }
}
