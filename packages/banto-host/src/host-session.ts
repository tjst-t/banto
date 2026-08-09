/**
 * Banto host session — embeds pi's Agent SDK loop directly in this process (ADR-0010 決定11).
 *
 * SDK mode, not Extension API and not RPC mode: banto-host owns AgentSession construction
 * in-process, in TypeScript, so it gets direct access to message history and turn-boundary
 * events (needed for the memory injection / turn control that is 番頭's core job, D11).
 *
 * D5: no judgment logic here — this only assembles a session from the given
 * system prompt and namespaced tools. Turn control / memory injection are later tasks.
 * D6: uses only what createAgentSession() already exposes.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { ScopedMemory } from "@banto/core";
import { createArtifactTools } from "./artifact-tools.js";
import { withArtifactOffload, type ArtifactStore } from "./artifacts.js";
import { createMemoryTools, renderMemoryForPrompt } from "./memory-tools.js";
import { CORE_ORIGIN, resolveSkills, type SkillEntry } from "./module.js";
import { LEARNED_ORIGIN, type LearnedSkillStore } from "./skill-learning.js";
import { createSkillTools } from "./skill-tools.js";
import { loadBantoSkills, renderSkillsForPrompt } from "./skills.js";
import { toPiTool, type NamespacedToolDefinition } from "./tool-registry.js";

export interface CreateBantoHostSessionOptions {
  /** System prompt for this turn loop. Plain string here — real prompt content is a later task. */
  systemPrompt: string;
  /** Namespaced tools (kobo.*, canvas.*, ...) available to the session. */
  tools: NamespacedToolDefinition[];
  /**
   * 番頭の記憶（D11）。渡すと `memory.*` が自動で登録され、保存済みの記憶が
   * **予算のぶんだけ**システムプロンプトへ注入される（提案3.3）。
   * 省略すると記憶なしのセッションになる（テスト・使い捨て用途）。
   */
  memory?: ScopedMemory;
  /**
   * この会話で効くプロジェクト（ADR-0003 の第二層）。渡した場所の記憶だけが注入され、
   * 他のプロジェクトの記憶は**横断しない**。省略すると人の記憶だけ。
   */
  memoryPlaces?: readonly { id: string; label?: string }[];
  /** 記憶の注入に使うトークン予算。省略すると banto-core の既定。 */
  memoryTokenBudget?: number;
  /** `scope: "project"` の place を検算するための、登録済みの場所ID。 */
  knownPlaceIds?: () => readonly string[];
  /**
   * ツール出力の退避先（提案§3.1）。渡すと `artifact.read` が自動で登録され、
   * 大きなツール結果は栞に置き換わる。省略すると退避しない（テスト・使い捨て用途）。
   */
  artifacts?: ArtifactStore;
  /** 退避に回す大きさ（文字数）。省略すると `DEFAULT_ARTIFACT_THRESHOLD_CHARS`。 */
  artifactThresholdChars?: number;
  /**
   * 番頭核のSKILL（手続き記憶）を読み込むか。既定 true。
   * false にすると `packages/banto-host/skills/` を読まない（テスト用）。
   */
  loadBantoSkills?: boolean;
  /**
   * モジュールが提供するSKILL（決定26の第2層）。由来つきで渡す。
   * 優先順位は「番頭の学習層 > 既定」。学習層は `learnedSkills` で渡す。
   */
  moduleSkills?: SkillEntry[];
  /**
   * 番頭の学習層（決定26 の最上層・task-0017）。渡すと同名の既定を上書きし、
   * `skill.learn` / `skill.unlearn` が登録される。
   */
  learnedSkills?: LearnedSkillStore;
  /** Working directory for resource discovery. Default: process.cwd() */
  cwd?: string;
  /** Global pi config directory. Default: ~/.pi/agent */
  agentDir?: string;
  model?: CreateAgentSessionOptions["model"];
  /**
   * pi 0.84 で `authStorage` / `modelRegistry` は無くなり、資格情報とモデル表を
   * まとめて持つ `modelRuntime` に一本化された。渡さなければ pi が
   * `agentDir/auth.json` と `models.json` から自分で作る（従来と同じ既定）。
   */
  modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  sessionManager?: CreateAgentSessionOptions["sessionManager"];
}

/**
 * Creates a minimal Banto host agent session: the given system prompt, the given
 * namespaced tools, and none of pi's built-in coding tools (read/bash/edit/write) —
 * 番頭 delegates file-level work to 職人 (D10), it does not edit files itself here.
 *
 * Tools are handed to the SDK under their **wire names** (決定22): the logical dotted
 * contract (`kobo.query.ready`) is preserved on the Banto side, while the provider sees
 * `kobo__query__ready`, which openai-completions-compatible providers accept.
 *
 * `memory` を渡すと、番頭は記憶を持つ（D11）——保存済みの好み・習慣がシステムプロンプトへ
 * 注入され、`memory.save` / `memory.recall` で読み書きできる。
 */
export async function createBantoHostSession(
  options: CreateBantoHostSessionOptions
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();

  // SKILLは一覧だけをプロンプトに載せ、本体は skill.read で読ませる（progressive disclosure）。
  // pi 側の SKILL 機構は read ツールを前提とするため使わない（理由は skills.ts 冒頭）。
  //
  // 決定26: 番頭核の既定とモジュールの既定を、優先順位つきで解決する。学習層（task-0017）は
  // resolveSkills の先頭に差し込むだけで効くので、ここの形は変わらない。
  const coreSkills: SkillEntry[] =
    options.loadBantoSkills === false
      ? []
      : loadBantoSkills().map((skill) => ({ skill, origin: CORE_ORIGIN }));
  // 既定＝番頭核とモジュール。学習層はこの上に載る（決定26）
  const defaults = resolveSkills([coreSkills, options.moduleSkills ?? []]).map((e) => e.skill);
  // task-0017 a2: 学習層を**先頭**に置く。resolveSkills は先勝ちなので、これで既定を上書きする
  const learnedEntries: SkillEntry[] = (options.learnedSkills?.list() ?? []).map((entry) => ({
    skill: entry.skill,
    origin: LEARNED_ORIGIN,
  }));
  const skills = resolveSkills([
    learnedEntries,
    coreSkills,
    options.moduleSkills ?? [],
  ]).map((e) => e.skill);

  // 記憶とSKILL一覧をシステムプロンプトの末尾に足す。
  // 記憶はセッション開始時点の内容を焼き込むので、以後の保存分は memory.recall で読み直す。
  const sections = [
    options.systemPrompt,
    options.memory
      ? renderMemoryForPrompt(options.memory, {
          ...(options.memoryPlaces ? { places: options.memoryPlaces } : {}),
          ...(options.memoryTokenBudget !== undefined
            ? { tokenBudget: options.memoryTokenBudget }
            : {}),
        })
      : "",
    renderSkillsForPrompt(skills),
  ].filter((s) => s.length > 0);
  const systemPrompt = sections.join("\n\n");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();

  const tools = [
    ...options.tools,
    ...(options.memory
      ? createMemoryTools(
          options.memory,
          options.knownPlaceIds ? { knownPlaceIds: options.knownPlaceIds } : {}
        )
      : []),
    ...(skills.length > 0 || options.learnedSkills
      ? createSkillTools(skills, {
          ...(options.learnedSkills ? { learned: options.learnedSkills } : {}),
          defaults,
        })
      : []),
    ...(options.artifacts ? createArtifactTools(options.artifacts) : []),
  ];

  // 提案§3.1: 大きなツール結果は文脈に載せず、栞に置き換える。
  // **皮をかぶせるのは pi へ渡す直前**——挿入時に決めることでプレフィックスキャッシュを守る
  const offloaded = options.artifacts
    ? withArtifactOffload(
        tools,
        options.artifacts,
        options.artifactThresholdChars !== undefined
          ? { thresholdChars: options.artifactThresholdChars }
          : {}
      )
    : tools;

  return createAgentSession({
    cwd,
    agentDir,
    model: options.model,
    modelRuntime: options.modelRuntime,
    resourceLoader,
    noTools: "builtin",
    customTools: offloaded.map(toPiTool),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
  });
}
