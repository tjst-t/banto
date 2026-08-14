/**
 * レビューは3段（ADR-0013 決定57・66、task-0065）。
 *
 * | 値 | 監査通過後 |
 * |---|---|
 * | `auto` | そのままマージ（人も番頭も見ない） |
 * | `banto`（既定） | 番頭が受けてレビューする。捌けたら承認、捌けなければ取次へ |
 * | `po` | 必ず PO まで上げる。番頭は判断しない |
 *
 * **`po` は機械的に判定する**（決定57）。番頭の付け忘れに依存しない——「これは PO に
 * 見せるべき」と気づく形にすると、気づかなかったものが黙って通る。判定材料は2つ：
 *
 *   1. `governance: true`（統治コード。`spec-improvement-loop` §7 で既にレビュー省略対象外）
 *   2. **層B設定に列挙されたパスに `scope.paths` が触れるとき**（UI/UX 等）
 *
 * **判定表はプロジェクトの持ち物**（決定66・38f：フレームワークはパス構成を知ってはいけない）。
 * リポジトリの `meta/config.yaml` に置き、clone すれば付いてくる。**既定は空**——
 * パスを1つも書かなければ `governance: true` だけが PO 直行になる。
 *
 * D6: YAML の解釈は banto-core の既存のもの（外部ライブラリを足さない）。
 * I2: 設定ファイルが壊れていたら、黙って「空」にせず理由を投げる——**緩む方向へ倒れない**。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseYamlFrontmatter } from "@banto/core";
import type { OrchestrationEvent, TaskRecord } from "@banto/core";

/** レビューの段（決定57）。 */
export type ReviewStage = "auto" | "banto" | "po";

/** 取りうる段。層B設定の綴りを照合するために並びとしても持つ。 */
export const REVIEW_STAGES: readonly ReviewStage[] = ["auto", "banto", "po"];

/**
 * 既定は `auto`——**証拠の揃ったものは人を通さず着地させる**（PO 裁定 2026-08-14）。
 *
 * 反転前は `banto`（監査を通ったものを番頭が一次受けする）だった。反転したのは、
 * 番頭が一次受けする形だと番頭の文脈が工場の中継で埋まり、D10（細かい仕事をしない）
 * が守れないため。
 *
 * **既定が `auto` でも、そのまま着地するわけではない。** `autoLandBlockers` が
 * 証拠を要求し、欠けていれば `banto` へ落とす。ここが緩んで見えるのは policy の
 * 解決までで、着地の可否はその先で決まる。
 *
 * 戻すときは層Bの `review.default_policy: banto`（ビルドも再起動も要らない）。
 */
export const DEFAULT_REVIEW_STAGE: ReviewStage = "auto";

/** 層B設定ファイル（プロジェクトのリポジトリの中）。 */
export const PROJECT_CONFIG_PATH = path.join("meta", "config.yaml");

/** 層B設定のうち、Kobo が読むもの。 */
export interface ProjectConfig {
  verify: {
    /**
     * マージ前ゲートの検証を回す検証環境プロファイル名（task-0075）。
     *
     * `<repoPath>/meta/environments.yaml` に定義したもの。**既定 `test`**。
     * Kobo は検証をホストで走らせない（PO裁定 2026-08-07）ので、**これが解決できないと
     * ゲートは通らない**——受け持たせるリポジトリには必ず1つ要る。
     */
    profile: string;
    /**
     * **自動生成のコンフリクト解消タスクに持たせる検査コマンド**（realign 第3便・段3）。
     *
     * `conflict-filer.ts` が書き出す契約の受け入れ条件すべてに載る。上の `profile` の
     * 環境の中で回るので、2つは組で読む。
     *
     * **既定は無い。** 書かなければ解消タスクは今までどおり検査ゼロの契約になり、
     * 自動着地の条件（→ `spec-daemon-core` §2.5）を満たさず人の承認を通る——
     * **これは正しい挙動なので塞がない**。設定した人だけが自動復旧を得る。
     *
     * コードに直書きしないのは、プロジェクトごとにテストの打ち方が違うから
     * （banto の `npm test` を埋め込むと他のプロジェクトで破綻する）。
     */
    conflictCommand?: string;
  };
  review: {
    /**
     * ここに触るタスクは必ず PO まで上げる（決定57・66）。
     *
     * 書き方は `scope.paths` と同じ glob（`packages/banto-web/**`）。**既定は空**。
     */
    poRequiredPaths: string[];
    /**
     * **判断待ちの間、人が触るための環境プロファイル**（決定59・段11c）。
     *
     * `meta/environments.yaml` に定義したもののうち、**人が触れる面を持つもの**を名指しする。
     * 省略したときは `verify.profile` に落ちるが、そちらは**触れる面を持つときだけ**使う
     * ——マージ前ゲートの検証用プロファイルは普通ポートを持たないので、そのまま流用すると
     * 「毎回 docker で立つが PO は触れない」という費用だけの環境が出来る（実測でそうなった）。
     *
     * 判定表と同じくこれも**プロジェクトの持ち物**（決定66・38f）。どのプロファイルが
     * 触れる面を持つかを知っているのは Environment Pool なので、Kobo は名前だけを扱う。
     */
    envProfile?: string;
    /**
     * **`review.policy` を書かなかったタスクの既定**（realign 第3便）。
     *
     * 省略時は `DEFAULT_REVIEW_STAGE`。**これが反転の後戻りの口**——`projectConfig()` は
     * 毎回ファイルを読み直す（写しを持たない・D3）ので、`meta/config.yaml` を1行直せば
     * 再起動もビルドも要らずに次の判定から元へ戻せる。
     *
     * **緩い側の口を足しても緩みは増えない。** `governance` と `po_required_paths` は
     * これより手前で効き、`manual` の読み替えもこれとは独立なので、ここを `auto` に
     * しても厳しい側の上書きは必ず勝つ（下の `resolveReviewStage` の並び順）。
     */
    defaultPolicy?: ReviewStage;
  };
  limits: {
    /**
     * 許す最大の等級（決定67・task-0063）。これを超える `model_tier` のタスクは
     * **黙って丸めず拒否する**——勝手に下げると「安く速く終わった」と読まれ、
     * 実際には要求水準を満たしていない成果を受け取ることになる。
     */
    maxModelTier?: "fast" | "standard" | "reasoning";
    /** 同時に動かせる職人の数。省略時は Kobo の既定（5）。 */
    maxConcurrentSessions?: number;
    /**
     * マージ前ゲートの検証コマンド1本あたりの制限時間（分。task-0071）。
     *
     * 省略時 `DEFAULT_VERIFY_TIMEOUT_MINUTES`、上限 `MAX_VERIFY_TIMEOUT_MINUTES`。
     * **検証コマンドはテスト一式そのもの**なので、分の単位で要る——同じことを
     * 検証環境側は 2026-08-01 に裁定済み（spec-environment §5.1：既定10分・上限60分。
     * 「既定30秒では npm test が途中で切れていた」）。ゲート側だけ 60 秒のままだった。
     */
    verifyTimeoutMinutes?: number;
    /**
     * **どれだけ止まっていたら知らせるか**（状態ごと・分。realign 第2便）。
     *
     * `meta/config.yaml` の `limits.dwell_warn_minutes`：
     * ```yaml
     * limits:
     *   dwell_warn_minutes:
     *     queued: 120
     *     review-ready: 480
     * ```
     * 書かなかった状態は `DEFAULT_DWELL_WARN_MINUTES` に落ちる。**どちらにも無い
     * 状態は見張らない**——通り過ぎるだけの状態（ready / merging 等）で鳴らしても、
     * 受け取った側にできることが無い。
     */
    dwellWarnMinutes?: Partial<Record<string, number>>;
  };
}

/**
 * マージ前ゲートの検証コマンドの制限時間（task-0071）。
 *
 * **数字は spec-environment §5.1 と揃える。** 同じ問い（テスト一式を何分待つか）に
 * 2つの答えを作らない。上限があるのは、待つ長さは外に残るものではないが、
 * マージキューは直列なので1本が居座ると後ろが全部止まるため。
 */
export const DEFAULT_VERIFY_TIMEOUT_MINUTES = 10;
export const MAX_VERIFY_TIMEOUT_MINUTES = 60;

/** 検証環境プロファイルの既定名。 */
export const DEFAULT_VERIFY_PROFILE = "test";

const EMPTY_CONFIG: ProjectConfig = {
  verify: { profile: DEFAULT_VERIFY_PROFILE },
  review: { poRequiredPaths: [] },
  limits: {},
};

/**
 * プロジェクトの層B設定を読む。**無ければ空**（設定ファイルを必須にしない）。
 *
 * I2: 在るのに読めない・形が違うのは異常なので投げる。「無い」と「壊れている」を
 *     混同すると、設定を書いたのに効いていないことに気づけない。
 */
export function loadProjectConfig(repoPath: string): ProjectConfig {
  const filePath = path.join(repoPath, PROJECT_CONFIG_PATH);
  if (!fs.existsSync(filePath)) return EMPTY_CONFIG;

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlFrontmatter(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`${PROJECT_CONFIG_PATH} を解釈できません: ${String(err)}`);
  }

  const verify = (parsed["verify"] ?? {}) as Record<string, unknown>;
  const verifyProfile = verify["profile"];
  if (verifyProfile !== undefined && typeof verifyProfile !== "string") {
    throw new Error(`${PROJECT_CONFIG_PATH}: verify.profile はプロファイル名（文字列）で書いてください`);
  }
  /**
   * 解消タスクに持たせる検査コマンド（realign 第3便・段3）。
   *
   * I2: **契約に書き出せない値は、設定を読んだ時点で断る。** 層Bの YAML パーサは
   * エスケープを扱わない（`stripQuotes` / `splitRespectingQuotes`）ので、引用符を
   * 両方含む文字列は受け入れ条件の inline map に載せると壊れる。壊れた契約を黙って
   * 書くより、書いた人が直せる場所で断る方がよい。
   */
  const conflictCommand = verify["conflict_command"];
  if (conflictCommand !== undefined) {
    if (typeof conflictCommand !== "string" || conflictCommand.trim().length === 0) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: verify.conflict_command は検査コマンド（空でない文字列）で書いてください` +
          "。回すものが無いなら、欄ごと書かないでください（そのとき解消タスクは人の承認を通ります）"
      );
    }
    if (conflictCommand.includes('"') && conflictCommand.includes("'")) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: verify.conflict_command に引用符を両方（" と '）含めることはできません` +
          "——タスク定義の受け入れ条件に書き出せません。どちらか一方に寄せてください"
      );
    }
  }

  const review = (parsed["review"] ?? {}) as Record<string, unknown>;
  const limits = (parsed["limits"] ?? {}) as Record<string, unknown>;
  const rawPaths = review["po_required_paths"];
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
    throw new Error(`${PROJECT_CONFIG_PATH}: review.po_required_paths は配列で書いてください`);
  }
  const envProfile = review["env_profile"];
  if (envProfile !== undefined && typeof envProfile !== "string") {
    throw new Error(`${PROJECT_CONFIG_PATH}: review.env_profile はプロファイル名（文字列）で書いてください`);
  }
  // I2: 知らない綴りを黙って既定へ落とさない。落とすと「auto にしたのに人へ来る」
  //     （あるいはその逆）が静かに起き、設定したのに効いていないことに気づけない
  const defaultPolicy = review["default_policy"];
  if (defaultPolicy !== undefined && !REVIEW_STAGES.includes(String(defaultPolicy) as ReviewStage)) {
    throw new Error(
      `${PROJECT_CONFIG_PATH}: review.default_policy は ${REVIEW_STAGES.join(" / ")} のいずれか` +
        `（got "${String(defaultPolicy)}"）`
    );
  }
  const tier = limits["max_model_tier"];
  if (tier !== undefined && !["fast", "standard", "reasoning"].includes(String(tier))) {
    throw new Error(
      `${PROJECT_CONFIG_PATH}: limits.max_model_tier は fast / standard / reasoning のいずれか（got "${String(tier)}"）`
    );
  }
  // 層B設定の読み取りは素の YAML（D6：ライブラリを足さない）なので、数も文字列で来る。
  // **書いた人には数に見えている**ので、数として読めるなら数として扱う——ただし
  // 数として読めないものは黙って無視せず投げる（I2：設定したのに効かない状態を作らない）
  const rawConcurrent = limits["max_concurrent_sessions"];
  let concurrent: number | undefined;
  if (rawConcurrent !== undefined) {
    concurrent = typeof rawConcurrent === "number" ? rawConcurrent : Number(String(rawConcurrent));
    if (!Number.isFinite(concurrent)) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: limits.max_concurrent_sessions は数で書いてください（got "${String(rawConcurrent)}"）`
      );
    }
  }

  const rawVerify = limits["verify_timeout_minutes"];
  let verifyMinutes: number | undefined;
  if (rawVerify !== undefined) {
    verifyMinutes = typeof rawVerify === "number" ? rawVerify : Number(String(rawVerify));
    if (!Number.isFinite(verifyMinutes) || verifyMinutes <= 0) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: limits.verify_timeout_minutes は正の数で書いてください（got "${String(rawVerify)}"）`
      );
    }
    // I2: 上限を超える指定は黙って丸めず断る。丸めると「30分待つ設定にした」と
    //     思い込んだまま、実際は上限で切られていることに気づけない
    if (verifyMinutes > MAX_VERIFY_TIMEOUT_MINUTES) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: limits.verify_timeout_minutes の上限は ${MAX_VERIFY_TIMEOUT_MINUTES} 分です（got ${verifyMinutes}）。` +
          "これ以上かかる検証は、マージキューが直列なので後ろを全部止めます——検証を分けることを考えてください"
      );
    }
  }

  /**
   * 滞留の閾値（状態ごと・分。realign 第2便）。
   *
   * I2: 数として読めないものを黙って無視しない——無視すると「閾値を設定したのに
   * 鳴らない」が静かに起きる。設定の間違いは、知らせないことより見つけやすくする。
   */
  const rawDwell = limits["dwell_warn_minutes"];
  let dwellWarnMinutes: Record<string, number> | undefined;
  if (rawDwell !== undefined) {
    if (typeof rawDwell !== "object" || rawDwell === null || Array.isArray(rawDwell)) {
      throw new Error(
        `${PROJECT_CONFIG_PATH}: limits.dwell_warn_minutes は「状態: 分」の対応で書いてください`
      );
    }
    dwellWarnMinutes = {};
    for (const [state, raw] of Object.entries(rawDwell as Record<string, unknown>)) {
      const value = typeof raw === "number" ? raw : Number(String(raw));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `${PROJECT_CONFIG_PATH}: limits.dwell_warn_minutes.${state} は正の数で書いてください（got "${String(raw)}"）`
        );
      }
      dwellWarnMinutes[state] = value;
    }
  }

  return {
    verify: {
      profile: (verifyProfile as string | undefined) ?? DEFAULT_VERIFY_PROFILE,
      ...(conflictCommand !== undefined ? { conflictCommand: conflictCommand as string } : {}),
    },
    review: {
      poRequiredPaths: Array.isArray(rawPaths) ? rawPaths.map(String) : [],
      ...(envProfile !== undefined ? { envProfile } : {}),
      ...(defaultPolicy !== undefined ? { defaultPolicy: defaultPolicy as ReviewStage } : {}),
    },
    limits: {
      ...(tier !== undefined ? { maxModelTier: tier as ProjectConfig["limits"]["maxModelTier"] } : {}),
      ...(concurrent !== undefined ? { maxConcurrentSessions: concurrent } : {}),
      ...(verifyMinutes !== undefined ? { verifyTimeoutMinutes: verifyMinutes } : {}),
      ...(dwellWarnMinutes !== undefined ? { dwellWarnMinutes } : {}),
    },
  };
}

/**
 * そのタスクのレビューの段を決める（決定57）。
 *
 * **`po` は機械的**。タスクが `auto` を名乗っていても、統治コードや PO 必須のパスに
 * 触るなら `po` が勝つ——**緩い方へは倒れない**。
 */
export function resolveReviewStage(task: TaskRecord, config: ProjectConfig): ReviewStage {
  if (task["governance"] === true) return "po";
  const scope = (task["scope"] as { paths?: unknown } | undefined)?.paths;
  const paths = Array.isArray(scope) ? scope.map(String) : [];
  if (paths.some((p) => config.review.poRequiredPaths.some((rule) => globOverlaps(p, rule)))) {
    return "po";
  }

  const declared = (task["review"] as { policy?: string } | undefined)?.policy;
  if (declared === "auto") return "auto";
  if (declared === "po") return "po";
  if (declared === "banto") return "banto";
  /**
   * 旧称 `manual` は `banto` へ読み替える（決定57：人＝PO 直行だった経路に番頭が入る）。
   *
   * **明示的に写す。** ここを「知らない値は既定へ落とす」で済ませていると、既定を
   * 反転した瞬間（realign 第3便）に**「人が見る」と書いたタスクが黙って機械通過になる**
   * ——帳簿には `manual` 宣言が13本あった。読み替えの向きは既定と独立でなければならない。
   */
  if (declared === "manual") return "banto";
  // 既定は層Bで差し替えられる（後戻りの口）。ここまで来ているということは、厳しい側の
  // 上書き（`governance` / `po_required_paths`）にも `manual` にも当たっていない
  return config.review.defaultPolicy ?? DEFAULT_REVIEW_STAGE;
}

// ── 自動着地の証拠（realign 第3便・PO 裁定 2026-08-14）─────────────────────────

/**
 * 監査の側の証拠。`handleAuditVerdict` が判定を刻むのと同じ時点で全部手に入る。
 */
export interface AutoLandEvidence {
  /** どの契約に対して監査したか（`audit_verdict.contractVersion`）。 */
  contractVersion?: number;
  /** どの基準で監査したか（`audit_verdict.checklistVersion`）。 */
  checklistVersion?: string;
  /**
   * そのときの契約の受け入れ条件。**見るのは `verify` だけ**（他の欄は無視する）
   * ——`id` や `text` まで要求すると、呼ぶ側が判定と関係ない形合わせを強いられる。
   */
  acceptance: ReadonlyArray<{ verify?: string; [key: string]: unknown }>;
}

/**
 * **自動着地を止める理由**。空なら人を通さず着地させてよい（PO 裁定 2026-08-14）。
 *
 * 真偽値ではなく理由の並びを返すのは、**落とした原因が帳簿から読めるようにする**ため
 * （I2：握り潰さない）。欠けが複数あれば複数返す——1つ直せば通ると読ませない。
 *
 * ## なぜ刻みを要求するのか
 *
 * 帳簿にある過去の監査 pass は、**判定基準が監査人に一度も届いていない状態**で、
 * **D1 を知らない実装役**の成果に対して出されたもの（realign 第2便で両方塞いだ）。
 * 刻みの無い判定は、その混在した過去のものと区別が付かない。「証拠のあるものだけを
 * 機械に通させる」ために刻みを要求したのだから、証拠が無いものを黙って通すなら
 * 要求した意味がなくなる。→ `spec-daemon-core` §2.4
 *
 * ## なぜ検査を要求するのか
 *
 * マージ前ゲートは**契約が書いた `verify` を回すだけ**なので、1本も無ければ
 * 「何も確かめずに passed」になる。実測で帳簿の契約72本中50本がこれだった。
 * 人が見るならその目が検査の代わりになるが、機械だけで通すならならない。
 */
export function autoLandBlockers(evidence: AutoLandEvidence): string[] {
  const blockers: string[] = [];
  if (evidence.contractVersion === undefined) {
    blockers.push("auto_land_unmarked:contractVersion（どの契約に対して監査したかが刻まれていない）");
  }
  if (evidence.checklistVersion === undefined) {
    blockers.push("auto_land_unmarked:checklistVersion（どの基準で監査したかが刻まれていない）");
  }
  // 空文字は「有る」に数えない——回すものが無いのは 1本も無いのと同じ
  if (!evidence.acceptance.some((ac) => typeof ac.verify === "string" && ac.verify.length > 0)) {
    blockers.push("auto_land_no_verify（契約に検査コマンドが1本も無く、ゲートが素通りする）");
  }
  return blockers;
}

/**
 * ゲートの側の証拠。**自動着地のときだけ要求する**（番頭裁定 2026-08-14）。
 *
 * この2つは `runMergeGate` の**出力**で、監査の分岐の時点にはまだ存在しない
 * （ゲートが回るのは `merging` に入ったあと）。だから「自動着地の入力」ではなく
 * **ゲートの成立条件**として扱う——状態機械を作り替えてゲートを前倒しするより、
 * 通す側の条件を1つ足す方が影響が小さい。
 *
 * **人の承認を経た経路には効かせない。** 人が見ているものと機械だけで通すものを
 * 同じ基準にすると、既存の緑が理由なく落ちる。この非対称は意図。
 */
export function gateEvidenceBlockers(marks: {
  baseCommit?: string;
  environmentDigest?: string;
}): string[] {
  const blockers: string[] = [];
  if (marks.baseCommit === undefined) {
    blockers.push("auto_land_unmarked:baseCommit（どのコミットの上で検査したかを刻めなかった）");
  }
  if (marks.environmentDigest === undefined) {
    blockers.push("auto_land_unmarked:environmentDigest（どの環境で検査したかを刻めなかった）");
  }
  return blockers;
}

/**
 * そのタスクは**人の承認を経ずに** `merging` へ入ったか（D3：帳簿から導く）。
 *
 * `auditing → merging` が自動着地の道、`approved → merging` が人を通した道
 * （`state-machine.ts` の遷移表）。**直近の入り方**で決める——過去に一度承認された
 * ことを、いまの着地の証拠に流用しない（落ちて差し戻し、次は自動、が起こりうる）。
 *
 * 別に持たない：真実は `state_transitioned` の並びだけ（D3）。
 */
export function landedWithoutHumanApproval(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "state_transitioned") continue;
    if (e.projectTag !== projectTag || e.taskId !== taskId) continue;
    if (e.to !== "merging") continue;
    return e.from === "auditing";
  }
  return false;
}

/**
 * 2つの glob が**重なりうるか**。
 *
 * ここで見たいのは「そのタスクが PO 必須の面に触る**可能性**があるか」なので、
 * 片方がもう片方を含む場合も重なりとして扱う（`packages/**` と `packages/banto-web/**`）。
 * **判定は緩い方へ倒さない**——迷ったら PO に見せる。
 *
 * D6: glob ライブラリを足さない。`**` と `*` だけを見る小さな比較で足りる。
 */
function globOverlaps(a: string, b: string): boolean {
  const segsA = a.split("/");
  const segsB = b.split("/");
  const len = Math.min(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const x = segsA[i]!;
    const y = segsB[i]!;
    if (x === "**" || y === "**") return true;
    if (!segmentOverlaps(x, y)) return false;
  }
  // ここまで一致していれば、どちらかが他方の下（＝重なる）
  return true;
}

/** 1階層の比較。`*` は任意の並びに当たる。 */
function segmentOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.includes("*") && !b.includes("*")) return false;
  const toRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return toRegExp(a).test(b) || toRegExp(b).test(a);
}
