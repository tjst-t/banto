// **Repositories のアカウントのための GitHub**（追加・2026-10-02、v4-modules.md §2.4「アカウント」）。
//
// **本物の GitHub を叩かない**（規則6）——デバイスフローは人が github.com で許可するまで進まない。中身は Module の
// 単体試験と同じ偽物（`packages/modules/repositories` の `test-fakes`。デバイスフロー・更新・`GET /user` を本物と同じ
// 話し方で返す）を使う——同じ偽物を2つ書かない（規則3）。
//
// core と同じプロセスで立て（`start-core.ts`）、行き先は env で Module に渡す。spec は別のプロセスなので、偽物の
// 振る舞いを替えるときは置き場のファイルに書いた URL の口（`/__fake/state`）を叩く。
import { readFileSync, writeFileSync } from "node:fs";
import { GITHUB_LOGIN_FIXTURE_FILE } from "./config.ts";
import { FAKE_CLIENT_ID, startFakeGithub } from "../packages/modules/repositories/dist/test-fakes.js";

/** 貼る PAT と、その持ち主 */
export const E2E_GITHUB_PAT = "ghp_e2e_pasted_pat_9Zq";
export const E2E_GITHUB_PAT_LOGIN = "e2e-pat-user";
/** ブラウザでログインして許可したときに誰になるか */
export const E2E_GITHUB_DEVICE_LOGIN = "e2e-device-user";
export const E2E_GITHUB_CLIENT_ID = FAKE_CLIENT_ID;

export async function startGithubLoginFixture(): Promise<{ web: string; api: string }> {
  const gh = await startFakeGithub();
  gh.users.set(E2E_GITHUB_PAT, E2E_GITHUB_PAT_LOGIN);
  gh.loginForDevice = E2E_GITHUB_DEVICE_LOGIN;
  gh.script = ["pending", "authorized"];
  writeFileSync(GITHUB_LOGIN_FIXTURE_FILE, JSON.stringify(gh.endpoints));
  return gh.endpoints;
}

/** 偽物の振る舞いを替える（spec から）。返すのは、これまでに更新を頼まれた回数 */
export async function setGithubLoginFixture(patch: {
  script?: string[];
  accessTokenTtl?: number | null;
  refreshError?: string | null;
  /** リポジトリを作る（1コミット入り。非公開なら readers の login だけが読める） */
  addRepo?: { owner: string; name: string; private?: boolean; readers?: string[] };
  /** Organization を作る（メンバーの login → 役割、メンバーがリポジトリを作れるか） */
  addOrg?: { login: string; members: Record<string, "admin" | "member">; membersCanCreate: boolean };
  /** そのリポジトリ（`owner/name`）への push を断る・断るのをやめる（push の失敗の試験） */
  rejectPush?: { repo: string; on: boolean };
  /** その login の GitHub App のインストールを差し替える（null で既定——自分に Administration・Contents が書けるもの——に戻す） */
  installations?: { login: string; list: Array<{ account: string; administration?: "read" | "write"; contents?: "read" | "write" }> | null };
}): Promise<{ refreshCalls: number; created: Array<{ owner: string; name: string; private: boolean; description?: string; by: string }> }> {
  const { web } = JSON.parse(readFileSync(GITHUB_LOGIN_FIXTURE_FILE, "utf8")) as { web: string };
  const res = await fetch(`${web}/__fake/state`, { method: "POST", body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`偽の GitHub が振る舞いの変更を断りました（${res.status}）`);
  return (await res.json()) as { refreshCalls: number; created: Array<{ owner: string; name: string; private: boolean; description?: string; by: string }> };
}
