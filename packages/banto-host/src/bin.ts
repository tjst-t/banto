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
import type * as http from "node:http";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  JsonlMemoryStore,
  LlmCatalog,
  ModelLedger,
  MODEL_ALIASES,
  ScopedMemory,
  type PlaceProvider,
  type ResolvedModel,
} from "@banto/core";

import type { WorkerInfo } from "@banto/worker-pool";
import {
  DEFAULT_CLAUDE_STOP_REMAINING_PCT,
  createClaudeQuotaMonitor,
  type ClaudeQuotaMonitor,
} from "@banto/worker-pool";
// Claude Code バックエンドの選択肢（PO裁定 2026-08-13）。認証の有無もここで見る
import {
  createClaudeBackend,
  createPiBackend,
  hostModelInfo,
  toBackendOption,
  type HarnessBackendDescriptor,
} from "./harness-backends.js";
import { createKoboModule, defaultKoboUrl } from "@banto/daemon";
import { BANTO_ORIGIN, startWorkerNotices, threadOrigin } from "./worker-notice.js";
import { guardWorkerOrigin } from "./worker-guard.js";
import { startKoboNotices } from "./kobo-notice.js";
import { createRemoteRelay, createRemoteSettings } from "./remote-module.js";
import { startEnvNotices } from "./env-notice.js";
import { TurnLog, defaultTurnLogPath, type TurnToolCounts } from "./turn-log.js";
import { createTrunkWorkNudge, withUnsettledRemainingNotice } from "./trunk-nudge.js";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { Inbox } from "./inbox.js";
import { createInboxTools } from "./inbox-tools.js";
import {
  createKoboPoDecisionTool,
  koboPoDecisionEffect,
  koboReviewTarget,
  koboAmendTarget,
  resolveStaleInboxForTask,
  sweepStaleInboxForTerminalTasks,
  type KoboPoDecision,
} from "./kobo-po-decision.js";
import { UserThemes } from "./user-themes.js";
import {
  assembleStewardContext,
  createBantoHostSession,
  type CreateBantoHostSessionOptions,
} from "./host-session.js";
import { hasInterruptedTurn, resumeInterruptedTurn, withEmptyResponseGuard } from "./turn-guard.js";
import { recoverLostTurns } from "./lost-turn.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createArtifactTools } from "./artifact-tools.js";
import { ArtifactStore } from "./artifacts.js";
import { createLlmChapterSummarizer, type ChapterCompleter } from "./chapter-summarizer.js";
import { createClaudeChapterCompleter, createPiChapterCompleter } from "./chapter-completers.js";
import {
  DEFAULT_CHAPTER_MODEL,
  chapterModelLabel,
  resolveChapterModel,
} from "./chapter-model.js";
import { ChapterKeeper, renderTranscript } from "./chapters.js";
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
import { createBrowserModule } from "./browser/index.js";
import { createLlmTools } from "./llm-tools.js";
import { refreshModelCatalog } from "./model-catalog.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { PlaceGrantStore } from "./place-grants.js";
import { ThreadStore } from "./thread-store.js";
import { SettingsStore } from "./settings-store.js";
import { createCoreSettingsSections } from "./core-settings.js";
import { type HarnessBackendOption, createSettingsModule, settingsSection } from "./settings-module.js";
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
import { createTurnBudget, withTurnBudgetReset } from "./turn-budget.js";
import { withWorkerCard } from "./worker-card.js";
import { withTierUnassignedNotice } from "./worker-tier-notice.js";
import { bindToolArgs, createThreadTools } from "./thread-tools.js";
import { type NamespacedToolDefinition } from "./tool-registry.js";
import { fromWireToolName, type BantoHarness } from "@banto/core";
import { PiHarness } from "./pi-harness.js";
import { ClaudeAgentHarness } from "./claude-agent-harness.js";
import { PooledSdkHarness, SdkSessionPool } from "./sdk-sessions.js";
import { selectPresentedTools } from "./presented-tools.js";
import {
  RESTART_RESUME_NOTICE,
  ThreadRegistry,
  watchStaleBranches,
  type ThreadFactory,
  type ThreadIdentity,
} from "./threads.js";
import { createRestartTool } from "./restart-tool.js";
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
 * 環境変数から正の整数を読む。**読めない値は黙って既定に落とさない**（I2）。
 *
 * `chapterThresholdRatio` と同じ流儀——設定したつもりの値と違う値で動くのが一番困る。
 */
function positiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[banto] ${name} は正の整数です（${raw}）。既定を使います`);
    return undefined;
  }
  return parsed;
}

/**
 * アイドルな SDK セッションを畳むまでの時間（ミリ秒）。`BANTO_SDK_IDLE_MS` で変えられる。
 * 既定は `DEFAULT_SDK_IDLE_MS`（15分。職人側の安全弁と同じ）。
 */
function sdkIdleMs(): number | undefined {
  return positiveIntFromEnv("BANTO_SDK_IDLE_MS");
}

/**
 * 同時に生かす SDK セッションの上限。`BANTO_SDK_MAX_SESSIONS` で変えられる。
 * 既定は `DEFAULT_SDK_MAX_LIVE`（8本。根拠は `sdk-sessions.ts` の注釈）。
 */
function sdkMaxSessions(): number | undefined {
  return positiveIntFromEnv("BANTO_SDK_MAX_SESSIONS");
}

/**
 * Claude サブスクの枠を止める残量 % のしきい値。`BANTO_CLAUDE_STOP_REMAINING_PCT` で
 * 変えられる。既定は `DEFAULT_CLAUDE_STOP_REMAINING_PCT`（20）——残り 20% を切ったら
 * Claude Agent SDK を止めて pi へフォールバックする。
 *
 * I2: 読めない値・範囲外は黙って既定に落とさず知らせる。
 */
function claudeStopRemainingPct(): number {
  const raw = process.env["BANTO_CLAUDE_STOP_REMAINING_PCT"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CLAUDE_STOP_REMAINING_PCT;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.warn(
      `[banto] BANTO_CLAUDE_STOP_REMAINING_PCT は 0〜100 の数値です（${raw}）。既定（${DEFAULT_CLAUDE_STOP_REMAINING_PCT}）を使います`
    );
    return DEFAULT_CLAUDE_STOP_REMAINING_PCT;
  }
  return parsed;
}

// 章の要約に使うモデルの解決は `chapter-model.ts` の `resolveChapterModel`（task-0151）。

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

- **trunk** — one project. It is never folded away by itself, and it is the record of what got decided. What lands in a trunk stays short: a branch opened, a branch asked or reported something, a branch concluded. **Never replay a branch's contents into the trunk** — that is what makes a trunk readable end to end. Detail is not lost, it is read on demand (thread.read).
- **branch** — one question that has an end. Open it with thread.open when a topic is going to take repeated back-and-forth. You must say what would bring it back (returnCondition) and why it is not being discussed in the trunk (reason). **If you cannot say what would end it, do not open a branch — talk in the trunk.** Branches are one level deep: you cannot open a branch from inside a branch. Fold it with thread.merge and give the conclusion in one line; "保留：<reason>" is a valid conclusion. thread.merge also takes what you investigated / decided / what is left — that detail stays in the branch, not the trunk.
- **A trunk and its branches can talk while a branch is running.** From the trunk: thread.read to see what is actually happening inside one (open or already folded), thread.steer to hand it a message after it started — a changed premise, a narrowed scope, an answer. From a branch: thread.consult to put a question or a report back on the trunk before you fold, when the trunk's judgement is needed and inventing a conclusion would be worse. Do not use it as chat: a branch that consults on every step should have stayed in the trunk.
- **You are not limited to asking a branch to fold itself.** thread.steer only hands over a message — the branch has to act on it, and it will not until its next turn. When you have already decided a branch is done (an investigation not worth chasing further, a premise that no longer holds), fold it yourself with thread.fold instead of waiting: give a conclusion, same as thread.merge. It only works on your own branches, not another trunk's, and not while the branch's turn is still running. If the branch already wrote its own conclusion, thread.fold does not overwrite it — yours is recorded alongside it. A branch folded this way with remaining work still needs \`where\`, same as thread.settle.
- **帳場** — one special trunk, the only conversation that can never be closed. **It is not a project, and it is not the trunk for developing banto itself.** Anything that does not belong to a specific project lands here: notices with no destination, a request before it has become a project, one-off errands. It always sits first in the user's rail.
- **Starting a new trunk** (thread.open_trunk): the test is whether you would want this work's accumulated memory mixed into an existing trunk's conversations. If you would, it belongs in that trunk. If mixing it would be noise, start a trunk. Repeated back-and-forth alone is a branch, not a trunk.
- **Ending a trunk** (thread.close_trunk): when the project is over. You choose what memory to carry out of it — rewrite anything that still holds elsewhere so it makes sense outside this project. What you do not carry stays with the folded trunk. Open branches must be folded first.
- **Passing word between trunks** (thread.send): memory and context are split per trunk, which is exactly why things sometimes need to cross. Send the fact and why it matters over there — do not give instructions; what happens in that trunk is its steward's call. Trunks only — another trunk's branches are none of your business, and you cannot read inside them either. Do not go back and forth: if two or three messages do not settle it, raise it to the user or move to that trunk.
- **Work left over in a branch does not reach the trunk by itself.** Before you fold, every line of remaining must say where it went — an issue id (imp-NNNN / task-NNNN), the sessionId of a worker you started, or an explicit "to be delegated in the trunk". **thread.merge refuses to fold a branch when a line of remaining has no whereabouts** — and a judgement you need from the trunk is not remaining work: ask for it with thread.consult while the branch is still alive, because remaining never reaches the trunk and never wakes it. Say the next move and its whereabouts in the conclusion too; a conclusion that ends at "I recommend X" leaves nobody holding the work. A branch folded with remaining stays in thread.list as 未処理 N件 until you take it off with thread.settle (threadId, where) — where is required, and "done" is not a whereabouts.
- **If folding a branch leaves a move for the trunk to make, write it in handoff (thread.merge).** That is the one thing a folded branch can hand over: 幹が次に踏む一手 — "task-0152 landed, restart banto so it takes effect". With handoff the trunk gets exactly one turn and reads it; without it the trunk does not move at all, because a conclusion line is a notice and notices never wake the trunk (ADR-0025 決定120). Folding again does not wake it twice. Do not confuse the three: a question while the branch is alive is thread.consult, work someone still has to do is remaining, and a move the trunk itself takes now is handoff. Also: **whoever you ask for a signal must be the branch that actually holds the task** — a branch that is only watching the factory has no moment at which to signal.
- thread.list shows every open conversation, which one you are in, and what each branch is waiting on — plus any folded branch that still carries unsettled work. Add includeClosed to find a folded branch you want to read back.
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
      "give the conclusion in one line; that line is all the trunk will see.",
      "",
      "**If folding leaves a move for the trunk to make, write it in handoff.** The conclusion",
      "line is a notice and notices never wake the trunk — so a conclusion alone stops here.",
      "handoff (幹が次に踏む一手, e.g. \"task-0152 landed, restart banto so it takes effect\")",
      "wakes the trunk exactly once and hands the work over. Nothing to hand over: leave it out."
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
  /**
   * **役の台帳**（ADR-0021 決定101）。`llm-registry.json`（pi の供給）とは別ファイル。
   *
   * **書くのは番頭ホストだけ**（決定101d）。工房は読み取り専用で開く。
   */
  const modelLedger = new ModelLedger({ path: path.join(dataDir(), "model-roles.json") });
  const llmCatalog = new LlmCatalog({
    ledger: modelLedger,
    authJsonPath: path.join(agentDir, "auth.json"),
    modelsJsonPath: path.join(agentDir, "models.json"),
    overlayPath: path.join(dataDir(), "llm-registry.json"),
    resolver: createModelResolver(modelRegistry),
    migration: {
      workerProvider: workerPoolSettings["provider"] as string | undefined,
      workerModel: workerPoolSettings["model"] as string | undefined,
    },
  });


  /**
   * **`settings.harness` → `roles.steward` へ畳む**（PO裁定 2026-08-13）。
   *
   * 「新しい会話は何で始まるか」に2箇所が答えていた（実データで食い違った）。
   * 束縛の座標に `backend` を持たせたので、設定側の欄は要らなくなる。
   * **設定側を真実として移す**——実際に効いていたのはそちらだから（`startBackend`）。
   */
  const legacyHarness = settings.all().harness;
  if (legacyHarness?.backend) {
    const current = llmCatalog.roles().steward;
    llmCatalog.setRole(
      "steward",
      legacyHarness.backend === "claude-agent-sdk" ? "claude" : (current?.provider ?? "opencode"),
      legacyHarness.model ?? current?.model ?? "",
      legacyHarness.backend
    );
    settings.update("harness", undefined as never);
    console.log(`[banto] 番頭の既定を roles.steward へ移しました（${legacyHarness.backend}）`);
  }
  // 職人のモデル解決（tier→実モデル）は**工房が自分で持つ**（task-0066）。番頭ホストは
  // 台帳（オーバーレイ）を書くだけで、職人を起こすのは別プロセス——オーバーレイは
  // 更新時刻で読み直されるので、画面で選んだ tier は次の委譲から効く（D3）。

  // 決定26 の層を解いた SKILL（番頭核＋モジュール）。studio はこれをそのまま見せる
  const coreSkills: SkillEntry[] = skills.map((skill) => ({ skill, origin: CORE_ORIGIN }));

  // ADR-0011 決定42: LLM は中核のドメイン。モジュールではなく中核の Tool として持つ
  const llmTools = createLlmTools({ catalog: llmCatalog });
  /**
   * **在庫は減らさない**（ADR-0019 決定82）。番頭に渡すのは4本だけだが（決定98f）、
   * HTTP 面（設定画面の到達先）と取次の効きは17本のまま——ここを絞ると画面が 404 になる。
   */
  const llmAllTools = [...llmTools.tools, ...llmTools.settings];

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
  const koboContract = createKoboModule(koboUrl);
  // 決定41: 工場の区画（役割ごとの職人の当て方）も設定画面に出す。項目の宣言は
  // 工場のパッケージから、読み書きは HTTP 越しに——Worker Pool と同じ形（task-0066）
  /**
   * **PO が画面から通せるようにするための中継**（task-0147・段3）。
   *
   * 工場は 127.0.0.1 にしか出ていない（決定40）ので、ブラウザからは直接届かない。
   * Tool の口（`/tools/*`）は写しの `execute` が担うので中継しない——中継されるのは
   * 工場が自分で生やしている面、いまは **PO 専用の承認口**
   * （`POST /api/kobo/projects/:proj/tasks/:id/approve`）だけ。
   *
   * 検証環境で先に踏んだのと同じ形（決定39）。**ホストは合言葉を預からない**
   * ——ブラウザが付けた名乗りをそのまま流し、照合するのは工場（task-0147 の縛り2）。
   * ここに判断は無い（D5）。
   */
  const koboRelay = createRemoteRelay(koboUrl);
  const koboModule = {
    ...koboContract,
    settings: createRemoteSettings(koboContract.settings, "kobo", koboContract.name, koboUrl),
    /**
     * **取次の札の回答を、その PO 専用の口へ結ぶ**（ADR-0023 決定113・imp-0034）。
     *
     * `internalTools` なので `ModuleRegistry.tools()` には出ず、番頭の在庫にも提示にも
     * 載らない——**モデルからは呼べない**。呼ぶのは PO が札を押したときのホストだけ
     * （`runInboxEffect`）。番頭に渡っている `kobo.approve` は今までどおり
     * PO 必須のタスクを断る（決定57 はここで保たれる）。
     */
    internalTools: [createKoboPoDecisionTool(koboUrl)],
    serve: (req: http.IncomingMessage, res: http.ServerResponse) => koboRelay.serve(req, res),
  };

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
    // 番頭とPOが同じブラウザを触る（2026-08-15 の判定）。起こす実装は後続で入る
    createBrowserModule(),
  ]);

  // 設定モジュールは他モジュールの宣言を集めるので、レジストリが揃ってから登録する（決定41）
  /**
   * **バックエンド → プロバイダ → モデル**（PO裁定 2026-08-13）。
   *
   * pi 側は LLM 登録の「番頭が使ってよい」モデル、Claude Code 側は SDK の別名。
   * 同じ `opus` が両方に出るのが正しい——どちらの経路で呼ぶかを人が選ぶ。
   * **会話の画面（`settings.harness_models`）と設定の選択肢が同じ元から出る**（D3）。
   */
  /**
   * **バックエンドは自分を名乗る**（決定98d）。ここは並べるだけで、中身は知らない
   * ——`CLAUDE_KNOWN_MODELS` を直に読んでいた頃は、バックエンドが増えるたびに
   * ここと `onSelectModel` の2箇所を直して回ることになっていた。
   */
  /**
   * **Claude のサブスク枠の監視**（クオータ節約）。残りがしきい値を切ったら
   * `shouldStop()` が真になり、Claude Agent SDK 経路（会話・章の要約）を pi へ落とす。
   * 枠がリセットされれば自動でまた使えるようになる。監視は裏で定期に動かす。
   */
  const claudeQuota: ClaudeQuotaMonitor = createClaudeQuotaMonitor({
    stopRemainingPct: claudeStopRemainingPct(),
  });

  const harnessBackends: HarnessBackendDescriptor[] = [
    createPiBackend({
      // 番頭に許しているモデルだけ（採用の方針・決定98b）
      hostModels: () => llmCatalog.models().filter((m) => m.policy.includes("host")),
      resolve: (provider, id) => resolveModel(provider, id),
    }),
    createClaudeBackend({ quota: claudeQuota }),
  ];
  const backendById = new Map(harnessBackends.map((b) => [b.id, b]));

  /**
   * **職人に選べるモデル**（ADR-0021 決定102）。数え上げるのは工房で、ここは写しを持つだけ
   * ——番頭の層とは別の名乗り（決定100）なので、番頭側の一覧を流用しない。
   *
   * **待たない。** 設定の区画は同期で組むので、いまある写しを返して裏で取り直す
   * （Claude のモデル一覧と同じ形・決定98d）。**取れなかったら空にしない**（I2）。
   */
  let workerModelCache: Array<{ value: string; label: string }> = [];
  let workerModelsAskedAt = 0;
  const WORKER_MODELS_TTL_MS = 60_000;
  const refreshWorkerModels = (): void => {
    if (Date.now() - workerModelsAskedAt < WORKER_MODELS_TTL_MS) return;
    workerModelsAskedAt = Date.now();
    const tool = modules.tools().find((t) => t.name === "worker.models");
    if (!tool) return;
    void tool
      .execute({}, { toolCallId: `worker-models-${Date.now()}` })
      .then((result) => {
        const found = (result.details as { models?: Array<{ name: string; label: string; runtime: string }> })
          ?.models;
        if (!found || found.length === 0) return; // I2: 空を信じない
        workerModelCache = found.map((m) => {
          // 名前の形はバックエンドで違う（pi は `provider/model`、Claude は別名だけ）
          const slash = m.name.indexOf("/");
          const backend = m.runtime === "claude-agent-sdk" ? "claude-agent-sdk" : "pi";
          const [provider, model] =
            slash > 0 ? [m.name.slice(0, slash), m.name.slice(slash + 1)] : ["claude", m.name];
          return { value: `${backend}|${provider}|${model}`, label: `${backend} › ${m.label}` };
        });
      })
      .catch(() => {
        // 工房が落ちているだけ。写しはそのまま（選べないものを選ばせない・I2）
      });
  };
  const workerModelChoices = (): Array<{ value: string; label: string }> => {
    refreshWorkerModels();
    return workerModelCache;
  };
  /**
   * **起動時に温める。** 設定を最初に開いた1回だけ職人の選択肢が空になり、
   * いまの割り当てが「一覧に無い」と出る——**開いただけで壊れて見える**（実機で確認）。
   */
  setTimeout(() => refreshWorkerModels(), 2_000).unref?.();
  const harnessBackendOptions = (): HarnessBackendOption[] => harnessBackends.map(toBackendOption);

  modules.register(
    createSettingsModule({
      core: createCoreSettingsSections(settings, {
        llmCatalog,
        // 設定画面の選択肢も**会話の画面と同じ元**から作る（D3）
        harnessChoices: () =>
          harnessBackendOptions()
            .filter((b) => !b.unavailable)
            .flatMap((b) =>
              b.providers.flatMap((p) =>
                p.models.map((m) => ({
                  value: `${b.id}|${p.id}|${m.id}`,
                  label: `${b.label} › ${p.id} › ${m.name ?? m.id}`,
                }))
              )
            ),
        // いま効いている場所をそのまま映す（画面と実態を食い違わせない）。
        // 保存が無いときの起動時指定も、既定の書斎も、ここに含まれる
        effectivePlaces: () =>
          effectiveStaticPlaces(settings, workspace).map((c) => ({
            id: c.id,
            path: c.path,
            ...(c.writable ? { writable: [...c.writable] } : {}),
          })),
        onPlacesChanged: () => ensureDesk(settings, workspace),
        /**
         * **職人に選べるモデル**（ADR-0021 決定102）。工房が数え上げたものをそのまま出す
         * ——番頭の層とは別の名乗りなので、こちらは工房へ聞く（決定100）。
         *
         * 工房が落ちていれば空。**そのときは自由入力に落ちず「割り当てなし」だけになる**
         * ——選べないものを選ばせないため（I2）。
         */
        workerChoices: () => workerModelChoices(),
        // 既定の等級は**核の台帳**が持つ（決定99a）
        workerDefaultTier: () => modelLedger.defaultTier() ?? "",
        onWorkerTierChanged: (tier) => modelLedger.setDefaultTier(tier),
        // task-0151 a3: 画面が「いま実際に使われているもの」を映せるよう、解決も同じ元から
        effectiveChapterModel: () =>
          resolveChapterModel({
            envRaw: process.env["BANTO_CHAPTER_MODEL"],
            settingsValue: settings.all().chapterModel,
            backends: harnessBackends,
          }),
      }),
      modules,
      store: settings,
      /**
       * **バックエンド → プロバイダ → モデル**（PO裁定 2026-08-13）。
       *
       * pi 側は LLM 登録の「番頭が使ってよい」モデル、Claude Code 側は SDK の別名。
       * 同じ `opus` が両方に出るのが正しい——どちらの経路で呼ぶかを人が選ぶ。
       */
      harnessOptions: () => harnessBackendOptions(),
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
  /**
   * 会話ごとのハーネスの作り手（PO要望 2026-08-13）。**会話の途中でバックエンドを
   * 差し替える**ために、両方の作り手を覚えておく。pi 側は同じものを返す——章立てが
   * その pi セッションに紐づいているので、戻ったときに文脈が残っている必要がある。
   */
  /**
   * **常駐する SDK セッションの本数を抑える安全弁**（task-0165）。
   *
   * ホストが 4 回 OOM で殺された直接の原因が、畳まれないまま積み上がった
   * Claude Code の子プロセス（12〜13本で 2.3〜2.4 GiB／unit の上限は 3.00 GiB）。
   * アイドルと本数の上限で畳み、次の発話が来たら札で戻す（会話は失われない）。
   */
  const sdkSessions = new SdkSessionPool({
    ...(sdkIdleMs() !== undefined ? { idleMs: sdkIdleMs()! } : {}),
    ...(sdkMaxSessions() !== undefined ? { maxLive: sdkMaxSessions()! } : {}),
  });
  sdkSessions.start();
  const harnessSwitchers = new Map<
    string,
    {
      pi: () => BantoHarness;
      claude: (model?: string) => BantoHarness;
      /** Claude 側を畳む（pi へ戻すとき）。札は残るので選び直せば続きから戻る。 */
      releaseClaude: () => void;
    }
  >();
  /**
   * 会話ごとの「そのターンの道具呼び出し回数」（T4）。台帳（T1）へ出すために持つ。
   *
   * 数えているのは会話ごとの器（`TrunkWorkNudge`）だが、台帳を書くのはホスト。
   * 間を結ぶのがここ——1本の Map で足りるので、`Thread` にも `server` にも
   * 数えの都合を持ち込まない（D3: 導出できる値を二重に持たない）。会話1本につき
   * 小さな器が1つ増えるだけなので、畳んでも消さない（開き直しで同じ id が戻る）。
   */
  const turnCounts = new Map<string, { counts(): TurnToolCounts }>();
  let server: BantoHostServer;
  const threadFactory: ThreadFactory = async (
    threadId,
    resumeFrom,
    wantedModel,
    identity,
    resumeBackendSession
  ) => {
    const canvas = new Canvas(catalog);
    /**
     * T4: 幹で手を動かしたら枝へ促す器。**会話ごと**——ここで `identity` を渡すので、
     * 促されるのは幹だけになる（枝は数えるだけ）。数えは台帳（T1）へ出す。
     */
    const trunkNudge = createTrunkWorkNudge({ kind: identity?.kind });
    turnCounts.set(threadId, trunkNudge);
    /**
     * ターンの予算（PO報告 2026-08-11）。**会話ごと**に持つ——隣の会話の数えと混ぜると、
     * 正常な1回目の確認まで断ることになる。
     *
     * T4 の促しも**同じ切れ目**で数え直す（`onReset`）。切れ目を2つに増やすと、
     * バックエンドを足したときに片方だけ数え直されない形に戻る。
     */
    const turnBudget = createTurnBudget({ onReset: () => trunkNudge.reset() });
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
      ...createInboxTools(inbox, {
        threadId,
        // 決定113: 札の回答を、工場の PO 専用の口へ結ぶ（通す／戻すの両方）。
        // 番頭が書けるのはどの選択肢がどの判断かまでで、呼ぶ先を決めるのはここ
        resolvePoDecisionEffect: ({ canvasKind, canvasParams, decision, detail, changes }) => {
          // レビュー面（通す／戻す）と改訂面（適用する）は、届け先の読み方が違うので分ける。
          const review = koboReviewTarget(canvasKind, canvasParams);
          if (review) {
            if (decision === "approve" || decision === "send_back") {
              return koboPoDecisionEffect(review, decision, detail);
            }
            return undefined;
          }
          const amend = koboAmendTarget(canvasKind, canvasParams);
          if (amend && decision === "amend") {
            return koboPoDecisionEffect(amend, "amend", detail, changes);
          }
          return undefined;
        },
      }),
      // 決定98f: 番頭が持つのは読みと診断の4本だけ（設定変更は GUI とファイルの担当）
      ...llmTools.tools,
      ...createThreadTools({
        threads,
        // 名前を付け直す宛先は**この会話**に固定する（番頭に threadId を書かせない）
        threadId,
        // 出所は「別の会話」。職人の報告と同じ札で出さない（PO報告 2026-07-31）
        seed: (threadId, message) => server.notify(message, { threadId, source: "thread" }),
        /**
         * **幹どうしの言伝**（PO要望 2026-08-10）。`seed` と同じ経路を通す——
         * 出所が「別の会話」であることは、開くときも渡すときも変わらない。
         */
        deliver: (threadId, message) => server.notify(message, { threadId, source: "thread" }),
        /**
         * **枝から幹への相談**（決定107）。記録は `ThreadRegistry.consult` が札として
         * 済ませているので、ここでは幹のターンだけ回す——`notify` を使うと同じ一言が
         * 知らせとしても積まれ、1つの相談が2行に見える
         */
        nudge: (threadId, message) => server.nudge(threadId, message),
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
      /**
       * レベル1（PO裁定）: banto 自身の再起動。exit(0) で終わり、systemd が起動し直す。
       *
       * **巻き添えで落ちるものは無い**（imp-0062。2026-08-15 実測）。職人は
       * `banto-worker-pool.service`、検証環境のコンテナは `docker-<id>.scope` に居り、
       * `banto.service` は `BindsTo`／`PartOf` を持たない——落ちるのは自分の cgroup、
       * すなわち**走行中のターン**（会話セッションはこのプロセスの子）だけである。
       * 「職人・検証環境の始末は cgroup 巻き添えで成立する」と書いてあったのは嘘だった。
       *
       * 中身は `restart-tool.ts`（imp-0037）。**返事を返してから、ターンの外で落ちる**
       * ——ここで exit まで済ませていたので `tool_end` が書けず、会話に
       * `state:"running"` の道具が永久に残っていた。
       */
      createRestartTool({
        // PO裁定 2026-08-15: 再起動の一言は**呼んだ会話の続き**。知らせとして枝へ回さない
        threadId,
        notify: (text, target) =>
          server.notify(text, { ...target, source: "system", conversation: true }),
        close: async () => {
          // 落ちる直前の取りこぼしを防ぐ。`tool_end` の保存は間引かれている（SAVE_DELAY_MS）
          threads.flushAll();
          // graceful に閉じる（全スレッドの後始末＋WS/HTTPのclose。SIGTERM の shutdown と同じ）
          await server.close();
        },
        exit: (code) => process.exit(code),
      }),
      // 決定35a: 職人の報告は**起こしたスレッド**へ返る。番頭に自分の threadId を
      // 書かせず、ここで固定して渡す（番頭は自分がどのスレッドかを知らない）
      /**
       * ターンの予算は**ここでは掛けない**（PO報告 2026-08-11）。
       *
       * 番頭が呼べる道具の最後の1点（`createBantoHostSession`）でまとめて掛ける——
       * 呼び出し側で選んで掛けると、**足し忘れた道具が抜け道になる**。実際、最初に
       * 書いた対策はモジュールの口だけを見ていて、`file.find` を混ぜられた実機の暴走を
       * 止められなかった。
       */
      ...modules.tools().map((tool) => {
        if (tool.name === "worker.delegate") {
          const bound = bindToolArgs(tool, { origin: threadOrigin(threadId) });
          // 決定36g：職人の作業場所を砦に通す。いままで無検査で、番頭が任意の
          // ディレクトリを職人に書き換えさせられた
          const guarded = guardPathArg(bound, places, "worktreePath");
          /**
           * **起こしたら会話に口が立つ**（PO要望 2026-08-11）。番頭が `canvas.open` を
           * 思い出したときだけ、では忘れたときに見えない——枝の札（決定77）と同じく
           * 機構にする。「どこにも出ていない職人は起こせない」。
           */
          const carded = withWorkerCard(guarded, (utsuwa) => server.showUtsuwa(threadId, utsuwa));
          /**
           * **等級が空いていて起こせなかったら取次へ**（ADR-0021 決定104）。
           * 直せるのは PO だけ（設定の口は番頭に渡していない・決定41c）なので、
           * 会話のエラーで終わらせない。
           */
          return withTierUnassignedNotice(carded, { inbox, threadId });
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
        // **戻すときも宛先を固定する**（PO報告 2026-08-10）。当時は `work/tasks/*.md`
        // から取り込まれたタスクに宛先が無く、番頭が会話から戻しても付かないままで、
        // 知らせが帳場へ流れ込んでいた（task-0089）。戻せと言った会話が宛先になる
        // ——第4便で取り込みの経路自体が消えたが、`reopen` 側の固定は残す
        if (tool.name === "kobo.enqueue" || tool.name === "kobo.reopen") {
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

    /**
     * 番頭の文脈と道具の材料。**バックエンドを問わず同じものを渡す**（ADR-0020 決定89）。
     */
    const stewardContextOptions: CreateBantoHostSessionOptions = {
      // **会話ごとに立場が違う**ので、そこだけを足して渡す（PO報告 2026-08-10）
      systemPrompt: SYSTEM_PROMPT + describeThread(identity),
      tools: ownTools,
      /**
       * **在庫と提示を分ける**（ADR-0019 決定82）。在庫は `ownTools` のまま全部、
       * モデルに見せるのは `PRESENTED_TOOL_NAMES` だけにする。
       *
       * **実測（2026-08-12・ローカル vLLM・n=80 の対比較）**: 100個そのままだと
       * 番頭は **48.8% のターンで道具を1本も呼ばない**。43本に絞ると 98.8%、
       * 散文の一覧を足すと 100%（いずれも p<0.001）。**埋もれた道具が呼ばれない**
       * のではなく、**道具箱ごと見えなくなっていた**。
       *
       * 本番の合成だけが true を渡す——試験や、少数の道具で組む呼び出し元を巻き込まない。
       */
      presentSelectedTools: true,
      // 番頭が呼べる道具すべてに掛かる（抜け道を作らない）
      turnBudget,
      // T4: 幹で委譲・調べ物をしたら枝へ促す。**断らない**（促すだけ）。枝では何も変わらない
      trunkNudge,
      memory,
      memoryTrunks: here,
      /**
       * 章の引き継ぎ資料を読む口（提案§3.2・inc-0050）。
       *
       * **セッションを組むところで渡す。** 以前は下の「逆引き用の写し」にしか足して
       * おらず、番頭の道具箱に入っていなかった——文脈には見出しだけが載るのに詳細を
       * 引く手段が無く、段階的開示の後半が丸ごと欠けていた。記憶・SKILL・成果物と
       * 同じ場所で組めば、片方だけ足し忘れることが起きない
       */
      handoffs: { store: handoffs, threadId },
      // I2: 知らない幹へ黙って書かない。省略時はこの会話の幹（defaultTrunkId）
      knownTrunkIds: () => knownTrunks().map((t) => t.id),
      defaultTrunkId: () => identity?.trunkId,
      knownTrunkList: knownTrunks,
      artifacts,
      // 器が描けなかったときに出どころを名指しできるようにする（決定81(d)）
      artifactModuleOf: (name: string) => modules.moduleForTool(name)?.name,
      ...(artifactThresholdChars() !== undefined
        ? { artifactThresholdChars: artifactThresholdChars()! }
        : {}),
      moduleSkills: modules.skills(),
      learnedSkills,
      sessionManager,
      modelRuntime,
      ...(sessionModel ? { model: sessionModel } : {}),
    };

    const { session } = await createBantoHostSession(stewardContextOptions);
    // imp-0016: ツールコール（git status / file.read など）の後、次の LLM 応答が空
    // （text/toolCall なし・stopReason "stop"）だと pi が正常終了としてターンを閉じ、
    // 応答が止まる。withEmptyResponseGuard が空応答を continue() で再試行する。
    // 再試行はガードの中で完結するので、server は HostSession 契約のまま無変更（決定3）
    const guardedSession = withEmptyResponseGuard(session);
    /**
     * **バックエンドを選ぶ**（ADR-0020 決定88・95）。設定は起動時に読む——走っている
     * 会話の途中で会話のやり方は変えられない（設定画面も `restartRequired`）。
     *
     * Agent SDK は **Claude 以外のモデルに繋げない**（公式が明文で非対応）。
     * ローカルの無料モデルで回したいなら pi を選ぶ。
     *
     * ここから先、番頭のターンループは `BantoHarness` の語彙だけで動く——pi の
     * `agent.state.messages` や `sessionManager` に触るのは皮の内側だけになる。
     */
    /**
     * **バックエンドは provider の上位の階層**（PO裁定 2026-08-13）。
     *
     * `opus` は pi（opencode zen）経由でも Agent SDK 経由でも選べるので、
     * **モデル名からバックエンドは決まらない**。人が選ぶのは
     * 「バックエンド → プロバイダ → モデル」の3段で、選び直しは会話の途中でできる。
     *
     * 作り手を両方持っておく——差し替えのたびに組み立て直せるようにするため。
     */
    /**
     * **組み立ては pi と共通**（`assembleStewardContext`）。
     *
     * ここを別に組んでいたせいで、Agent SDK の番頭には**記憶も SKILL も散文の道具一覧も
     * 退避もターン予算も無かった**（レビュー 2026-08-13 で発覚。本番の既定がそれだった）。
     * D11・決定47a・暴走を止めるターン予算は、**どのバックエンドでも同じように効く**必要がある。
     */
    /**
     * **この会話の Claude 側の皮**（task-0165）。
     *
     * 中身（`ClaudeAgentHarness` ＝ Claude Code の子プロセス）は**遅らせて組み、
     * 触られなくなったら畳む**。畳んでも札（決定97・task-0104）は皮が持つので、
     * 次の発話で同じ会話の続きとして戻る——モデルを替えても会話は続く。
     * 皮そのものは会話の生涯で1本のまま（`Thread.harness` の差し替えを起こさない）。
     */
    let claudeHarness: PooledSdkHarness | undefined;
    /** 皮に被せた分（未処理の1行・ターン予算）。**組み直しても同じものを返す**。 */
    let claudeWrapped: BantoHarness | undefined;
    /**
     * 章を畳んでいる最中かを訊く口。**`chapters` はこの下で組まれる**ので、後から差す
     * ——畳み中の会話を安全弁に畳ませないための掛け金（imp-0052 と同じ理由）。
     */
    let chapterGateRef: { isClosing(): boolean } | undefined;
    /**
     * imp-0036(c): 未処理を抱えた枝の件数を、**幹の文脈に1行**足す皮。
     *
     * **両バックエンドに掛ける**——片方だけに掛かる形は、ターン予算が一度やった失敗。
     * 幹でなければ何も足さない（`kind` を渡すのはそのため）。
     */
    const unsettledNotice = (harness: BantoHarness): BantoHarness =>
      withUnsettledRemainingNotice(harness, {
        kind: identity?.kind,
        // 呼ぶたびに数え直す（降ろした次のターンからは出ない）
        branches: () => threads.unsettledBranches(threadId),
      });
    const makeClaudeHarness = (model?: string): BantoHarness => {
      /**
       * **皮は1本しか作らない**（task-0165）。
       *
       * 以前はここで毎回 `ClaudeAgentHarness` を組み直していた（`PromptQueue` は
       * 「空になっても終わらせない」ので、前のものを畳んでから作る必要がある）。
       * いまはその「畳んで組み直す」を皮の中へ入れてある——組み直しの理由が
       * モデルの選び直しでも、安全弁でも、上限でも同じ形になる。
       */
      if (!claudeHarness) {
        claudeHarness = new PooledSdkHarness({
          threadId,
          pool: sdkSessions,
          ...(resumeBackendSession ? { resume: resumeBackendSession } : {}),
          ...(model ? { model } : {}),
          // 章を畳んでいる最中は安全弁に畳ませない（返事と要約の相手が消える）
          held: () => chapterGateRef?.isClosing() === true,
          /**
           * **組み立ては起こすたびにやり直す**——記憶も SKILL も、畳んでいる間に
           * 増えていることがある（`assembleStewardContext` は毎回読み直す）。
           */
          create: ({ resume, model: chosen }) => {
            const assembled = assembleStewardContext(stewardContextOptions);
            return new ClaudeAgentHarness({
              systemPrompt: assembled.systemPrompt,
              // 提示する集合だけを載せる（ADR-0019 決定82）。組み込みは `tools: []` で0本
              tools: selectPresentedTools(assembled.tools),
              ...(chosen ? { model: chosen } : {}),
              ...(resume ? { resume } : {}),
            });
          },
        });
        claudeWrapped = unsettledNotice(withTurnBudgetReset(claudeHarness, turnBudget));
      }
      // 選び直しなら生きている中身を畳む（次の発話で新しいモデルの側が起きる）
      claudeHarness.selectModel(model);
      return claudeWrapped!;
    };

    /**
     * **ターン予算の数え直しはバックエンドの継ぎ目で掛ける**（PO報告 2026-08-13）。
     *
     * 以前は `HostSession` を包んだ皮の中で `reset()` していたが、その皮は
     * pi にしか渡らず、Agent SDK 側では**一度も数え直されなかった**——本番の既定が
     * そちらで、PO が話しかけるほど数えが積み上がり、新しい指示ごと断られた。
     * ここで包めば、番頭のターンを回す入力は出所に依らず全部 `prompt()` を通る。
     *
     * imp-0036(c) の「未処理 N件」の1行も**同じ継ぎ目**で足す（`unsettledNotice`）。
     * **ターンは起こさない**（ADR-0025 決定120）：既に起きたターンの入力に足すだけで、
     * 札も取次も `prompt` の呼び出しも増やさない。
     */
    const piHarness: BantoHarness = unsettledNotice(
      withTurnBudgetReset(
        new PiHarness({
          // 会話の口は皮を通す（空応答ガード）
          session: guardedSession,
          // 文脈と章の操作は pi の本体でしか出来ない。**皮では届かない**
          agentSession: session,
          toLogicalName: (wireName) => {
            try {
              return fromWireToolName(wireName);
            } catch {
              // 名前空間規則に従わない名前（pi 組み込み等）はそのまま通す
              return wireName;
            }
          },
          renderTranscript,
        }),
        turnBudget
      )
    );

    /**
     * この会話が始まるバックエンド。会話ごとの指定（索引に残る）→ 設定の既定 → pi。
     * **走り出しは片方だけ組む**のではなく pi は常に組む——章立てが pi の
     * セッションに紐づいており、戻ってきたときに文脈が残っている必要があるため。
     */
    const stewardRole = llmCatalog.roles().steward;
    /**
     * この会話が始まるバックエンド。
     *
     * **会話に記録があるなら、それが勝つ**——索引に `backend` が無い記録は
     * バックエンドという概念より前のもので、**pi を指している**（他に無かった）。
     * ここで既定へ落とすと、pi のモデルで話していた会話が黙って別のバックエンドで
     * 起き直る（実機で 52 会話が丸ごとそうなった）。
     */
    const startBackend = wantedModel
      ? (wantedModel.backend ?? "pi")
      : (stewardRole?.backend ?? "pi");
    /**
     * **クオータ節約**: Claude で始まるはずの会話でも、枠が尽きかけていたら pi で始める。
     * 会話を黙って別のバックエンドで起こし直すのは避けたいが（上の注記）、これは
     * Claude が「選べない」状態なので、選べないものを選ばせない（I2・決定98a）の形。
     * ログに理由を出し、画面（`unavailable()`）も同じ事情を映す。
     */
    const claudeStopped = claudeQuota.shouldStop();
    const effectiveBackend =
      startBackend === "claude-agent-sdk" && claudeStopped ? "pi" : startBackend;
    if (effectiveBackend !== startBackend) {
      const s = claudeQuota.snapshot();
      console.log(
        `[banto] Claude サブスクの枠が尽きかけました（残り ${
          s.remainingPct === undefined ? "?" : `${s.remainingPct.toFixed(0)}%`
        }）—— ${threadId} は pi で始めます`
      );
    }
    const harness: BantoHarness =
      effectiveBackend === "claude-agent-sdk"
        ? makeClaudeHarness(
            wantedModel?.backend === "claude-agent-sdk" ? wantedModel.id : stewardRole?.model
          )
        : piHarness;
    harnessSwitchers.set(threadId, {
      pi: () => piHarness,
      claude: makeClaudeHarness,
      /**
       * **pi へ戻すときに Claude 側を畳む**（決定97）。札は残すので、また Claude を
       * 選べば同じ文脈から続く——畳むのは走っているプロセスだけ。
       */
      releaseClaude: () => {
        // 皮は残す（札もそこに残る）。畳むのは走っている中身だけ
        void claudeHarness?.release("pi へ戻した").catch((err: unknown) => {
          console.error(
            `[banto] ${threadId} の SDK セッションを畳めませんでした: ${String(err)}` +
              "——会話はそのまま続きます"
          );
        });
      },
    });
    /**
     * 実行中に枠が尽きかけたら、**その場で pi へ差し替える**（自動フォールバック）。
     *
     * 起きるのは定期の再計測（数分に一度）。既に pi の会話は何もしない。`server` は
     * この下（`BantoHostServer.start`）でしか使えないが、契機はその後にしか来ないので
     * クロージャから参照して良い。差し替えと同時に Claude 側の子プロセスを畳む。
     */
    let stopSub: (() => void) | undefined;
    if (claudeQuota.onStopCrossing) {
      stopSub = claudeQuota.onStopCrossing((snap) => {
        const thread = threads.get(threadId);
        if (!thread || thread.harness !== claudeWrapped) return;
        server?.swapHarness(threadId, piHarness, () =>
          harnessSwitchers.get(threadId)?.releaseClaude()
        );
        console.log(
          `[banto] Claude サブスクの枠が尽きかけました（残り ${
            snap.remainingPct === undefined ? "?" : `${snap.remainingPct.toFixed(0)}%`
          }）—— ${threadId} を pi に切り替えました`
        );
      });
    }

    // 提案§3.2: 自動コンパクションを切り（ハーネスが済ませた）、章立てに置き換える。
    //
    // **要約器は本セッションと別の呼び出し**（決定28）。**会話のモデルへは頼らない**
    // （task-0151・inc-0068）——既定は claude-agent-sdk の haiku で固定。指定は
    // 環境変数 BANTO_CHAPTER_MODEL > 画面の設定「章の要約に使うモデル」> 既定の順
    // （README を参照）。指定が解決できないときも黙って別物へ落とさない（I2・a4）。
    const chapterModelResolution = resolveChapterModel({
      envRaw: process.env["BANTO_CHAPTER_MODEL"],
      settingsValue: settings.all().chapterModel,
      backends: harnessBackends,
    });
    if (chapterModelResolution.fallback) {
      const { requested, reason, from } = chapterModelResolution.fallback;
      const requestedLabel = "raw" in requested ? requested.raw : chapterModelLabel(requested);
      console.warn(
        `[banto] ${threadId}: 章の要約モデルの指定（${
          from === "env" ? "BANTO_CHAPTER_MODEL" : "設定「章の要約に使うモデル」"
        }: ${requestedLabel}）を解決できません（${reason}）。既定（${chapterModelLabel(
          DEFAULT_CHAPTER_MODEL
        )}）を使います`
      );
    }
    let chapterRef = chapterModelResolution.ref;
    /**
     * **クオータ節約**: 枠が尽きかけていたら、章の要約も Claude を使わず pi へ落とす
     * （PO裁定：両方止める）。会話と同じ pi モデル（`model`）で足りる——要約は安い
     * モデルで書く方針（task-0151）だが、会話を回しているモデルなら必ず解ける。
     * pi のモデルが1つも無い環境では Claude のまま（できる範囲のベスト）。pi の登録で
     * 解けない場合は黙って Claude を落とさない（I2）。
     */
    if (claudeQuota.shouldStop() && chapterRef.backend === "claude-agent-sdk") {
      const fallback =
        model?.provider && model?.id && resolveModel(model.provider, model.id)
          ? ({ backend: "pi", provider: model.provider, model: model.id } as const)
          : undefined;
      if (fallback) {
        console.log(
          `[banto] ${threadId}: 章の要約も pi へ切り替えます（${chapterModelLabel(
            chapterRef
          )} → ${chapterModelLabel(fallback)}／クオータ節約）`
        );
        chapterRef = fallback;
      }
    }
    // pi 経由なら、この会話とは無関係にモデル実体を解決する（記憶抽出にも使う）。
    // `resolveChapterModel` が既に `supports()` で確かめているので、pi のときは必ず解ける
    const chapterPiModel =
      chapterRef.backend === "pi" ? resolveModel(chapterRef.provider, chapterRef.model) : undefined;
    const chapterComplete: ChapterCompleter =
      chapterRef.backend === "claude-agent-sdk"
        ? createClaudeChapterCompleter(chapterRef.model)
        : createPiChapterCompleter(chapterPiModel!, (m) => modelRegistry.getApiKeyAndHeaders(m));
    /**
     * 記憶の抽出（`createLlmMemoryExtractor`）は今のところ pi 経由でしか呼べない
     * （このタスクの範囲外・別途 inc として追う論点）。章の要約が claude-agent-sdk を
     * 選んでいるときは、記憶の抽出だけ会話のモデルへ戻す——以前からの fallback と同じ形
     */
    const memoryModel = chapterPiModel ?? sessionModel;

    const chapters = new ChapterKeeper({
      // **いまのハーネスを毎回引く**——差し替えに追随する（PO要望 2026-08-13）
      harness: () => threads.get(threadId)?.harness ?? harness,
      store: handoffs,
      threadId,
      summarize: createLlmChapterSummarizer({
        modelRef: chapterRef,
        ...(chapterPiModel?.maxTokens ? { modelMaxTokens: chapterPiModel.maxTokens } : {}),
        complete: chapterComplete,
        ...(chapterModelResolution.fallback ? { fallback: chapterModelResolution.fallback } : {}),
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
      ...(memoryModel
        ? {
            extractMemories: async (transcript: string) => {
              const person = memory.forPerson();
              const deltas = await createLlmMemoryExtractor({
                model: memoryModel,
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
          }
        : {}),
      ...(chapterThresholdRatio() !== undefined
        ? { thresholdRatio: chapterThresholdRatio()! }
        : {}),
      onChapterClosed: (record) => {
        /**
         * 畳んだことは隠さない——が、**番頭には言わない**（PO報告 2026-08-11）。
         *
         * 知らせ（`notify`）で流していたので、畳むたびに**ターンが回っていた**。
         * 番頭は畳んだばかりの空の文脈で、PO が何も頼んでいないのに `thread.list`・
         * `inbox.list`・`kobo.list` と調べ始める——押した側から見れば「区切ったのに
         * 勝手に喋り出す」で、軽くしたはずの文脈もその場で埋め直される。
         *
         * 章の頭には引き継ぎ資料が入っている（`renderChapterOpening`）ので、番頭に
         * 改めて教える必要はない。**画面に区切りの線が1本入れば足りる**。
         */
        server.markChapter(threadId, record.chapter, record.summary.topic);
      },
      /**
       * **畳めなかったことも隠さない**（inc-0050）。
       *
       * 畳めないと文脈は増え続ける。黙って毎ターン試し続けると、POには
       * 「そのうち急に何も入らなくなる」形でだけ現れる。出しておけば手が打てる。
       */
      onCloseFailed: (err) => {
        /**
         * 見直す先は**理由の側が名乗る**（inc-0068）。ここで
         * 「BANTO_CHAPTER_MODEL を見直してください」と一律に足していたが、
         * 実際に使われていたモデルが分からないと、どの設定を触るか決まらない
         * ——要約器が使ったモデル・入力の大きさ・出力上限・やり直したかは
         * `String(err)` に載っている。
         */
        server.notify(
          `章を畳めませんでした（${String(err)}）。文脈はそのまま伸び続けます` +
            "——このまま続けると入らなくなるので、区切りのよいところで新しい幹へ移してください。",
          { threadId, source: "system" }
        );
      },
    });
    chapters.start();
    /**
     * **章を畳んでいる最中は SDK セッションを畳ませない**（task-0165 a4）。
     *
     * `chapters` はハーネスの後に組まれるので、掛け金はここで差す
     * ——畳み中に安全弁が中身を捨てると、要約の相手も `startChapter` の相手も消える。
     */
    chapterGateRef = chapters;

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
      harness,
      canvas,
      tools,
      /**
       * **PO がその場で章を畳む口**（決定25 の人側）。
       *
       * 閾値は文脈の量しか見ないが、区切りは人にも分かる——「この話は終わったので、
       * ここから先は別の前提で進めたい」は量では拾えない。**要約に使えるモデルは
       * 常に用意される**（task-0151：既定 haiku まで落ちるので、以前のように
       * 章立てそのものを始めないことは無い）。
       */
      // **畳めたかどうかを返す**——溜まっていない章は畳みようがなく、黙って何も
      // 起きないと押した側からは壊れて見える（PO報告 2026-08-11）
      closeChapter: async () => (await chapters.closeChapter()) !== undefined,
      /**
       * **畳んでいる間の発話を待たせる口**（imp-0052）。サーバはこれを見て、
       * これから捨てるセッションへ発話を渡さない——渡すと答えかけたところで切られる。
       */
      chapterGate: chapters,
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
        // 再開するかは**先に**引く。`resumeInterruptedTurn` は待たずに流すので（起動を
        // 1ターン分ぶら下げない）、戻り値では間に合わない——失われたターンの回収と
        // 二重に起こさないために、判定だけここで取る
        const resuming = hasInterruptedTurn(session);
        void resumeInterruptedTurn(session);
        return resuming;
      },
      dispose: () => {
        chapters?.stop();
        session.dispose();
        // 決定97: 会話を畳んだら Claude 側も畳む（`Thread.dispose` はいまのハーネスしか
        // 知らない——pi へ戻したあとに残っている Claude のセッションはここでしか届かない）
        void claudeHarness?.dispose();
        // クオータの契機の購読も外す（畳んだ会話を掴んだままにしない）
        stopSub?.();
        // 作り手の表からも外す（残すと畳んだ会話の作り手を掴んだままになる）
        harnessSwitchers.delete(threadId);
      },
    };
  };

  // I2: 場所で分けていた頃の記憶が残っていたら名指しする（自動では移さない）
  warnStrandedPlaceMemory();

  // task-0036: 会話はホストの再起動を越えて残る
  const threadStore = new ThreadStore(path.join(dataDir(), "threads"), undefined, inbox);
  threads = new ThreadRegistry(threadFactory, threadStore);
  /**
   * **会話を起こす前に、まずクオータの残量を測る**（起動時のフォールバックを効かせる）。
   * 残量が分からないまま `startBackend` を決めると、枠が尽きていても Claude で起きて
   * 消費を始めてしまう。認証が無い環境ではそのまま即返る（計測しない・I2）。測ったら
   * 背後での定期監視も始める——実行中に枠を切ったときの自動フォールバック用。
   */
  await claudeQuota.refresh();
  claudeQuota.start();
  /**
   * 読み戻しは**中断されたターンの後片付けも兼ねる**（imp-0037）。
   *
   * 落ちる前に走っていた道具を `ok`/`failed` に確定させ、再起動を呼んだ会話へは
   * 「続きを進めてください」を1件記録し、PO へは取次で1件知らせる。返るのは
   * **ターンを回す宛先**——回すのはサーバが立ってからなので、ここでは受け取るだけ。
   */
  const resumeAfterRestart = await threads.restore(inbox);
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
    // T1: ターンの台帳。幹のターンが何本回り、どの出所から来たかを後から数える
    // T4: そのターンで道具を何回呼んだか（うち閲覧系が何回か）も一緒に残す
    //     ——促しの閾値をどこに引くかは、この実測が出てから PO が決める
    turnLog: new TurnLog(defaultTurnLogPath(), (threadId) => turnCounts.get(threadId)?.counts()),
    inbox,
    userThemes,
    port: settings.all().network?.port ?? options.port,
    catalog,
    modules,
    // ADR-0011 決定42: 中核の Tool も HTTP に出す（中核由来のGUIの到達先）
    coreTools: llmAllTools,
    /**
     * 取次で押された選択肢を効かせる（決定73）。
     *
     * **引くのはモジュールの帳簿**（決定27：Banto をブローカーにしない）。呼ぶ先は
     * 普通 `internalTools`——番頭には渡していない口を、POが押したときだけホストが呼ぶ。
     *
     * I2: 知らないモジュール・知らない Tool は黙って成功にしない。押した側は
     *     効いたつもりでいるので、効かなかったことは必ず返す。
     */
    runInboxEffect: async (effect, origin) => {
      const tools =
        effect.module === CORE_ORIGIN
          ? llmAllTools
          : (() => {
              const owner = modules.get(effect.module);
              if (!owner) throw new Error(`モジュール "${effect.module}" は登録されていません`);
              return [...owner.tools, ...(owner.internalTools ?? [])];
            })();
      const tool = tools.find((t) => t.name === effect.tool);
      if (!tool) {
        throw new Error(`"${effect.module}" に Tool "${effect.tool}" はありません`);
      }
      /**
       * **どの札のどの回答で押されたか**を、効果が望んだ名前の引数として渡す（決定113）。
       *
       * 積む時点では札の id が無いので、埋められるのはここだけ。工場の PO 承認は
       * これを `task_approved.via` として帳簿へ書く——合言葉をやめた代わりに、
       * 監査可能性はこの記録が担う。
       */
      const args = {
        ...(effect.args ?? {}),
        ...(effect.originArg
          ? { [effect.originArg]: `inbox:${origin.itemId}#${origin.actionId}` }
          : {}),
      };
      const result = await tool.execute(args as never, {
        toolCallId: `inbox-${Date.now()}`,
      });
      return result.content.map((c) => c.text ?? "").join("").trim();
    },
    // task-0048: ビルド済み UI があれば同じポートで配る（常駐させるときの形）
    ...(webDir ? { webDir } : {}),
    // 画像添付の可否判定（/api/model）。id は指定されたモデル名のまま
    // （解決で API 送信用 id に変わる場合があるため——MODEL_ALIASES）。
    //
    // **能力は「標準そのものを解けたとき」だけ名乗る**（`hostModelInfo`）。
    // `resolveHostDefault()` が代打へ落ちていたときにその vision / contextWindow を
    // 標準の値として出すと、名前は `opus` なのに中身は無関係なモデル、になる
    ...(model && hostDefault
      ? {
          model: hostModelInfo({
            steward: hostDefault,
            resolved: resolvedModel
              ? {
                  provider: resolvedModel.provider,
                  id: resolvedModel.id,
                  vision: model.input.includes("image"),
                  ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                }
              : undefined,
            resolveExact: (p, m) => llmCatalog.resolveExact(p, m),
          }),
        }
      : {}),
    ...(currentProvider ? { modelProvider: currentProvider } : {}),
    /**
     * 画面からモデルを変える口（決定：番頭は具体モデルを持つ／ADR-0004）。
     *
     * **その会話だけに効かせる**（PO裁定 2026-08-04）。既定は書き換えない——新しい会話の
     * 既定は `roles.steward`（設定画面「番頭が使うモデル」）が持つ。
     * I2: 解決できない・ハーネスが対応していないときは throw して、画面を前のままにする。
     */
    onSelectModel: async (thread, nextProvider: string, nextId: string, nextBackend?: string) => {
      const backend = nextBackend ?? thread.model?.backend ?? "pi";
      const switcher = harnessSwitchers.get(thread.id);

      /**
       * **回せるかはバックエンドに聞く**（決定98a）。`undefined` ではなく
       * `NotSupported` が返るので、断る理由と**次にどうすればよいか**をそのまま出せる。
       */
      const chosen = backendById.get(backend);
      // I2: 知らないバックエンドを黙って pi として扱わない（別の経路で開いてしまう）
      if (!chosen) throw new Error(`バックエンド "${backend}" は登録されていません`);
      const support = chosen.supports({ provider: nextProvider, model: nextId });
      if (support !== true) throw new Error(support.reason);

      /**
       * **Claude Code のときはモデルの別名をそのまま渡す**（決定94）。
       * Agent SDK は Claude 以外へ繋げないので、LLM 登録での解決はしない
       * ——登録に載らないモデル（`opus` 等）を「使えない」と断ってしまう。
       */
      if (backend === "claude-agent-sdk") {
        if (!switcher) throw new Error("この会話はバックエンドを差し替えられません");
        const harness = switcher.claude(nextId);
        console.log(`[banto] backend(${thread.id}): claude-agent-sdk / ${nextId}`);
        /**
         * 画像は渡せる。harness が画像ブロックを SDK へ流し込む
         * （`claude-agent-harness.ts` の `toSdkImageBlocks`／実測 2026-08-15）。
         * **`hostModelInfo()` と揃えること**——片方だけだとモデルを選び直した
         * 瞬間に名乗りが嘘に戻る。文脈長は依然として名乗らない（分からないので）
         */
        return { id: nextId, vision: true, backend, harness };
      }

      // ここまで来れば pi が解決できることは `supports` が確かめている
      const next = resolveModel(nextProvider, nextId)!;

      // pi へ戻す（あるいは pi のまま）。**同じ pi セッションへ戻る**ので文脈も戻る
      const back = thread.model?.backend === "claude-agent-sdk" ? switcher?.pi() : undefined;
      // 決定97: 戻ったら Claude 側は畳む（放すだけでは子プロセスが残る）
      if (back) switcher?.releaseClaude();
      const target = back ?? thread.harness;
      if (!target.setModel) {
        throw new Error("このハーネスは動作中のモデル切替に対応していません");
      }
      // **その会話だけ**に効かせる。他の会話は自分のモデルのまま（PO裁定 2026-08-04）
      await target.setModel(next);
      console.log(`[banto] model(${thread.id}): ${backend} / ${nextProvider}/${nextId}`);
      return {
        id: nextId,
        vision: next.input.includes("image"),
        backend,
        ...(back ? { harness: back } : {}),
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
  const resumedPending = new Set<string>();
  for (const thread of threads.list()) {
    if (await thread.resumePendingTurn?.()) resumedPending.add(thread.id);
  }

  /**
   * **再起動をまたいだ会話を、番頭の側から起こす**（imp-0037）。
   *
   * `system.restart` を呼んだターンは、返事を返す前にプロセスが消えていた。誰も
   * 話しかけなければ番頭は黙ったままで、PO には「固まった」に見えていた
   * ——SKILL `safe-restart` の手順5「再起動後を確かめる」が実行不可能だった理由がこれ。
   *
   * 知らせの行は読み戻し（`threads.restore`）が既に記録しているので、ここは
   * **ターンを回すだけ**（決定107 の `nudge` と同じ分担。`notify` を使うと同じ一言が
   * 二重に積まれる）。待たない——起動を1ターン分ぶら下げる理由がない。
   */
  for (const threadId of resumeAfterRestart) {
    void server.nudge(threadId, RESTART_RESUME_NOTICE).catch(
      (err: unknown) => {
        // I2: 起こせなかったことを黙らせない（また番頭が黙ったままになる）
        console.error(`[banto] ${threadId} の続きを起こせませんでした: ${String(err)}`);
      }
    );
  }

  /**
   * **道具を1回も呼ぶ前に落ちたターンを起こし直す**（inc: thread-104）。上の2つの回収の
   * 3つ目で、そこで既に起こした会話は外す。判定と方針は `lost-turn.ts`（D5: ここは配線）。
   */
  recoverLostTurns({
    threads: threads.list(),
    alreadyResumed: new Set([...resumedPending, ...resumeAfterRestart]),
    nudge: (threadId, message) => server.nudge(threadId, message),
  });

  // 決定29: 番頭が起こした職人のイベントだけを受ける。他の起動元（Kobo 等）の分は届かない。
  // 起動前に溜まっていた古い報告は今さら流さない（最初の1回で今の位置まで進める）。
  //
  // **引きに行く形**（task-0066）。工房が別プロセスになったので同一プロセスの購読は使えない
  // ——Kobo と同じく `worker.events` を `afterEventId` で追う。
  //
  // 決定35a: 宛先は**起こしたスレッド**。origin を見て振り分ける。
  //
  // inc-0069: 読み位置はファイルに持ち、**配り終えた分までしか進めない**。落ちている
  // 間に出た報告と、積んだまま配れていなかった報告が、再起動で消えないようにする。
  const stopWorkerNotices = startWorkerNotices({
    tools: modules.tools(),
    notify: (message, target) => server.notify(message, { ...target, source: "worker" }),
    cursorPath: path.join(dataDir(), "worker-cursor.json"),
  });

  // 決定58: 工場の判断待ちは**積んだスレッド**へ返る。別プロセスなので引きに行く形
  // （`afterEventId` で、落ちている間に起きたことも取りこぼさない）
  const stopKoboNotices = startKoboNotices({
    tools: koboModule.tools,
    notify: (message, target) =>
      server.notify(message, { ...target, source: "kobo" }),
    cursorPath: path.join(dataDir(), "kobo-cursor.json"),
    // 決定57・task-0273 穴2: タスクが終端（supersede / settle / abandon / close）に
    // 入ったら、そのタスクに紐づく未解決の取次（PO レビュー依頼・改訂の確認など）を
    // 「古い」として自動で畳む。黙って消さず、履歴に stale:<状態> として残す。
    onTaskClosed: ({ projectTag, taskId, to }) => {
      resolveStaleInboxForTask(inbox, projectTag, taskId, to);
    },
    // task-0276: 仕組導入前に残った stale 取次を起動時に掃く。工場が終端（closed /
    // superseded）としているタスクを全部挙げ、それぞれに紐づく未解決の取次を
    // `resolveStaleInboxForTask` で「古い」として畳む（黙って消さず、履歴に理由を残す）。
    // 将来の終端遷移は上の `onTaskClosed` が受け持つ——掃くのは起動時の1回だけ。
    sweepStaleOnStartup: async (invoke) => {
      await sweepStaleInboxForTerminalTasks(inbox, async (state) => {
        // task-0277: kobo.list は MAX_ROWS=100 で切り詰めるため、閉じたタスクが100件を
        // 超えると offset 無しでは終端タスクの一部が一覧に載らず、紐づく未解決の取次が
        // 畳まれず残る。offset を進めて**全部**を引き切るまで列挙する（a1・a2）。
        const tasks: Array<{ taskId: string; projectTag: string; status: string }> = [];
        let offset = 0;
        while (true) {
          const details = await invoke("kobo.list", { state, offset });
          const rows = ((details["tasks"] ?? []) as Array<{
            taskId: string;
            projectTag: string;
            status: string;
          }>);
          tasks.push(...rows);
          if (rows.length === 0) break;
          const total = details["total"] as number | undefined;
          offset += rows.length;
          // 引き切った（この state の全件に達した、または進まなくなった）ら終わり（I2）
          if (total === undefined || offset >= total) break;
        }
        return tasks;
      });
    },
  });

  // task-0067: 検証環境の衛生（畳み忘れ・畳み損ね・孤児）も引きに行く。**外に残ったものは
  // 費用**（I3）なので、番頭が落ちている間の分も届くように読み位置をファイルに持つ。
  // 宛先は既定スレッド——置き場全体の話で、特定の会話のものではない
  const stopEnvNotices = startEnvNotices({
    tools: modules.tools(),
    notify: (message, target) => server.notify(message, { ...target, source: "env" }),
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
    /**
     * **新しい会話が何で始まるか**を、そのまま出す（I1）。
     *
     * 以前はここが pi の解決結果だけを出しており、既定が Claude Code のときも
     * `huihui/...` と名乗って**嘘になっていた**。バックエンドまで含めて言う。
     */
    (() => {
      const steward = llmCatalog.roles().steward;
      if (steward) {
        return `[banto] model: ${steward.backend ?? "pi"} / ${steward.provider}/${steward.model}`;
      }
      return `[banto] model: ${model ? `pi / ${model.provider}/${model.id}` : "(pi の既定解決)"}`;
    })()
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
      // 安全弁の見回りも止める（畳むのはこの下の `threads.dispose()` が全部やる）
      sdkSessions.stop();
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
