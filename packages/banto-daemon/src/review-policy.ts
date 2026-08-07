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
import type { TaskRecord } from "@banto/core";

/** レビューの段（決定57）。 */
export type ReviewStage = "auto" | "banto" | "po";

/** 既定は `banto`——監査を通ったものは番頭が一次受けする（決定57）。 */
export const DEFAULT_REVIEW_STAGE: ReviewStage = "banto";

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
  };
  review: {
    /**
     * ここに触るタスクは必ず PO まで上げる（決定57・66）。
     *
     * 書き方は `scope.paths` と同じ glob（`packages/banto-web/**`）。**既定は空**。
     */
    poRequiredPaths: string[];
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
  const review = (parsed["review"] ?? {}) as Record<string, unknown>;
  const limits = (parsed["limits"] ?? {}) as Record<string, unknown>;
  const rawPaths = review["po_required_paths"];
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
    throw new Error(`${PROJECT_CONFIG_PATH}: review.po_required_paths は配列で書いてください`);
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

  return {
    verify: { profile: (verifyProfile as string | undefined) ?? DEFAULT_VERIFY_PROFILE },
    review: { poRequiredPaths: Array.isArray(rawPaths) ? rawPaths.map(String) : [] },
    limits: {
      ...(tier !== undefined ? { maxModelTier: tier as ProjectConfig["limits"]["maxModelTier"] } : {}),
      ...(concurrent !== undefined ? { maxConcurrentSessions: concurrent } : {}),
      ...(verifyMinutes !== undefined ? { verifyTimeoutMinutes: verifyMinutes } : {}),
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
  // 旧称 `manual` は `banto` へ読み替える（決定57：人＝PO 直行だった経路に番頭が入る）
  return DEFAULT_REVIEW_STAGE;
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
