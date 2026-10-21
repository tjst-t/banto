// 今あるフォルダをリポジトリにする（docs/specs/v4-modules.md §2.4「core との境目」、Backlog #502）。
//
// core の「Project にする」の画面（チャットを Project にする、v4-frontend.md §6.53）が、Module の名乗った画面
// （`_meta["dev.banto/canvas"] = "folder-adopter"`）を枠の中に出す。画面で人が「GitHub に上げる」「手元だけ」を選び、
// core の画面で押したら、ここで**そのフォルダの場所のまま**リポジトリにする：
//
// - git でないフォルダ：`git init`（ブランチ名は新しいリポジトリと同じ決め方）→ 中身を最初のコミットに → 台帳に足す。
//   コミットで失敗したら、作ったばかりの `.git` を消して元に戻す（半分だけリポジトリになったフォルダを残さない）
// - **上のリポジトリの中にあるが、上のリポジトリがその中を何も追っていないフォルダ**：入れ子のリポジトリとして、
//   git でないフォルダと同じに git init する（2026-10-21、レビュー）。チャットの置き場 `~/banto/chats/…` は、`~/banto`
//   そのものがリポジトリ（banto を clone した場所）のことがあり、そこで断ると「Project にする」で「今の場所のまま」を
//   選んだとき必ず失敗する。上のリポジトリには「追っていないフォルダ」として見えるだけで、上の履歴は変えない
// - もう git のリポジトリの一番上：台帳に足すだけ（コミットはしない——人の作業の途中を勝手にコミットしない）
// - もう台帳にある：何もしない（そう返す）
// - それ以外（上のリポジトリが中のファイルを追っているフォルダ・worktree・bare 等）は断る
//
// GitHub に上げるのは、このあと画面が今の公開の口（`start_publish`）で続ける——判断は1箇所（`publish.ts`）。

import { realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configuredDefaultBranch, gitCommitAll, gitInit, readFolder, tracksUnder, type FolderFacts } from "./git.js";
import type { LedgerStore } from "./ledger.js";
import { displayPath, resolveUserPath } from "./paths.js";
import { assignAccount, describeRefusal, newEntry, place, type Place } from "./repositories.js";

/** 最初のコミットの件名 */
export const FIRST_COMMIT_MESSAGE = "Initial commit";

export interface AdoptInspection extends Place {
  /**
   * `init`：git でない——git init して中身を最初のコミットにし、台帳に足す。`import`：git のリポジトリの一番上——
   * 台帳に足すだけ。`known`：もう台帳にある。断るときは無く、`refusal` に理由
   */
  state?: "init" | "import" | "known";
  refusal?: string;
  /** もう origin が GitHub を指している（GitHub には上げられない——もうある） */
  github?: { owner: string; name: string };
  /** origin が GitHub の外を指している（GitHub には上げない） */
  elsewhere?: string;
  /** 上のリポジトリの中にある（`init` は、その中の入れ子のリポジトリとして作る）——上のリポジトリの一番上の見せる形 */
  nestedIn?: string;
}

export interface AdoptResult extends Place {
  /** git init したか */
  initialized: boolean;
  /** 最初のコミットを作ったか（中身が無ければ作らない） */
  committed: boolean;
  /** 前から台帳にあった（何もしていない） */
  alreadyListed: boolean;
  /** いまのブランチ（init したときは決めた名前） */
  branch?: string;
}

function remoteOf(facts: Extract<FolderFacts, { kind: "repo" }>): Pick<AdoptInspection, "github" | "elsewhere"> {
  if (facts.remote.kind === "github") return { github: { owner: facts.remote.owner, name: facts.remote.name } };
  if (facts.remote.kind === "elsewhere") return { elsewhere: facts.remote.url };
  return {};
}

/**
 * git init してよいフォルダか。git でない——よい。上のリポジトリの中——上がその中を何も追っていなければよい
 * （入れ子のリポジトリにする）。それ以外は断る理由
 */
async function initPlan(path: string, facts: FolderFacts, home: string): Promise<{ init: true; nestedIn?: string } | { init: false; refusal?: string }> {
  if (facts.kind === "not-git") return { init: true };
  if (facts.kind !== "inside") return { init: false };
  // readFolder の top は realpath——比べる側も realpath に
  if (await tracksUnder(facts.top, await realpath(path))) {
    return {
      init: false,
      refusal: `${displayPath(facts.top, home)} のリポジトリが、このフォルダの中のファイルを追っています（入れ子のリポジトリにすると、同じファイルを2つのリポジトリが追うことになります）`,
    };
  }
  return { init: true, nestedIn: facts.top };
}

export class FolderAdopter {
  /** いまリポジトリにしているフォルダ（同じフォルダを2回同時に git init しない） */
  private readonly busy = new Set<string>();

  constructor(
    private readonly store: LedgerStore,
    private readonly home: string = homedir(),
  ) {}

  /** そのフォルダをリポジトリにすると何が起きるか。**読めなかったら投げる**（「git でない」と取り違えない、規則2） */
  async inspect(input: string): Promise<AdoptInspection> {
    const resolved = resolveUserPath(input, this.home);
    const facts = await readFolder(resolved);
    if (facts.kind !== "repo") {
      const plan = await initPlan(resolved, facts, this.home);
      if (plan.init) return { ...place(resolved, this.home), state: "init", ...(plan.nestedIn ? { nestedIn: displayPath(plan.nestedIn, this.home) } : {}) };
      return { ...place(resolved, this.home), refusal: plan.refusal ?? describeRefusal(facts, this.home) };
    }
    const known = (await this.store.entries()).some((e) => e.path === facts.path);
    return { ...place(facts.path, this.home), state: known ? "known" : "import", ...remoteOf(facts) };
  }

  /** リポジトリにする。**画面の判断を信じず、ここで読み直す** */
  async adopt(input: string): Promise<AdoptResult> {
    const resolved = resolveUserPath(input, this.home);
    if (this.busy.has(resolved)) throw new Error(`${displayPath(resolved, this.home)} は、いまリポジトリにしています`);
    this.busy.add(resolved);
    try {
      let facts = await readFolder(resolved);
      let initialized = false;
      let committed = false;
      let branch: string | undefined;
      const plan = facts.kind === "repo" ? { init: false as const } : await initPlan(resolved, facts, this.home);
      if (plan.init) {
        branch = (await configuredDefaultBranch(resolved)) ?? "main";
        await gitInit(resolved, branch);
        initialized = true;
        try {
          committed = await gitCommitAll(resolved, FIRST_COMMIT_MESSAGE);
        } catch (err) {
          // 作ったばかりの .git だけを消す（中のファイルには触らない）。消せなければ、それも言う
          await rm(join(resolved, ".git"), { recursive: true, force: true }).catch((rmErr: Error) => {
            throw new Error(`${(err as Error).message}（作りかけの .git も消せませんでした：${rmErr.message}）`);
          });
          throw err;
        }
        facts = await readFolder(resolved);
        if (facts.kind !== "repo") throw new Error(`git init したフォルダが読めません（${facts.kind}）`);
      }
      if (facts.kind !== "repo") {
        const why = "refusal" in plan && plan.refusal ? plan.refusal : describeRefusal(facts, this.home);
        throw new Error(`${displayPath(resolved, this.home)} はリポジトリにできません（${why}）`);
      }
      const repo = facts;
      const accounts = await this.store.accounts();
      const alreadyListed = await this.store.update((entries) => {
        if (entries.some((e) => e.path === repo.path)) return { entries, result: true };
        return { entries: [...entries, assignAccount(newEntry(repo), accounts)], result: false };
      });
      return {
        ...place(repo.path, this.home),
        initialized,
        committed,
        alreadyListed,
        ...((branch ?? repo.branch) ? { branch: branch ?? repo.branch } : {}),
      };
    } finally {
      this.busy.delete(resolved);
    }
  }
}
