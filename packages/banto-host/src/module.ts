/**
 * モジュール（Module）＝ Banto への登録単位（ADR-0010 決定25・27）。
 *
 * 1つのモジュールが次の4点をまとめて提供する：
 *   1. 接続情報 — Banto および UI がそのモジュールへ到達する先
 *   2. 番頭へ提供する Tool（決定1・決定9）
 *   3. キャンバスへ提供する GUI カタログエントリ（決定17）
 *   4. そのモジュールの SKILL（決定26。番頭の学習層が上書きできる既定）
 *
 * Kobo・基本GUIセット・Worker Pool はいずれもモジュールで、機構としては対等
 * （基本GUIセットと Worker Pool は常に同梱される「組み込みモジュール」）。
 *
 * D5: ここに判断は無い。登録の帳簿と、由来つきの束ね直しだけを行う。
 * I2: kind・Tool名・SKILL名の衝突は黙って上書きせず例外にする。
 *
 * 命名の注意（決定27a）：TypeScript では `module` が ES モジュールで埋まっているため、
 * 型・変数には `BantoModule` / `ModuleRegistry` のように接頭辞を付ける。
 */

import type { CanvasViewSpec } from "./canvas.js";
import type { BantoSkill } from "./skills.js";
import { toolDomain, type NamespacedToolName } from "./tool-namespace.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";

/** 番頭核自身が持つ SKILL・Tool の由来を表す予約語。モジュール名には使えない。 */
export const CORE_ORIGIN = "core";

/**
 * モジュールへの到達先。
 *
 * 絶対URL（外部モジュール。例 `http://localhost:3000`）または同一オリジンからの
 * 相対パス（組み込みモジュール。例 `/api/workspace`）を書く。組み込みは Banto ホスト
 * 自身が提供するため、UI は自分のオリジンに解決すればよい（決定25）。
 */
export interface ModuleEndpoint {
  baseUrl: string;
}

/** 登録単位。 */
export interface BantoModule {
  /**
   * モジュール名。Tool 名前空間ドメインの単位でもある（決定27a）。
   * 予約語 `core` は使えない。
   */
  name: string;
  /** 人が読む名前 */
  title: string;
  /** 何を担うモジュールかの説明 */
  description: string;
  /** 到達先 */
  endpoint: ModuleEndpoint;
  /** 番頭へ提供する Tool */
  tools: NamespacedToolDefinition[];
  /** キャンバスへ提供する GUI */
  views: CanvasViewSpec[];
  /** このモジュールが既定として出す SKILL */
  skills: BantoSkill[];
}

/** 由来つきの SKILL。番頭核のものは origin が `core`（決定26 の3層を区別するため）。 */
export interface SkillEntry {
  skill: BantoSkill;
  origin: string;
}

export interface ModuleRegistry {
  /** モジュールを登録する。名前・Tool名・kind・SKILL名の衝突は例外（I2）。 */
  register(module: BantoModule): void;
  /** 登録順のモジュール一覧。 */
  list(): BantoModule[];
  get(name: string): BantoModule | undefined;
  /** 全モジュールの Tool を束ねて返す（番頭のセッションへ渡す）。 */
  tools(): NamespacedToolDefinition[];
  /** 全モジュールの GUI を束ねて返す（キャンバスのカタログへ渡す）。 */
  views(): CanvasViewSpec[];
  /** 全モジュールの SKILL を由来つきで返す。 */
  skills(): SkillEntry[];
  /** ある GUI（kind）を提供しているモジュール。UI が接続情報を得るのに使う。 */
  moduleForView(kind: string): BantoModule | undefined;
  /** ある Tool を提供しているモジュール。 */
  moduleForTool(toolName: string): BantoModule | undefined;
}

export function createModuleRegistry(modules: BantoModule[] = []): ModuleRegistry {
  const byName = new Map<string, BantoModule>();
  const viewOwner = new Map<string, string>();
  const toolOwner = new Map<string, string>();
  const skillOwner = new Map<string, string>();

  const registry: ModuleRegistry = {
    register(module) {
      if (module.name === CORE_ORIGIN) {
        throw new Error(`Module name "${CORE_ORIGIN}" is reserved for Banto core.`);
      }
      if (byName.has(module.name)) {
        throw new Error(`Module "${module.name}" is already registered.`);
      }

      // I2: 衝突は黙って上書きしない。どのモジュールと衝突したかを添える。
      // 先に全件検査してから登録し、途中で失敗しても帳簿が半端に汚れないようにする。
      for (const tool of module.tools) {
        const owner = toolOwner.get(tool.name);
        if (owner) {
          throw new Error(`Tool "${tool.name}" is already provided by module "${owner}".`);
        }
      }
      for (const view of module.views) {
        const owner = viewOwner.get(view.kind);
        if (owner) {
          throw new Error(`Canvas view "${view.kind}" is already provided by module "${owner}".`);
        }
      }
      for (const skill of module.skills) {
        const owner = skillOwner.get(skill.name);
        if (owner) {
          throw new Error(`SKILL "${skill.name}" is already provided by module "${owner}".`);
        }
      }

      byName.set(module.name, module);
      for (const tool of module.tools) toolOwner.set(tool.name, module.name);
      for (const view of module.views) viewOwner.set(view.kind, module.name);
      for (const skill of module.skills) skillOwner.set(skill.name, module.name);
    },

    list: () => Array.from(byName.values()),
    get: (name) => byName.get(name),
    tools: () => Array.from(byName.values()).flatMap((m) => m.tools),
    views: () => Array.from(byName.values()).flatMap((m) => m.views),
    skills: () =>
      Array.from(byName.values()).flatMap((m) =>
        m.skills.map((skill) => ({ skill, origin: m.name }))
      ),
    moduleForView: (kind) => {
      const owner = viewOwner.get(kind);
      return owner === undefined ? undefined : byName.get(owner);
    },
    moduleForTool: (toolName) => {
      const owner = toolOwner.get(toolName);
      return owner === undefined ? undefined : byName.get(owner);
    },
  };

  for (const module of modules) registry.register(module);
  return registry;
}

/**
 * SKILL を優先順位順に解決する（決定26）。
 *
 * 先に渡した層が勝つ。番頭の学習層は先頭に差し込む想定で、学習層の実装（task-0017）が
 * 入っても呼び出し側の形は変わらない。
 *
 * @param layers 優先順位の高い順に並べた SKILL の層
 */
export function resolveSkills(layers: SkillEntry[][]): SkillEntry[] {
  const resolved = new Map<string, SkillEntry>();
  for (const layer of layers) {
    for (const entry of layer) {
      // 先に入った層を後の層で上書きしない＝先勝ち
      if (!resolved.has(entry.skill.name)) resolved.set(entry.skill.name, entry);
    }
  }
  return Array.from(resolved.values());
}

/** モジュールが持つ Tool のドメイン一覧（決定27a：1モジュールは1つ以上のドメインを持つ）。 */
export function moduleDomains(module: BantoModule): string[] {
  const domains = new Set<string>();
  for (const tool of module.tools) domains.add(toolDomain(tool.name as NamespacedToolName));
  return Array.from(domains);
}
