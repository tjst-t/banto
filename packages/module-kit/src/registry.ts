/**
 * モジュール台帳（要件 C11・C12、ADR-0001 決定5）。
 *
 * 解決するのは**モジュール起動時とスレッドへの紐づけ時の2箇所だけ**。
 * 実行中の追随はしない——常時追随する機構は、それ自体が「黙って壊れる」候補になる。
 */

import {
  checkManifest,
  describeProblem,
  type BantoModule,
  type Dependency,
  type ManifestProblem,
  type ModuleId,
} from './manifest.js';

/**
 * 台帳に載せる1件。`listTools` は**接続してから**実際のツール名を返す。
 *
 * 宣言は自己申告なので、`tools/list` で実在を確かめる（要件 C11）。
 * Vault がツール名を変えたら、Repo は push のときではなく**接続のときに**落ちる。
 */
export interface ModuleSource {
  readonly manifest: BantoModule;
  listTools(): Promise<readonly string[]>;
}

export type RegistryProblem =
  | { readonly kind: 'manifest'; readonly problem: ManifestProblem }
  | { readonly kind: 'duplicate-id'; readonly moduleId: ModuleId }
  | { readonly kind: 'required-module-missing'; readonly moduleId: ModuleId; readonly missing: ModuleId }
  | {
      readonly kind: 'required-tool-missing';
      readonly moduleId: ModuleId;
      readonly missing: ModuleId;
      readonly tool: string;
    }
  | { readonly kind: 'cycle'; readonly path: readonly ModuleId[] }
  | { readonly kind: 'unreachable'; readonly moduleId: ModuleId; readonly detail: string };

/** 任意の依存が欠けている状態。起動は止めないが、黙って進めもしない。 */
export interface Degradation {
  readonly moduleId: ModuleId;
  readonly missing: ModuleId;
  readonly tools: readonly string[];
  readonly reason: string;
}

export interface Resolution {
  /** 起動してよいモジュール。 */
  readonly ready: readonly ModuleId[];
  /** 起動を止める理由。1件でもあれば起動しない（要件 C11）。 */
  readonly problems: readonly RegistryProblem[];
  /** 任意の依存が欠けているところ。これを使うツールだけが理由つきで断る。 */
  readonly degradations: readonly Degradation[];
}

export function describeRegistryProblem(problem: RegistryProblem): string {
  switch (problem.kind) {
    case 'manifest':
      return describeProblem(problem.problem);
    case 'duplicate-id':
      return `${problem.moduleId}: id が重複している。id は MCP サーバ名になるので一意でなければならない`;
    case 'required-module-missing':
      return `${problem.moduleId}: 必須の依存 ${problem.missing} が台帳に無い`;
    case 'required-tool-missing':
      return `${problem.moduleId}: 必須の依存 ${problem.missing} に ${problem.tool} が無い（tools/list で確認）`;
    case 'cycle':
      return `依存が循環している: ${problem.path.join(' → ')}`;
    case 'unreachable':
      return `${problem.moduleId}: 接続できない——${problem.detail}`;
  }
}

/**
 * 台帳を解決する。
 *
 * **必須が欠ければ起動しない。何が足りないかを言う**（要件 C11）。
 * 何が壊れるかが分かるように、任意の欠けも `degradations` として返す（要件 C12）。
 */
export async function resolve(sources: readonly ModuleSource[]): Promise<Resolution> {
  const problems: RegistryProblem[] = [];
  const byId = new Map<ModuleId, ModuleSource>();

  for (const source of sources) {
    if (byId.has(source.manifest.id)) {
      problems.push({ kind: 'duplicate-id', moduleId: source.manifest.id });
      continue;
    }
    byId.set(source.manifest.id, source);
    for (const problem of checkManifest(source.manifest)) {
      problems.push({ kind: 'manifest', problem });
    }
  }

  // 循環は起動時に検出して止まる。必須の辺だけを見る
  // ——任意の辺は欠けても進めるので、循環していても止める理由にならない。
  problems.push(...findCycles(byId));

  // 実在するツール名を集める。接続できないこと自体が問題であり、
  // 「空の一覧」と混同しない（教訓13：例外にならない失敗）。
  const toolsOf = new Map<ModuleId, ReadonlySet<string>>();
  for (const [id, source] of byId) {
    try {
      toolsOf.set(id, new Set(await source.listTools()));
    } catch (cause) {
      problems.push({
        kind: 'unreachable',
        moduleId: id,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const degradations: Degradation[] = [];

  for (const [id, source] of byId) {
    for (const dep of source.manifest.requires ?? []) {
      const missing = checkDependency(id, dep, byId, toolsOf);
      problems.push(...missing);
    }

    for (const dep of source.manifest.optional ?? []) {
      const issues = checkDependency(id, dep, byId, toolsOf);
      if (issues.length === 0) continue;
      degradations.push({
        moduleId: id,
        missing: dep.module,
        tools: dep.tools,
        reason: issues.map(describeRegistryProblem).join(' / '),
      });
    }
  }

  const blocked = new Set(
    problems.flatMap((p) =>
      p.kind === 'cycle' ? p.path : 'moduleId' in p ? [p.moduleId] : [],
    ),
  );

  return {
    ready: problems.length === 0 ? [...byId.keys()] : [...byId.keys()].filter((id) => !blocked.has(id)),
    problems,
    degradations,
  };
}

function checkDependency(
  moduleId: ModuleId,
  dep: Dependency,
  byId: ReadonlyMap<ModuleId, ModuleSource>,
  toolsOf: ReadonlyMap<ModuleId, ReadonlySet<string>>,
): RegistryProblem[] {
  if (!byId.has(dep.module)) {
    return [{ kind: 'required-module-missing', moduleId, missing: dep.module }];
  }
  const available = toolsOf.get(dep.module);
  if (available === undefined) {
    // 接続できなかった。その旨は別途 unreachable として出ているので、ここでは重ねない。
    return [];
  }
  return dep.tools
    .filter((tool) => !available.has(tool))
    .map((tool) => ({ kind: 'required-tool-missing', moduleId, missing: dep.module, tool }) as const);
}

/** 必須の依存だけを辿って循環を探す。見つけた循環はそのまま経路で返す。 */
function findCycles(byId: ReadonlyMap<ModuleId, ModuleSource>): RegistryProblem[] {
  const found: RegistryProblem[] = [];
  const seen = new Set<ModuleId>();
  const onPath = new Set<ModuleId>();

  const walk = (id: ModuleId, path: ModuleId[]): void => {
    if (onPath.has(id)) {
      const start = path.indexOf(id);
      found.push({ kind: 'cycle', path: [...path.slice(start), id] });
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    onPath.add(id);
    for (const dep of byId.get(id)?.manifest.requires ?? []) {
      if (byId.has(dep.module)) walk(dep.module, [...path, id]);
    }
    onPath.delete(id);
  };

  for (const id of byId.keys()) walk(id, []);
  return found;
}

/**
 * 起動してよいかを判定する。**必須が欠けていれば起動しない。**
 * 投げる例外には何が足りないかを全部書く——「起動しませんでした」だけでは直せない。
 */
export function assertStartable(resolution: Resolution): void {
  if (resolution.problems.length === 0) return;
  const lines = resolution.problems.map((p) => `  - ${describeRegistryProblem(p)}`);
  throw new Error(`モジュールを起動できない:\n${lines.join('\n')}`);
}
