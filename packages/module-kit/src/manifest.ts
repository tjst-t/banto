/**
 * モジュールの契約（ADR-0001 決定5、要件 C1〜C12）。
 *
 * ここが Phase 1 の完了条件の1つめ——**契約が確定していること**。
 * 中身より先に形を決める。
 */

/** モジュールの識別子。MCP サーバ名になり、そのままツールの名前空間になる。 */
export type ModuleId = string;

/**
 * プロセス境界（要件 C8c）。**既定値を持たない必須フィールド。**
 *
 * 既定値は「忘れられる」機構そのものである。「落ちてもホストが生きる」
 * 「鍵が AI 実行と同居しない」という安全要件を、既定値の陰で静かに消させない。
 */
export type Isolation = 'in-process' | 'subprocess';

/** 宣言すると `in-process` を拒否される能力。 */
export type Handles = 'secrets';

/** ツールインターフェースの繋ぎ先。境界に対応する。 */
export type McpSpec =
  | { readonly kind: 'in-process' }
  | { readonly kind: 'subprocess'; readonly command: string; readonly args?: readonly string[] }
  | { readonly kind: 'url'; readonly url: string };

/**
 * 依存の宣言（要件 C11）。
 *
 * **2つの名前空間を混ぜない。** ここは一度混ざっていて、3本目のモジュールを
 * 書いたときに露見した（教訓6：契約の言葉が同じでも、意味が同じとは限らない）。
 * `tools` は**相手の**ツール名、`usedBy` は**自分の**ツール名で、別のもの。
 */
export interface Dependency {
  readonly module: ModuleId;
  /**
   * **相手の**ツールの名前（名前空間を付けない素の名前）。
   *
   * 接続時に `tools/list` で実在を確かめるために使う。
   * 「そのモジュールに依存している」だけでは、相手がツール名を変えたときに
   * 使う瞬間まで気づけない。
   */
  readonly tools: readonly string[];
  /**
   * **自分の**ツールのうち、この依存が無いと成り立たないもの。
   *
   * 任意の依存でだけ意味を持つ——必須が欠けたときはそもそも起動しないので、
   * どのツールが断るかを考える必要がない。省くと、依存が欠けても
   * どのツールも断らない（＝黙って動いているように見える）。
   */
  readonly usedBy?: readonly string[];
}

export interface BantoModule {
  readonly id: ModuleId;
  /** 一行の説明。台帳に出る。 */
  readonly description: string;
  readonly isolation: Isolation;
  readonly mcp: McpSpec;
  /** GUI の接続先。任意（要件 C9：最小実装はツールインターフェースだけ）。 */
  readonly api?: { readonly url: string };
  readonly handles?: readonly Handles[];
  readonly requires?: readonly Dependency[];
  readonly optional?: readonly Dependency[];
}

/**
 * 契約に**入れなかった**もの、とその理由。
 *
 * `alwaysLoad`（＝API の `defer_loading: false`）を書けるようにしていない。
 *
 * 実測（2026-08-20）：
 * ```
 * ツール無し          create=     0  read= 20,871
 * 遅延ロード 8個      create=     0  read= 20,943   ← 既定。キャッシュは生きる
 * 遅延ロード 40個     create= 5,394  read= 15,837
 * alwaysLoad 8個     create=21,535  read=      0   ← 全損
 * alwaysLoad 40個    create=24,191  read=      0   ← 全損
 * ```
 * **`alwaysLoad` を立てるとキャッシュ読みがゼロになる。** 1ターンの費用が
 * およそ13倍になり、しかも**そのモジュールを紐づけた全スレッドに効く**。
 * 1つのモジュールの不注意が全体を壊す形なので、書けるようにしない。
 *
 * 必要になったら、そのときに設計の議論をする。いま決めない
 * ——決まっていないものを、決まっているかのように扱わない。
 */
export const NOT_IN_THE_CONTRACT = ['alwaysLoad'] as const;

export type ManifestProblem =
  | { readonly kind: 'isolation-missing'; readonly moduleId: ModuleId }
  | { readonly kind: 'boundary-mismatch'; readonly moduleId: ModuleId; readonly detail: string }
  | { readonly kind: 'secrets-in-process'; readonly moduleId: ModuleId };

/**
 * マニフェスト単体の検査。
 *
 * **判定できる分は機械で押さえる**（要件 C8c）——宣言は自己申告なので、
 * 突き合わせられるものは突き合わせる。
 */
export function checkManifest(module: BantoModule): ManifestProblem[] {
  const problems: ManifestProblem[] = [];

  // 型では防げない。JSON から読んだマニフェストは any 相当で入ってくる。
  if (module.isolation !== 'in-process' && module.isolation !== 'subprocess') {
    problems.push({ kind: 'isolation-missing', moduleId: module.id });
  }

  // 境界と繋ぎ先が食い違っていたら、どちらが本当かを推測しない。
  const boundaryOfMcp = module.mcp.kind === 'in-process' ? 'in-process' : 'subprocess';
  if (module.isolation === 'in-process' && boundaryOfMcp !== 'in-process') {
    problems.push({
      kind: 'boundary-mismatch',
      moduleId: module.id,
      detail: `isolation は in-process だが mcp.kind が ${module.mcp.kind}`,
    });
  }
  if (module.isolation === 'subprocess' && module.mcp.kind === 'in-process') {
    problems.push({
      kind: 'boundary-mismatch',
      moduleId: module.id,
      detail: 'isolation は subprocess だが mcp.kind が in-process',
    });
  }

  // 鍵を持つものを、AI が走るプロセスと同居させない（要件 D3）。
  if (module.handles?.includes('secrets') === true && module.isolation === 'in-process') {
    problems.push({ kind: 'secrets-in-process', moduleId: module.id });
  }

  return problems;
}

export function describeProblem(problem: ManifestProblem): string {
  switch (problem.kind) {
    case 'isolation-missing':
      return `${problem.moduleId}: isolation が無い。"in-process" か "subprocess" を必ず書く（既定値は持たない）`;
    case 'boundary-mismatch':
      return `${problem.moduleId}: 境界の宣言と繋ぎ先が食い違っている——${problem.detail}`;
    case 'secrets-in-process':
      return `${problem.moduleId}: secrets を扱うと宣言したモジュールは in-process にできない（鍵が AI 実行と同居する）`;
  }
}
