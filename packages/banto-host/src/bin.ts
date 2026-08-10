#!/usr/bin/env node
/**
 * `banto` CLI（task-0009）。
 *
 *   banto serve            番頭ホストを常駐起動する（WS APIを開く）
 *   banto chat [--url ..]  起動中のホストへ接続し、端末から会話する
 *
 * CLI は WS APIの一クライアントに過ぎない——WebUI も同じAPIにぶら下がる
 * （Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * D5: 判断ロジックを持たない。組み立ては host-session.ts、配信は server.ts。
 * I2: 失敗は握りつぶさず、終了コードとメッセージで返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import { getAgentDir, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  JsonlMemoryStore,
  LlmCatalog,
  MODEL_ALIASES,
  ScopedMemory,
  type PlaceProvider,
  type ResolvedModel,
} from "@banto/core";

import type { WorkerInfo } from "@banto/worker-pool";
import { createKoboModule, defaultKoboUrl } from "@banto/daemon";
import { BANTO_ORIGIN, startWorkerNotices, threadOrigin } from "./worker-notice.js";
import { guardWorkerOrigin } from "./worker-guard.js";
import { startKoboNotices } from "./kobo-notice.js";
import { startEnvNotices } from "./env-notice.js";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { Inbox } from "./inbox.js";
import { createInboxTools } from "./inbox-tools.js";
import { UserThemes } from "./user-themes.js";
import { createBantoHostSession } from "./host-session.js";
import { resumeInterruptedTurn, withEmptyResponseGuard } from "./turn-guard.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createArtifactTools } from "./artifact-tools.js";
import { ArtifactStore } from "./artifacts.js";
import { createLlmChapterSummarizer } from "./chapter-summarizer.js";
import { ChapterKeeper } from "./chapters.js";
import { createHandoffTools } from "./handoff-tools.js";
import { HandoffStore } from "./handoffs.js";
import { applyMemoryDeltas, createLlmMemoryExtractor } from "./memory-extraction.js";
import { createMemoryTools } from "./memory-tools.js";
import {
  LEARNED_ORIGIN,
  LearnedSkillStore,
  detectStaleOverrides,
  renderStaleOverrides,
  type StaleOverride,
} from "./skill-learning.js";
import { CORE_ORIGIN, createModuleRegistry, resolveSkills, type SkillEntry } from "./module.js";
import { createStudioModule } from "./modules/studio.js";
import { createPiAgentModule } from "./modules/pi-agent.js";
import { createLlmTools } from "./llm-tools.js";
import { refreshModelCatalog } from "./model-catalog.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { PlaceGrantStore } from "./place-grants.js";
import { ThreadStore } from "./thread-store.js";
import { SettingsStore } from "./settings-store.js";
import { createCoreSettingsSections } from "./core-settings.js";
import { createSettingsModule, settingsSection } from "./settings-module.js";
import { createRepoManagerModule, createRepoManagerPlaceProvider } from "@banto/repo-manager";
import { createCollectedPlaceProvider } from "@banto/environment-pool";
import {
  createRemoteEnvironmentPoolModule,
  createRemoteWorkerPoolModule,
  defaultEnvironmentPoolUrl,
  defaultWorkerPoolUrl,
} from "./remote-pools.js";
import { workspaceRoot } from "./workspace.js";
import {
  PlaceRegistry,
  broadlyWritable,
  createStaticPlaceProvider,
  ensureDeskDir,
  withDefaultDesk,
  type StaticPlaceConfig,
} from "./places.js";
import { guardPathArg } from "./place-scoped.js";
import { createSkillTools } from "./skill-tools.js";
import { bindToolArgs, createThreadTools } from "./thread-tools.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";
import { Type } from "typebox";
import {
  ThreadRegistry,
  watchStaleBranches,
  type ThreadFactory,
  type ThreadIdentity,
} from "./threads.js";
import { loadBantoSkills } from "./skills.js";

/**
 * 番頭が作業してよい場所の設定（決定36d・38b）。
 *
 * **番頭が書けない場所に置く**のが要点——リポジトリ内の設定に置くと、番頭がそれ自体を
 * 書き換えて自分の権限を広げられる（I1：ずるは不可能にする）。
 *
 * 形式：`BANTO_PLACES=<id>:<path>[:<書ける範囲をカンマ区切り>];...`
 * 例：`banto:/home/me/ghq/github.com/me/banto:docs/**,work/**`
 * 未設定なら、従来どおりワークスペース1つ（読み取り専用）。
 */
function readPlaceConfig(fallbackRoot: string): StaticPlaceConfig[] {
  const raw = process.env["BANTO_PLACES"];
  if (!raw || raw.trim().length === 0) {
    return [{ id: "workspace", label: "ワークスペース", path: fallbackRoot }];
  }
  const places: StaticPlaceConfig[] = [];
  for (const entry of raw.split(";").map((e) => e.trim()).filter((e) => e.length > 0)) {
    const [id, place, writable] = entry.split(":");
    // I2: 壊れた設定を黙って飛ばさない。場所を1つ失うと番頭が黙って別の場所を触りうる
    if (!id || !place) throw new Error(`BANTO_PLACES の項目が不正です: "${entry}"`);
    places.push({
      id,
      label: id,
      path: place,
      ...(writable ? { writable: writable.split(",").map((w) => w.trim()).filter(Boolean) } : {}),
    });
  }
  return places;
}

/**
 * いま効いている静的な場所（設定 > 環境変数）に、既定の書斎を足したもの。
 *
 * **「どれが効いているか」の判断はここ1箇所**。設定画面もこれを映すので、画面と実態が
 * 食い違わない（以前は core-settings 側にも同じ分岐があった）。
 */
function effectiveStaticPlaces(settings: SettingsStore, fallbackRoot: string): StaticPlaceConfig[] {
  const configured = settings.all().places;
  const source = configured && configured.length > 0 ? configured : readPlaceConfig(fallbackRoot);
  return withDefaultDesk(source);
}

/** 書斎の実体が無ければ作る。I2: 作ったときだけ、どこに作ったかを言う。 */
function ensureDesk(settings: SettingsStore, fallbackRoot: string): void {
  const created = ensureDeskDir(effectiveStaticPlaces(settings, fallbackRoot));
  if (created !== undefined) {
    console.log(`[banto] 書斎（成果物の置き場所）を作りました: ${created}`);
  }
}

/** データの置き場所。BANTO_DATA_DIR で差し替えられる。 */
function dataDir(): string {
  return process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto");
}

/**
 * 検証環境サービスのデータ置き場（task-0066）。
 *
 * **回収した成果物を番頭が読めるようにする**ために要る。別プロセスなので導けない——
 * サービスと同じ既定（`BANTO_ENV_POOL_DATA` ?? `<BANTO_DATA_DIR>/environment-pool`）を
 * ここでも組み立てる。配置で変えるなら両方に同じ値を渡すこと。
 */
function envPoolDataDir(): string {
  return process.env["BANTO_ENV_POOL_DATA"] ?? path.join(dataDir(), "environment-pool");
}

/**
 * sessionId から職人を引く（決定63 の砦のため）。
 *
 * 工房が別プロセスになったので、台帳を直に見ずに `worker.list` で聞く。
 * I2: 引けなかったことを「見つからない」にしない——理由を添えて投げる
 * （黙って undefined を返すと、他人の職人を畳めてしまう）。
 */
async function lookupWorker(
  tools: NamespacedToolDefinition[],
  sessionId: string
): Promise<WorkerInfo | undefined> {
  const list = tools.find((t) => t.name === "worker.list");
  if (!list) throw new Error("worker.list が登録されていません（Worker Pool モジュールが未配線）");
  const result = await list.execute({ query: sessionId, includeClosed: true } as never, {
    toolCallId: `worker-lookup-${Date.now()}`,
  });
  const workers = ((result.details ?? {}) as { workers?: WorkerInfo[] }).workers ?? [];
  return workers.find((w) => w.sessionId === sessionId);
}

/**
 * Kobo の帳簿の置き場所（決定63）。番頭には**どの設定でも書かせない**。
 *
 * 別プロセスなので、ここから導けない——Kobo 自身は `BANTO_DATA_DIR` を見るが、既定が
 * 違う（番頭は `./.banto`、Kobo は `./data`）ため当てにすると外す。教えてもらう。
 */
function koboDataDir(): string | undefined {
  const configured = process.env["BANTO_KOBO_DATA_DIR"];
  return configured && configured.trim().length > 0 ? path.resolve(configured) : undefined;
}

/** 人の記憶の置き場所（ADR-0003 第一層。全プロジェクト横断）。 */
function memoryPath(): string {
  return path.join(dataDir(), "memory.jsonl");
}

/**
 * その仕事の記憶の置き場所（ADR-0003 第二層。**横断させない**）。
 *
 * **区画の単位は幹**（PO裁定 2026-08-10）。以前は場所（リポジトリ）で分けていたが、
 * 複数のリポジトリにまたがる仕事も、まだリポジトリの無い相談も持てないので、
 * **場所は「どこに書けるか」、幹は「何についての仕事か」**と切り離した。
 *
 * 幹ごとに別ファイルにする——同じファイルに `scope` で同居させると、絞り込みを
 * 1箇所書き忘れた時点で混ざる。ここでは混ぜようとしても混ざらない。
 *
 * 置き場は**リポジトリの中ではなくホストのデータ置き場**。リポジトリに置くと、
 * 番頭が自分の記憶を書き換えられてしまう（決定38b と同じ理由）。
 */
function trunkMemoryPath(trunkId: string): string {
  return path.join(dataDir(), "trunks", encodeURIComponent(trunkId), "memory.jsonl");
}

/** 場所で分けていた頃の記憶の置き場（読み出し専用。移行の案内に使う）。 */
function legacyPlaceMemoryPath(placeId: string): string {
  return path.join(dataDir(), "projects", encodeURIComponent(placeId), "memory.jsonl");
}

/**
 * 章を閉じる閾値（文脈長に対する割合）。`BANTO_CHAPTER_THRESHOLD` で変えられる。
 *
 * 既定は `DEFAULT_CHAPTER_THRESHOLD_RATIO`（0.6）。低すぎると章が増えて資料のコストが
 * 嵩み、高すぎると閉じる余力が無くなる——そこがコンパクションの失敗そのもの（提案§6 論点2）。
 *
 * I2: 読めない値・範囲外は黙って既定に落とさず知らせる。
 */
function chapterThresholdRatio(): number | undefined {
  const raw = process.env["BANTO_CHAPTER_THRESHOLD"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    console.warn(
      `[banto] BANTO_CHAPTER_THRESHOLD は 0 と 1 の間の割合です（${raw}）。既定を使います`
    );
    return undefined;
  }
  return parsed;
}

/**
 * 章の引き継ぎ資料を書くモデル（決定28：抽出には安いモデルを使う）。
 *
 * `BANTO_CHAPTER_MODEL="provider/model-id"` で会話とは別のモデルを指定できる。
 * **指定が無ければ undefined**——呼び出し側が会話のモデルへ落とす。カタログの
 * 職人向け標準は tier（具体モデルではない）なので、ここでは当てにしない。
 *
 * I2: 指定したのに解決できないときは、黙って会話のモデルへ落とさず知らせる。
 */
function chapterSummarizerModelSpec(): { provider: string; id: string } | undefined {
  const raw = process.env["BANTO_CHAPTER_MODEL"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const at = raw.indexOf("/");
  if (at <= 0 || at === raw.length - 1) {
    console.warn(`[banto] BANTO_CHAPTER_MODEL は "provider/model-id" の形です（${raw}）`);
    return undefined;
  }
  return { provider: raw.slice(0, at), id: raw.slice(at + 1) };
}

/**
 * 陳腐化した学習層について incident を積む（P3・決定26・task-0017 a4）。
 *
 * **ホストのデータ置き場に書く。** リポジトリの `work/inbox/incident/` に書きたくなるが、
 * 番頭はそこへ書けない（決定38b：自分の統制下のファイルを書き換えられないため）。
 * PO が取り込むまでの置き場としてここに残し、ログにパスを出す。
 */
function writeStaleSkillIncident(stale: readonly StaleOverride[]): string {
  const dir = path.join(dataDir(), "incidents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stale-skill-overrides-${stale.length}.md`);
  const body = [
    "---",
    "type: incident",
    "kind: incident",
    "origin: agent",
    "class: bug",
    "status: open",
    "refs: [adr-0010, task-0017]",
    "---",
    "",
    "## 内容",
    "",
    "番頭の学習層（SKILL）が、元にした既定より古くなっている。",
    "このまま使うと、既定側の改良が番頭に届かない（決定26 が名指しした事故）。",
    "",
    renderStaleOverrides(stale),
    "",
    "## どうするか",
    "",
    "既定の変更を読み、学習層を書き直す（`skill.learn`）か、学びが不要になっていれば",
    "捨てる（`skill.unlearn`）。**放置すると静かに劣化し続ける。**",
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

/**
 * ツール出力を退避に回す大きさ（文字数）。`BANTO_ARTIFACT_THRESHOLD` で変えられる。
 *
 * 小さすぎると番頭が毎回 `artifact.read` を叩いて往復が増え、大きすぎると退避が効かない。
 * 既定は banto-host の `DEFAULT_ARTIFACT_THRESHOLD_CHARS`（提案§6 論点4）。
 *
 * I2: 数として読めない値が入っていたら黙って既定に落とさず知らせる。
 */
function artifactThresholdChars(): number | undefined {
  const raw = process.env["BANTO_ARTIFACT_THRESHOLD"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[banto] BANTO_ARTIFACT_THRESHOLD が読めません（${raw}）。既定を使います`);
    return undefined;
  }
  return parsed;
}

/**
 * ユーザーに見せる出力の言語。
 *
 * プロンプト本文は英語で固定し、**言語だけをここで可変にする**。マルチ言語対応は
 * この定数の差し替えで届く範囲から始められる（PO裁定 2026-08-05）。
 */
const RESPONSE_LANGUAGE = "Japanese";

/**
 * 番頭のシステムプロンプト。
 *
 * **本文は英語、出力は RESPONSE_LANGUAGE。** LLMプロバイダ層はプラガブル＝モデル非依存
 * （CLAUDE.md）なので、日本語の指示追従が弱いモデルでも役割が崩れないほうを採る。
 * 出力言語は独立した指示にしてあるので、英語で書いても応答は日本語のままになる。
 *
 * 商家の比喩（店・番頭・職人）は banto の世界観だが、**プロンプトでは比喩に寄りかからない**。
 * vision.md「番頭を『もう一人の人格』として演出することは目的ではない」とも整合する。
 * 役割語は Terms で一度定義してから使い、以降は機構の名前（worker / place / canvas）で書く。
 *
 * 依頼主は "user" と呼ぶ。"PO"（product owner）は本人の心持ちであって製品として定義する
 * ものではない、というPO裁定（2026-08-05）。略語のまま渡すと purchase order とも読める。
 *
 * 会話の名付け（PO要望 2026-08-05）：機構は thread.rename、いつ呼ぶかの判断はここ。
 */
const SYSTEM_PROMPT = `# Role

You are banto, an agent that runs software development work on behalf of the user.
You are not the one who writes the code. Delegate hands-on work — investigation, implementation, review — to workers, and spend your own context on remembering how things got here and on deciding what to do next (D10).

# Language

Write everything the user sees in ${RESPONSE_LANGUAGE}: chat replies, thread names, and any notes or records you write to files.

# Terms

- **user** — the person you are talking to. They own this product and hold final decision authority.
- **worker** — a separate agent process you start with worker.delegate. A worker has no memory, so every piece of context it needs must be written into the instruction you give it.
- **place** — a directory you can work against: a repository, a worktree, or a scratch area. List them with place.list; tools take a \`place\` argument saying which one you mean.
- **canvas** — a display area you can open on the user's screen, for things that are hard to convey in text.

# Memory

Memory is split in two, and **the unit of the second layer is the trunk**.

- \`scope: "person"\` — the user themselves: preferences, habits, standing decisions. Carried into **every** conversation.
- \`scope: "project"\` — this trunk's memory: the decisions, conventions and domain of this one piece of work. It is injected **only into this trunk and its branches**, and never into another trunk. You do not name the trunk — leaving \`trunk\` out means the one you are in.
- A branch shares its parent trunk's memory. What you learn in a branch stays with the work after the branch is folded.
- **When in doubt, project, not person.** Something specific to one job that lands in the person layer skews your judgement on unrelated jobs.
- The injected memory is only this trunk's. To reach across, \`memory.search({ acrossTrunks: true })\` — use it when you suspect "we worked this out somewhere else". If you find something worth keeping here, save it here too.
- What a trunk carries out when it ends is your call (thread.close_trunk). That is how trunk memory becomes person memory.

# Conversations: trunks, branches, and the 帳場

Conversations are not parallel tabs. Each project has one **trunk** that lives on, and short-lived **branches** hang off it.

- **trunk** — one project. It is never folded away by itself, and it is the record of what got decided. Only two lines from a branch ever reach its trunk: the line saying a branch opened, and the line saying what it concluded. **Never replay a branch's contents into the trunk** — that is what makes a trunk readable end to end.
- **branch** — one question that has an end. Open it with thread.open when a topic is going to take repeated back-and-forth. You must say what would bring it back (returnCondition) and why it is not being discussed in the trunk (reason). **If you cannot say what would end it, do not open a branch — talk in the trunk.** Branches are one level deep: you cannot open a branch from inside a branch. Fold it with thread.merge and give the conclusion in one line; "保留：<reason>" is a valid conclusion.
- **帳場** — one special trunk, the only conversation that can never be closed. **It is not a project, and it is not the trunk for developing banto itself.** Anything that does not belong to a specific project lands here: notices with no destination, a request before it has become a project, one-off errands. It always sits first in the user's rail.
- **Starting a new trunk** (thread.open_trunk): the test is whether you would want this work's accumulated memory mixed into an existing trunk's conversations. If you would, it belongs in that trunk. If mixing it would be noise, start a trunk. Repeated back-and-forth alone is a branch, not a trunk.
- **Ending a trunk** (thread.close_trunk): when the project is over. You choose what memory to carry out of it — rewrite anything that still holds elsewhere so it makes sense outside this project. What you do not carry stays with the folded trunk. Open branches must be folded first.
- thread.list shows every open conversation, which one you are in, and what each branch is waiting on.
- Once you know what a conversation is about, name it with thread.rename, and rename it again when the topic moves on. The user picks conversations by name, so a stale name — or "会話 3" — tells them nothing. Keep it short, around 15 characters. Do not rename for a brief digression.

# Showing things: utsuwa inside the conversation, faces for work

- **utsuwa** — a fixed vocabulary of small display forms that sit inside the conversation. Put a tool result into one with canvas.show: you name the utsuwa, the observation id (printed at the end of every tool result as ［観測 a-0007］), and optionally which part of it. **You never resend the data and you never lay out a screen** — the vocabulary is fixed and the core draws it. Use them for the facts the user needs in order to decide.
- **face** — a full view opened with canvas.open, for work that needs width: searching, navigating, comparing. canvas.list_catalog says what can be opened. Opening one leaves a line in the conversation, so the user can return to it later.
- Rule of thumb: **comparing is a face; facts to decide on are an utsuwa.** A list over ten rows, a whole diff, anything the user has to touch — send it to a face.
- If canvas.show reports it could not draw, it tells you what was missing. Pick another utsuwa or send it to a face. The conversation is not blocked.

# Delegating to workers

- Delegate hands-on work — investigation, implementation — with worker.delegate (D10). skill.read gives you worker-delegation, which covers how to write the instruction.
- Reports and questions from workers reach you automatically. **A report is the worker's own claim, not proof that the work is done.** Verify the result yourself when it matters. Answer questions with worker.steer.
- Once you are satisfied, end the worker with worker.close. A worker waiting for an answer stays alive as a process. Closing keeps the record, and worker.wake resumes the original session if you want to continue.

# Files and git

- file.* and git.* let you read the contents and history of a place.
- file.write lets you write your own output — decision records, tickets, notes — but **only within the scope the user has granted for that place**, and every place is read-only by default. If a write is refused, ask for the scope with place.request_write. That posts a decision to the inbox and the user can grant it from a button next to the conversation — you do not need to open any view. Asking alone does not grant it: wait for the notice that says how they answered.
- Work that changes code goes to a worker. Do not write it yourself (D10).
- You do not have git write operations (commit, push, branch). Delegate them to a worker — what gets written stays uncommitted and goes through the user's review.

# Verification

- Run verification with env.verify. The mechanism brings the environment up, runs the command, and always tears it down, so the result counts as **a verified fact** rather than a worker's claim.
- When you want the user to see something with their own eyes, pass ports to env.provision's expose and it returns a url. You do not need this when only a machine has to check. Use env.provision only when the environment must stay up for review, and tear it down with env.teardown when you are done.`;
/**
 * 「いまどの会話に居るか」をシステムプロンプトへ足す（PO報告 2026-08-10）。
 *
 * **帳場を「banto 開発の幹」と取り違えていた**——会話ごとに立場が違うのに、番頭へ渡る
 * プロンプトは全会話で同じだった。`thread.list` で毎ターン確かめさせるのは高くつくので、
 * 器を作るときに一度だけ渡す。
 *
 * 題は後から変わりうる（`thread.rename`）ので「開いたときの名前」として渡す。
 * 変わらないもの（帳場か・幹か枝か・還す条件）が肝心なので、そちらを強く書く。
 */
function describeThread(identity: ThreadIdentity | undefined): string {
  if (!identity) return "";
  const lines: string[] = ["", "# This conversation", ""];
  if (identity.isMain) {
    lines.push(
      `You are in the **帳場** (opened as 「${identity.title}」).`,
      "",
      "This is the one conversation that is never closed, and **it is not a project**.",
      "It is not the trunk for developing banto, and it is not about any single repository.",
      "Anything that has no project of its own arrives here: notices with no destination,",
      "a request before it has become a project, one-off errands.",
      "",
      "When something here grows into work with its own body of memory, start a trunk for it",
      "with thread.open_trunk and continue there. When it does not, just deal with it here.",
      "",
      "**The 帳場 has its own memory partition, and it is a lost-and-found, not a project.**",
      "Anything that turns out to belong to a project should be saved in that project's trunk,",
      "not here."
    );
  } else if (identity.kind === "trunk") {
    lines.push(
      `You are in the trunk of the project 「${identity.title}」.`,
      "",
      "Everything in this conversation is about this project. **This trunk is also the unit",
      "of memory**: what you save with scope \"project\" is injected into this trunk and its",
      "branches, and into no other conversation. If a request turns out to belong to a",
      "different project, say so and point at that trunk instead of answering here.",
      "",
      "This trunk holds the decisions: keep it readable end to end. Work that will take",
      "repeated back-and-forth goes to a branch (thread.open)."
    );
  } else {
    lines.push(
      `You are in the branch 「${identity.title}」` +
        (identity.parentTitle ? `, off the trunk 「${identity.parentTitle}」.` : "."),
      "",
      identity.returnCondition
        ? `It returns when: ${identity.returnCondition}`
        : "No return condition was written for it. Work out what would end it, or fold it.",
      "",
      "**Memory here belongs to the trunk**, not to the branch: what you save with scope",
      "\"project\" stays with 「" + (identity.parentTitle ?? "the trunk") + "」 after this branch is folded.",
      "",
      "Stay on this one question. **You cannot open a branch from here** — if it needs one,",
      "fold this branch back first. When the condition is met, fold it with thread.merge and",
      "give the conclusion in one line; that line is all the trunk will see."
    );
  }
  return lines.join("\n");
}

/**
 * 再起動後に中断していた職人を自動で起こす（task-0050）。
 *
 * banto が `system.restart` や SIGTERM で終了したとき、職人のセッション JSONL は
 * Worker Pool のデータディレクトリに残っている。`WorkerPool.wake()` は元のセッションを
 * 再開し、pi に `--session` を渡して同じ会話から続けられる。
 *
 * 一覧（`WorkerPool.list({ includeClosed: true })`）から `state` が `"closed"` の職人を
 * 全て探し、`wake()` で起こし直す。
 *
 * unsafe な worker（`system.restart` / `reboot` / `systemctl` / 検証用 worktree）を
 * 除外して再有効化（task-0057）。
 */


/**
 * LlmCatalog 用のモデル解決器を作る。
 * pi の ModelRegistry / getModel / getModels を LlmCatalog に渡す。
 *
 * **pi を import してよいのはこの層だけ**（決定3・`banto-core-layering.spec.ts`）。
 * 独立サービスとして立つ工房（Worker Pool）は、pi を持ち込まない解決器
 * （`createFileModelResolver`）を使う——最後の解決は pi の CLI が行うので、
 * provider と id さえ渡れば同じ職人が起きる（task-0066）。
 * 台帳に無いモデルの紐付け（MODEL_ALIASES）は両方が使うので banto-core にある。
 */
function createModelResolver(registry: ModelRegistry) {
  return {
    find(provider: string, modelId: string): ResolvedModel | undefined {
      const alias = MODEL_ALIASES[modelId];
      const actualProvider = alias?.provider ?? provider;
      const actualId = alias?.id ?? modelId;

      const custom = registry.find(actualProvider, actualId);
      if (custom) {
        const m = custom as { provider: string; id: string; name?: string; input?: string[] };
        return { provider: m.provider, id: m.id, name: m.name ?? m.id, input: m.input ?? [] };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const known = getModel(actualProvider as any, actualId as any);
      if (known) {
        return { provider: known.provider, id: known.id, name: known.name ?? known.id, input: known.input ?? [] };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const siblings = getModels(actualProvider as any);
      if (!siblings || siblings.length === 0) return undefined;

      return { ...siblings[0]!, id: actualId, name: modelId };
    },
    getKnownModels(provider: string): Array<{ id: string; name?: string; input?: string[] }> | undefined {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models = getModels(provider as any);
      return models;
    },
  };
}

interface ServeOptions {
  port: number;
  /** 待ち受けるアドレス。既定は localhost のみ（決定40）。 */
  host?: string;
}

async function serve(options: ServeOptions): Promise<void> {
  /**
   * 起動が終わるまでイベントループを掴んでおく（inc-0020）。
   *
   * ドライバ側の根の原因（unref した handle からの応答を待つ）は直したが、
   * ここは**起動中の非同期処理すべて**に効く一般の守り。ref された handle が
   * 何も無い瞬間があると、Node は「やることが無い」と判断して **await の途中で
   * 黙って exit 0 する**——ログにもエラーにも何も残らない。
   *
   * 起動が終わるまでホストが抜けないことを、呼ぶ側の都合に依らず保証する。
   * 待ち受け始めればサーバのソケットがループを保つので、そこで放す。
   */
  const startupKeepAlive = setInterval(() => {}, 1 << 30);

  // task-0047: 保存された設定。**番頭が書けない場所**に置く（決定38b）
  const settings = new SettingsStore(path.join(dataDir(), "settings.json"));

  // 提案§3.2: 章の引き継ぎ資料。会話データとして置く（リポジトリは汚さない）
  const handoffs = new HandoffStore(path.join(dataDir(), "handoffs"));

  /**
   * 場所で分けていた頃の記憶を**黙って捨てない**（I2・PO裁定 2026-08-10）。
   *
   * 区画を場所から幹へ移したので、`projects/<場所>/memory.jsonl` はもう誰も読まない。
   * ここで名指ししておかないと、覚えていたはずのことが理由も分からず消えて見える。
   * **自動で移さない**——どの幹の記憶かは中身を読まないと決まらず、推測で混ぜたら
   * 幹を分けた意味が消えるから。移し先は PO と番頭が決める。
   */
  const warnStrandedPlaceMemory = (): void => {
    const dir = path.join(dataDir(), "projects");
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // 無いのが普通（場所で分けていた頃を通っていない）
    }
    for (const name of entries) {
      const file = legacyPlaceMemoryPath(decodeURIComponent(name));
      let lines: number;
      try {
        lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        continue;
      }
      if (lines === 0) continue;
      console.warn(
        `[banto] ${file} に場所で分けていた頃の記憶が ${lines} 件あります。` +
          "記憶の区画は幹になったので、この記憶はもう会話に載りません" +
          "（要るものは読んで memory.save で幹へ入れ直してください）"
      );
    }
  };

  /**
   * ADR-0003 の二層。人の記憶は1つ、その仕事の記憶は**幹ごと**（横断させない）。
   * 区画の単位を場所から幹へ移した（PO裁定 2026-08-10）。
   */
  const memory = new ScopedMemory(
    new JsonlMemoryStore(memoryPath()),
    (trunkId) => new JsonlMemoryStore(trunkMemoryPath(trunkId))
  );
  const skills = loadBantoSkills();
  // 決定26・task-0017: SKILL の学習層。番頭が書けない場所に置く（決定38b と同じ理由）
  const learnedSkills = new LearnedSkillStore(path.join(dataDir(), "skills"));
  const workspace = workspaceRoot();

  // 決定36：番頭が作業してよい場所。既定は BANTO_WORKSPACE（従来どおり1つ）。
  // BANTO_PLACES で複数を与えられる（決定36d：静的な場所はホスト設定。モジュールにしない）。
  //
  // **設定を先に登録する。** 同じ場所が両方から出たとき先勝ちなので、書き込みを許した
  // 設定側が、repo-manager が返す読み取り専用の同じリポジトリに負けないようにする（決定38a）。
  // 決定38c: POが後から許した範囲。保存先はホストのデータ置き場——リポジトリの中に置くと
  // 番頭が宣言を書き換えて自分の権限を広げられる（決定38b。file.write の砦がここを守っている）
  const grants = new PlaceGrantStore(path.join(dataDir(), "place-grants.json"));
  // 設定に場所が入っていればそれが真実、無ければ環境変数（決定41）。
  // **毎回読み直す**ので、設定画面で変えるとその場で効く（D3：ファイルは意図）
  const staticPlaces: PlaceProvider = {
    name: "static",
    list: async () => createStaticPlaceProvider(effectiveStaticPlaces(settings, workspace)).list(),
  };
  const places = new PlaceRegistry([staticPlaces, createRepoManagerPlaceProvider()], grants);
  ensureDesk(settings, workspace);
  for (const place of broadlyWritable(await places.list())) {
    // 決定38e：広く許したことを黙って通さない
    console.warn(
      `[banto] 場所 "${place.id}" は広い書き込み範囲（${(place.writable ?? []).join(", ")}）を許しています`
    );
  }

  // 決定25・27: モジュールを1箇所で登録する。Tool・GUI・SKILL はここから束ねて配る。
  //
  // **番頭ホストは工房も検証環境も自分の中に作らない**（task-0066・決定61）。作っていた頃は
  // (a) Kobo が職人を起こすのに番頭の稼働が要り（決定27b が避けた依存の逆転）、
  // (b) 番頭が立てた環境と Kobo が立てた環境で台帳が2つに割れていた（inc-0027）。
  // いまはどちらも独立サービスで、番頭はその**利用者**——Kobo と同じ載せ方（到達先＋写し）。
  const workerPoolUrl = defaultWorkerPoolUrl();
  const envPoolUrl = defaultEnvironmentPoolUrl();

  // 決定39: 検証環境の公開は Environment Pool の責務（中継も Caddy もサービス側にある）。
  // 画面の「接続と公開」で Caddy を設定しても、**別プロセスには届かない**——
  // 黙って効かないことにしないで、どこに置くべきかを言う（I2）
  const caddyAdmin = settings.all().network?.caddyAdmin;
  const envDomain = settings.all().network?.envDomain;
  if (caddyAdmin ?? envDomain) {
    console.warn(
      "[banto] Caddy の設定（接続と公開）は検証環境のサービス側で読みます。" +
        "banto-environment-pool.service に BANTO_CADDY_ADMIN / BANTO_ENV_DOMAIN を渡してください" +
        "——ここでの設定は効きません"
    );
  }

  // imp-0007 の裁定: 回収した成果物を**読める場所**として出す。置き場所を Pool が決める
  // だけだと、番頭は取り出したものを読めない（砦の外なので file.read が弾く）。
  // 別プロセスになったので、置き場は同じ規則（`<データ置き場>/collected`）で組み立てる
  places.add(createCollectedPlaceProvider(path.join(envPoolDataDir(), "collected")));

  // task-0048: 常駐時は UI も自分で配る。既定は packages/banto-web/dist（ビルドしていれば）
  const webDir =
    process.env["BANTO_WEB_DIST"] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "banto-web", "dist");

  // 決定40: 既定は localhost。広げるのは明示的な指定だけ
  const bindHost =
    options.host ?? settings.all().network?.bind ?? process.env["BANTO_HOST_BIND"] ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost") {
    // 黙って広い口を開けない（決定36d の場所の警告と同じ考え方）
    console.warn(
      `[banto] ${bindHost} で待ち受けます。**Banto は認証を持ちません**——` +
        "前段（Caddy 等）で守られていない経路から、記憶・書き込み・検証環境の" +
        "credentials 経路に直接届きます"
    );
  }

  // LLM Catalog の初期化（ADR-0004）。pi の設定を読み、banto のオーバーレイと統合する
  const agentDir = getAgentDir();
  /**
   * pi 0.84 で `AuthStorage` と `ModelRegistry.create()` は無くなり、資格情報とモデル表を
   * まとめて持つ `ModelRuntime` に一本化された（`ModelRegistry` はその同期版の facade）。
   *
   * `create()` は**外へ出ない**（内側の更新は `allowNetwork: false`）。ここで揃うのは
   * `models.json` と組み込みの定義から組んだ表で、それだけで解決はできる（実測 1231 件）。
   */
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  // **待たない**（inc-0047）。遅い外の応答に待ち受け開始を握らせない
  void refreshModelCatalog(modelRegistry);

  const workerPoolSettings = (settings.all().modules?.["worker-pool"] ?? {}) as Record<string, unknown>;
  const llmCatalog = new LlmCatalog({
    authJsonPath: path.join(agentDir, "auth.json"),
    modelsJsonPath: path.join(agentDir, "models.json"),
    overlayPath: path.join(dataDir(), "llm-registry.json"),
    resolver: createModelResolver(modelRegistry),
    migration: {
      workerProvider: workerPoolSettings["provider"] as string | undefined,
      workerModel: workerPoolSettings["model"] as string | undefined,
    },
  });

  // 職人のモデル解決（tier→実モデル）は**工房が自分で持つ**（task-0066）。番頭ホストは
  // 台帳（オーバーレイ）を書くだけで、職人を起こすのは別プロセス——オーバーレイは
  // 更新時刻で読み直されるので、画面で選んだ tier は次の委譲から効く（D3）。

  // 決定26 の層を解いた SKILL（番頭核＋モジュール）。studio はこれをそのまま見せる
  const coreSkills: SkillEntry[] = skills.map((skill) => ({ skill, origin: CORE_ORIGIN }));

  // ADR-0011 決定42: LLM は中核のドメイン。モジュールではなく中核の Tool として持つ
  const llmTools = createLlmTools({ catalog: llmCatalog });

  // 決定38b・63: どの設定でも書かせない置き場。**自分の分だけでは足りない**——
  // Kobo の帳簿（イベントログ・登録簿）も番頭には触れないことが機構で担保されている
  // 必要がある。いまは「場所として登録していないから書けない」という配置任せだった。
  // Kobo は別プロセスで置き場所は配置の問題なので、教えてもらう（`BANTO_KOBO_DATA_DIR`）。
  // **守れているかは起動ログに出す**——設定し忘れが黙って穴になるのを避ける
  const protectedPaths = [dataDir(), ...(koboDataDir() ? [koboDataDir()!] : [])];
  console.log(`[banto] 書き込み禁止の置き場: ${protectedPaths.join(", ")}`);
  if (!koboDataDir()) {
    console.warn(
      "[banto] Kobo の帳簿の置き場が分かりません（BANTO_KOBO_DATA_DIR 未設定）。" +
        "その置き場が「場所」として登録されると、番頭が帳簿を書き換えられます（決定63）"
    );
  }

  // 決定25・27b: Kobo は**独立プロセス**なので、載るのは実装ではなく到達先。
  // 立っていなくても登録はする——`kobo.*` が消えると番頭は「工場が無い」ではなく
  // 「積み方を知らない」状態になり、自分で実装を始めてしまう（D10 が崩れる）。
  // 立っているかは起動時に一度だけ確かめてログに出す（黙って届かない状態を作らない）
  const koboUrl = defaultKoboUrl();
  const koboModule = createKoboModule(koboUrl);

  /**
   * 取次（受け口）。**会話に紐づかない**——どの会話を見ていても、POを待たせている
   * ものは同じ1つの列にある。記録は追記だけのイベントログで、起動時に読み直す。
   *
   * モジュールより先に作る（決定73）：判断を求める口を持つモジュールは、ここへ積む。
   */
  const inbox = new Inbox(path.join(dataDir(), "inbox.jsonl"));

  const modules = createModuleRegistry([
    // 決定73: 書き込み許可の要求も取次へ積む。判断を求めるものは全部1つの列に集まる
    createWorkspaceModule(places, { protectedPaths }, grants, inbox),
    // Worker Pool は**必須の組み込みモジュール**（決定27c）。無いと番頭は職人へ委譲できず
    // D10 が構造的に満たせない。立っていなくても登録はする——`worker.*` が消えると、
    // 番頭は「工房が無い」ではなく「委譲の仕方を知らない」状態になり、自分で手を動かし始める
    createRemoteWorkerPoolModule(workerPoolUrl),
    koboModule,
    createRepoManagerModule(),
    // 決定32c・34: 番頭は Kobo 無しでも検証を回せる。「テストが通った」を職人の主張ではなく
    // 機構の返す事実として受け取るための実行能力（決定29a）。
    // **中継はホストが素通しする**（決定39）——公開された環境の URL は
    // `/api/environment-pool/env/<id>/` で、ブラウザは 127.0.0.1 のサービスへ届かない
    createRemoteEnvironmentPoolModule(envPoolUrl),
    // task-0050: pi coding agent の接続情報表示（LLM 管理は llm-registry が担当）
    createPiAgentModule(),
  ]);

  // 設定モジュールは他モジュールの宣言を集めるので、レジストリが揃ってから登録する（決定41）
  modules.register(
    createSettingsModule({
      core: createCoreSettingsSections(settings, {
        llmCatalog,
        // いま効いている場所をそのまま映す（画面と実態を食い違わせない）。
        // 保存が無いときの起動時指定も、既定の書斎も、ここに含まれる
        effectivePlaces: () =>
          effectiveStaticPlaces(settings, workspace).map((c) => ({
            id: c.id,
            path: c.path,
            ...(c.writable ? { writable: [...c.writable] } : {}),
          })),
        onPlacesChanged: () => ensureDesk(settings, workspace),
      }),
      modules,
      store: settings,
    })
  );

  // studio は他モジュールの SKILL も見せるので、レジストリが揃ってから登録する
  modules.register(
    createStudioModule({
      memory,
      // **毎回解き直す**（学習層を含む3層。決定26）。起動時に1回解いた配列を渡すと、
      // 番頭が `skill.learn` で学んだ手順が再起動まで画面に出ず、番頭と PO で見え方が割れる
      skills: () =>
        resolveSkills([
          learnedSkills.list().map((e) => ({ skill: e.skill, origin: LEARNED_ORIGIN })),
          coreSkills,
          modules.skills(),
        ]),
      /**
       * ADR-0003 の第二層をビューアが切り替えられるようにする。**区画は幹**（PO裁定 2026-08-10）。
       *
       * 出すのは**開いている幹と、記憶がある幹だけ**。畳んだ幹も記憶は残るので落とせないが、
       * 全部並べると空の札が数十枚出て、中身のある層が埋もれる（D7：探させない）。
       */
      places: async () =>
        threads
          .trunks()
          .filter((t) => t.state === "open" || memory.forProject(t.id).list().length > 0)
          .map((t) => ({ id: t.id, label: t.title })),
    })
  );

  // 決定44: モジュールの起動時処理。レジストリが揃ってから、待ち受ける前に一度だけ。
  // 中核は「何をするか」を知らない——職人の復帰も Worker Pool が自分で決める
  const initFailures = await modules.init();
  for (const f of initFailures) {
    console.error(`[banto] モジュール "${f.module}" の起動処理が失敗しました: ${f.error}`);
  }

  // 決定26・task-0017 a4: 既定が変わったオーバーライドを見つける。
  //
  // **黙って古いまま使わない**（P3）。学習層が既定の改良を隠したまま効き続けると、
  // モジュールを直しても番頭には永久に届かない——層A資産が「静かに劣化する」典型。
  // 起動時に一度だけ検査し、見つかったら incident を積む。
  const staleOverrides = detectStaleOverrides(learnedSkills.list(), skills);
  if (staleOverrides.length > 0) {
    const incident = writeStaleSkillIncident(staleOverrides);
    console.error(
      `[banto] 学習層の SKILL が既定より古くなっています（${staleOverrides.length} 件）:\n` +
        `${renderStaleOverrides(staleOverrides)}\n` +
        `[banto] incident を積みました: ${incident}`
    );
  }

  const catalog = createCanvasCatalog(modules.views());

  /** 持ち込みのテーマ。置くだけで足せる（作り直しが要らない）。 */
  const userThemes = new UserThemes(path.join(dataDir(), "themes"));

  /**
   * モデルの出どころは**「番頭の標準」ひとつだけ**（PO裁定 2026-08-04）。
   *
   * 以前は起動時の指定（`--model` / `BANTO_MODEL` / 設定ファイル）が標準より優先していた。
   * 設定画面で標準を変えても起動のたびに元へ戻り、画面の表示と実際が食い違う——
   * 置き場所を1つにして、設定画面が唯一の入口になるようにした（D3）。
   */
  const hostDefault = llmCatalog.defaults().host;
  const provider = hostDefault?.provider;
  const modelId = hostDefault?.model;
  const resolvedModel = llmCatalog.resolveHostDefault();
  // createBantoHostSession は pi-ai の Model 型を要求するため、modelRegistry から取得
  const model = resolvedModel
    ? modelRegistry.find(resolvedModel.provider, resolvedModel.id) ?? getModel(resolvedModel.provider as any, resolvedModel.id as any)
    : undefined;
  const currentModelId = modelId;
  const currentProvider = provider;

  /**
   * プロバイダ／モデル名からハーネスのモデル実体へ。使えない組み合わせは undefined。
   * 戻り値は pi の `Model`（セッションの組み立てと差し替えにそのまま渡す）。
   */
  function resolveModel(wantProvider: string, wantId: string): typeof model {
    const found = llmCatalog.resolveExact(wantProvider, wantId);
    if (!found) return undefined;
    return (
      modelRegistry.find(found.provider, found.id) ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getModel(found.provider as any, found.id as any)
    );
  }

  /**
   * 新しい会話が使うモデル。**毎回カタログの「番頭の標準」を引き直す**——
   * 設定画面で標準を変えたら、次に開く会話からその場で効く（PO報告 2026-08-04：
   * 以前は起動時に解決した1つを使い回していて、設定が配線されていなかった）。
   */
  function defaultModelForNewThread(): { provider: string; id: string } | undefined {
    const fromCatalog = llmCatalog.defaults().host;
    if (fromCatalog) return { provider: fromCatalog.provider, id: fromCatalog.model };
    // カタログに標準が無ければ、起動時に解決したもので始める
    if (currentProvider && currentModelId) return { provider: currentProvider, id: currentModelId };
    return undefined;
  }

  // スレッド1本分の器を作る（決定2・task-0035）。**キャンバスはスレッドごと**——
  // ここを共有すると、ある会話で GUI を開いたときに別の会話の表示まで変わる。
  //
  // 記憶は全スレッドで共有する（D11：番頭は記憶を持つ。分裂させない）。
  let threads: ThreadRegistry;
  let server: BantoHostServer;
  const threadFactory: ThreadFactory = async (threadId, resumeFrom, wantedModel, identity) => {
    const canvas = new Canvas(catalog);
    // 提案§3.1: ツール出力の退避先。**会話ごと**——別の会話の観測を引けると、
    // スレッドごとに文脈を分けている意味（決定35a）が崩れる。
    // ADR-0017 決定81(a): 器に載せるのはここに退避済みの結果だけ（データを再送させない）
    const artifacts = new ArtifactStore(path.join(dataDir(), "artifacts", threadId));
    // 記憶・SKILLのToolは createBantoHostSession が内部で足すので、ここでは渡さない。
    // canvas.* / thread.* / llm.* は Banto 中核自身のドメイン（決定27a・ADR-0011 決定42）で
    // モジュールではない。番頭は常にこれらを持つ。
    const ownTools = [
      ...createCanvasTools(canvas, catalog, {
        artifacts,
        // 器は会話へ積んで配る。**凍る**ので後から書き換えない（決定81(c)）
        showUtsuwa: (utsuwa) => server.showUtsuwa(threadId, utsuwa),
      }),
      // 取次は会話に紐づかないが、積むのは会話の中の番頭なので Tool は各会話に配る。
      // 宛先を渡すのは、積んだ札から**その話をしていた会話へ戻れる**ようにするため（決定73）
      ...createInboxTools(inbox, { threadId }),
      ...llmTools,
      ...createThreadTools({
        threads,
        // 名前を付け直す宛先は**この会話**に固定する（番頭に threadId を書かせない）
        threadId,
        // 出所は「別の会話」。職人の報告と同じ札で出さない（PO報告 2026-07-31）
        seed: (threadId, message) => server.notify(message, { threadId, source: "thread" }),
        /**
         * 幹を終うとき、番頭が選んだ記憶を**横断の層（人の記憶）へ上げる**。
         * 枝の結論が幹へ還るのと同じ形が、一段上で繰り返される（PO裁定 2026-08-09）。
         */
        carryOut: (texts) => {
          const person = memory.forPerson();
          for (const text of texts) {
            // 番頭が選んで持って出たものなので `explicit`（会話から抽出したのではない）
            person.save({ kind: "fact", text, origin: "explicit" });
          }
          return texts.length;
        },
      }),
      // レベル1（PO裁定）: banto 自身の再起動。exit(0) で終わり、systemd の Restart=always が
      // 起動し直す。職人・検証環境の始末は KillMode=control-group の cgroup 巻き添えで成立する
      // （ユニットの Restart=always への変更は PO が実施する——ここでは exit(0) するだけでよい）
      defineNamespacedTool({
        name: "system.restart",
        label: "System: Restart",
        description:
          "banto ホスト自身を再起動する。全クライアントに通知してから graceful に終了し、" +
          "systemd（Restart=always）が起動し直す。会話は保存済みで、再起動後に続きから話せる。" +
          "稼働中の職人は中断されるが、記録は残り worker.wake で再開できる。" +
          "検証環境は cgroup の巻き添えで落ちるので、事前に env.list で確認すること",
        parameters: Type.Object({}),
        async execute() {
          // 通知を必ず届けてから終わる——送信が終わる前に死なない（I2）
          await server.notify(
            "これから再起動します。会話は保存済みで、再起動後に続きから話せます。",
            { source: "system" }
          );
          // notify は broadcast を直ちに流すが、クライアントに届く猶予を少し残す
          await new Promise((resolve) => setTimeout(resolve, 300));
          // graceful に閉じる（全スレッドの後始末＋WS/HTTPのclose。SIGTERM の shutdown と同じ）
          await server.close();
          // Restart=always なら systemd が起動し直す。テスト環境では単に終了する
          process.exit(0);
        },
      }),
      // 決定35a: 職人の報告は**起こしたスレッド**へ返る。番頭に自分の threadId を
      // 書かせず、ここで固定して渡す（番頭は自分がどのスレッドかを知らない）
      ...modules.tools().map((tool) => {
        if (tool.name === "worker.delegate") {
          const bound = bindToolArgs(tool, { origin: threadOrigin(threadId) });
          // 決定36g：職人の作業場所を砦に通す。いままで無検査で、番頭が任意の
          // ディレクトリを職人に書き換えさせられた
          return guardPathArg(bound, places, "worktreePath");
        }
        // 決定63：**自分が起こしていない職人は畳めない。** Kobo の職人を番頭が畳むと、
        // Kobo は動いているつもりのまま実体が消える（Worker Pool 側には置けない——
        // 呼び出し元を区別できるのは束ねているこの層だけ）
        if (tool.name === "worker.close" || tool.name === "worker.stop") {
          // 工房は別プロセスなので、誰が起こしたかは Tool で引く（task-0066）
          return guardWorkerOrigin(tool, threadOrigin(threadId), (sessionId) =>
            lookupWorker(modules.tools(), sessionId)
          );
        }
        // 決定58: 工場に積んだ仕事の知らせも**積んだスレッド**へ返る。職人と同じ機構で、
        // 宛先は番頭に書かせずここで固定する（番頭は自分がどのスレッドかを知らない）
        if (tool.name === "kobo.enqueue") {
          return bindToolArgs(tool, { origin: threadOrigin(threadId) });
        }
        // 決定36g：**番頭が任意のパスを渡せる口は砦に通す。** 受け持たせるリポジトリも同じ
        // ——登録すると工場がそこで職人を動かし、ブランチを切ってマージする
        if (tool.name === "kobo.register_project") {
          return guardPathArg(tool, places, "repoPath");
        }
        // 決定73: 書き込み許可の判断待ちは**頼んだ会話**へ返る。職人・工場と同じ機構で、
        // 宛先は番頭に書かせずここで固定する（番頭は自分の threadId を知らない）
        if (tool.name === "place.request_write") {
          return bindToolArgs(tool, { threadId });
        }
        return tool;
      }),
    ];
    // task-0036: 番頭の文脈をディスクへ書く。**ここが inMemory だと再起動で全部消える**
    // ——画面の記録（ThreadStore）を戻しても、番頭は何も覚えていない状態になる。
    // 復元のときは元のファイルを開き直し、続きから話せるようにする
    const sessionDir = path.join(dataDir(), "threads", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionManager =
      resumeFrom && fs.existsSync(resumeFrom)
        ? SessionManager.open(resumeFrom, sessionDir, process.cwd())
        : SessionManager.create(process.cwd(), sessionDir);

    /**
     * この会話のモデル。**保存されていたもの > 番頭の標準**の順で決める。
     * 標準はカタログから毎回引き直すので、設定を変えれば次の会話から効く。
     */
    const wanted = wantedModel ?? defaultModelForNewThread();
    const threadModel = wanted ? resolveModel(wanted.provider, wanted.id) : undefined;
    // I2: 保存されていたモデルが使えなくなっていたら黙って別のモデルで開かない
    if (wanted && !threadModel) {
      console.warn(
        `[banto] ${threadId}: ${wanted.provider}/${wanted.id} を解決できないため、` +
          "起動時のモデルで開きます"
      );
    }
    const sessionModel = threadModel ?? model;

    /**
     * ADR-0003 の第二層：**この会話の幹の記憶だけ**を注入する（PO裁定 2026-08-10）。
     *
     * 区画の単位を場所から幹へ移した。**枝は親の幹と同じ区画**なので、枝で調べたことは
     * その仕事の記憶として溜まる。他の幹の記憶は載らない——載せると、幹を分けた意味が消える
     * （探すのは `memory.search({ acrossTrunks: true })` で幹をまたげる）。
     */
    const here = identity
      ? [
          {
            id: identity.trunkId,
            label:
              identity.kind === "branch" ? (identity.parentTitle ?? identity.title) : identity.title,
          },
        ]
      : [];
    /**
     * 区画の一覧（横断して探すときに開く先）。**畳んだ幹も入れる**——終わった仕事の
     * 記憶こそ横断で効く。無ければ「覚えていたはずのもの」に手が届かない
     */
    const knownTrunks = (): Array<{ id: string; label: string }> =>
      threads.trunks().map((t) => ({ id: t.id, label: t.title }));

    const { session } = await createBantoHostSession({
      // **会話ごとに立場が違う**ので、そこだけを足して渡す（PO報告 2026-08-10）
      systemPrompt: SYSTEM_PROMPT + describeThread(identity),
      tools: ownTools,
      memory,
      memoryTrunks: here,
      // I2: 知らない幹へ黙って書かない。省略時はこの会話の幹（defaultTrunkId）
      knownTrunkIds: () => knownTrunks().map((t) => t.id),
      defaultTrunkId: () => identity?.trunkId,
      knownTrunkList: knownTrunks,
      artifacts,
      // 器が描けなかったときに出どころを名指しできるようにする（決定81(d)）
      artifactModuleOf: (name) => modules.moduleForTool(name)?.name,
      ...(artifactThresholdChars() !== undefined
        ? { artifactThresholdChars: artifactThresholdChars()! }
        : {}),
      moduleSkills: modules.skills(),
      learnedSkills,
      sessionManager,
      modelRuntime,
      ...(sessionModel ? { model: sessionModel } : {}),
    });
    // imp-0016: ツールコール（git status / file.read など）の後、次の LLM 応答が空
    // （text/toolCall なし・stopReason "stop"）だと pi が正常終了としてターンを閉じ、
    // 応答が止まる。withEmptyResponseGuard が空応答を continue() で再試行する。
    // 再試行はガードの中で完結するので、server は HostSession 契約のまま無変更（決定3）
    const guardedSession = withEmptyResponseGuard(session);

    // 提案§3.2: pi の自動コンパクションを切り、章立てに置き換える。
    //
    // **要約器は本セッションと別の呼び出し**（決定28）。安いモデルがカタログにあれば
    // それを使い、無ければこの会話のモデルで書く。要約器を用意できないときは
    // 章立てを始めない——引き継ぎ無しで文脈だけ畳むのが最悪だから（I2）。
    const wantedSummarizer = chapterSummarizerModelSpec();
    const summarizerModel = wantedSummarizer
      ? resolveModel(wantedSummarizer.provider, wantedSummarizer.id)
      : undefined;
    // I2: 指定したのに解決できないときは黙って落とさず知らせる
    if (wantedSummarizer && !summarizerModel) {
      console.warn(
        `[banto] BANTO_CHAPTER_MODEL（${wantedSummarizer.provider}/${wantedSummarizer.id}）を` +
          "解決できません。会話のモデルで引き継ぎ資料を書きます"
      );
    }
    const writerModel = summarizerModel ?? sessionModel;
    let chapters: ChapterKeeper | undefined;
    if (writerModel) {
      chapters = new ChapterKeeper({
        session,
        store: handoffs,
        threadId,
        summarize: createLlmChapterSummarizer({
          model: writerModel,
          auth: (m) => modelRegistry.getApiKeyAndHeaders(m),
        }),
        // 閾値は**会話のモデル**の文脈長で測る（要約器の文脈長ではない）
        ...(sessionModel?.contextWindow ? { contextWindow: sessionModel.contextWindow } : {}),
        // PO指摘 2026-08-05: 退避した観測の索引を引き継ぎ資料へ書く。
        // 渡さないと、畳んだ番頭は栞（artifact のID）を見失う
        artifacts,
        // 決定28: 記憶の抽出は章の境界だけで走る（explicit gate）。**人の記憶へ入れる**。
        //
        // 区画が幹になった今、宛先の幹は分かる（identity.trunkId）が、抽出器は「人に
        // ついての長生きする事実」を出すように書かれていて、差分に区画を持たない。
        // 幹へ入れるなら抽出器の出力形式から変わるので、ここでは変えない
        // （残っている論点：仕事に固有の話が横断層へ入りうる。→ handoff）
        extractMemories: async (transcript) => {
          const person = memory.forPerson();
          const deltas = await createLlmMemoryExtractor({
            model: writerModel,
            auth: (m) => modelRegistry.getApiKeyAndHeaders(m),
          })({ transcript, existing: person.list() });
          const applied = applyMemoryDeltas(person, deltas);
          for (const { delta, reason } of applied.skipped) {
            console.warn(`[banto] 記憶を足しませんでした（${reason}）: ${JSON.stringify(delta)}`);
          }
          if (applied.added.length + applied.corrected.length > 0) {
            console.log(
              `[banto] ${threadId}: 記憶を ${applied.added.length} 件追加・` +
                `${applied.corrected.length} 件訂正しました（次の章から効きます）`
            );
          }
        },
        ...(chapterThresholdRatio() !== undefined
          ? { thresholdRatio: chapterThresholdRatio()! }
          : {}),
        onChapterClosed: (record) => {
          // 畳んだことは隠さない。番頭が細部を覚えていないときに PO が気づける
          server.notify(
            `ここまでを第${record.chapter}章として畳みました（${record.summary.topic}）。` +
              "前のやり取りは失われていません——詳細が要るときは番頭が引き継ぎ資料を読みます。",
            { threadId, source: "system" }
          );
        },
      });
      chapters.start();
    } else {
      console.warn(
        `[banto] ${threadId}: 要約に使えるモデルが無いため章立てを始めません` +
          "（文脈は pi の自動コンパクションのままです）"
      );
    }

    // server はイベントの wire名→論理名 逆引きに、登録した論理名のToolを必要とする
      const tools = [
        ...ownTools,
        // **逆引き用の写し**（実際に走るのは createBantoHostSession が組んだ側）。
        // 同じ options で組まないと、名前が食い違って逆引きが外れる
        ...createMemoryTools(memory, {
          knownTrunkIds: () => knownTrunks().map((t) => t.id),
          defaultTrunkId: () => identity?.trunkId,
          knownTrunkList: knownTrunks,
        }),
        ...createSkillTools(skills, { learned: learnedSkills, defaults: skills }),
        ...createArtifactTools(artifacts),
        ...createHandoffTools(handoffs, threadId),
      ];
    return {
      session: guardedSession,
      canvas,
      tools,
      // この会話が実際に使っているモデル。画面と索引へ出す（会話ごとに持つ）
      ...(threadModel && wanted
        ? {
            model: {
              provider: wanted.provider,
              id: wanted.id,
              vision: threadModel.input.includes("image"),
              ...(threadModel.contextWindow ? { contextWindow: threadModel.contextWindow } : {}),
            },
          }
        : {}),
      getLastError: () => session.agent.state.errorMessage,
      ...(sessionManager.getSessionFile() ? { sessionFile: sessionManager.getSessionFile()! } : {}),
      // imp-0016 主対策: 再起動で進行中ターンが失われたスレッド（最後が toolResult）を
      // 復元時に再開する。resumeInterruptedTurn は「最後が toolResult のときだけ continue()
      // する」ので、新規スレッド（履歴なし）では何もしない
      resumePendingTurn: async () => {
        void resumeInterruptedTurn(session);
      },
      dispose: () => {
        chapters?.stop();
        session.dispose();
      },
    };
  };

  // I2: 場所で分けていた頃の記憶が残っていたら名指しする（自動では移さない）
  warnStrandedPlaceMemory();

  // task-0036: 会話はホストの再起動を越えて残る
  const threadStore = new ThreadStore(path.join(dataDir(), "threads"));
  threads = new ThreadRegistry(threadFactory, threadStore);
  await threads.restore();
  /**
   * 帳場（メインの幹）が無ければ**新しく開く**（PO裁定 2026-08-10）。
   *
   * **既存の幹は昇格させない。** どの幹も既にその話題の記憶と経緯を抱えているので、
   * 「どの幹の話でもないもの」の受け皿には向かない——たまたま先頭にあった幹へ
   * 孤児の知らせが流れ込む、という今回の不具合がそれだった。
   */
  const restored = threads.list({ state: "open" });
  const defaultThread =
    threads.main() ?? (await threads.open({ kind: "trunk", main: true }));
  if (restored.length > 0) {
    console.log(`[banto] 会話を ${threads.list().length} 本読み戻しました`);
  }

  server = await BantoHostServer.start({
    threads,
    inbox,
    userThemes,
    port: settings.all().network?.port ?? options.port,
    catalog,
    modules,
    // ADR-0011 決定42: 中核の Tool も HTTP に出す（中核由来のGUIの到達先）
    coreTools: llmTools,
    /**
     * 取次で押された選択肢を効かせる（決定73）。
     *
     * **引くのはモジュールの帳簿**（決定27：Banto をブローカーにしない）。呼ぶ先は
     * 普通 `internalTools`——番頭には渡していない口を、POが押したときだけホストが呼ぶ。
     *
     * I2: 知らないモジュール・知らない Tool は黙って成功にしない。押した側は
     *     効いたつもりでいるので、効かなかったことは必ず返す。
     */
    runInboxEffect: async (effect) => {
      const tools =
        effect.module === CORE_ORIGIN
          ? llmTools
          : (() => {
              const owner = modules.get(effect.module);
              if (!owner) throw new Error(`モジュール "${effect.module}" は登録されていません`);
              return [...owner.tools, ...(owner.internalTools ?? [])];
            })();
      const tool = tools.find((t) => t.name === effect.tool);
      if (!tool) {
        throw new Error(`"${effect.module}" に Tool "${effect.tool}" はありません`);
      }
      const result = await tool.execute((effect.args ?? {}) as never, {
        toolCallId: `inbox-${Date.now()}`,
      });
      return result.content.map((c) => c.text ?? "").join("").trim();
    },
    // task-0048: ビルド済み UI があれば同じポートで配る（常駐させるときの形）
    ...(webDir ? { webDir } : {}),
    // 画像添付の可否判定（/api/model）。id は指定されたモデル名のまま
    // （解決で API 送信用 id に変わる場合があるため——MODEL_ALIASES）。vision は
    // 解決されたモデルの能力（input に image があるか）から求める
    ...(model && currentModelId
      ? {
          model: {
            id: currentModelId,
            vision: model.input.includes("image"),
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          },
        }
      : {}),
    ...(currentProvider ? { modelProvider: currentProvider } : {}),
    /**
     * 画面からモデルを変える口（決定：番頭は具体モデルを持つ／ADR-0004）。
     *
     * **開いている会話すべてに効かせて、既定としても保存する**——番頭は連続した一人で、
     * 会話ごとに別の頭になったりしないし、再起動で選び直させるのも筋が悪い。
     * I2: 解決できない・ハーネスが対応していないときは throw して、画面を前のままにする。
     */
    onSelectModel: async (thread, nextProvider: string, nextId: string) => {
      const next = resolveModel(nextProvider, nextId);
      if (!next) throw new Error(`${nextProvider}/${nextId} は使えるモデルの一覧にありません`);
      if (!thread.session.setModel) {
        throw new Error("このハーネスは動作中のモデル切替に対応していません");
      }
      // **その会話だけ**に効かせる。他の会話は自分のモデルのまま（PO裁定 2026-08-04）
      await thread.session.setModel(next);
      console.log(`[banto] model(${thread.id}): ${nextProvider}/${nextId}`);
      return {
        id: nextId,
        vision: next.input.includes("image"),
        ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
      };
    },
    // 決定40: 既定は localhost のみ。Banto は認証を持たず、守るのは前段の役目——
    // 全インターフェースで待つと前段を素通りできてしまい、その裁定が成り立たない
    host: bindHost,
  });

  // 待ち受け始めた＝サーバのソケットがイベントループを保つので、掴みを放す（inc-0020）
  clearInterval(startupKeepAlive);

  // 決定36g: 再起動で中断したターンを復元——server.start() 後に配信が始まるので、
  // 購読を張る前に resumePendingTurn を済ませておく
  for (const thread of threads.list()) {
    await thread.resumePendingTurn?.();
  }

  // 決定29: 番頭が起こした職人のイベントだけを受ける。他の起動元（Kobo 等）の分は届かない。
  // 起動前に溜まっていた古い報告は今さら流さない（最初の1回で今の位置まで進める）。
  //
  // **引きに行く形**（task-0066）。工房が別プロセスになったので同一プロセスの購読は使えない
  // ——Kobo と同じく `worker.events` を `afterEventId` で追う。
  //
  // 決定35a: 宛先は**起こしたスレッド**。origin を見て振り分ける。
  const stopWorkerNotices = startWorkerNotices({
    tools: modules.tools(),
    notify: (message, target) => server.notify(message, { ...target, source: "worker" }),
  });

  // 決定58: 工場の判断待ちは**積んだスレッド**へ返る。別プロセスなので引きに行く形
  // （`afterEventId` で、落ちている間に起きたことも取りこぼさない）
  const stopKoboNotices = startKoboNotices({
    tools: koboModule.tools,
    notify: (message, target) =>
      server.notify(message, { ...target, source: "kobo" }),
    cursorPath: path.join(dataDir(), "kobo-cursor.json"),
  });

  // task-0067: 検証環境の衛生（畳み忘れ・畳み損ね・孤児）も引きに行く。**外に残ったものは
  // 費用**（I3）なので、番頭が落ちている間の分も届くように読み位置をファイルに持つ。
  // 宛先は既定スレッド——置き場全体の話で、特定の会話のものではない
  const stopEnvNotices = startEnvNotices({
    tools: modules.tools(),
    notify: (message) => server.notify(message, { source: "env" }),
    cursorPath: path.join(dataDir(), "env-cursor.json"),
  });
  /**
   * 黙って止まった枝を取次へ積む（ADR-0017 決定77・P6・ADR-0016）。
   *
   * **忘れられた枝を人の記憶に頼らせない。** 埋没しない不変条件（幹の札・横断の通知・
   * レールの点）のうち、止まっている枝には**横断の通知**を足す——札は在っても、
   * 動いていないことは札からは読めない。
   */
  const stopStaleBranches = watchStaleBranches(threads, {
    onStale: (branch, days) => {
      inbox.post({
        // 同じ枝で札を積み増さない（動き出せば `watchStaleBranches` が忘れる）
        key: `branch-stale:${branch.id}`,
        source: { id: "banto", label: "番頭" },
        kind: "止まっている枝",
        rule: "P6",
        title: `枝「${branch.title}」が ${days} 日止まっています`,
        ...(branch.openReason ? { why: branch.openReason } : {}),
        what:
          `還す条件は「${branch.returnCondition ?? "（無し）"}」ですが、` +
          `${days} 日なにも記録されていません。黙って止まった枝は機構の異常として扱います（P6）。`,
        ask: "この枝をどうしますか",
        actions: [
          { id: "open", label: "枝を開いて続ける", tone: "call" },
          { id: "hold", label: "保留で畳む", tone: "plain" },
        ],
        opens: { threadId: branch.id },
      });
    },
  });

  // 立っているかを一度だけ確かめる。I2: 届かない相手を「何も無い」と混同しない
  void fetch(`${koboUrl.replace(/\/api\/kobo$/, "")}/api/v1/health`)
    .then((res) => {
      console.log(`[banto] kobo: ${koboUrl}（${res.ok ? "応答あり" : `応答 ${res.status}`}）`);
    })
    .catch(() => {
      console.warn(
        `[banto] kobo: ${koboUrl} へ届きません。積む・読む（kobo.*）は失敗します——` +
          "工場を使うなら banto-daemon を起動してください"
      );
    });

  // 工房と検証環境も同じく別プロセス（task-0066）。**立っていないと委譲も検証もできない**
  // ——番頭は Tool の失敗で気づくが、起動時に分かる方が早い（I2）
  const probe = (label: string, url: string, hint: string): void => {
    void fetch(`${new URL(url).origin}/health`)
      .then((res) => {
        console.log(`[banto] ${label}: ${url}（${res.ok ? "応答あり" : `応答 ${res.status}`}）`);
      })
      .catch(() => {
        console.warn(`[banto] ${label}: ${url} へ届きません。${hint}`);
      });
  };
  probe(
    "worker pool",
    workerPoolUrl,
    "職人への委譲（worker.*）は失敗します——banto-worker-pool.service を起動してください"
  );
  probe(
    "environment pool",
    envPoolUrl,
    "検証（env.*）は失敗します——banto-environment-pool.service を起動してください"
  );

  console.log(`[banto] listening on ws://localhost:${server.port}/ws`);
  console.log(
    `[banto] model: ${model ? `${model.provider}/${model.id}` : "(pi の既定解決)"}`
  );
  console.log(`[banto] memory: ${memoryPath()}`);
  console.log(`[banto] skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`[banto] canvas: ${catalog.list().map((c) => c.kind).join(", ") || "(none)"}`);
  console.log(`[banto] workspace: ${workspace}`);
  console.log(`[banto] worker pool: ${workerPoolUrl}`);
  console.log(`[banto] environment pool: ${envPoolUrl}`);
  console.log(`[banto] default thread: ${defaultThread.title} (${defaultThread.id})`);
  console.log(
    `[banto] modules: ${modules.list().map((m) => `${m.name}(${m.endpoint.baseUrl})`).join(", ") || "(none)"}`
  );

  const shutdown = (): void => {
    void (async () => {
      stopWorkerNotices();
      stopKoboNotices();
      stopEnvNotices();
      stopStaleBranches();
      // server.close() が全スレッドの後始末（購読解除＋対話ループの dispose）まで行う
      await server.close();
      threads.dispose();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function chat(url: string): Promise<void> {
  let resolveTurn: (() => void) | undefined;

  const onEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "welcome":
        console.log(`[banto] connected (session ${event.sessionId})`);
        console.log(`[banto] tools: ${event.tools.join(", ") || "(none)"}\n`);
        break;
      case "text_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_start":
        console.log(`\n[tool] ${event.name} ...`);
        break;
      case "tool_end":
        console.log(`[tool] ${event.name} ${event.isError ? "failed" : "ok"}`);
        break;
      case "turn_end":
        if (event.errorMessage) console.error(`\n[banto] error: ${event.errorMessage}`);
        console.log("\n");
        resolveTurn?.();
        break;
      case "error":
        console.error(`[banto] ${event.message}`);
        resolveTurn?.();
        break;
    }
  };

  const client = await BantoHostClient.connect(url, onEvent);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("close", () => {
    client.close();
    process.exit(0);
  });

  const ask = (): void => {
    rl.question("> ", (line) => {
      const text = line.trim();
      if (text.length === 0) {
        ask();
        return;
      }
      const turn = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
      client.send({ type: "prompt", text });
      void turn.then(ask);
    });
  };
  ask();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (command) {
    case "serve": {
      const host = flag("host") ?? process.env["BANTO_HOST_BIND"];
      await serve({
        port: Number(flag("port") ?? process.env["BANTO_PORT"] ?? BANTO_DEFAULT_PORT),
        ...(host ? { host } : {}),
      });
      break;
    }
    case "chat":
      await chat(flag("url") ?? `ws://localhost:${BANTO_DEFAULT_PORT}`);
      break;
    default:
      console.error(
        "usage: banto <serve|chat> [--port N] [--host ADDR] [--url ws://host:port]\n" +
          "  モデルは設定画面（LLM・モデル）で選ぶ。起動時には指定しない。\n" +
          "  --host は待ち受けるアドレス（既定 127.0.0.1）。Banto は認証を持たないので、\n" +
          "  外に出すなら前段（Caddy 等）で守ること"
      );
      process.exit(2);
  }
}

// I2: 起動時の失敗は静かに終わらせず、原因を出して非ゼロ終了する
main().catch((err: unknown) => {
  console.error(`[banto] ${String(err)}`);
  process.exit(1);
});
