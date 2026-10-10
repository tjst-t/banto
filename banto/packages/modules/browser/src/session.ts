// **ブラウザ1つ**（Project ごと）。最初の道具の呼び出しで起こし、AI の呼び出しが無いまま決めた時間がたったら止める
// （メモリを返す。v4-modules.md §4.1「形」）。プロファイル（Cookie・localStorage 等）は Module の置き場に置くので、
// 止めても起こし直してもログイン状態は残る（launchPersistentContext）。

import { rmSync } from "node:fs";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { BrowserError } from "./args.js";
import { attachRecorder, type CdpLike } from "./cdp-recorder.js";
import type { ConsoleLevel, NetworkLog } from "./network-log.js";

export interface SessionDeps {
  profileDir: string;
  log: NetworkLog;
  /** プロファイルの置き場でブラウザを起こす（入っていなければ入れる——install.ts） */
  launch: (profileDir: string, onProgress?: (message: string) => void) => Promise<BrowserContext>;
  /** 使われなければ止めるまでの時間（ms）。呼ぶたびに読む——設定を変えたら次から効く */
  idleMs: () => number;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  current: boolean;
}

/** 起こしたときのページの大きさ（screencast の既定と同じ。AI は browserAct の resize で変える） */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export class BrowserSession {
  private context: BrowserContext | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private readonly pages = new Map<string, Page>();
  /** 登録が終わる（CDP の Network を有効にし終える）まで待てるように、約束で持つ */
  private readonly ids = new WeakMap<Page, Promise<string>>();
  private currentTab: string | undefined;
  private nextTab = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 止めた理由（最後に止まったとき）。状態を見る口が返す */
  lastStop: { at: string; reason: string } | undefined;
  /** 人の画面が開いている数。開いている間は使われていなくても止めない（v4-modules.md §4.1「起こす・止める」） */
  private holds = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {}

  get running(): boolean {
    return this.context !== undefined;
  }

  /** AI の呼び出しがあった——止めるまでの時計を巻き戻す */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // 画面が開いている間は止めない（人が見ている）——閉じたときに数え直す（release）
      if (this.holds > 0) return;
      void this.stop(`画面が閉じていて AI の呼び出しが ${Math.round(this.deps.idleMs() / 60000)} 分無かったので止めました`);
    }, this.deps.idleMs());
    this.idleTimer.unref();
  }

  /** 人の画面が開いた。返す関数で閉じたことを知らせる（2回呼んでも1回分） */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      // 最後の画面が閉じたら、そこから数え直す（起きていなければ数えない）
      if (this.holds === 0 && this.context) this.touch();
    };
  }

  /** タブ・選んでいるタブ・動いているかが変わったら呼ぶ（人の画面に知らせる）。返す関数で外す */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error(`[browser] 変わったことを知らせられませんでした: ${(err as Error).message}`);
      }
    }
  }

  /** そのタブの CDP の口を新しく開く（screencast・人の入力。閉じるのは使う側） */
  async newCdp(page: Page): Promise<CDPSession> {
    if (!this.context) throw new BrowserError("ブラウザが動いていません");
    return this.context.newCDPSession(page);
  }

  /** 起きていなければ起こす。同時に呼ばれても1回だけ */
  async ensure(onProgress?: (message: string) => void): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.starting ??= this.start(onProgress).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(onProgress?: (message: string) => void): Promise<BrowserContext> {
    const context = await this.deps.launch(this.deps.profileDir, onProgress);
    // タブの id は**止めて起こし直しても続きから**振る——通信とコンソールの記録はタブの id を持って残るので、t1 から
    // 振り直すと前に起こしたときの t1 と混ざる（listNetwork の tab で絞ったとき）。Module ごと起こし直したときも記録の続きから
    this.nextTab = Math.max(this.nextTab, this.deps.log.maxTabNumber() + 1);
    this.context = context;
    context.on("close", () => {
      // ブラウザが落ちた・止めた——次の呼び出しで起こし直す
      if (this.context === context) this.forget();
    });
    context.on("page", (page) => {
      // 開いてすぐ閉じたページは CDP を繋ぐ前に消える——そのタブは記録しないだけ（理由は Module のログに残す）
      this.register(page).catch((err: Error) => console.error(`[browser] タブを繋げませんでした: ${err.message}`));
    });
    for (const page of context.pages()) await this.register(page);
    // 起こしたのが人の画面なら AI の呼び出しは無い——ここから数える（画面が開いている間は止めない）
    this.touch();
    this.emit();
    return context;
  }

  private forget(): void {
    this.context = undefined;
    this.pages.clear();
    this.currentTab = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.deps.log.saveNow();
    this.emit();
  }

  async stop(reason: string): Promise<void> {
    // 起こしている途中なら、起き終わるのを待って止める（起こし損ねたなら止めるものは無い）
    const context = this.context ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    if (!context) return;
    this.lastStop = { at: new Date().toISOString(), reason };
    this.forget();
    await context.close().catch(() => undefined); // もう閉じている（落ちた）——止めたいのは同じ
  }

  /** 「ブラウザの記録を消す」：止めて、プロファイルと通信の記録を消す */
  async clearData(): Promise<void> {
    await this.stop("ブラウザの記録を消すために止めました");
    rmSync(this.deps.profileDir, { recursive: true, force: true });
    this.deps.log.clear();
  }

  private register(page: Page): Promise<string> {
    const existing = this.ids.get(page);
    if (existing) return existing;
    const id = `t${this.nextTab++}`;
    const registering = this.attach(id, page);
    this.ids.set(page, registering);
    return registering;
  }

  private async attach(id: string, page: Page): Promise<string> {
    this.pages.set(id, page);
    this.currentTab ??= id;
    page.on("close", () => {
      this.pages.delete(id);
      if (this.currentTab === id) this.currentTab = [...this.pages.keys()].at(-1);
      this.emit();
    });
    // URL とタイトルが変わったら人の画面のタブの並びと URL 欄に出す
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.emit();
    });
    page.on("load", () => this.emit());
    const log = this.deps.log;
    page.on("console", (msg) => {
      const loc = msg.location();
      log.addConsole({
        tab: id,
        level: consoleLevel(msg.type()),
        kind: "console",
        text: msg.text(),
        ...(loc.url ? { url: loc.url, line: loc.lineNumber + 1 } : {}),
        at: Date.now(),
      });
    });
    page.on("pageerror", (err) => {
      log.addConsole({ tab: id, level: "error", kind: "exception", text: err.message, ...(err.stack ? { stack: err.stack } : {}), at: Date.now() });
    });
    const cdp = await this.context!.newCDPSession(page);
    // Playwright の CDPSession は知らせの名前ごとに型が付く——ここでは名前を文字で受ける形に合わせる
    attachRecorder(log, () => id, cdp as unknown as CdpLike);
    // 本文はブラウザの中の入れ物にあるうちに取る——入れ物を大きめにして、取る前に捨てられにくくする
    await cdp.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
    this.emit();
    return id;
  }

  // ---- タブ ----------------------------------------------------------------------------------

  async listTabs(): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const [id, page] of this.pages) {
      out.push({ id, url: page.url(), title: await page.title().catch(() => ""), current: id === this.currentTab });
    }
    return out;
  }

  get current(): string | undefined {
    return this.currentTab;
  }

  /** タブを引く。省略ならいま選んでいるタブ */
  page(tab?: string): { id: string; page: Page } {
    const id = tab ?? this.currentTab;
    if (id === undefined) throw new BrowserError("開いているタブがありません（browserOpen でページを開いてください）");
    const page = this.pages.get(id);
    if (!page) throw new BrowserError(`タブ ${id} はありません（browserTabs の list で開いているタブを見られます）`);
    return { id, page };
  }

  async newTab(): Promise<{ id: string; page: Page }> {
    const context = await this.ensure();
    const page = await context.newPage();
    const id = await this.register(page);
    this.currentTab = id;
    this.emit();
    return { id, page };
  }

  /** いま選んでいるタブ。1つも無ければ開く */
  async currentOrNew(): Promise<{ id: string; page: Page }> {
    if (this.currentTab !== undefined && this.pages.has(this.currentTab)) return this.page();
    return this.newTab();
  }

  select(tab: string): void {
    this.page(tab);
    if (this.currentTab === tab) return;
    this.currentTab = tab;
    this.emit();
  }

  async close(tab: string): Promise<void> {
    const { page } = this.page(tab);
    await page.close();
  }
}

function consoleLevel(type: string): ConsoleLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warning";
  if (type === "info") return "info";
  if (type === "debug" || type === "trace") return "debug";
  return "log";
}
