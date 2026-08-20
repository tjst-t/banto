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
 * ## 画面（banto-web）のビルドも同じ口に乗せる（task-0304）
 *
 * banto-host は `packages/banto-web/dist` を静的配信するが、その dist は起こし直しでは
 * 作り直されない——`npm run build:web` を誰かが手で打つまで web 側の変更は反映されず、
 * 「工場は緑・main へ着地済み・でも画面は古いまま」になる（task-0279 で実際に起きた）。
 * デプロイゲートは検証（npm test）に通ったあと・ユニットを起こし直す前にこのビルドも
 * 回し、失敗すれば検証の失敗と同じ扱いで**拒否**する（古い dist を配り続ける方が、
 * 半端な状態で再起動するより安全）。対象ユニットに `banto.service` が無いデプロイ
 * （例: worker-pool だけの起こし直し）は画面を配り直す意味が無いので飛ばすが、
 * 飛ばした理由は記録・返答に必ず残す（黙って飛ばさない）。
 *
 * 判定ロジックは `evaluateDeployGate` に切り出し、道具の実行や再起動の仕組みへ
 * 依存させない（D5: 判定はここ、Surface に判断を持たせない）。試験は偽の verify /
 * build / restart / record を差して判定だけを検証する。
 */

import { Type } from "typebox";
import { defineNamespacedTool } from "@banto/core";
import { runDeployVerify } from "./deploy-verify.js";

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

/** 画面（packages/banto-web）の dist を作り直すコマンドの既定（task-0304）。 */
export const DEFAULT_DEPLOY_BUILD_WEB_COMMAND = "npm run build:web";

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

/**
 * 画面（packages/banto-web）ビルドの結果（task-0304）。
 *
 * 対象ユニットに `banto.service` が無いデプロイでは実行自体を飛ばすことがある——
 * そのときは `attempted: false` になり、`report` に飛ばした理由が残る（黙って飛ばさない）。
 */
export interface DeployBuildResult {
  /** 実際にビルドコマンドを走らせたか。飛ばした（force・対象外ユニット）ときは false。 */
  attempted: boolean;
  /** ビルドが失敗していないか。飛ばしたときは true 扱い（再起動を妨げない）。 */
  passed: boolean;
  /** 失敗内容、または飛ばした理由。 */
  report: string;
  /** 走らせた（または走らせるはずだった）ビルドコマンド。 */
  command: string;
}

/** `evaluateDeployGate` の戻り値。再起動を呼ぶべきか、拒否すべきかの判定だけを持つ。 */
export type DeployOutcome =
  | {
      kind: "restart";
      units: string[];
      forced: boolean;
      verify: DeployVerifyResult;
      build: DeployBuildResult;
    }
  | {
      kind: "rejected";
      units: string[];
      forced: false;
      verify: DeployVerifyResult;
      build: DeployBuildResult;
    };

/** 検証一式を実行する口。Environment Pool の `env.verify` や、ホストから直接 `npm test` を回す実装を差す。 */
export interface DeployVerifyRunner {
  /** `command`（例: npm test）を main のチェックアウトに対して回す。 */
  run(command: string): Promise<{ passed: boolean; report: string }>;
}

/** 画面ビルドを実行する口（task-0304）。`DeployVerifyRunner` と同じ形——任意の npm スクリプトを回す。 */
export interface DeployBuildRunner {
  /** `command`（例: npm run build:web）を main のチェックアウトに対して回す。 */
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
  /** 画面ビルドのコマンド（既定 `npm run build:web`）。task-0304。 */
  buildCommand: string;
  /** 画面ビルドを実行する口。task-0304。 */
  build: DeployBuildRunner;
  /** 判定（通過・拒否・強制）を記録する口。force で通したことが残る。 */
  record: (line: string) => void;
}): Promise<DeployOutcome> {
  const { units, force, verifyCommand, verify, buildCommand, build, record } = opts;

  if (force) {
    // 強制は**明示的に**だけ通す。通したことが記録に残る（a3）。検証と同じく
    // 画面ビルドも force で迂回する（task-0304: 既存のゲート迂回と揃える）。
    const verifyResult: DeployVerifyResult = {
      passed: true,
      report: "(force で検証を省略)",
      command: verifyCommand,
      forced: true,
    };
    const buildResult: DeployBuildResult = {
      attempted: false,
      passed: true,
      report: "(force で画面ビルドも省略)",
      command: buildCommand,
    };
    record(
      `deploy-force: units=[${units.join(",")}] verify=${verifyCommand} build=${buildCommand}` +
        `（ゲートと画面ビルドを force で迂回）`
    );
    return { kind: "restart", units, forced: true, verify: verifyResult, build: buildResult };
  }

  const r = await verify.run(verifyCommand);
  const verifyResult: DeployVerifyResult = { ...r, command: verifyCommand, forced: false };

  if (!verifyResult.passed) {
    // I2: ゲートは失敗で**再起動しない**（拒否）。落ちた内容を report に載せて返す。
    // 検証が通らなかった時点で画面ビルドは実行しない。
    const buildResult: DeployBuildResult = {
      attempted: false,
      passed: false,
      report: "検証が通らなかったため画面ビルドは実行していません",
      command: buildCommand,
    };
    record(`deploy-rejected: units=[${units.join(",")}] verify=${verifyCommand}（${verifyResult.report}）`);
    return { kind: "rejected", units, forced: false, verify: verifyResult, build: buildResult };
  }

  // task-0304: 検証に通ったあと・ユニットを起こし直す前に画面をビルドし直す。
  // 対象に banto.service（画面を配信するユニット）が無いなら配り直す意味が無いので
  // 飛ばすが、飛ばした理由は必ず記録に残す（黙って飛ばさない）。
  let buildResult: DeployBuildResult;
  if (!units.includes("banto.service")) {
    buildResult = {
      attempted: false,
      passed: true,
      report: "対象ユニットに banto.service が無いため画面ビルドを飛ばしました",
      command: buildCommand,
    };
    record(`deploy-build-skip: units=[${units.join(",")}]（${buildResult.report}）`);
  } else {
    const b = await build.run(buildCommand);
    buildResult = { attempted: true, passed: b.passed, report: b.report, command: buildCommand };

    if (!b.passed) {
      // I2: 画面ビルドの失敗も検証の失敗と同じ扱い——起こし直さず拒否する。
      // 古い dist を配り続ける方が、半端な状態で再起動するより安全。
      record(`deploy-build-rejected: units=[${units.join(",")}] build=${buildCommand}（${b.report}）`);
      return { kind: "rejected", units, forced: false, verify: verifyResult, build: buildResult };
    }
    record(`deploy-build-pass: units=[${units.join(",")}] build=${buildCommand}（${b.report}）`);
  }

  record(`deploy-pass: units=[${units.join(",")}] verify=${verifyCommand}（${verifyResult.report}）`);
  return { kind: "restart", units, forced: false, verify: verifyResult, build: buildResult };
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
  /**
   * 画面（packages/banto-web）の dist を作り直す（`npm run build:web` 相当）。task-0304。
   * 省略時は `runDeployVerify`（deploy-verify.ts の汎用ランナー）を既定コマンドで使う——
   * 検証と同じく任意の npm スクリプトをシェルを介さず実行できるので実装を流用できる。
   */
  runBuildWeb?(command: string): Promise<{ passed: boolean; report: string }>;
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
 * 動作: (1) main に対して `npm test` 一式を検証、(2) pass → 対象に `banto.service` が
 * あれば画面（`npm run build:web`）を作り直す、(3) 検証・画面ビルドがどちらも通れば
 * 指定ユニットを起こし直す、(4) どちらかが fail → **拒否**し、失敗内容を返す。
 * `force:true` のときだけ明示的にゲートと画面ビルドを迂回し、迂回したことは記録に残る。
 *
 * クラッシュ復旧（`Restart=on-failure` の自動再起動）はこの道具を通らない——systemd が
 * 即起こす（従来どおり）。計画的デプロイだけがゲートを通る。
 *
 * 素通しの `system.restart` との関係: デプロイ時の正式な口はこちら（ゲート付き）。
 * `system.restart` は緊急/強制のみ・明示的に使う。
 */
export function createDeployTool(deps: DeployToolDeps) {
  const graceMs = deps.graceMs ?? 1000;
  const runBuildWeb =
    deps.runBuildWeb ?? ((command: string) => runDeployVerify(command, process.cwd()));
  return defineNamespacedTool({
    name: "system.deploy",
    label: "System: Deploy",
    description:
      "計画的デプロイ（起こし直し）の正式な口。main に対して検証一式（既定 npm test）を" +
      "回し、通ったら対象に banto.service を含む場合に画面（npm run build:web）も作り直す。" +
      "**どちらも通ったときだけ**指定ユニットを起こし直す。どちらかが落ちていれば**拒否**して" +
      "失敗内容（落ちた spec、または画面ビルドの失敗内容）を返す——再起動しない。" +
      "force:true のときだけ明示的にゲートと画面ビルドを迂回でき、迂回したことは記録に残る。" +
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
        buildCommand: DEFAULT_DEPLOY_BUILD_WEB_COMMAND,
        build: { run: (command) => runBuildWeb(command) },
        record: deps.record,
      });

      if (outcome.kind === "rejected") {
        // I2: 失敗で再起動しない。落ちた内容を報告だけして、このターンは完走する
        const buildFailed = outcome.build.attempted && !outcome.build.passed;
        const reasonLabel = buildFailed ? "画面ビルドが失敗しました" : "検証が通りませんでした";
        const buildLine = buildFailed
          ? `\n画面ビルド: ${outcome.build.command}\n${outcome.build.report}`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `デプロイを拒否します（${reasonLabel}）。再起動はしません。\n` +
                `検証: ${verifyCommand}\n${outcome.verify.report}${buildLine}`,
            },
          ],
        };
      }

      // ゲート通過 → 起こし直す。`system.restart` と同じく、返事を返してからターンの外で
      // 落ちる（tool_end を書く余地を残す）。banto.service（自分）の再起動は deps.restart が
      // notify → close → exit の順で行う。
      const forcedLabel = outcome.forced ? "（force でゲートを迂回）" : "";
      const buildLabel = outcome.build.attempted
        ? `画面ビルド: 成功（${outcome.build.command}）。`
        : `画面ビルド: 省略（${outcome.build.report}）。`;
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
              `検証: ${verifyCommand}。${buildLabel}`,
          },
        ],
      };
    },
  });
}
