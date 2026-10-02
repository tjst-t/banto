// Repositories の台帳（docs/specs/v4-modules.md §2.4）——知っているリポジトリと、Module の設定。
//
// 置き場は Module のデータ置き場（host が渡す `BANTO_MODULE_DATA_DIR`）の JSON 2つ。
// **台帳が覚えるのは置き場所と、リモートの場所だけ**（GitHub なら owner/name、外は URL）。リモートの場所は
// フォルダの origin の写しで、**写しを持つ理由は「元（フォルダ）が消えうる」こと**（規則3 の例外、§2.4）
// ——フォルダが消えても clone し直せるように。食い違ったら origin を正として直す（`syncWithOrigin`）。
// ブランチ・コミット・worktree はフォルダから読む（写さない）。
//
// **扱うアカウント**（GitHub の login）も台帳が覚える（§2.4、段階2で足した）。origin の持ち主と登録したアカウントの
// login が一致したときに書く（Import・一覧）。覚えるのは login で、アカウントの登録を外しても消さない——同じ login を
// 登録し直せば、また繋がる。
//
// 同じ置き場に、**登録した GitHub のアカウント**（`accounts.json`）と Module の設定（`settings.json`）も置く。
// アカウントが持つのは Vault の alias の在りかだけ——**秘密の値はここに書かない**（Vault が持つ）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sameGithubLocation, type GithubLocation } from "./remote.js";
import type { FolderFacts } from "./git.js";
import type { AliasPlace } from "./vault.js";

export interface LedgerEntry {
  /** 置き場所（realpath）。一覧の中で一意 */
  path: string;
  /** GitHub の場所。GitHub に無ければ無し */
  github?: GithubLocation;
  /** GitHub の外（gitlab 等）の origin の URL */
  elsewhere?: string;
  /** origin に合わせて GitHub の場所を直したとき、それまで覚えていた場所（一覧で一度だけ言う。見たら消す） */
  correctedFrom?: GithubLocation;
  /** 扱うアカウント（GitHub の login）。登録が外れていても消さない */
  account?: string;
}

export interface RepositoriesSettings {
  /** clone・新しく作るときの置き場。無ければ既定（`DEFAULT_REPO_HOME`）。人が打った形（`~/…`）のまま */
  repoHome?: string;
  /** ブラウザでログインに使う GitHub App の client ID（秘密ではない。人が GitHub App を作って写す） */
  githubAppClientId?: string;
}

/**
 * API の資格情報。どちらも **Vault の alias の在りか**だけを持つ
 * - `pat`：人が貼った（か選んだ）PAT
 * - `app`：ブラウザでログイン（GitHub App のデバイスフロー）で得たトークンの組。banto が置く秘密（種別 `oauth-token`）
 *   で、更新で置き換わる。**更新はそのトークンを出した App の client ID でしかできない**ので、client ID も一緒に覚える
 *   （設定の client ID を変えても、前の App で入ったアカウントは前の App で更新する）
 */
export type AccountCredential = { kind: "pat"; alias: AliasPlace } | { kind: "app"; alias: AliasPlace; clientId: string };

export interface GithubAccount {
  /** GitHub の login（`GET /user` で確かめたもの）。アカウントの名前で、一覧の中で一意（大文字小文字を区別しない） */
  login: string;
  credential: AccountCredential;
  /** SSH 鍵（Vault の alias）。無ければ HTTPS で clone・push する */
  ssh?: AliasPlace;
  /** 最後の更新が失敗した（もう一度ログインするか、更新が通るまで残す——画面で言う） */
  refreshFailure?: { at: string; message: string };
}

/** 既定の置き場（2026-09-30、ユーザー決定。ghq 形式はやめた） */
export const DEFAULT_REPO_HOME = "~/banto";

const LEDGER_FILE = "ledger.json";
const SETTINGS_FILE = "settings.json";
const ACCOUNTS_FILE = "accounts.json";

/**
 * フォルダの origin に合わせて台帳の1行を直す。**フォルダが読めない（無い・git でない等）間は直さない**
 * ——台帳の値だけが手がかりなので。直したかどうかは `changed` で返す（書き戻すかを呼ぶ側が決める）
 */
export function syncWithOrigin(entry: LedgerEntry, facts: FolderFacts): { entry: LedgerEntry; changed: boolean } {
  if (facts.kind !== "repo") return { entry, changed: false };
  const github = facts.remote.kind === "github" ? { owner: facts.remote.owner, name: facts.remote.name } : undefined;
  const elsewhere = facts.remote.kind === "elsewhere" ? facts.remote.url : undefined;
  let next: LedgerEntry = entry;
  if (!sameGithubLocation(github, entry.github)) {
    const { github: _old, ...rest } = next;
    // **覚えていた場所が変わったときだけ**お知らせを残す。覚えていなかったものを覚えるのは知らせない
    next = { ...rest, ...(github ? { github } : {}), ...(entry.github ? { correctedFrom: entry.github } : {}) };
  } else if (github && (github.owner !== entry.github?.owner || github.name !== entry.github?.name)) {
    // 大文字小文字だけの違いは、知らせずに origin の書き方に合わせる
    next = { ...next, github };
  }
  if (next.elsewhere !== elsewhere) {
    const { elsewhere: _old, ...rest } = next;
    next = { ...rest, ...(elsewhere ? { elsewhere } : {}) };
  }
  return { entry: next, changed: next !== entry };
}

function isLocation(v: unknown): v is GithubLocation {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as GithubLocation).owner === "string" &&
    typeof (v as GithubLocation).name === "string"
  );
}

/** 台帳の1行として読めるか。**読めないものを黙って落とさない**——呼ぶ側が理由つきで止まる */
export function parseLedgerEntry(raw: unknown, where: string): LedgerEntry {
  const r = raw as Record<string, unknown>;
  if (typeof r !== "object" || r === null || typeof r.path !== "string" || !r.path.startsWith("/")) {
    throw new Error(`${where}：置き場所（絶対パス）がありません`);
  }
  if (r.github !== undefined && !isLocation(r.github)) throw new Error(`${where}：GitHub の場所が読めません`);
  if (r.elsewhere !== undefined && typeof r.elsewhere !== "string") throw new Error(`${where}：リモートの URL が読めません`);
  if (r.correctedFrom !== undefined && !isLocation(r.correctedFrom)) throw new Error(`${where}：直す前の場所が読めません`);
  if (r.account !== undefined && (typeof r.account !== "string" || r.account === "")) throw new Error(`${where}：アカウントが読めません`);
  return {
    path: r.path,
    ...(r.github ? { github: { owner: (r.github as GithubLocation).owner, name: (r.github as GithubLocation).name } } : {}),
    ...(typeof r.elsewhere === "string" ? { elsewhere: r.elsewhere } : {}),
    ...(r.correctedFrom
      ? { correctedFrom: { owner: (r.correctedFrom as GithubLocation).owner, name: (r.correctedFrom as GithubLocation).name } }
      : {}),
    ...(typeof r.account === "string" ? { account: r.account } : {}),
  };
}

function parsePlace(raw: unknown, where: string): AliasPlace {
  const r = raw as Record<string, unknown>;
  if (typeof r !== "object" || r === null || typeof r.implementation !== "string" || typeof r.name !== "string") {
    throw new Error(`${where}：Vault の在りかが読めません`);
  }
  if (r.group !== undefined && typeof r.group !== "string") throw new Error(`${where}：Vault の置き場が読めません`);
  return { implementation: r.implementation, name: r.name, ...(typeof r.group === "string" ? { group: r.group } : {}) };
}

/** 登録したアカウントの1件として読めるか。読めないものを黙って落とさない */
export function parseAccount(raw: unknown, where: string): GithubAccount {
  const r = raw as Record<string, unknown>;
  if (typeof r !== "object" || r === null || typeof r.login !== "string" || r.login === "") throw new Error(`${where}：login がありません`);
  const c = r.credential as Record<string, unknown> | undefined;
  let credential: AccountCredential;
  if (c?.kind === "pat") credential = { kind: "pat", alias: parsePlace(c.alias, `${where}の PAT`) };
  else if (c?.kind === "app" && typeof c.clientId === "string" && c.clientId !== "") {
    credential = { kind: "app", alias: parsePlace(c.alias, `${where}のログイン`), clientId: c.clientId };
  } else throw new Error(`${where}：API の資格情報が読めません`);
  const f = r.refreshFailure as Record<string, unknown> | undefined;
  if (f !== undefined && (typeof f?.at !== "string" || typeof f.message !== "string")) throw new Error(`${where}：更新の失敗の記録が読めません`);
  return {
    login: r.login,
    credential,
    ...(r.ssh !== undefined ? { ssh: parsePlace(r.ssh, `${where}の SSH 鍵`) } : {}),
    ...(f ? { refreshFailure: { at: f.at as string, message: f.message as string } } : {}),
  };
}

/**
 * 台帳と設定の置き場。**書き換えは1本ずつ**——画面の操作が重なっても、読んだ後に別の書き換えを上書きしない。
 * 書くときは別名に書いてから置き換える（途中で落ちても壊れた JSON を残さない）
 */
export class LedgerStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private async readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, file), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // 壊れた台帳を「空」と読まない（規則2）——読めたように見せると、次の書き込みで消える
      throw new Error(`台帳（${join(this.dataDir, file)}）を読めませんでした：${(err as Error).message}`);
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = join(this.dataDir, file);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  }

  async entries(): Promise<LedgerEntry[]> {
    const raw = await this.readJson(LEDGER_FILE);
    if (raw === undefined) return [];
    const list = (raw as { repositories?: unknown }).repositories;
    if (!Array.isArray(list)) throw new Error(`台帳（${LEDGER_FILE}）の形が違います`);
    return list.map((e, i) => parseLedgerEntry(e, `台帳の ${i + 1} 行目`));
  }

  /** 台帳を読み、直して、書く。**1本ずつ**走る。`fn` が返した値をそのまま返す */
  update<T>(fn: (entries: LedgerEntry[]) => Promise<{ entries: LedgerEntry[]; result: T }> | { entries: LedgerEntry[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.entries();
      const { entries, result } = await fn(before);
      if (entries !== before) await this.writeJson(LEDGER_FILE, { version: 1, repositories: entries });
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async settings(): Promise<RepositoriesSettings> {
    const raw = (await this.readJson(SETTINGS_FILE)) as { repoHome?: unknown; githubAppClientId?: unknown } | undefined;
    if (raw === undefined) return {};
    if (raw.repoHome !== undefined && typeof raw.repoHome !== "string") throw new Error("設定の置き場が読めません");
    if (raw.githubAppClientId !== undefined && typeof raw.githubAppClientId !== "string") throw new Error("設定の client ID が読めません");
    return {
      ...(raw.repoHome ? { repoHome: raw.repoHome } : {}),
      ...(raw.githubAppClientId ? { githubAppClientId: raw.githubAppClientId } : {}),
    };
  }

  /** 設定の一部を変える（`undefined` の項目は消す）。ほかの項目は今のまま——1本ずつ走る */
  updateSettings(patch: { [K in keyof RepositoriesSettings]?: RepositoriesSettings[K] | undefined }): Promise<RepositoriesSettings> {
    const run = this.queue.then(async () => {
      const next: RepositoriesSettings = { ...(await this.settings()) };
      for (const [k, v] of Object.entries(patch) as Array<[keyof RepositoriesSettings, string | undefined]>) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      await this.writeJson(SETTINGS_FILE, next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async accounts(): Promise<GithubAccount[]> {
    const raw = await this.readJson(ACCOUNTS_FILE);
    if (raw === undefined) return [];
    const list = (raw as { accounts?: unknown }).accounts;
    if (!Array.isArray(list)) throw new Error(`アカウントの一覧（${ACCOUNTS_FILE}）の形が違います`);
    return list.map((a, i) => parseAccount(a, `アカウントの ${i + 1} 件目`));
  }

  /** アカウントの一覧を読み、直して、書く。台帳と同じ列で**1本ずつ**走る */
  updateAccounts<T>(
    fn: (accounts: GithubAccount[]) => Promise<{ accounts: GithubAccount[]; result: T }> | { accounts: GithubAccount[]; result: T },
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.accounts();
      const { accounts, result } = await fn(before);
      if (accounts !== before) await this.writeJson(ACCOUNTS_FILE, { version: 1, accounts });
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
