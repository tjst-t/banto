// **ブラウザ1つ**（Project ごと）。最初の道具の呼び出しで起こし、AI の呼び出しが無いまま決めた時間がたったら止める
// （メモリを返す。v4-modules.md §4.1「形」）。プロファイル（Cookie・localStorage 等）は Module の置き場に置くので、
// 止めても起こし直してもログイン状態は残る（`--user-data-dir`——chrome.ts）。

import { rmSync } from "node:fs";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { BrowserError } from "./args.js";
import { attachRecorder, type CdpLike } from "./cdp-recorder.js";
import type { ConsoleLevel, NetworkLog } from "./network-log.js";
import type { VideoSupport } from "./video.js";

/** ブラウザの音を人の画面へ流せるか。流せるなら PulseAudio の口（chrome.ts・audio.ts） */
export type AudioRoute = { available: true; server: string } | { available: false; reason: string };

export interface SessionDeps {
  profileDir: string;
  log: NetworkLog;
  /**
   * プロファイルの置き場でブラウザを起こす（入っていなければ入れる——install.ts。起こし方は chrome.ts）。最初のタブは設定の
   * 検索エンジンのトップで開く。`blank` なら about:blank（すぐほかの URL へ行く——ensure）
   */
  launch: (profileDir: string, onProgress?: (message: string) => void, blank?: boolean) => Promise<LaunchedBrowser>;
  /** 使われなければ止めるまでの時間（ms）。呼ぶたびに読む——設定を変えたら次から効く */
  idleMs: () => number;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  /** ブラウザの版（ブラウザに聞いたもの） */
  version: string;
  /** 描く倍率（起こしたときに決まり、止めるまで変わらない——chrome.ts） */
  scale: number;
  /** 起こせたが、足りないものがある（日本語の字体が入れられなかった等——fonts.ts）。状態を見る口が返す */
  notice?: string;
  /** 仮想の画面の名前と大きさ（デバイスピクセル）。動画の取り込みが使う（chrome.ts・video.ts） */
  display?: string;
  screen?: { width: number; height: number };
  /** 人の画面を動画で流せるか（GStreamer があるか——video.ts の ensureVideo） */
  video?: VideoSupport;
  /** 人の画面に音を流せるか（PulseAudio があり、立ったか——audio.ts の ensureAudio・chrome.ts） */
  audio?: AudioRoute;
  /** ブラウザを閉じる（プロセスと仮想の画面も止める） */
  close: () => Promise<void>;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  /** 人の画面が映しているタブ（Project の「いま選んでいるタブ」） */
  current: boolean;
  /** 持ち主の会話（Thread の id）。人のタブ（持ち主なし）は無い */
  owner?: string;
}

/** 起こしたときのページの大きさ（screencast の既定と同じ。AI は browserAct の resize で変える） */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/**
 * **窓の幅の下限**（Google Chrome の窓の最小幅。実測・2026-10-13：400 を指定しても innerWidth は 500）。これより狭いページは
 * 窓を 500 にして、ページの大きさの上書き（`Emulation.setDeviceMetricsOverride`）を併せる——上書きしたページは窓の左上
 * (0,0) から描かれ（390×844 を倍率2で 780×1688、画素単位で一致——実測）、動画はページの大きさだけを取り込む
 * （v4-modules.md §4.1「動画で流す」の穴①）。高さの下限は 100 以下（実測）で、resize の下限と同じなので上書きは要らない
 */
export const MIN_WINDOW_WIDTH = 500;
/** 窓の大きさを変えたあと、ページの innerWidth・innerHeight が新しい値になるまで待つ上限（実測は 40〜110ms） */
const SETTLE_TIMEOUT_MS = 2_000;
/** 起こしたブラウザの最初のタブが出るまで待つ上限 */
const FIRST_PAGE_TIMEOUT_MS = 10_000;
/** 落ち着いたとみなすまで、同じ大きさが続く時間（途中で通る大きさは 40〜130ms——settle） */
const SETTLE_STABLE_MS = 150;

export class BrowserSession {
  private context: BrowserContext | undefined;
  private launched: LaunchedBrowser | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private readonly pages = new Map<string, Page>();
  /** 登録が終わる（CDP の Network を有効にし終える）まで待てるように、約束で持つ */
  private readonly ids = new WeakMap<Page, Promise<string>>();
  /** タブごとに開いたままの CDP の口（通信の記録と、窓より狭いページの大きさの上書き——setViewport） */
  private readonly cdps = new WeakMap<Page, CDPSession>();
  /** タブの CDP の target の id（そのタブの窓を引く——Browser.getWindowForTarget） */
  private readonly targetIds = new WeakMap<Page, string>();
  /** ページの大きさを上書きしているタブ（窓より狭いページ） */
  private readonly overridden = new WeakSet<Page>();
  /** **ページの大きさ（CSS ピクセル）。ブラウザに1つ**——窓で決めるので、タブごとには持たない（setViewport） */
  private size = { ...DEFAULT_VIEWPORT };
  /** 窓ごとに、合わせ終えた大きさ（`1280x800`）。ポップアップの窓も、できたときに合わせる */
  private readonly placed = new Map<number, string>();
  /** ブラウザ全体の CDP の口（窓の大きさ） */
  private browserCdp: Promise<CDPSession> | undefined;
  /** 窓の大きさを変える操作は1つずつ */
  private windowChain: Promise<void> = Promise.resolve();
  /** 大きさを変えている・窓を足している間の深さ（入れ子になる——会話のタブの窓を足す間に、その窓を合わせる） */
  private resizeDepth = 0;
  /** 窓ごとに、表に出ているタブ（窓の中で選ばれているタブ。裏のタブは写しが撮れない——captureReady） */
  private readonly activeInWindow = new Map<number, string>();
  /**
   * 大きさを変える前に呼ぶ（人の画面が動画の取り込みを止め終えるまで待つ——変えている間の絵を流さないため。view-stream.ts が置く）
   */
  beforeResize: (() => Promise<void>) | undefined;
  /** **人の画面の**「いま選んでいるタブ」（会話の印の無い呼び出しもこれに効く）。会話ごとのいまのタブは threadTabs */
  private currentTab: string | undefined;
  /**
   * **タブの持ち主の会話**（Thread の id。v4-modules.md §4.1「タブは会話ごと」）。人が開いたタブは入れない（持ち主なし）。
   * ブラウザを起こし直すとタブは残らない（最初のタブの1枚から起きる）ので、持ち主も止めるときに捨てる
   */
  private readonly owners = new Map<string, string>();
  /** 会話ごとの「いまのタブ」（タブを省いた操作が効く——その会話が最後に使った自分のタブか、select で選んだタブ） */
  private readonly threadTabs = new Map<string, string>();
  /** CDP の target の id → タブの id（ポップアップの開いた元を引く・会話が開いたタブを待つ） */
  private readonly tabByTarget = new Map<string, string>();
  /** 会話が開いている途中のタブ（target の id → 持ち主）。登録の前に持ち主を決めておく */
  private readonly pendingOwners = new Map<string, string>();
  /** 起こしている会話（起こした最初のタブの持ち主。人の画面・会話の印の無い呼び出しが起こしたなら無い） */
  private starter: string | undefined;
  /**
   * 起こし終えたブラウザ（最初のタブの窓を合わせ終えるまでは undefined——running・ensure はこれを見る）。context は繋いだ
   * 時点で置く（最初のタブの登録が使う）が、窓を合わせ終える前に AI が開く・撮る・人の画面が映すと、ページの大きさが
   * 1280×712（枠つきの normal）や 1920×1080（大きさを指定する前の全画面）になる
   */
  private ready: BrowserContext | undefined;
  private frontTab: string | undefined;
  private nextTab = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 止めた理由（最後に止まったとき）。状態を見る口が返す */
  lastStop: { at: string; reason: string } | undefined;
  /** 人の画面が開いている数。開いている間は使われていなくても止めない（v4-modules.md §4.1「起こす・止める」） */
  private holds = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {}

  /** 動いているブラウザの版（ブラウザに聞いたもの。動いていなければ undefined） */
  get browserVersion(): string | undefined {
    return this.context ? this.launched?.version : undefined;
  }

  get running(): boolean {
    return this.ready !== undefined;
  }

  /** 動いているブラウザの注意（起こしたときに足りなかったもの。動いていなければ undefined） */
  get notice(): string | undefined {
    return this.context ? this.launched?.notice : undefined;
  }

  /** 動いているブラウザの仮想の画面（名前・デバイスピクセルの大きさ）と、動画・音を流せるか（動いていなければ undefined） */
  get display(): { name: string; screen: { width: number; height: number }; video: VideoSupport; audio: AudioRoute } | undefined {
    const l = this.launched;
    if (!this.context || !l?.display || !l.screen) return undefined;
    return {
      name: l.display,
      screen: l.screen,
      video: l.video ?? { available: false, reason: "動画で流せるかを確かめていません" },
      audio: l.audio ?? { available: false, reason: "音を流せるかを確かめていません" },
    };
  }

  /** 動いているブラウザの描く倍率（動いていなければ undefined） */
  get scale(): number | undefined {
    return this.context ? this.launched?.scale : undefined;
  }

  /**
   * **ページの大きさ（CSS ピクセル）を変える**——ブラウザに1つ（全部のタブ・窓）。**窓で決める**（v4-modules.md §4.1「動画で流す」(a)）：
   * 窓をキオスク形の全画面にしたまま大きさを変えるには、`Browser.setWindowBounds` で「normal にする → 大きさを指定 →
   * fullscreen に戻す」の3手が要る（fullscreen のまま大きさだけは変えられない）。これでページの innerWidth×倍率と、Xvfb の
   * (0,0) から取り込んだ絵が画素単位で一致する。**`Emulation.setDeviceMetricsOverride` だけで変えない**——窓の中に模擬した
   * viewport を描くので、画面を取り込むとページと絵が食い違う。窓より狭いページ（幅 500 未満）と端数の倍率だけ上書きを併せる
   * （MIN_WINDOW_WIDTH・applyOverride）。
   * 上書きの deviceScaleFactor は 0（上書きしない）——起こした倍率（chrome.ts）がそのままページの devicePixelRatio になる。
   * **Playwright の setViewportSize は使わない**（deviceScaleFactor を 1 に上書きし、倍率2のページから 1 に見えることがあった——
   * 実測・2026-10-11）。変え終えたら、いま選んでいるタブの innerWidth・innerHeight が新しい値になるまで待ってから返す
   */
  async setViewport(size: { width: number; height: number }): Promise<void> {
    if (!this.context) throw new BrowserError("ブラウザが動いていません");
    const run = this.windowChain.then(() =>
      this.whileResizing(async () => {
        this.size = { width: size.width, height: size.height };
        for (const page of this.pages.values()) await this.fitWindow(page);
        for (const page of this.pages.values()) await this.applyOverride(page);
        await this.frontCurrent();
        const current = this.currentTab !== undefined ? this.pages.get(this.currentTab) : undefined;
        if (current) await this.settle(current);
      }),
    );
    this.windowChain = run.catch(() => undefined);
    await run;
  }

  /** 大きさを変えている・窓を足している間（人の画面は動画を流さない——view-stream.ts） */
  get resizing(): boolean {
    return this.resizeDepth > 0;
  }

  /**
   * 窓の大きさを変える・窓を足す間（3手の途中はタブの帯や画面いっぱいの窓が一瞬映る・足した窓は一度前に出る——v4-modules.md
   * §4.1「動画で流す」(a)・「タブは会話ごと」）。人の画面に動画の取り込みを止めてもらい（beforeResize）、終えたら流し直して
   * もらう（resizing を下ろして知らせる）。入れ子でもよい——一番外が終えるまで下ろさない
   */
  private async whileResizing<T>(work: () => Promise<T>): Promise<T> {
    this.resizeDepth += 1;
    this.emit();
    try {
      await this.beforeResize?.();
      return await work();
    } finally {
      this.resizeDepth -= 1;
      this.emit();
    }
  }

  /** ページの大きさ（CSS ピクセル。ブラウザに1つ——setViewport） */
  viewport(): { width: number; height: number } {
    return { ...this.size };
  }

  private cdpForBrowser(): Promise<CDPSession> {
    const browser = this.context?.browser();
    if (!browser) return Promise.reject(new BrowserError("ブラウザに繋がっていません"));
    this.browserCdp ??= browser.newBrowserCDPSession();
    return this.browserCdp;
  }

  /** そのタブの窓と、いまのページの大きさに合わせた印（`1280x800`）。閉じたタブは undefined */
  private async windowOf(page: Page): Promise<{ windowId: number; key: string; width: number } | undefined> {
    const targetId = this.targetIds.get(page);
    if (!targetId || page.isClosed()) return undefined;
    const cdp = await this.cdpForBrowser();
    const { windowId } = (await cdp.send("Browser.getWindowForTarget", { targetId })) as { windowId: number };
    const width = Math.max(MIN_WINDOW_WIDTH, this.size.width);
    return { windowId, key: `${width}x${this.size.height}`, width };
  }

  /** そのタブの窓がまだ合わせていない（新しい窓——起こした最初のタブ・ポップアップ）か */
  private async unplaced(page: Page): Promise<boolean> {
    const w = await this.windowOf(page);
    return w !== undefined && this.placed.get(w.windowId) !== w.key;
  }

  /** そのタブの窓を、いまのページの大きさ（窓の下限まで）の全画面にする。合わせ終えた窓は飛ばす */
  private async fitWindow(page: Page): Promise<void> {
    const w = await this.windowOf(page);
    if (!w || this.placed.get(w.windowId) === w.key) return;
    const { windowId, key, width } = w;
    const cdp = await this.cdpForBrowser();
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width, height: this.size.height } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
    this.placed.set(windowId, key);
  }

  /**
   * 窓より狭いページと、**端数の倍率**（1.25・1.5・1.75）のページは大きさを上書きする（そうでなければ外す）。端数の倍率では、
   * 窓の大きさ（CSS ピクセル）を Chrome が画素に丸めるので、ページは指定より 1〜2 だけ大きくなる——1.5 で 843×641 は 844×642、
   * 1.75 では画素の整数になる 1280×800 でも 1280×801（実測・2026-10-16）。窓はページ以上の大きさになるので、上書きした
   * ページは窓の左上 (0,0) から指定どおりの大きさで描かれる。上書きしないと、settle が待ちきれず（1回 2 秒）その間動画を
   * 流せず、取り込む範囲もページと食い違った（Backlog #359）
   */
  private async applyOverride(page: Page): Promise<void> {
    const cdp = this.cdps.get(page);
    if (!cdp || page.isClosed()) return;
    if (this.size.width < MIN_WINDOW_WIDTH || !Number.isInteger(this.launched?.scale ?? 1)) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: this.size.width, height: this.size.height, deviceScaleFactor: 0, mobile: false });
      this.overridden.add(page);
    } else if (this.overridden.has(page)) {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      this.overridden.delete(page);
    }
  }

  /** いま選んでいるタブを前に出す（画面に映るのは前にある窓のタブ——動画はそれを取り込む） */
  private async frontCurrent(): Promise<void> {
    const id = this.currentTab;
    const page = id !== undefined ? this.pages.get(id) : undefined;
    if (!page || page.isClosed()) return;
    await page.bringToFront();
    await this.markActive(id!, page);
    if (this.frontTab !== id) {
      this.frontTab = id;
      this.emit();
    }
  }

  /** そのタブが、窓の中で表に出ているタブになった */
  private async markActive(id: string, page: Page): Promise<void> {
    const w = await this.windowOf(page).catch(() => undefined);
    if (w) this.activeInWindow.set(w.windowId, id);
  }

  /**
   * **写しを撮れるようにする**（browserScreenshot の前）。窓の中で裏にあるタブは Chrome が描かない——写しは1回目が返らず
   * （時間切れ）、2回目からは裏に回った時点の古い絵が返る（実測・2026-10-14）。会話のタブは窓を分けているので表に出ているが、
   * ページから開いた新しいタブ（_blank）は開いた元と同じ窓に入り、どちらか一方だけが表に出る。裏なら、人の画面の動画を
   * 止めている間にそのタブを表に出してから、人の画面のタブを前に出し直す。**人の画面が映しているタブと同じ窓の裏**なら、
   * 表に出すと人の画面が替わるので、理由を返して断る
   */
  async captureReady(id: string): Promise<void> {
    const { page } = this.page(id);
    const w = await this.windowOf(page);
    if (!w || this.activeInWindow.get(w.windowId) === id) return;
    const current = this.currentTab !== undefined ? this.pages.get(this.currentTab) : undefined;
    if (current && this.currentTab !== id && (await this.windowOf(current))?.windowId === w.windowId) {
      throw new BrowserError(
        `タブ ${id} は人の画面が映しているタブ（${this.currentTab}）と同じ窓の裏にあるので、写しを撮れません（表に出すと人の画面が替わります）。` +
          "中身は browserSnapshot で読めます",
      );
    }
    await this.onWindows("写すタブを表に出せませんでした", () =>
      this.whileResizing(async () => {
        await page.bringToFront();
        await this.markActive(id, page);
        await this.frontCurrent();
      }),
    );
  }

  /**
   * 前に出し終えたタブ（仮想の画面に映っているタブ）。**選んだ直後はまだ前のタブが映っている**——動画の絵の頭はこちらで書く
   * （選んだタブの名前で前のタブの絵を送らない）。選んでいるタブ（current）とは前に出し終えるまでの間だけ違う
   */
  get front(): string | undefined {
    return this.context ? this.frontTab : undefined;
  }

  /**
   * タブの innerWidth・innerHeight が、いまのページの大きさに**落ち着く**まで待つ。来なければ理由を残して進む。
   * 1度合っただけでは返さない——3手の途中（normal で大きさを指定した直後）に一度合い、全画面に戻る間に画面いっぱいの
   * 大きさを通ってから戻ることがある（実測・2026-10-13：5回中3回、1920×1080・500×552・1280×712 を 40〜130ms 通った）
   */
  private async settle(page: Page): Promise<void> {
    const want = `${this.size.width}x${this.size.height}`;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let last = "";
    let since: number | undefined;
    while (Date.now() < deadline && !page.isClosed()) {
      // Playwright の evaluate で読む（できたばかりのタブ・読み込み中のタブでも、読める文脈ができるまで待つ。CDP の
      // Runtime.evaluate を直に送ると、できたばかりのタブで 2 秒返らなかった——実測・2026-10-13）
      last = await Promise.race([
        page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("（500ms 返らない）"), 500)),
      ]).catch((err: Error) => `（読めない：${err.message.split("\n")[0]}）`);
      if (last !== want) since = undefined;
      else if (since === undefined) since = Date.now();
      else if (Date.now() - since >= SETTLE_STABLE_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (page.isClosed()) return; // 待つ間にタブが閉じた——合わせる相手がもう無い
    console.error(`[browser] ページの大きさが ${want} になりませんでした（${last}）`);
  }

  /** 窓の操作を順に流す（大きさの変更と、新しいタブの窓合わせが混ざらないように）。失敗は理由を残す */
  private onWindows(what: string, work: () => Promise<void>): Promise<void> {
    const run = this.windowChain.then(work).catch((err: Error) => console.error(`[browser] ${what}: ${err.message}`));
    this.windowChain = run;
    return run;
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

  /** そのタブに戻る先（delta -1）・進む先（+1）があるか。Playwright の goBack は、戻る・進むのキャッシュから戻すと応答が無く、戻る先が無いときと見分けられない */
  async canGo(page: Page, delta: -1 | 1): Promise<boolean> {
    const cdp = await this.newCdp(page);
    try {
      const h = (await cdp.send("Page.getNavigationHistory")) as { currentIndex: number; entries: unknown[] };
      const next = h.currentIndex + delta;
      return next >= 0 && next < h.entries.length;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * 起きていなければ起こす。同時に呼ばれても1回だけ。`thread` は起こした会話——**起こした最初のタブはその会話のもの**
   * （会話が起こしたブラウザの最初のタブを人のタブとして残し、会話は裏に新しいタブを開く、にしない）。最初のタブは設定の
   * 検索エンジンのトップで開く（読み込みは待たない——起動の引数。chrome.ts）。`blank` は最初のタブをすぐほかの URL へ移す
   * 呼び出し（browserOpen）——about:blank で開く（検索エンジンを読み込んですぐ捨てない）。同時に呼ばれたら起こし始めた呼び出しのもの
   */
  async ensure(onProgress?: (message: string) => void, thread?: string, blank = false): Promise<BrowserContext> {
    if (this.ready) return this.ready;
    if (!this.starting) this.starter = thread;
    this.starting ??= this.start(onProgress, blank).finally(() => {
      this.starting = undefined;
      this.starter = undefined;
    });
    return this.starting;
  }

  private async start(onProgress: ((message: string) => void) | undefined, blank: boolean): Promise<BrowserContext> {
    const launched = await this.deps.launch(this.deps.profileDir, onProgress, blank);
    const context = launched.context;
    this.launched = launched;
    // タブの id は**止めて起こし直しても続きから**振る——通信とコンソールの記録はタブの id を持って残るので、t1 から
    // 振り直すと前に起こしたときの t1 と混ざる（listNetwork の tab で絞ったとき）。Module ごと起こし直したときも記録の続きから
    this.nextTab = Math.max(this.nextTab, this.deps.log.maxTabNumber() + 1);
    this.context = context;
    const gone = () => {
      // ブラウザが落ちた・止めた——次の呼び出しで起こし直す
      if (this.context === context) this.forget();
    };
    context.on("close", gone);
    context.browser()?.on("disconnected", gone);
    context.on("page", (page) => {
      // 開いてすぐ閉じたページは CDP を繋ぐ前に消える——そのタブは記録しないだけ（理由は Module のログに残す）
      this.register(page).catch((err: Error) => console.error(`[browser] タブを繋げませんでした: ${err.message}`));
    });
    // **最初のタブの登録（窓を3手で合わせて落ち着くまで——register）を待ってから起きたことにする**。繋いだ直後は pages() が
    // 空のことがあり、最初のタブは "page" の知らせから登録される——その登録も同じ約束（ids）を待つ
    const first = context.pages()[0] ?? (await this.firstPage(context));
    for (const page of first ? [first, ...context.pages()] : context.pages()) await this.register(page);
    if (this.context !== context) throw new BrowserError("起こしている間にブラウザが終わりました");
    this.ready = context;
    // 起こしたのが人の画面なら AI の呼び出しは無い——ここから数える（画面が開いている間は止めない）
    this.touch();
    this.emit();
    return context;
  }

  /** 起こしたブラウザの最初のタブが出るのを待つ。出なければ理由を残して undefined（タブの無いまま起きる） */
  private firstPage(context: BrowserContext): Promise<Page | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        context.off("page", onPage);
        console.error(`[browser] 起こしたブラウザの最初のタブが ${FIRST_PAGE_TIMEOUT_MS}ms 出ませんでした（タブの無いまま起きます）`);
        resolve(undefined);
      }, FIRST_PAGE_TIMEOUT_MS);
      const onPage = (page: Page) => {
        clearTimeout(timer);
        resolve(page);
      };
      context.once("page", onPage);
    });
  }

  private forget(): void {
    this.context = undefined;
    this.ready = undefined;
    this.pages.clear();
    this.placed.clear();
    this.activeInWindow.clear();
    this.browserCdp = undefined;
    this.size = { ...DEFAULT_VIEWPORT };
    this.currentTab = undefined;
    this.frontTab = undefined;
    this.owners.clear();
    this.threadTabs.clear();
    this.tabByTarget.clear();
    this.pendingOwners.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.deps.log.saveNow();
    this.emit();
  }

  async stop(reason: string): Promise<void> {
    // 起こしている途中なら、起き終わるのを待って止める（起こし損ねたなら止めるものは無い）
    const context = this.context ?? (this.starting ? await this.starting.catch(() => undefined) : undefined);
    if (!context) return;
    const launched = this.launched;
    this.lastStop = { at: new Date().toISOString(), reason };
    this.forget();
    await launched?.close();
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
      this.owners.delete(id);
      // 窓の中で表に出ていたなら、Chrome が隣のタブを表に出す——どれかは分からないので、写す前に表に出し直す（captureReady）
      for (const [windowId, tab] of this.activeInWindow) if (tab === id) this.activeInWindow.delete(windowId);
      // その会話のいまのタブだったら、その会話のほかの自分のタブ（一番新しく開いたもの）に。無ければ次に開く
      for (const [thread, tab] of this.threadTabs) {
        if (tab !== id) continue;
        const rest = [...this.pages.keys()].filter((t) => this.owners.get(t) === thread).at(-1);
        if (rest !== undefined) this.threadTabs.set(thread, rest);
        else this.threadTabs.delete(thread);
      }
      if (this.frontTab === id) this.frontTab = undefined;
      if (this.currentTab === id) {
        this.currentTab = [...this.pages.keys()].at(-1);
        // ブラウザが前に出すタブと、こちらが選び直したタブは違うことがある——選んだほうを前に出す
        void this.onWindows("選んでいるタブを前に出せませんでした", () => this.frontCurrent());
      }
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
    this.cdps.set(page, cdp);
    const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as { targetInfo: { targetId: string; openerId?: string } };
    this.targetIds.set(page, targetInfo.targetId);
    this.tabByTarget.set(targetInfo.targetId, id);
    // 持ち主：会話が開いたタブ（newTab）・起こした会話の最初のタブ・**ページから開いた新しいタブとポップアップは開いた元の
    // タブの持ち主**（noopener の _blank でも target の openerId は残る）。どれでもなければ人のタブ
    const opener = targetInfo.openerId !== undefined ? this.tabByTarget.get(targetInfo.openerId) : undefined;
    const owner =
      this.pendingOwners.get(targetInfo.targetId) ??
      (opener !== undefined ? this.owners.get(opener) : undefined) ??
      (this.ready === undefined && this.starter !== undefined && this.pages.size === 1 ? this.starter : undefined);
    this.pendingOwners.delete(targetInfo.targetId);
    if (owner !== undefined && !page.isClosed()) {
      this.owners.set(id, owner);
      if (!this.threadTabs.has(owner)) this.threadTabs.set(owner, id);
    }
    // Playwright の CDPSession は知らせの名前ごとに型が付く——ここでは名前を文字で受ける形に合わせる
    attachRecorder(log, () => id, cdp as unknown as CdpLike);
    // ページの大きさをいまの大きさにそろえる（人の画面の絵と入力の座標はこの大きさで計る）。**ポップアップと window.open は
    // 別の窓になり、大きさの指定は無視されて URL 帯つきで上に重なる**（実測・2026-10-13）——その窓も同じ3手で全画面・同じ大きさに
    // する。そのうえで、いま選んでいるタブを前に出し直す（新しいタブ・窓はブラウザが前に出す。人の画面が映すのは選んでいるタブ
    // ——v4-modules.md §4.1「動画で流す」の穴②）
    await this.onWindows("新しいタブの窓を合わせられませんでした", async () => {
      // できたタブは、その窓の中で表に出ている（新しい窓・ページから開いた _blank）
      await this.markActive(id, page);
      const fit = async () => {
        await this.fitWindow(page);
        await this.applyOverride(page);
        // 選んでいるタブが無かった（最初のタブ）ならブラウザが前に出している。ほかは選んでいるタブを前に出し直す
        if (this.currentTab !== id) await this.frontCurrent();
        else this.frontTab = id;
      };
      // 新しい窓（起こした最初のタブ・ポップアップ）は3手で合わせる——その間は動画を流さず、落ち着いてから流し直す。
      // 同じ窓の新しいタブ（_blank・＋）は窓がもう合っているので、そのまま
      if (await this.unplaced(page)) {
        await this.whileResizing(async () => {
          await fit();
          await this.settle(page);
        });
      } else await fit();
    });
    // 本文はブラウザの中の入れ物にあるうちに取る——入れ物を大きめにして、取る前に捨てられにくくする
    await cdp.send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
    this.emit();
    return id;
  }

  // ---- タブ ----------------------------------------------------------------------------------

  async listTabs(): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const [id, page] of this.pages) {
      const owner = this.owners.get(id);
      out.push({ id, url: page.url(), title: await page.title().catch(() => ""), current: id === this.currentTab, ...(owner ? { owner } : {}) });
    }
    return out;
  }

  /** 人の画面の「いま選んでいるタブ」 */
  get current(): string | undefined {
    return this.currentTab;
  }

  /** その会話の「いまのタブ」（閉じていれば無い） */
  threadTab(thread: string): string | undefined {
    const id = this.threadTabs.get(thread);
    return id !== undefined && this.pages.has(id) ? id : undefined;
  }

  /** タブの持ち主の会話（人のタブは undefined） */
  ownerOf(tab: string): string | undefined {
    return this.owners.get(tab);
  }

  /**
   * タブを引く。省略なら、会話の呼び出しは**その会話のいまのタブ**、会話の印の無い呼び出し（と人の画面）は人の画面の
   * いま選んでいるタブ
   */
  page(tab?: string, thread?: string): { id: string; page: Page } {
    const id = tab ?? (thread !== undefined ? this.threadTab(thread) : this.currentTab);
    if (id === undefined) {
      throw new BrowserError(
        thread !== undefined
          ? "この会話のタブはまだありません（browserOpen でページを開いてください。ほかのタブは browserTabs の list で見られ、tab で指せます）"
          : "開いているタブがありません（browserOpen でページを開いてください）",
      );
    }
    const page = this.pages.get(id);
    if (!page) throw new BrowserError(`タブ ${id} はありません（browserTabs の list で開いているタブを見られます）`);
    return { id, page };
  }

  /**
   * **ほかの会話のタブへの操作を断る**（理由と持ち主を返す）。人のタブ（持ち主なし）・自分のタブ・会話の印の無い呼び出しは
   * 通す。通したら、自分のタブをその会話の「いまのタブ」にする（タブを省いた次の操作が効く）
   */
  claim(tab: string, thread: string | undefined, what: string): void {
    if (thread === undefined) return;
    const owner = this.owners.get(tab);
    if (owner === undefined) return;
    if (owner !== thread) {
      throw new BrowserError(
        `タブ ${tab} はほかの会話（Thread ${owner.slice(0, 8)}）のタブなので、${what} はできません（タブは会話ごと）。` +
          "読む道具（browserSnapshot・browserScreenshot・listNetwork・getNetworkRequest・browserConsole）は使えます。" +
          "自分で開くなら browserOpen（tab を省くとこの会話のタブ）、自分のタブは browserTabs の list で見られます",
      );
    }
    this.threadTabs.set(thread, tab);
  }

  /** 読んだ——自分のタブなら、その会話の「いまのタブ」にする（ほかのタブは読んでも替えない） */
  used(tab: string, thread: string | undefined): void {
    if (thread !== undefined && this.owners.get(tab) === thread) this.threadTabs.set(thread, tab);
  }

  /**
   * 新しいタブを開く。**会話が開くタブは、その会話のもの**で、**裏に開く**——人の画面の表示を替えない（自分の窓に開き、
   * 人の画面のタブを前に出し直す）。会話の印の無い呼び出しと人の画面は、開いたタブを選んで前に出す（今どおり）。
   * `url` を渡すとそのページで開く（読み込みは待たない——人の画面の＋の検索エンジンのトップ）。無ければ about:blank
   */
  async newTab(thread?: string, url = "about:blank"): Promise<{ id: string; page: Page }> {
    const context = await this.ensure(undefined, thread);
    // **タブごとに窓を分ける**：同じ窓の裏のタブは Chrome が描かず、写しが撮れない（captureReady）。窓は足したときに一度
    // 前に出る（background でも——実測・2026-10-14）ので、足して合わせ終えるまで人の画面の動画を止めておく
    const opened = await this.whileResizing(async () => {
      const cdp = await this.cdpForBrowser();
      const { targetId } = (await cdp.send("Target.createTarget", { url, newWindow: true, background: thread !== undefined })) as {
        targetId: string;
      };
      if (thread !== undefined) {
        const early = this.tabByTarget.get(targetId);
        if (early !== undefined) this.owners.set(early, thread); // 先に登録された（持ち主を決める前）——ここで付ける
        else this.pendingOwners.set(targetId, thread);
      }
      const tab = await this.tabOf(context, targetId);
      if (thread !== undefined) {
        this.owners.set(tab.id, thread);
        this.threadTabs.set(thread, tab.id);
      } else this.currentTab = tab.id;
      // 登録の間はそれまで選んでいたタブを前に出し直している——会話の印の無い呼び出し・人の画面は、開いたタブを前に出す
      // （人の画面が映すのは選んでいるタブ）。会話のタブなら人の画面のタブがそのまま前に残る
      await this.onWindows("開いたタブを前に出せませんでした", () => this.frontCurrent());
      return tab;
    });
    this.emit();
    return opened;
  }

  /** CDP で開いた target のタブが登録し終わるのを待つ */
  private async tabOf(context: BrowserContext, targetId: string): Promise<{ id: string; page: Page }> {
    const deadline = Date.now() + FIRST_PAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
        const registering = this.ids.get(page);
        if (registering && this.targetIds.get(page) === targetId) return { id: await registering, page };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.pendingOwners.delete(targetId);
    throw new BrowserError(`開いたタブが ${FIRST_PAGE_TIMEOUT_MS / 1000} 秒で使えるようになりませんでした`);
  }

  /** いま選んでいるタブ（会話の呼び出しはその会話のいまのタブ）。無ければ開く */
  async currentOrNew(thread?: string): Promise<{ id: string; page: Page }> {
    if (thread !== undefined) {
      const id = this.threadTab(thread);
      return id !== undefined ? this.page(id) : this.newTab(thread);
    }
    if (this.currentTab !== undefined && this.pages.has(this.currentTab)) return this.page();
    return this.newTab();
  }

  /**
   * タブを選ぶ。**会話の呼び出しは、その会話の「いまのタブ」を替えるだけで、人の画面の表示は替えない**（ほかの会話のタブは
   * 断る——claim）。会話の印の無い呼び出しと人の画面は、人の画面のいま選んでいるタブを替える
   */
  select(tab: string, thread?: string): void {
    this.page(tab);
    if (thread !== undefined) {
      this.claim(tab, thread, `browserTabs の select`);
      this.threadTabs.set(thread, tab);
      return;
    }
    if (this.currentTab === tab) return;
    this.currentTab = tab;
    void this.onWindows("選んだタブを前に出せませんでした", () => this.frontCurrent());
    this.emit();
  }

  /**
   * タブを閉じる。**最後のタブなら止める**——画面ありのブラウザは、人のブラウザと同じく最後のタブ（窓）を閉じると自分で
   * 終わる（headless は残った）。終わるのを待たずにこちらから止める（終わりかけのブラウザに次の呼び出しが当たらないように）
   */
  async close(tab: string, thread?: string): Promise<void> {
    const { page } = this.page(tab);
    this.claim(tab, thread, "browserTabs の close");
    if (this.pages.size === 1) {
      await this.stop("最後のタブを閉じたので止めました");
      return;
    }
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
