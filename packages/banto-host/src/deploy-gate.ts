/**
 * デプロイゲート（task-0274 / PO裁定 2026-08-17）。
 *
 * banto は main の .ts を直読し、**起こし直し（再起動）で反映**される。マージ ≠ 反映
 * なので、フル回帰（npm test 一式）は起こし直しの**直前**に1回走らせれば足りる。
 * ここはその口——マージ前ゲート（banto-daemon）が変更対象 spec + typecheck だけに限定
 * したぶんを、デプロイ時にまとめて回す。
 *
 * ## 2段構えの位置づけ
 *
 * - マージ前ゲート = 変更対象 spec + typecheck（フル回帰は走らせない）
 * - デプロイゲート = 起こし直しの直前に main に対して npm test 一斉、pass したときだけ再起動
 *
 * ## クラッシュ復旧は対象外（設計の中心）
 *
 * `Restart=on-failure` による自動再起動は systemd が行うもので、テストしてから起こすことは
 * できない。これは**デプロイではなく復旧**なので、ゲートを通さない（従来どおり即復旧）。
 * ゲートを通るのは**計画的デプロイ**（`system.deploy` を明示的に呼んだとき）だけ。
 *
 * 判定ロジックは `evaluateDeployGate` に切り出し、道具の実行や再起動の仕組みへ
 * 依存させない（D5: 判定はここ、Surface に判断を持たせない）。試験は偽の verify /
 * restart / record を差して判定だけを検証する。
 */

import { Type } from "typebox";
import { defineNamespacedTool } from "@banto/core";

/**
 * 計画的な起こし直しの対象になりうる常駐サービスの unit 名（4ユニット構成）。
 *
 * safe-restart SKILL の表と揃える。`banto-daemon.service` は本来5つ目の口だが、
 * 稼働機の unit はこの4つ（banto.service / banto-daemon.service / banto-worker-pool.service /
 * banto-environment-pool.service）が実在する計画的な起こし直しの単位である。
 */
export const DEPLOY_UNITS = [
  "banto.service",
  "banto-daemon.service",
  "banto-worker-pool.service",
  "banto-environment-pool.service",
] as const;

/** `system.deploy` の `units` 引数の既定値。指定が無ければ4つ全部。 */
export const DEFAULT_DEPLOY_UNITS: readonly string[] = DEPLOY_UNITS;

/** デプロイゲートで走らせる検証コマンドの既定。フル回帰（npm test 一式）を回す。 */
export const DEFAULT_DEPLOY_VERIFY_COMMAND = "npm test";

/** 検証の結果。 */
export interface DeployVerifyResult {
  /** 検証が通ったか。 */
  passed: boolean;
  /** 失敗内容（落ちた spec・終了コードなど）。pass なら空か説明。 */
  report: string;
  /** 走らせた検証コマンド。記録に残す（後から何をもって通した（落とした）のか言える）。 */
  command: string;
  /** この回で強制フラグを押したか。 */
  forced: boolean;
}

/** `evaluateDeployGate` の戻り値。再起動を呼ぶべきか、拒否すべきかの判定だけを持つ。 */
export type DeployOutcome =
  | {
      kind: "restart";
      units: string[];
      forced: boolean;
      verify: DeployVerifyResult;
    }
  | {
      kind: "rejected";
      units: string[];
      forced: false;
      verify: DeployVerifyResult;
    };

/** 検証一式を実行する口。Environment Pool の `env.verify` や、ホストから直接 `npm test` を回す実装を差す。 */
export interface DeployVerifyRunner {
  /** `command`（例: npm test）を main のチェックアウトに対して回す。 */
  run(command: string): Promise<{ passed: boolean; report: string }>;
}

/**
 * デプロイゲートの中立な判定。
 *
 * I2: 検証に到達できなかった（落ちた）ことを「通った」にしない——`passed:false` のまま
 * 拒否する。呼び出し側は `outcome.kind` だけで再起動するかどうかを決める。
 */
export async function evaluateDeployGate(opts: {
  units: string[];
  force: boolean;
  verifyCommand: string;
  verify: DeployVerifyRunner;
  /** 判定（通過・拒否・強制）を記録する口。force で通したことが残る。 */
  record: (line: string) => void;
}): Promise<DeployOutcome> {
  const { units, force, verifyCommand, verify, record } = opts;

  if (force) {
    // 強制は**明示的に**だけ通す。通したことが記録に残る（a3）。
    const verify: DeployVerifyResult = {
      passed: true,
      report: "(force で検証を省略)",
      command: verifyCommand,
      forced: true,
    };
    record(`deploy-force: units=[${units.join(",")}] verify=${verifyCommand}（ゲートを強制で迂回）`);
    return { kind: "restart", units, forced: true, verify };
  }

  const r = await verify.run(verifyCommand);
  const result: DeployVerifyResult = { ...r, command: verifyCommand, forced: false };

  if (!result.passed) {
    // I2: ゲートは失敗で**再起動しない**（拒否）。落ちた内容を report に載せて返す。
    record(`deploy-rejected: units=[${units.join(",")}] verify=${verifyCommand}（${result.report}）`);
    return { kind: "rejected", units, forced: false, verify: result };
  }

  record(`deploy-pass: units=[${units.join(",")}] verify=${verifyCommand}（${result.report}）`);
  return { kind: "restart", units, forced: false, verify: result };
}

/** `createDeployTool` が検証と再起動のために持つ口。 */
export interface DeployToolDeps {
  /** この道具を呼んだ会話（`system.restart` と同じ。取れなければ宛先なし）。 */
  threadId?: string;
  /** 全クライアントへ知らせる。 */
  notify(text: string, target: { threadId?: string }): Promise<void>;
  /** WS/HTTP と全スレッドの後始末。 */
  close(): Promise<void>;
  /** プロセスを終える。systemd が起動し直す。 */
  exit(code: number): void;
  /** 返事が履歴へ落ちるまでの猶予。 */
  graceMs?: number;
  /** main に対して検証一式を回す（`env.verify` 相当）。 */
  runVerify(command: string): Promise<{ passed: boolean; report: string }>;
  /** 指定ユニットを起こし直す。`banto.service`（自分）が含まれるときは graceful に落ちる。 */
  restart(opts: { units: string[]; forced: boolean; verifyCommand: string }): Promise<void>;
  /** 判定（通過・拒否・強制）を残す記録の口。 */
  record(line: string): void;
}

/** 既知の unit 名だけに絞る。未知の名前は黙って捨てず、呼び出し側が説明に載せる。 */
function knownUnits(units: readonly string[]): string[] {
  const allowed = new Set<string>(DEPLOY_UNITS);
  return units.filter((u) => allowed.has(u));
}

/**
 * `system.deploy`——計画的デプロイの正式な口。
 *
 * 動作: (1) main に対して `npm test` 一式を検証、(2) pass → 指定ユニットを起こし直す、
 * (3) fail → **拒否**し、失敗内容（落ちた spec）を返す。`force:true` のときだけ明示的に
 * ゲートを迂回し、迂回したことは記録に残る。
 *
 * クラッシュ復旧（`Restart=on-failure` の自動再起動）はこの道具を通らない——systemd が
 * 即起こす（従来どおり）。計画的デプロイだけがゲートを通る。
 *
 * 素通しの `system.restart` との関係: デプロイ時の正式な口はこちら（ゲート付き）。
 * `system.restart` は緊急/強制のみ・明示的に使う。
 */
export function createDeployTool(deps: DeployToolDeps) {
  const graceMs = deps.graceMs ?? 1000;
  return defineNamespacedTool({
    name: "system.deploy",
    label: "System: Deploy",
    description:
      "計画的デプロイ（起こし直し）の正式な口。main に対して検証一式（既定 npm test）を" +
      "回し、**通ったときだけ**指定ユニットを起こし直す。落ちていれば**拒否**して" +
      "失敗内容（落ちた spec）を返す——再起動しない。force:true のときだけ明示的にゲートを" +
      "迂回でき、迂回したことは記録に残る。" +
      "対象は4ユニット（banto.service / banto-daemon.service / banto-worker-pool.service / " +
      "banto-environment-pool.service）。クラッシュ復旧（Restart=on-failure の自動再起動）は" +
      "このゲートを通らない——即復旧（従来どおり）。",
    parameters: Type.Object({
      units: Type.Optional(Type.Array(Type.String())),
      force: Type.Optional(Type.Boolean()),
      verifyCommand: Type.Optional(Type.String()),
    }),
    async execute(params) {
      const units = knownUnits(
        Array.isArray(params["units"]) && params["units"].length > 0
          ? params["units"]
          : DEFAULT_DEPLOY_UNITS
      );
      const force = params["force"] === true;
      const verifyCommand =
        typeof params["verifyCommand"] === "string" && params["verifyCommand"].length > 0
          ? params["verifyCommand"]
          : DEFAULT_DEPLOY_VERIFY_COMMAND;

      if (units.length === 0) {
        // 未知の unit 名しか指定されなかった——黙って通さない（I2）。エラーは投げて
        // サーバが tool を failed として記録する（server.ts の tool_end 翻訳）
        return {
          content: [
            {
              type: "text" as const,
              text: `システムの unit 名が分かりません（既知は ${DEPLOY_UNITS.join(" / ")}）`,
            },
          ],
        };
      }

      const outcome = await evaluateDeployGate({
        units,
        force,
        verifyCommand,
        verify: { run: (command) => deps.runVerify(command) },
        record: deps.record,
      });

      if (outcome.kind === "rejected") {
        // I2: 失敗で再起動しない。落ちた内容を報告だけして、このターンは完走する
        return {
          content: [
            {
              type: "text" as const,
              text:
                `デプロイを拒否します（検証が通りませんでした）。再起動はしません。\n` +
                `検証: ${verifyCommand}\n${outcome.verify.report}`,
            },
          ],
        };
      }

      // ゲート通過 → 起こし直す。`system.restart` と同じく、返事を返してからターンの外で
      // 落ちる（tool_end を書く余地を残す）。banto.service（自分）の再起動は deps.restart が
      // notify → close → exit の順で行う。
      const forcedLabel = outcome.forced ? "（force でゲートを迂回）" : "";
      const timer = setTimeout(() => {
        void (async () => {
          try {
            await deps.restart({ units, forced: outcome.forced, verifyCommand });
          } catch (err) {
            // I2: 再起動の後始末で転んだことを黙って exit(0) に混ぜない
            console.error(`[banto] デプロイ再起動で転びました: ${String(err)}`);
          }
          deps.exit(0);
        })();
      }, graceMs);
      timer.unref?.();
      return {
        content: [
          {
            type: "text" as const,
            text:
              `検証が通ったので再起動します${forcedLabel}。対象: ${units.join(" / ")}。` +
              `検証: ${verifyCommand}`,
          },
        ],
      };
    },
  });
}
