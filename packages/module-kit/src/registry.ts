/**
 * モジュール台帳（要件 C11・C12、ADR-0001 決定5）。
 *
 * 解決するのは**モジュール起動時とスレッドへの紐づけ時の2箇所だけ**。
 * 実行中の追随はしない——常時追随する機構は、それ自体が「黙って壊れる」候補になる。
 */

import {
  checkManifest,
  describeProblem,
  isCapabilityDependency,
  type BantoModule,
  type Capability,
  type Dependency,
  type ManifestProblem,
  type ModuleId,
} from './manifest.js';
import type { Availability } from './define.js';

/**
 * 役割 → 実装の割り当て。**設定から来る**（決定16、仕様 §6）。
 *
 * **候補が1つでも自動で選ばない。** 黙って選ばれた既定は忘れられる
 * ——`isolation` に既定値を置かないのと同じ理由（要件 C8c）。
 * 環境がどれになっているかは、運用者が書いた1行として残っていてほしい。
 */
export type Bindings = ReadonlyMap<Capability, ModuleId>;

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
  | { readonly kind: 'unreachable'; readonly moduleId: ModuleId; readonly detail: string }
  /** 役割を名乗る実装が1つも無い。**綴り違いはここで捕まる。** */
  | {
      readonly kind: 'capability-no-provider';
      readonly moduleId: ModuleId;
      readonly capability: Capability;
    }
  /** 名乗る実装は在るが、どれを使うかが設定で決まっていない。 */
  | {
      readonly kind: 'capability-unbound';
      readonly moduleId: ModuleId;
      readonly capability: Capability;
      readonly candidates: readonly ModuleId[];
    }
  /** 設定が指した実装が、その役割を名乗っていない。 */
  | {
      readonly kind: 'capability-not-provided';
      readonly moduleId: ModuleId;
      readonly capability: Capability;
      readonly bound: ModuleId;
    };

/** 任意の依存が欠けている状態。起動は止めないが、黙って進めもしない。 */
export interface Degradation {
  readonly moduleId: ModuleId;
  /** 欠けている相手。役割が未割り当てのときは実装が決まらないので null。 */
  readonly missing: ModuleId | null;
  /** 役割で依存していた場合の役割名。 */
  readonly capability?: Capability;
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
    case 'capability-no-provider':
      return (
        `${problem.moduleId}: 役割 ${problem.capability} を名乗るモジュールが台帳に1つも無い` +
        `（綴り違いか、そのモジュールを載せ忘れているか）`
      );
    case 'capability-unbound':
      return (
        `${problem.moduleId}: 役割 ${problem.capability} にどの実装を使うかが決まっていない。` +
        `候補: ${problem.candidates.join(', ')}——設定で明示的に選ぶ（候補が1つでも自動では選ばない）`
      );
    case 'capability-not-provided':
      return (
        `${problem.moduleId}: 役割 ${problem.capability} に ${problem.bound} が割り当てられているが、` +
        `${problem.bound} はその役割を名乗っていない（provides に無い）`
      );
  }
}

/**
 * 台帳を解決する。
 *
 * **必須が欠ければ起動しない。何が足りないかを言う**（要件 C11）。
 * 何が壊れるかが分かるように、任意の欠けも `degradations` として返す（要件 C12）。
 */
export async function resolve(
  sources: readonly ModuleSource[],
  bindings: Bindings = new Map(),
): Promise<Resolution> {
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

  // 役割 → それを名乗る実装。**自己申告の一覧**であり、満たしているかは
  // 依存側の `tools` を `tools/list` と突き合わせて別途確かめる。
  const providersOf = new Map<Capability, ModuleId[]>();
  for (const [id, source] of byId) {
    for (const capability of source.manifest.provides ?? []) {
      const list = providersOf.get(capability);
      if (list) list.push(id);
      else providersOf.set(capability, [id]);
    }
  }

  // 循環は起動時に検出して止まる。必須の辺だけを見る
  // ——任意の辺は欠けても進めるので、循環していても止める理由にならない。
  problems.push(...findCycles(byId, bindings, providersOf));

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
      problems.push(...checkDependency(id, dep, byId, toolsOf, bindings, providersOf));
    }

    for (const dep of source.manifest.optional ?? []) {
      const issues = checkDependency(id, dep, byId, toolsOf, bindings, providersOf);
      if (issues.length === 0) continue;
      const target = targetOf(id, dep, bindings, providersOf);
      degradations.push({
        moduleId: id,
        // 役割が未割り当てなら、欠けている「実装」は決まらない。無理に埋めない。
        missing: 'moduleId' in target ? target.moduleId : null,
        ...(isCapabilityDependency(dep) ? { capability: dep.capability } : {}),
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

/**
 * 依存が実際にどの実装を指すかを解く。
 *
 * 実装を名指しした依存はそのまま。**役割の依存は設定の割り当てを通す**
 * ——ここが「実装は差し替えられる」の実体（決定16）。
 */
function targetOf(
  dependent: ModuleId,
  dep: Dependency,
  bindings: Bindings,
  providersOf: ReadonlyMap<Capability, readonly ModuleId[]>,
): { readonly moduleId: ModuleId } | { readonly problem: RegistryProblem } {
  if (!isCapabilityDependency(dep)) return { moduleId: dep.module };

  const capability = dep.capability;
  const candidates = providersOf.get(capability) ?? [];

  // 型で綴りを守れない代わりに、ここで捕まえる（`Capability` の注記を見よ）。
  if (candidates.length === 0) {
    return { problem: { kind: 'capability-no-provider', moduleId: dependent, capability } };
  }

  const bound = bindings.get(capability);
  // **候補が1つでも自動で選ばない。** 黙って選ばれた既定は忘れられる（C8c と同じ）。
  if (bound === undefined) {
    return { problem: { kind: 'capability-unbound', moduleId: dependent, capability, candidates } };
  }
  if (!candidates.includes(bound)) {
    return { problem: { kind: 'capability-not-provided', moduleId: dependent, capability, bound } };
  }
  return { moduleId: bound };
}

function checkDependency(
  dependent: ModuleId,
  dep: Dependency,
  byId: ReadonlyMap<ModuleId, ModuleSource>,
  toolsOf: ReadonlyMap<ModuleId, ReadonlySet<string>>,
  bindings: Bindings,
  providersOf: ReadonlyMap<Capability, readonly ModuleId[]>,
): RegistryProblem[] {
  const target = targetOf(dependent, dep, bindings, providersOf);
  if ('problem' in target) return [target.problem];

  const missing = target.moduleId;
  if (!byId.has(missing)) {
    return [{ kind: 'required-module-missing', moduleId: dependent, missing }];
  }
  const available = toolsOf.get(missing);
  if (available === undefined) {
    // 接続できなかった。その旨は別途 unreachable として出ているので、ここでは重ねない。
    return [];
  }
  // **役割の実体はこの突き合わせである。** 名乗るだけでは足りない（規則1）。
  return dep.tools
    .filter((tool) => !available.has(tool))
    .map((tool) => ({ kind: 'required-tool-missing', moduleId: dependent, missing, tool }) as const);
}

/**
 * 必須の依存だけを辿って循環を探す。見つけた循環はそのまま経路で返す。
 *
 * **役割の辺も、割り当てを通して辿る。** 辿らないと、役割を挟むだけで
 * 循環の検出をすり抜けられてしまう。
 */
function findCycles(
  byId: ReadonlyMap<ModuleId, ModuleSource>,
  bindings: Bindings,
  providersOf: ReadonlyMap<Capability, readonly ModuleId[]>,
): RegistryProblem[] {
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
      const target = targetOf(id, dep, bindings, providersOf);
      // 解けない依存は別の問題として出る。ここでは辺が無いものとして扱う。
      if ('moduleId' in target && byId.has(target.moduleId)) walk(target.moduleId, [...path, id]);
    }
    onPath.delete(id);
  };

  for (const id of byId.keys()) walk(id, []);
  return found;
}

/**
 * 解決の結果から、そのモジュールの `Availability` を作る。
 *
 * **手で組み立てさせない。** 手で書くと、台帳が「欠けている」と言っているものと
 * モジュールが「断る」ものが、いつか食い違う（規則3：写しを持たない）。
 */
export function availabilityFor(moduleId: ModuleId, resolution: Resolution): Availability {
  const mine = resolution.degradations.filter((d) => d.moduleId === moduleId);
  const matches = (dep: Dependency): Degradation | undefined =>
    mine.find((d) =>
      isCapabilityDependency(dep) ? d.capability === dep.capability : d.missing === dep.module,
    );

  return {
    has: (dep) => matches(dep) === undefined,
    reasonFor: (dep) => matches(dep)?.reason ?? '',
  };
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
