// **Module に届ける**（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」）。
//
// Module が中継で「終わったら届ける」 tool（サブエージェントの `runInBackground` 等）を呼ぶと、返事は呼んだ Module に
// 返る（決定・2026-09-26、ユーザー）。Thread に届ける口（`thread-deliveries.ts`）と同じ考え方で：
//
// - **残してから渡す**——届いたらまずファイルに残し、それから呼んだ Module の受け口の tool
//   （`dev.banto/receivesReplies`）を呼ぶ。その瞬間に Module が止まっていても、次に繋がったときに渡す
// - **返事待ちは失くさない**——頼んだ先の Module が止まったら、host が代わりに「途中で終わりました」（`lost: true`）を
//   渡す。banto を起こし直したときも同じ（札は覚え直さないので、前の走行の返事待ちは全部「途中で終わりました」）
//
// Event Store ではなく専用のファイルに置く：中身は Project・Thread のどちらにも属さない（banto 全体の Module どうしも
// 使える）短命の待ち行列で、渡し終えたら消える。会話の記録として残すものではない。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModuleReplyArguments } from "@banto/module-contract";

/** 頼んだ先が「あとで届ける」と約束した、まだ届いていない返事 */
export interface ModuleAwaitingReply {
  /** 札（頼んだ先に渡したもの）。この行の鍵 */
  replyTo: string;
  /** 呼んだ Module に見せた返事の印 */
  replyId: string;
  /** 届け先（呼んだ Module） */
  toConn: string;
  toModule: string;
  /** 頼んだ先（あとで届ける Module） */
  fromConn: string;
  fromModule: string;
  since: string;
}

/** 残したが、まだ受け口に渡せていないもの */
export interface ModuleReplyPending {
  deliveryId: string;
  toConn: string;
  args: ModuleReplyArguments;
  at: string;
}

interface FileShape {
  format: "banto-module-replies/1";
  awaiting: ModuleAwaitingReply[];
  pending: ModuleReplyPending[];
}

export interface ModuleRepliesDeps {
  /** 置き場（例 `<dataDir>/delivery/module-replies.json`） */
  file: string;
  /**
   * 受け口に渡す。**渡せなかったら投げる**（Module が繋がっていない・受け口が無い等）——残したまま、次に繋がったときに
   * もう一度渡す。受け口が `isError` を返したら `"refused"`（Module が受け取りを断った——何度渡しても同じなので捨てる）
   */
  hand(toConn: string, args: ModuleReplyArguments): Promise<"handed" | "refused">;
  now?: () => Date;
}

export class ModuleReplies {
  private state: FileShape = { format: "banto-module-replies/1", awaiting: [], pending: [] };
  /** ファイルへの書き込みを1本ずつ */
  private writing: Promise<void> = Promise.resolve();
  /** 届け先ごとの渡す列——同じ Module に同じものを2回渡さない・届いた順に渡す */
  private readonly handing = new Map<string, Promise<void>>();

  private constructor(private readonly deps: ModuleRepliesDeps) {}

  static async open(deps: ModuleRepliesDeps): Promise<ModuleReplies> {
    const r = new ModuleReplies(deps);
    try {
      const raw = JSON.parse(await readFile(deps.file, "utf8")) as Partial<FileShape>;
      if (raw.format !== "banto-module-replies/1") throw new Error(`知らない形です（format=${String(raw.format)}）`);
      r.state = { format: raw.format, awaiting: raw.awaiting ?? [], pending: raw.pending ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // 読めないものは黙って空にしない——横に退けて、理由を残す（規則2）
        const aside = `${deps.file}.unreadable-${Date.now()}`;
        await rename(deps.file, aside).catch(() => undefined);
        console.warn(`[host] Module 宛ての返事の置き場が読めませんでした（${aside} に退けました）:`, err);
      }
    }
    return r;
  }

  awaiting(): readonly ModuleAwaitingReply[] {
    return this.state.awaiting;
  }

  pending(): readonly ModuleReplyPending[] {
    return this.state.pending;
  }

  /** 頼んだ先が「あとで届ける」と約束した */
  async recordAwaiting(input: Omit<ModuleAwaitingReply, "since">): Promise<void> {
    this.state.awaiting = [
      ...this.state.awaiting.filter((a) => a.replyTo !== input.replyTo),
      { ...input, since: this.now().toISOString() },
    ];
    await this.save();
  }

  /**
   * 届いた。**残してから渡す**。`replyTo` を渡すと、最後の1通（`final`）でその返事待ちを済ませる
   */
  async deliver(input: { toConn: string; args: ModuleReplyArguments; replyTo?: string }): Promise<{ deliveryId: string }> {
    const deliveryId = randomUUID();
    this.state.pending = [...this.state.pending, { deliveryId, toConn: input.toConn, args: input.args, at: this.now().toISOString() }];
    if (input.args.final && input.replyTo) {
      this.state.awaiting = this.state.awaiting.filter((a) => a.replyTo !== input.replyTo);
    }
    await this.save();
    void this.handPending(input.toConn);
    return { deliveryId };
  }

  /**
   * **頼んだ先が止まった**——その Module からの返事待ちを全部「途中で終わりました」にして、呼んだ Module に渡す
   */
  async loseFrom(fromConn: string, why: string): Promise<number> {
    const lost = this.state.awaiting.filter((a) => a.fromConn === fromConn);
    for (const a of lost) await this.deliverLost(a, why);
    return lost.length;
  }

  /** **banto を起こし直した**——前の走行の返事待ちは全部「途中で終わりました」（札は覚え直さない） */
  async loseAll(why: string): Promise<number> {
    const lost = [...this.state.awaiting];
    for (const a of lost) await this.deliverLost(a, why);
    return lost.length;
  }

  /** その札の返事待ちだけを「途中で終わりました」にする（頼んだ先が約束を果たさずに札を手放したとき等） */
  async loseOne(replyTo: string, why: string): Promise<void> {
    const a = this.state.awaiting.find((x) => x.replyTo === replyTo);
    if (a) await this.deliverLost(a, why);
  }

  /**
   * **残っているものを渡す**（届け先の Module が繋がったとき・届いたとき）。届いた順に1件ずつ。渡せなければそこで止める
   * （順番を崩さない。次に繋がったときにまた呼ばれる）
   */
  handPending(toConn: string): Promise<void> {
    const prev = this.handing.get(toConn) ?? Promise.resolve();
    const next = prev.then(() => this.handPendingNow(toConn));
    this.handing.set(toConn, next.catch(() => undefined));
    return next;
  }

  private async handPendingNow(toConn: string): Promise<void> {
    for (;;) {
      const item = this.state.pending.find((p) => p.toConn === toConn);
      if (!item) return;
      let outcome: "handed" | "refused";
      try {
        outcome = await this.deps.hand(toConn, item.args);
      } catch (err) {
        console.warn(
          `[host] ${toConn} に返事（${item.args.from}「${item.args.title}」）を渡せませんでした。次に繋がったときに渡します:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      if (outcome === "refused") {
        console.warn(`[host] ${toConn} が返事（${item.args.from}「${item.args.title}」）の受け取りを断りました。捨てます`);
      }
      this.state.pending = this.state.pending.filter((p) => p.deliveryId !== item.deliveryId);
      await this.save();
    }
  }

  private async deliverLost(a: ModuleAwaitingReply, why: string): Promise<void> {
    await this.deliver({
      toConn: a.toConn,
      replyTo: a.replyTo,
      args: {
        replyId: a.replyId,
        from: a.fromModule,
        title: `${a.fromModule} の仕事は途中で終わりました`,
        text: `${a.fromModule} に頼んだ「終わったら届ける」仕事の返事は、もう届きません——${why}。結果が要るなら、頼み直してください。`,
        final: true,
        lost: true,
      },
    });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.deps.file);
    });
    return this.writing;
  }
}
