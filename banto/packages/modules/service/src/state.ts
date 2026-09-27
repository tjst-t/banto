// systemd の状態と、起動役が残した記録と、マスターの desired から、AI に見せる状態を決める
// （docs/specs/v4-modules.md §4.2「状態の語彙」）。

import type { Desired } from "./spec.js";
import type { ExitRecord } from "./log-wrapper.js";

export type ServiceState =
  | "running" // 動いている
  | "starting" // 起動の途中
  | "restarting" // 落ちて、systemd が起こし直す途中
  | "crashed" // 落ちて、起こし直しの上限に当たった（startService / restartService で起こし直せる）
  | "exited" // 自分で終わった（終了コード 0）。起こし直さない
  | "stopped" // banto が止めた（stopService）
  | "stopped-externally" // 人やプログラムが中で止めた。止めたまま受け入れる（決定・2026-09-27）
  | "not-started"; // まだ一度も起きていない・写しが無かった

export const STATE_LABELS: Record<ServiceState, string> = {
  running: "動いている",
  starting: "起動の途中",
  restarting: "落ちて、起こし直している途中",
  crashed: "落ちた（起こし直しの上限に当たった。startService か restartService で起こし直せる）",
  exited: "自分で終わった（終了コード 0。起こし直さない）",
  stopped: "止めた（stopService）",
  "stopped-externally": "外から止められた（banto は起こし直さない。コンテナを起こし直すと起きる）",
  "not-started": "まだ起きていない",
};

/** `systemctl show -p …` の出力（KEY=VALUE の行）を読む */
export function parseShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function decideState(input: {
  show: Record<string, string>;
  desired: Desired;
  lastExit?: ExitRecord;
  startedAt?: string;
}): ServiceState {
  const active = input.show["ActiveState"] ?? "inactive";
  const sub = input.show["SubState"] ?? "";
  if (active === "active" || active === "reloading") return "running";
  if (active === "activating") return sub === "auto-restart" ? "restarting" : "starting";
  // 止めたものは、systemd に落ちた印が残っていても「止めた」（Fable のレビュー）
  if (input.desired === "stopped") return "stopped";
  if (active === "failed") return "crashed";
  // inactive / deactivating：systemd は終わり方を忘れているので、起動役の記録で見分ける
  const exit = input.lastExit;
  // 記録が今回の起動より古いなら、今回の終わり方は分からない
  if (!exit || (input.startedAt && exit.at < input.startedAt)) return "not-started";
  if (exit.stopRequested) return "stopped-externally";
  if (exit.code === 0 && !exit.signal) return "exited";
  return "crashed";
}
