// **Module の置き場に残す状態**：設定（使われなければ止めるまでの時間・ブラウザの言語と時刻の地域）と「AI に触らせない」。
// プロファイルと同じく、止めても起こし直しても残る（v4-modules.md §4.1「人と AI の同時操作」）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BrowserState {
  /** AI の呼び出しが無いままこれだけたったら止める（分。30 は仮——v4-modules.md §4.1） */
  idleMinutes: number;
  /** 人が「AI に触らせない」を入れている */
  aiBlocked: boolean;
  /** ブラウザの言語（BCP 47。Accept-Language・navigator.languages・Intl。identity.ts）。次に起こしたときから効く */
  locale: string;
  /** ブラウザの時刻の地域（IANA）。次に起こしたときから効く */
  timezone: string;
}

export const DEFAULT_STATE: BrowserState = { idleMinutes: 30, aiBlocked: false, locale: "ja-JP", timezone: "Asia/Tokyo" };

/** 言語として読めるか。読めなければ理由を返す */
export function checkLocale(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0) return "locale は文字列（ja-JP の形）です";
  try {
    if (Intl.getCanonicalLocales(v)[0] !== v) return `locale は ${Intl.getCanonicalLocales(v)[0]} の形で書きます（${JSON.stringify(v)} が来ました）`;
  } catch {
    return `locale が言語の名前として読めません（ja-JP の形）: ${JSON.stringify(v)}`;
  }
  return undefined;
}

/** 時刻の地域として読めるか。読めなければ理由を返す */
export function checkTimezone(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0) return "timezone は文字列（Asia/Tokyo の形）です";
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
  } catch {
    return `timezone が時刻の地域として読めません（Asia/Tokyo の形）: ${JSON.stringify(v)}`;
  }
  return undefined;
}

export class StateFile {
  private state: BrowserState;

  constructor(private readonly path: string) {
    this.state = { ...DEFAULT_STATE };
    if (existsSync(path)) {
      // 壊れていたら止める（規則2）——黙って既定に戻すと「AI に触らせない」が切れる
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BrowserState>;
      if (raw.idleMinutes !== undefined) {
        if (typeof raw.idleMinutes !== "number" || raw.idleMinutes <= 0) throw new Error(`${path}: idleMinutes が正の数ではありません`);
        this.state.idleMinutes = raw.idleMinutes;
      }
      if (raw.aiBlocked !== undefined) {
        if (typeof raw.aiBlocked !== "boolean") throw new Error(`${path}: aiBlocked が true / false ではありません`);
        this.state.aiBlocked = raw.aiBlocked;
      }
      if (raw.locale !== undefined) {
        const why = checkLocale(raw.locale);
        if (why) throw new Error(`${path}: ${why}`);
        this.state.locale = raw.locale;
      }
      if (raw.timezone !== undefined) {
        const why = checkTimezone(raw.timezone);
        if (why) throw new Error(`${path}: ${why}`);
        this.state.timezone = raw.timezone;
      }
    }
  }

  get(): BrowserState {
    return { ...this.state };
  }

  set(patch: Partial<BrowserState>): BrowserState {
    this.state = { ...this.state, ...patch };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
    return this.get();
  }
}
