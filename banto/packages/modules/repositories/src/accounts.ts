// GitHub のアカウント（docs/specs/v4-modules.md §2.4「アカウント」、段階2）。
//
// アカウント＝**名前（GitHub の login）・API の資格情報・SSH 鍵**。名前は打たせない——資格情報で `GET /user` を
// 引いて確かめた login を名前にする（打った名前と資格情報の持ち主が食い違う、が起きない）。
//
// API の資格情報は2通り：
// - **PAT**：人が画面で貼る→Vault に預ける（`github-<login>-pat`、種別 secret）。または Vault に既にある alias を選ぶ
// - **ブラウザでログイン**：GitHub App のデバイスフロー。得たトークンの組を Vault に置く（`oauth-github-<login>`、
//   種別 `oauth-token`——MCP の OAuth のログイン情報と同じ置き方：1つの alias に JSON でまとめ、banto が置き換える）。
//   **8時間で切れるので、使う直前に期限を見て refresh token で取り直す**（refresh token も回るので置き換える）。
//   同じアカウントの更新は**1本ずつ**——GitHub の refresh token は1回使うと無効になるので、2本が同時に同じ鍵で
//   更新すると片方が負け、置き換えの順によっては使えない鍵が Vault に残る。更新に失敗したら受信箱に1件出す
//
// **秘密の値は返り値・記録・ログに出さない**——画面に返すのは login と alias の在りかだけ。値を持つのは
// 呼び出しの間のメモリだけ（`tokenFor` の返り値は、この Module の中で GitHub を呼ぶためのもの。道具では返さない）。
//
// Vault の口はどれも**人の画面からの呼び出しの中で**呼ぶ（呼び出しの印 `callId` を必ず添える）。デバイスフローの
// 待ちも、画面が `pollLogin` を呼ぶ形にした——背景で待って Vault に書くと、人の画面の外の呼び出しになり、
// 中継の承認に掛かる（聞く会話も無い）。

import { randomUUID } from "node:crypto";
import type { GithubApi, TokenSet } from "./github.js";
import type { AccountCredential, GithubAccount, LedgerStore } from "./ledger.js";
import type { NoticeSink } from "./relay-client.js";
import type { AliasEntry, AliasPlace, VaultAccess } from "./vault.js";

/** 期限のこれだけ前から、使う前に取り直す（使っている途中で切れないように） */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** Vault に置くトークンの組の形の印（読むときに確かめる） */
const STORED_FORMAT = "github-app-user-token/1";

export interface AccountView {
  login: string;
  credential: { kind: "pat"; alias: AliasPlace } | { kind: "app"; alias: AliasPlace; clientId: string };
  ssh?: AliasPlace;
  refreshFailure?: { at: string; message: string };
}

export interface LoginStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  /** ms（epoch） */
  expiresAt: number;
  interval: number;
}

export type LoginPoll =
  | { state: "pending"; expiresAt: number }
  | { state: "expired" }
  | { state: "denied" }
  /** 待っている間に、人が「やめる」を押した——許可されていても、受け取ったものは捨てた */
  | { state: "cancelled" }
  | { state: "done"; account: AccountView; relogin: boolean };

export interface CredentialChoices {
  /** PAT に選べるもの（種別 secret） */
  secrets: AliasEntry[];
  /** SSH 鍵に選べるもの（種別 ssh-identity） */
  sshKeys: AliasEntry[];
  failures: Array<{ implementation: string; error: string }>;
}

export interface AccountsDeps {
  store: LedgerStore;
  vault: VaultAccess;
  github: GithubApi;
  notices: NoticeSink;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface LoginFlow {
  clientId: string;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  ssh?: AliasPlace;
  /** 同じログインを2つの画面が同時に待っても、GitHub に聞くのは1本ずつ */
  queue: Promise<unknown>;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const patAliasFor = (login: string) => `github-${login.toLowerCase()}-pat`;
export const appAliasFor = (login: string) => `oauth-github-${login.toLowerCase()}`;

function view(a: GithubAccount): AccountView {
  return {
    login: a.login,
    credential: a.credential,
    ...(a.ssh ? { ssh: a.ssh } : {}),
    ...(a.refreshFailure ? { refreshFailure: a.refreshFailure } : {}),
  };
}

function storedTokens(raw: string, login: string): TokenSet {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }
  // **読めないものを「無い」にしない**（規則2）——直す手がかりが消える
  if (body.format !== STORED_FORMAT || typeof body.accessToken !== "string") {
    throw new Error(`@${login} のログイン情報が読めません（Vault の ${appAliasFor(login)} が壊れています）。もう一度ログインしてください`);
  }
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const expiresAt = num(body.expiresAt);
  const refreshTokenExpiresAt = num(body.refreshTokenExpiresAt);
  return {
    accessToken: body.accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(typeof body.refreshToken === "string" ? { refreshToken: body.refreshToken } : {}),
    ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
  };
}

const serialize = (t: TokenSet) => JSON.stringify({ format: STORED_FORMAT, ...t });

function samePlace(a: AliasPlace, b: AliasPlace): boolean {
  return a.implementation === b.implementation && a.name === b.name && (a.group ?? "") === (b.group ?? "");
}

/** 画面から来た在りか。形だけ確かめる（あるか・種別は Vault の目録で確かめる） */
export function parsePlaceArg(raw: unknown, what: string): AliasPlace {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || typeof r.implementation !== "string" || typeof r.name !== "string" || r.name === "") {
    throw new Error(`${what}の在りかが読めません`);
  }
  if (r.group !== undefined && typeof r.group !== "string") throw new Error(`${what}の置き場が読めません`);
  return { implementation: r.implementation, name: r.name, ...(typeof r.group === "string" ? { group: r.group } : {}) };
}

export class GithubAccounts {
  private readonly flows = new Map<string, LoginFlow>();
  private readonly refreshing = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: AccountsDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async list(): Promise<{ accounts: AccountView[]; appClientId?: string }> {
    const [accounts, settings] = await Promise.all([this.deps.store.accounts(), this.deps.store.settings()]);
    return { accounts: accounts.map(view), ...(settings.githubAppClientId ? { appClientId: settings.githubAppClientId } : {}) };
  }

  /** 登録の画面で選べる alias（値は通らない） */
  async credentialChoices(callId?: string): Promise<CredentialChoices> {
    const { aliases, failures } = await this.deps.vault.listAliases(callId);
    return {
      secrets: aliases.filter((a) => a.kind === "secret"),
      sshKeys: aliases.filter((a) => a.kind === "ssh-identity"),
      failures,
    };
  }

  /** GitHub App の client ID（秘密ではない）。`null` で消す */
  async setAppClientId(input: string | null): Promise<{ appClientId?: string }> {
    if (input === null) {
      await this.deps.store.updateSettings({ githubAppClientId: undefined });
      return {};
    }
    const value = input.trim();
    // GitHub App の client ID は `Iv1.…`・`Iv23…` のような英数字（App ID の数字だけとは違う）
    if (!/^[A-Za-z0-9._-]{8,}$/.test(value)) {
      throw new Error("client ID の形が違います（GitHub App の設定の「Client ID」を写してください。App ID の数字ではありません）");
    }
    await this.deps.store.updateSettings({ githubAppClientId: value });
    return { appClientId: value };
  }

  private async assertSshKey(ssh: AliasPlace | undefined, callId?: string): Promise<void> {
    if (!ssh) return;
    const { aliases } = await this.deps.vault.listAliases(callId);
    const found = aliases.find((a) => samePlace(a, ssh));
    if (!found) throw new Error(`SSH 鍵 ${ssh.name} が Vault にありません`);
    if (found.kind !== "ssh-identity") throw new Error(`${ssh.name} は SSH 鍵ではありません（${found.kind}）`);
  }

  private async assertNew(login: string): Promise<void> {
    const existing = (await this.deps.store.accounts()).find((a) => sameLogin(a.login, login));
    if (existing) throw new Error(`@${existing.login} は、もう登録してあります`);
  }

  /** 保存する（**書く直前にもう一度ぶつかりを見る**——同時に2つ登録されても2件にしない） */
  private save(account: GithubAccount, replace: boolean): Promise<GithubAccount> {
    return this.deps.store.updateAccounts((accounts) => {
      const at = accounts.findIndex((a) => sameLogin(a.login, account.login));
      if (at >= 0 && !replace) throw new Error(`@${accounts[at]!.login} は、もう登録してあります`);
      const next = at >= 0 ? accounts.map((a, i) => (i === at ? account : a)) : [...accounts, account];
      return { accounts: next, result: account };
    });
  }

  /**
   * PAT で登録する。貼った値（`pat`）か、Vault に既にある alias（`patAlias`）。**先に `GET /user` で確かめる**
   * ——通らない PAT は Vault に預けない
   */
  async addWithPat(input: { pat?: string; patAlias?: AliasPlace; ssh?: AliasPlace }, callId?: string): Promise<AccountView> {
    const pasted = input.pat?.trim();
    if (!pasted && !input.patAlias) throw new Error("PAT を貼るか、Vault の alias を選んでください");
    await this.assertSshKey(input.ssh, callId);
    const token = pasted ?? (await this.deps.vault.resolve(input.patAlias!, callId));
    const user = await this.deps.github.currentUser(token).catch((err: Error) => {
      throw new Error(`この PAT では GitHub に入れませんでした：${err.message}`);
    });
    await this.assertNew(user.login);
    let alias: AliasPlace;
    if (pasted) {
      try {
        alias = await this.deps.vault.createSecret(
          { name: patAliasFor(user.login), value: pasted, note: `GitHub @${user.login} の PAT（Repositories のアカウント）` },
          callId,
        );
      } catch (err) {
        throw new Error(`Vault に預けられませんでした：${(err as Error).message}`);
      }
    } else alias = input.patAlias!;
    const saved = await this.save({ login: user.login, credential: { kind: "pat", alias }, ...(input.ssh ? { ssh: input.ssh } : {}) }, false);
    return view(saved);
  }

  // ── ブラウザでログイン（デバイスフロー） ─────────────────────────────────────

  /** 始める——GitHub にコードをもらう。**画面に返すのはコードと開く URL だけ**（device_code はここに残す） */
  async startLogin(input: { ssh?: AliasPlace }, callId?: string): Promise<LoginStart> {
    const { githubAppClientId: clientId } = await this.deps.store.settings();
    if (!clientId) throw new Error("GitHub App の client ID が設定されていません");
    await this.assertSshKey(input.ssh, callId);
    const code = await this.deps.github.requestDeviceCode(clientId);
    const now = this.now();
    // 終わったもの・切れたものは片づける（画面を閉じて放置されたもの）
    for (const [id, f] of this.flows) if (f.expiresAt <= now) this.flows.delete(id);
    const flowId = randomUUID();
    const flow: LoginFlow = {
      clientId,
      deviceCode: code.deviceCode,
      expiresAt: now + code.expiresIn * 1000,
      interval: code.interval,
      nextPollAt: now + code.interval * 1000,
      ...(input.ssh ? { ssh: input.ssh } : {}),
      queue: Promise.resolve(),
    };
    this.flows.set(flowId, flow);
    return { flowId, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: flow.expiresAt, interval: code.interval };
  }

  cancelLogin(flowId: string): void {
    this.flows.delete(flowId);
  }

  /**
   * 1回だけ GitHub に聞く。**interval より早くは聞かない**——早く呼ばれたら、その時刻まで待ってから聞く
   * （`slow_down` を受けたら間隔を延ばす）。許可されたら、login を確かめて Vault に置き、アカウントにする
   */
  pollLogin(flowId: string, callId?: string): Promise<LoginPoll> {
    const flow = this.flows.get(flowId);
    if (!flow) return Promise.reject(new Error("このログインはもう終わっています。もう一度始めてください"));
    const run = flow.queue.then(async (): Promise<LoginPoll> => {
      if (!this.flows.has(flowId)) throw new Error("このログインはもう終わっています。もう一度始めてください");
      const wait = flow.nextPollAt - this.now();
      if (wait > 0) await this.sleep(wait);
      // **待っている間にやめられた**——起きたあとで GitHub に聞かない
      if (!this.flows.has(flowId)) return { state: "cancelled" };
      if (this.now() >= flow.expiresAt) {
        this.flows.delete(flowId);
        return { state: "expired" };
      }
      let r;
      try {
        r = await this.deps.github.pollDeviceToken(flow.clientId, flow.deviceCode);
      } catch (err) {
        this.flows.delete(flowId);
        throw err;
      }
      flow.nextPollAt = this.now() + flow.interval * 1000;
      switch (r.kind) {
        case "pending":
          return { state: "pending", expiresAt: flow.expiresAt };
        case "slow-down":
          // GitHub が返す新しい間隔に従う（返さなければ5秒延ばす——RFC 8628 §3.5）
          flow.interval = r.interval > flow.interval ? r.interval : flow.interval + 5;
          flow.nextPollAt = this.now() + flow.interval * 1000;
          return { state: "pending", expiresAt: flow.expiresAt };
        case "expired":
          this.flows.delete(flowId);
          return { state: "expired" };
        case "denied":
          this.flows.delete(flowId);
          return { state: "denied" };
        case "authorized":
          // **聞いている間にやめられた**——許可されていても、受け取ったトークンは Vault に置かずに捨てる
          if (!this.flows.has(flowId)) return { state: "cancelled" };
          this.flows.delete(flowId);
          try {
            return await this.finishLogin(r.tokens, flow, callId);
          } catch (err) {
            // GitHub はもうトークンを出している——保存していないことと、取り消し方を言う（宙に浮いたままにしない）
            throw new Error(
              `${(err as Error).message}（このログインは banto に保存していません。GitHub が出したトークンは、github.com の ` +
                "Settings → Applications → Authorized GitHub Apps から取り消せます）",
            );
          }
      }
    });
    flow.queue = run.catch(() => undefined);
    return run;
  }

  private async finishLogin(tokens: TokenSet, flow: LoginFlow, callId?: string): Promise<LoginPoll> {
    const user = await this.deps.github.currentUser(tokens.accessToken).catch((err: Error) => {
      throw new Error(`ログインはできましたが、GitHub がユーザーを返しませんでした：${err.message}`);
    });
    const existing = (await this.deps.store.accounts()).find((a) => sameLogin(a.login, user.login));
    if (existing && existing.credential.kind !== "app") {
      throw new Error(`@${existing.login} は PAT で登録してあります。ブラウザでログインに替えるなら、先にそのアカウントを外してください`);
    }
    // **もう一度ログインしたら、前の置き場を置き換える**（更新に失敗したアカウントを直す道）
    const alias = await this.serial(user.login, () =>
      this.deps.vault.putOwned(
        { name: appAliasFor(user.login), value: serialize(tokens), note: `GitHub @${user.login} のログイン（Repositories がブラウザでログインして受け取ったもの）` },
        existing?.credential.alias,
        callId,
      ),
    );
    const ssh = flow.ssh ?? existing?.ssh;
    const saved = await this.save(
      { login: user.login, credential: { kind: "app", alias, clientId: flow.clientId }, ...(ssh ? { ssh } : {}) },
      existing !== undefined,
    );
    return { state: "done", account: view(saved), relogin: existing !== undefined };
  }

  // ── 外す ─────────────────────────────────────────────────────────────────

  /**
   * 登録を外す。**ブラウザでログインしたものは Vault のログイン情報も消す**（banto が置いた秘密——消すのがログアウト）。
   * **PAT は消さない**——人が預けた秘密で、ほかでも使っているかもしれない。消すなら Vault の画面で
   */
  async remove(login: string, callId?: string): Promise<{ removed: AccountView; loginRemoved: boolean }> {
    const account = (await this.deps.store.accounts()).find((a) => sameLogin(a.login, login));
    if (!account) throw new Error(`@${login} は登録されていません`);
    let loginRemoved = false;
    if (account.credential.kind === "app") {
      const alias = account.credential.alias;
      await this.serial(account.login, async () => {
        // 先に Vault の画面で消していれば、もう無い——無いものを消そうとして止まらない（あるかは目録で見る）。
        // **その Vault が読めていないなら「無い」と言えない**——外すのを断る（ログイン情報を残したまま登録だけ消さない）
        const { aliases, failures } = await this.deps.vault.listAliases(callId);
        const unreadable = failures.find((f) => f.implementation === alias.implementation);
        if (unreadable) throw new Error(`Vault（${unreadable.implementation}）が読めないので外せません：${unreadable.error}`);
        if (!aliases.some((a) => samePlace(a, alias))) return;
        await this.deps.vault.remove(alias, callId);
        loginRemoved = true;
      });
    }
    await this.deps.store.updateAccounts((accounts) => ({
      accounts: accounts.filter((a) => !sameLogin(a.login, account.login)),
      result: undefined,
    }));
    return { removed: view(account), loginRemoved };
  }

  // ── 使えるトークン（段階3以降の clone・作成・公開が使う。道具では返さない） ────────────────

  /** 同じアカウントのトークンを触る仕事は1本ずつ（更新が2本走らないように） */
  private serial<T>(login: string, fn: () => Promise<T>): Promise<T> {
    const key = login.toLowerCase();
    const run = (this.refreshing.get(key) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => undefined);
    this.refreshing.set(key, settled);
    void settled.then(() => {
      if (this.refreshing.get(key) === settled) this.refreshing.delete(key);
    });
    return run;
  }

  /**
   * **このアカウントで今使えるトークン**。PAT はそのまま。ブラウザでログインしたものは、期限が近ければ取り直してから返す
   * （取り直した組は Vault の同じ置き場に置き換える）。更新に失敗したら、アカウントに記録し、受信箱に1件出して、投げる
   */
  async tokenFor(login: string, callId?: string): Promise<string> {
    const account = (await this.deps.store.accounts()).find((a) => sameLogin(a.login, login));
    if (!account) throw new Error(`@${login} は登録されていません`);
    const credential = account.credential;
    if (credential.kind === "pat") return this.deps.vault.resolve(credential.alias, callId);
    return this.serial(account.login, async () => {
      const stored = storedTokens(await this.deps.vault.resolve(credential.alias, callId), account.login);
      if (stored.expiresAt === undefined || stored.expiresAt - this.now() > REFRESH_MARGIN_MS) return stored.accessToken;
      let next: TokenSet;
      try {
        next = await this.refresh(credential, stored, callId);
      } catch (err) {
        let message = (err as Error).message;
        try {
          await this.refreshFailed(account.login, message);
        } catch (noticeErr) {
          // 知らせられなかったことも黙らない——更新の失敗と一緒に言う
          message = `${message}（受信箱にも出せませんでした：${(noticeErr as Error).message}）`;
        }
        throw new Error(`@${account.login} のログインを更新できませんでした：${message}`);
      }
      if (account.refreshFailure) await this.setRefreshFailure(account.login, undefined);
      return next.accessToken;
    });
  }

  private async refresh(credential: Extract<AccountCredential, { kind: "app" }>, stored: TokenSet, callId?: string): Promise<TokenSet> {
    if (!stored.refreshToken) throw new Error("更新の鍵（refresh token）がありません。もう一度ログインしてください");
    if (stored.refreshTokenExpiresAt !== undefined && stored.refreshTokenExpiresAt <= this.now()) {
      throw new Error("更新の鍵（refresh token）の期限が切れています。もう一度ログインしてください");
    }
    const next = await this.deps.github.refresh(credential.clientId, stored.refreshToken);
    try {
      await this.deps.vault.putOwned(
        { name: credential.alias.name, value: serialize(next), note: "Repositories が更新したログイン" },
        credential.alias,
        callId,
      );
    } catch (err) {
      // GitHub はもう前の鍵を無効にしている——ここで落ちると、Vault に残るのは使えない鍵。そのまま言う（規則2）
      throw new Error(`GitHub からは新しいトークンを受け取りましたが、Vault に置けませんでした（${(err as Error).message}）。もう一度ログインしてください`);
    }
    return next;
  }

  private setRefreshFailure(login: string, failure: GithubAccount["refreshFailure"]): Promise<void> {
    return this.deps.store.updateAccounts((accounts) => {
      const at = accounts.findIndex((a) => sameLogin(a.login, login));
      if (at < 0) return { accounts, result: undefined };
      const { refreshFailure: _old, ...rest } = accounts[at]!;
      const next: GithubAccount = failure ? { ...rest, refreshFailure: failure } : rest;
      return { accounts: accounts.map((a, i) => (i === at ? next : a)), result: undefined };
    });
  }

  private async refreshFailed(login: string, message: string): Promise<void> {
    await this.setRefreshFailure(login, { at: new Date(this.now()).toISOString(), message });
    await this.deps.notices.raiseNotice({
      key: `github-refresh:${login.toLowerCase()}`,
      title: `GitHub @${login} のログインを更新できませんでした`,
      detail: `${message}——banto 全体の設定の Repositories で、もう一度「ブラウザでログイン」してください`,
    });
  }

  /** 確かめる——今使えるトークンで `GET /user` を引き、登録した login と同じかを見る（更新も通る） */
  async verify(login: string, callId?: string): Promise<{ login: string }> {
    const token = await this.tokenFor(login, callId);
    const user = await this.deps.github.currentUser(token);
    if (!sameLogin(user.login, login)) {
      throw new Error(`この資格情報は @${user.login} のものです（登録は @${login}）。外して登録し直してください`);
    }
    return { login: user.login };
  }
}
