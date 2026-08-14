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
import { createHandoffTools } from "./handoff-tools.js";
import type { HandoffStore } from "./handoffs.js";
import { CORE_ORIGIN, resolveSkills, type SkillEntry } from "./module.js";
import { LEARNED_ORIGIN, type LearnedSkillStore } from "./skill-learning.js";
import { createSkillTools } from "./skill-tools.js";
import { guardTurn, type TurnBudget } from "./turn-budget.js";
import { loadBantoSkills, renderSkillsForPrompt } from "./skills.js";
import { toPiTool, type NamespacedToolDefinition } from "./tool-registry.js";
import {
  presentedWireNames,
  renderToolCategories,
  selectPresentedTools,
} from "./presented-tools.js";

/** 提示の実数を出すのは起動につき1回だけ（会話ごとに52行出さない）。 */
let loggedPresentation = false;

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
   * この会話で効く幹（ADR-0003 の第二層）。渡した幹の記憶だけが注入され、
   * 他の幹の記憶は**横断しない**。省略すると人の記憶だけ。普通はちょうど1本。
   */
  memoryTrunks?: readonly { id: string; label?: string }[];
  /** `scope: "project"` で区画を省いたときの既定（＝この会話の幹）。 */
  defaultTrunkId?: () => string | undefined;
  /** 幹の一覧（`memory.search({ acrossTrunks: true })` が開く区画）。 */
  knownTrunkList?: () => readonly { id: string; label?: string }[];
  /** 記憶の注入に使うトークン予算。省略すると banto-core の既定。 */
  memoryTokenBudget?: number;
  /** `scope: "project"` の宛先を検算するための、いま在る幹のID。 */
  knownTrunkIds?: () => readonly string[];
  /**
   * ツール出力の退避先（提案§3.1）。渡すと `artifact.read` が自動で登録され、
   * 大きなツール結果は栞に置き換わる。省略すると退避しない（テスト・使い捨て用途）。
   */
  artifacts?: ArtifactStore;
  /**
   * 章の引き継ぎ資料の置き場（提案§3.2）。渡すと `handoff.read` / `handoff.list` が
   * 自動で登録される。**ここで組む**——`bin.ts` 側の一覧に足すだけだと、実際に
   * モデルへ渡る道具箱に入らない（inc-0050 でそうなっていた）。`threadId` が要る。
   */
  handoffs?: { store: HandoffStore; threadId: string };
  /** 退避に回す大きさ（文字数）。省略すると `DEFAULT_ARTIFACT_THRESHOLD_CHARS`。 */
  artifactThresholdChars?: number;
  /**
   * **ターンの予算**（PO報告 2026-08-11）。渡すと、番頭が呼べる道具すべてに掛かる。
   * 渡さないと掛からない（試験や、別の使い方をする呼び出し元のため）。
   */
  turnBudget?: TurnBudget;
  /**
   * Tool 名からモジュール名を引く（ADR-0017 決定81(d)）。
   *
   * 器が描けなかったときに「どのモジュールの・どの Tool か」を出すため——直せるのは
   * 登録した人なので、出所が分かる形で残す。渡さなければドメインで代用する。
   */
  artifactModuleOf?: (toolName: string) => string | undefined;
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
  /**
   * **在庫と提示を分ける**（ADR-0019 決定82）。true にすると、登録した道具のうち
   * `PRESENTED_TOOL_NAMES` に在るものだけをモデルへ見せ、**決定85 の並び**で渡す。
   * 併せて散文の一覧（決定84-5）をシステムプロンプトへ足す。
   *
   * 既定 false ＝ 従来どおり全部見せる。**本番の合成は `bin.ts` が true を渡す**
   * ——試験や別の使い方をする呼び出し元（少数の道具だけを渡す）を巻き込まないため。
   *
   * 隠すだけで**在庫からは外さない**ので、モジュールの HTTP 面（GUI）も
   * wire名→論理名の逆引きも生きたまま。
   */
  presentSelectedTools?: boolean;
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
/**
 * **番頭の文脈と道具を組み立てる**（バックエンド共通・ADR-0020 決定89）。
 *
 * ここで組むもの:
 * - 道具＝渡されたもの ＋ 記憶・引き継ぎ・SKILL・成果物の口
 * - 系プロンプト＝人格 ＋ **道具の散文一覧**（決定84-5）＋ **記憶の注入**（D11）＋ SKILL 一覧
 * - **皮**＝大きな結果の退避（決定47a）と**ターン予算**（全道具に一括）
 *
 * **バックエンドごとに組み直さない。** 以前はこの組み立てが pi 経路の内側にしかなく、
 * Agent SDK バックエンドの番頭は**記憶も SKILL も散文一覧も退避もターン予算も無い**
 * 状態で動いていた（レビュー 2026-08-13 で発覚。本番の既定がそれだった）。
 * D11「番頭は記憶を持つ」も、決定47a の退避も、暴走を止めるターン予算も、
 * **どのバックエンドでも同じように効く**必要がある。
 */
export function assembleStewardContext(options: CreateBantoHostSessionOptions): {
  tools: NamespacedToolDefinition[];
  systemPrompt: string;
} {
  const coreSkills: SkillEntry[] =
    options.loadBantoSkills === false
      ? []
      : loadBantoSkills().map((skill) => ({ skill, origin: CORE_ORIGIN }));
  const defaults = resolveSkills([coreSkills, options.moduleSkills ?? []]).map((e) => e.skill);
  const learnedEntries: SkillEntry[] = (options.learnedSkills?.list() ?? []).map((entry) => ({
    skill: entry.skill,
    origin: LEARNED_ORIGIN,
  }));
  const skills = resolveSkills([
    learnedEntries,
    coreSkills,
    options.moduleSkills ?? [],
  ]).map((e) => e.skill);

  const tools = [
    ...options.tools,
    ...(options.memory
      ? createMemoryTools(options.memory, {
          ...(options.knownTrunkIds ? { knownTrunkIds: options.knownTrunkIds } : {}),
          ...(options.defaultTrunkId ? { defaultTrunkId: options.defaultTrunkId } : {}),
          ...(options.knownTrunkList ? { knownTrunkList: options.knownTrunkList } : {}),
        })
      : []),
    ...(options.handoffs
      ? createHandoffTools(options.handoffs.store, options.handoffs.threadId)
      : []),
    ...(skills.length > 0 || options.learnedSkills
      ? createSkillTools(skills, {
          ...(options.learnedSkills ? { learned: options.learnedSkills } : {}),
          defaults,
        })
      : []),
    ...(options.artifacts ? createArtifactTools(options.artifacts) : []),
  ];

  const sections = [
    options.systemPrompt,
    options.presentSelectedTools ? renderToolCategories(selectPresentedTools(tools)) : "",
    options.memory
      ? renderMemoryForPrompt(options.memory, {
          ...(options.memoryTrunks ? { trunks: options.memoryTrunks } : {}),
          ...(options.memoryTokenBudget !== undefined
            ? { tokenBudget: options.memoryTokenBudget }
            : {}),
        })
      : "",
    renderSkillsForPrompt(skills),
  ].filter((s) => s.length > 0);

  // 提案§3.1: 大きなツール結果は文脈に載せず、栞に置き換える
  const offloaded = options.artifacts
    ? withArtifactOffload(tools, options.artifacts, {
        ...(options.artifactThresholdChars !== undefined
          ? { thresholdChars: options.artifactThresholdChars }
          : {}),
        ...(options.artifactModuleOf ? { moduleOf: options.artifactModuleOf } : {}),
      })
    : tools;

  // ターンの予算を**番頭が呼べる道具すべてに**掛ける（呼び出し側で選ぶと抜け道になる）
  const budgeted = options.turnBudget
    ? offloaded.map((tool) => guardTurn(tool, options.turnBudget!))
    : offloaded;

  return { tools: budgeted, systemPrompt: sections.join("\n\n") };
}

export async function createBantoHostSession(
  options: CreateBantoHostSessionOptions
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();

  // **組み立てはバックエンド共通**（`assembleStewardContext`）。ここで pi 固有の話に入る前に、
  // 記憶・SKILL・散文一覧・退避・ターン予算を済ませる
  const { tools: budgeted, systemPrompt } = assembleStewardContext(options);

  /**
   * **番頭は置き場のコンテキストファイルを読まない**（`noContextFiles`・PO指摘 2026-08-09）。
   *
   * pi の既定は cwd から `CLAUDE.md` / `AGENTS.md` を拾って**システムプロンプトの後ろへ
   * 継ぎ足す**。番頭ホストの cwd は systemd の `WorkingDirectory`＝**banto のインストール先**
   * なので、番頭は毎セッション **banto 自身の開発規約**（「P1: スコープ外パスに触らない」
   * 「npm run dev:web」「docs/spec/ を読め」…）を読まされていた。実測で
   * システムプロンプト 4,973 文字のうち 4,300 文字がそれだった。
   *
   * 二重に間違っている。①番頭は banto の開発者ではない——CLAUDE.md は
   * **banto を開発する側**（Claude Code）への指示であって、製品としての番頭の人格ではない。
   * ②仮に「案件の文脈を読む」のが正しいとしても、拾うのは**インストール先**であって
   * 相談している案件ではない。loamium の話をしていても banto の CLAUDE.md が載る。
   *
   * 番頭の人格は上の `sections` が組み立て、案件の知識は SKILL（決定26・progressive
   * disclosure）と `file.*` で**必要なときに**引く。置き場に落ちている物を黙って
   * 継ぎ足す経路は要らない。
   *
   * **職人はこの限りではない。** 職人の cwd はワークツリー＝その案件のリポジトリなので、
   * そこの `CLAUDE.md` を読むのは正しい（`pi-rpc-driver` はそのまま）。
   */
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd,
    agentDir,
    model: options.model,
    modelRuntime: options.modelRuntime,
    resourceLoader,
    noTools: "builtin",
    // **在庫**——全部登録する。提示は下で絞る（決定82）
    customTools: budgeted.map(toPiTool),
    sessionManager: options.sessionManager ?? SessionManager.inMemory(),
  });

  /**
   * **在庫と提示を分ける**（ADR-0019 決定82・83・85）。
   *
   * 登録は全部済ませたうえで、**モデルへ見せる集合だけ**を選び直す。`setActiveToolsByName`
   * は渡した順序をそのまま `agent.state.tools` にするので、**絞り込み（決定83）と
   * 並び替え（決定85）が同じ一手で済む**。
   *
   * なぜここか——`customTools` を減らすのではなく、登録の**後**で絞る。減らすと
   * モジュールの HTTP 面（`module-serve.ts`＝GUI）と wire名→論理名の逆引きが壊れる。
   * **隠すが、持っている。**
   *
   * pi の既定は「新しく登録された道具を自動で有効化する」（`_refreshToolRegistry`）。
   * その後にこれを呼ぶので、以後は選び直した集合が保たれる。
   *
   * 副作用に注意: この呼び出しは pi 側のシステムプロンプトも組み直すが、banto は
   * `systemPromptOverride` を使っているため**その結果は捨てられる**（＝プロンプトは動かない）。
   * 道具の散文一覧は上の `sections` で自前に載せている（決定84-5）。
   */
  if (options.presentSelectedTools) {
    const wireNames = presentedWireNames(budgeted);
    // I2: 表の道具が在庫に1本も無いなら、絞ると道具ゼロの番頭になる。黙って壊さない
    if (wireNames.length === 0) {
      throw new Error(
        "presentSelectedTools was requested but none of PRESENTED_TOOL_NAMES are registered."
      );
    }
    created.session.setActiveToolsByName(wireNames);
    /**
     * **絞った実数を1度だけ出す。**
     *
     * 観測面（`welcome.tools`・CLI の表示・受け入れ試験）が見ているのは**在庫の写し**なので、
     * そちらの数は絞っても動かない。実測（ADR-0019「実測で確かめること」①）で
     * 「仕分け後の道具数」を読むときに、**写しの数を見ると嘘になる**——inc-0050 で
     * 一度踏んだ「一覧が2つある」罠の裏返し。ここが唯一の真実。
     */
    if (!loggedPresentation) {
      loggedPresentation = true;
      console.log(`[banto] 道具: 提示 ${wireNames.length} / 在庫 ${budgeted.length}`);
    }
  }

  return created;
}
