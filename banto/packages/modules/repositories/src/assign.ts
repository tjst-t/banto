// 「読むだけ」の行にアカウントを後から指定する（docs/specs/v4-modules.md §2.4、段階4・ユーザー決定）。
//
// 行の「…」から、登録したアカウントを選んで台帳に書く。以後そのアカウントで扱う（clone し直し・後の公開）。
// 選ぶ前に、そのアカウントでそのリポジトリが**見えるか・書けるか**を GitHub に聞く（`GET /repos/{owner}/{repo}` の
// permissions）：
// - **見えない**（404）——**断る**。そのアカウントでは clone し直すこともできず、指定しても使えない（選び間違いの
//   ことが多い）。理由（そのアカウントからは見えない）と、次の手（見えるアカウントを選ぶ）を返す
// - **見えるが書けない**——**指定はできる**（clone し直しには使える）。書けないことを返し、画面がそう言う（公開・push は
//   できない）
// - **確かめられない**（GitHub が答えない・トークンが更新できない）——**断る**。確かめずに書くと「使えるはず」の嘘になる
// 「読むだけに戻す」も選べる——台帳に印（`readOnly`）を残し、持ち主と同じ login のアカウントがあっても自動では付け直さない

import type { GithubAccounts } from "./accounts.js";
import type { GithubApi } from "./github.js";
import type { LedgerStore } from "./ledger.js";

export type AccountAssignment =
  | { login: string; push: boolean }
  /** 読むだけに戻した */
  | { login: null };

export async function setRepositoryAccount(
  deps: { store: LedgerStore; accounts: GithubAccounts; github: GithubApi },
  input: { path: string; login: string | null },
  callId?: string,
): Promise<AccountAssignment> {
  const entry = (await deps.store.entries()).find((e) => e.path === input.path);
  if (!entry) throw new Error(`${input.path} は一覧にありません`);
  if (!entry.github) throw new Error("GitHub のリポジトリではないので、アカウントは使いません");
  const location = entry.github;
  if (input.login === null) {
    await deps.store.update((entries) => ({
      entries: entries.map((e) => {
        if (e.path !== input.path) return e;
        const { account: _a, ...rest } = e;
        return { ...rest, readOnly: true as const };
      }),
      result: undefined,
    }));
    return { login: null };
  }
  const account = (await deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === input.login!.toLowerCase());
  if (!account) throw new Error(`@${input.login} は登録されていません`);
  let access;
  try {
    const token = await deps.accounts.tokenFor(account.login, callId);
    access = await deps.github.repoAccess(token, location.owner, location.name);
  } catch (err) {
    throw new Error(`@${account.login} で ${location.owner}/${location.name} が読めるかを確かめられなかったので、指定していません：${(err as Error).message}`);
  }
  if (!access.visible) {
    throw new Error(
      `@${account.login} からは ${location.owner}/${location.name} が見えません（非公開で権限が無いか、GitHub App がそのリポジトリに入っていない）。見えるアカウントを選んでください`,
    );
  }
  await deps.store.update((entries) => ({
    entries: entries.map((e) => {
      if (e.path !== input.path) return e;
      const { readOnly: _r, ...rest } = e;
      return { ...rest, account: account.login };
    }),
    result: undefined,
  }));
  return { login: account.login, push: access.push };
}
