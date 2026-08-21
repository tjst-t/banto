/**
 * **このモジュールを外したら、何が壊れるか**（要件 C12）。
 *
 * > 設定でモジュールを無効化するとき、何が壊れるかが分かる。
 *
 * **押したあとに壊れるのではなく、押す前に分かる**ようにする。
 * 無効化してから「動かない」と気づくのは、要件が避けたい形そのものである。
 *
 * ## 台帳だけで導く（規則3）
 *
 * 依存はマニフェストに宣言されている（要件 C11）ので、**外したときの影響も
 * そこから導ける**。別表を持たないので、モジュールを足したときに更新し忘れる場所が無い。
 *
 * 見るのは2つの経路：
 *
 * 1. **名指しの依存**（`requires: { module: 'vault' }`）——外せば、その相手が起動しない
 * 2. **役割の依存**（`requires: { capability: 'environment' }`）——外したものが
 *    **その役割の最後の担い手**なら、頼っている側は誰にも頼めなくなる。
 *    他に担い手が居るなら壊れない（**差し替えられることが、この設計の狙いである**）
 */

import {
  isCapabilityDependency,
  type BantoModule,
  type Capability,
  type Dependency,
  type ModuleId,
} from './manifest.js';

/** 壊れかたの1件。**必須と任意を混ぜない**——起動しないのと、断るのは別である。 */
export interface Breakage {
  /** 影響を受けるモジュール。 */
  readonly moduleId: ModuleId;
  /** 必須なら起動しない。任意ならそのツールだけが理由つきで断る（要件 C11）。 */
  readonly severity: 'blocks-start' | 'declines';
  /** 名指しか、役割か。 */
  readonly via: { readonly module: ModuleId } | { readonly capability: Capability };
  /** 任意の依存のとき、断ることになる自分のツール名。 */
  readonly declining?: readonly string[];
}

export interface Impact {
  readonly moduleId: ModuleId;
  readonly breakages: readonly Breakage[];
  /**
   * 外すと**担い手が居なくなる役割**。
   * 「このモジュールしか居ない」ことが、外せない理由になる。
   */
  readonly orphanedCapabilities: readonly Capability[];
}

/**
 * `moduleId` を外したときの影響を、台帳から導く。
 *
 * **外す対象が居なくても答える**（空の影響）——「知らないモジュール」を
 * エラーにすると、呼び手が問い合わせる前に存在を確かめる必要が出る。
 */
export function impactOfDisabling(
  manifests: readonly BantoModule[],
  moduleId: ModuleId,
): Impact {
  const target = manifests.find((m) => m.id === moduleId);
  const others = manifests.filter((m) => m.id !== moduleId);

  // その役割を、外したあとも誰かが担えるか。
  const stillProvided = new Set<Capability>(others.flatMap((m) => m.provides ?? []));
  const orphaned = (target?.provides ?? []).filter((c) => !stillProvided.has(c));

  const breakages: Breakage[] = [];
  for (const other of others) {
    const check = (deps: readonly Dependency[] | undefined, severity: Breakage['severity']): void => {
      for (const dep of deps ?? []) {
        if (isCapabilityDependency(dep)) {
          // **他に担い手が居れば壊れない。** 差し替えられることが狙いである。
          if (!orphaned.includes(dep.capability)) continue;
          breakages.push({
            moduleId: other.id,
            severity,
            via: { capability: dep.capability },
            ...(severity === 'declines' && dep.usedBy !== undefined
              ? { declining: dep.usedBy }
              : {}),
          });
        } else if (dep.module === moduleId) {
          breakages.push({
            moduleId: other.id,
            severity,
            via: { module: moduleId },
            ...(severity === 'declines' && dep.usedBy !== undefined
              ? { declining: dep.usedBy }
              : {}),
          });
        }
      }
    };

    check(other.requires, 'blocks-start');
    check(other.optional, 'declines');
  }

  return { moduleId, breakages, orphanedCapabilities: orphaned };
}

/** 人に見せる1行。**「何も壊れない」もはっきり言う**——黙ると調べ足りないのと区別できない。 */
export function describeImpact(impact: Impact): string {
  if (impact.breakages.length === 0) {
    return impact.orphanedCapabilities.length === 0
      ? '外しても、他のモジュールは影響を受けない'
      : `外すと ${impact.orphanedCapabilities.join('・')} の担い手が居なくなる（いまは誰も頼っていない）`;
  }

  const blocked = impact.breakages.filter((b) => b.severity === 'blocks-start');
  const declines = impact.breakages.filter((b) => b.severity === 'declines');
  const lines: string[] = [];
  if (blocked.length > 0) {
    lines.push(`起動しなくなる: ${[...new Set(blocked.map((b) => b.moduleId))].join('・')}`);
  }
  if (declines.length > 0) {
    lines.push(
      `断るようになる: ${declines
        .map((b) => `${b.moduleId}${b.declining === undefined ? '' : `（${b.declining.join('・')}）`}`)
        .join('・')}`,
    );
  }
  return lines.join(' / ');
}
