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
 * 役割（ADR-0001 決定16）。**実装ではなく、満たすべき口の名前。**
 *
 * `'environment'` / `'publish'` のように、**複数の実装が名乗れる**。Factory は
 * 「環境をくれ」と言えるだけでよく、それが process なのか docker なのか
 * Proxmox なのかを知らない。
 *
 * **閉じた union にしない。** 閉じると、第三者が新しい役割を足すのに banto 中核の
 * コードを変えることになり、要件 C6 に反する。代わりに**綴り違いを構造で捕まえる**
 * ——名乗る実装が1つも無い役割は `capability-no-provider` として起動を止める。
 * 型で防げないぶんを、起動時の突き合わせで押さえる（規則1：自己申告を信頼しない）。
 */
export type Capability = string;

/**
 * 依存の宣言（要件 C11）。
 *
 * **2つの名前空間を混ぜない。** ここは一度混ざっていて、3本目のモジュールを
 * 書いたときに露見した（教訓6：契約の言葉が同じでも、意味が同じとは限らない）。
 * `tools` は**相手の**ツール名、`usedBy` は**自分の**ツール名で、別のもの。
 */
interface DependencyShape {
  /**
   * **相手の**ツールの名前（名前空間を付けない素の名前）。
   *
   * 接続時に `tools/list` で実在を確かめるために使う。
   * 「そのモジュールに依存している」だけでは、相手がツール名を変えたときに
   * 使う瞬間まで気づけない。
   *
   * **役割で依存するとき、この一覧が役割の実体になる。**「environment を名乗ってよいか」を
   * 自己申告ではなく実測で確かめられるのは、これがあるから。
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

/** 特定の実装に依存する。相手が1つしか在りえないとき（例：Repo → Vault）。 */
export interface ModuleDependency extends DependencyShape {
  readonly module: ModuleId;
}

/** 役割に依存する。**実装は設定で差し替わる**（決定16）。 */
export interface CapabilityDependency extends DependencyShape {
  readonly capability: Capability;
}

/**
 * **union にして、両方書く／どちらも書かないを型で潰す。**
 *
 * `module?` と `capability?` を1つの型に並べると、両方欠けたマニフェストが
 * 型を通ってしまい、「実行時に気づく」に落ちる。`ModuleId` と `Capability` は
 * どちらも string なので、**区別できるのは形だけ**である。
 */
export type Dependency = ModuleDependency | CapabilityDependency;

export function isCapabilityDependency(dep: Dependency): dep is CapabilityDependency {
  return 'capability' in dep;
}

/** 人に見せるときの呼び名。問題の説明で使う。 */
export function describeDependency(dep: Dependency): string {
  return isCapabilityDependency(dep) ? `役割 ${dep.capability}` : dep.module;
}

/**
 * モジュールが持ち込む画面の境界（要件 C1・C6・C14、決定20）。
 *
 * **`isolation` と同じ2択にする。** 新しい軸を作らない——
 * 「そのモジュールを自分のプロセスの中で走らせてよいか」と
 * 「そのモジュールの画面を自分のページの中で走らせてよいか」は、同じ問いである。
 *
 * | | プロセス | 画面 |
 * |---|---|---|
 * | 内側 | `in-process` | `in-page` |
 * | 外側 | `subprocess` | `sandboxed` |
 *
 * **既定値を持たない**（C8c と同じ理由）。既定値は「忘れられる」機構そのもので、
 * ここで忘れられると**他人の JavaScript がページの権限で走る**
 * ——合言葉の cookie も、他のモジュールの画面も触れてしまう。
 */
export type GuiBoundary = 'in-page' | 'sandboxed';

/** どの URI をどの面で開くか（要件 C14）。**モジュールが宣言し、ホストが割り当てる。** */
export interface ViewSpec {
  /** この接頭辞の URI を開ける。`banto://<自分の id>/` の下だけを名乗れる。 */
  readonly uriPrefix: string;
  /** 人に見せる面の名前。 */
  readonly title: string;
  /**
   * どこに出すか。既定は会話の中（`canvas`）。
   *
   * **設定の区画（要件 C4）に、新しい機構を足さない**（規則12）。
   * 「モジュールが自分の面を持ち、ホストが URI で開く」機構は C14 で作ってある。
   * 設定はその**置き場が違うだけ**なので、印を1つ足して済ませる。
   */
  readonly slot?: 'canvas' | 'settings';
}

export interface ModuleGui {
  readonly kind: GuiBoundary;
  /**
   * 画面の実体。
   *
   * **`in-page` は banto の束ねに入っているものしか指せない**——だから
   * 第三者モジュールは構造的に `in-page` を名乗れない（方針ではなく、束ねに無い）。
   * `sandboxed` はホストが配る URL で、iframe の中で走る。
   */
  readonly entry: string;
  readonly views: readonly ViewSpec[];
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
  /** 持ち込む画面（要件 C1・C14）。任意——**画面を持たないモジュールは普通にある**（C9）。 */
  readonly gui?: ModuleGui;
  /**
   * このモジュールが名乗る役割（決定16）。
   *
   * **名乗るだけでは足りない。** 実際に満たしているかは、依存側が書いた `tools` を
   * `tools/list` と突き合わせて確かめる（要件 C11 の機構がそのまま効く）。
   */
  readonly provides?: readonly Capability[];
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
  | { readonly kind: 'secrets-in-process'; readonly moduleId: ModuleId }
  | { readonly kind: 'gui-kind-missing'; readonly moduleId: ModuleId }
  | { readonly kind: 'gui-in-page-outside'; readonly moduleId: ModuleId; readonly detail: string }
  | { readonly kind: 'gui-view-outside-uri'; readonly moduleId: ModuleId; readonly uriPrefix: string };

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

  const gui = module.gui;
  if (gui !== undefined) {
    if (gui.kind !== 'in-page' && gui.kind !== 'sandboxed') {
      problems.push({ kind: 'gui-kind-missing', moduleId: module.id });
    }

    /**
     * **プロセスで信用していないものを、画面で信用しない。**
     *
     * `isolation` を外側にした（subprocess）モジュールや、鍵を扱うモジュールが
     * ページの中で走ると、**プロセスを分けた意味が画面側で消える**——
     * 同じページには合言葉の cookie も他モジュールの画面もある。
     */
    if (gui.kind === 'in-page' && module.isolation === 'subprocess') {
      problems.push({
        kind: 'gui-in-page-outside',
        moduleId: module.id,
        detail: 'isolation が subprocess なのに gui.kind が in-page',
      });
    }
    if (gui.kind === 'in-page' && module.handles?.includes('secrets') === true) {
      problems.push({
        kind: 'gui-in-page-outside',
        moduleId: module.id,
        detail: 'secrets を扱うと宣言しているのに gui.kind が in-page',
      });
    }

    // **自分の URI 空間の外は開けない**（要件 C14）。名乗れると、
    // 他のモジュールが持っているものを横取りできてしまう。
    for (const view of gui.views) {
      if (!view.uriPrefix.startsWith(`banto://${module.id}/`)) {
        problems.push({
          kind: 'gui-view-outside-uri',
          moduleId: module.id,
          uriPrefix: view.uriPrefix,
        });
      }
    }
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
    case 'gui-kind-missing':
      return `${problem.moduleId}: gui.kind が無い。"in-page" か "sandboxed" を必ず書く（既定値は持たない）`;
    case 'gui-in-page-outside':
      return (
        `${problem.moduleId}: この画面はページの中で走らせられない——${problem.detail}。` +
        `プロセスで信用していないものを画面で信用しない（sandboxed にする）`
      );
    case 'gui-view-outside-uri':
      return (
        `${problem.moduleId}: 自分の URI 空間の外を開こうとしている: ${problem.uriPrefix}` +
        `（banto://${problem.moduleId}/ の下だけを名乗れる）`
      );
  }
}

/**
 * 作業範囲の根を、環境変数から**必須で**受け取る。
 *
 * `?? process.cwd()` と書いてはいけない。**既定値は「忘れられる」機構そのもの**で、
 * これは `isolation` に既定値を置かない理由（C8c）とまったく同じである。
 *
 * 実際に事故が起きた（2026-08-20）：repo モジュールの root が cwd に落ち、
 * 試験を走らせただけで banto 自身のリポジトリに対して `git push` が実行され、
 * 本物のリモートに到達した。内容が同一だったので実害は無かったが、
 * **黙って既定に落ちる**という一点だけで、そこまで行ける。
 */
export function requiredRoot(envName: string): string {
  const value = process.env[envName];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${envName} が設定されていない。作業範囲の根に既定値は無い` +
        `——cwd に落とすと、そのとき居たディレクトリに対して操作が走る`,
    );
  }
  return value;
}
