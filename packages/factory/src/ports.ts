/**
 * Factory が外に頼むこと（ADR-0001 決定5・決定16）。
 *
 * **Factory は git を知らない。環境の種類も知らない。** 頼む先は口だけで、
 * 実体が Repo モジュールなのか、`env-process` なのか `env-docker` なのかを見ない。
 *
 * ここに `RepoPort` / `EnvironmentPort` という**型**を置くのは、
 * MCP のツール呼び出しをそのまま engine に散らすと、engine が
 * 「ツール名」と「引数の形」を知ることになるからである。写すのは1箇所に閉じる。
 */

/** 作業ツリーとブランチ。**持ち主は Repo**（決定5）。 */
export interface RepoPort {
  addWorktree(branch: string, relative: string): Promise<string>;
  hasWorktree(relative: string): Promise<boolean>;
  removeWorktree(relative: string): Promise<string>;
  /** その ref の先端。**テスト結果の鍵になる。** */
  headOf(ref: string): Promise<string>;
  /** ブランチが取り込み先より先に進んでいるか。 */
  isAhead(branch: string, base?: string): Promise<boolean>;
  isMerged(branch: string, into?: string): Promise<boolean>;
  merge(branch: string, into?: string): Promise<string>;
  /** 取り込み先の先端に載せ直す。**衝突したら投げる**（要件 B7）。 */
  rebaseOnto(relative: string, onto?: string): Promise<string>;
  /**
   * その ref に在るファイル。**作業ツリーではない**（`declaration.ts` の注記）。
   * 無ければ `null`——宣言していないことは失敗ではない。
   */
  readFileAt(ref: string, relative: string): Promise<string | null>;
}

/** 役割 `environment`（決定16）。**実装は差し替わる。** */
export interface EnvironmentPort {
  create(workdir: string): Promise<string>;
  status(handle: string): Promise<'ready' | 'gone'>;
  exec(
    handle: string,
    command: string,
    args: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  destroy(handle: string): Promise<string>;
}

export interface RunPlan {
  readonly runId: string;
  readonly threadId: string;
  readonly branch: string;
  readonly request: string;
  /** 作業ツリーの場所（Repo の root からの相対）。 */
  readonly workdir: string;
}

/**
 * 実装する人。**既定の実装はサブエージェント**（決定10）だが、口にしてある。
 *
 * 口にする理由は2つある。**差し替えたいからではなく、**
 *
 * 1. 要件 B4「既定では人を待たない」を満たすには、Factory 側が実装の進み方を
 *    制御できないといけない
 * 2. **engine を試験するとき、engine の外側を本物にしたいから。** git も環境も
 *    本物で回し、LLM だけを決まった動きに置き換える——LLM は engine の
 *    依存であって、試験の対象ではない（教訓1 は「対象を偽るな」と言っている）
 */
export interface Implementer {
  /** ブランチの上に commit を作る。**commit しなければ、実装は済んでいない。** */
  implement(plan: RunPlan, handle: string, env: EnvironmentPort): Promise<void>;
}

/**
 * テストの走らせ方。**リポジトリが持つ**（決定16、仕様 §6・§8-4）。
 *
 * Factory はコマンドを組み立てない——組み立てると Factory が
 * プロジェクトの事情を知ることになる。
 */
export interface TestCommand {
  readonly command: string;
  readonly args: readonly string[];
}
