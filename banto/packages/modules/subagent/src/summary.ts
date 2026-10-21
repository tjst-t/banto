// **要約の材料**（決定・2026-10-20、ユーザー「人が明示的にボタンを押して要約を指示したときだけでいい」。アーキ仕様 §4.1「4.」、
// Backlog #490）。
//
// 材料は banto 側から見えたことだけ——頼んだ文の頭・やること一覧・経過の新しい分（題・説明・状態）・最後の発言・触ったファイル。
// エージェントの会話の記録は読まない。要約を作るのは core（host の口 `relaySummarizeBackgroundWork`）で、指示とモデルも core が持つ
// ——ここは材料を組むだけ。core も上限（`BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS`）で切るが、ここでも超えないように組む
// （切られるのが一番新しい経過にならないように、収まらなければ古い経過から落とす）。数字は仕様の最初の値

import { BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS } from "@banto/module-contract";
import type { RunRecord, RunStep } from "./runs.js";

export const SUMMARY_PROMPT_HEAD = 2000;
export const SUMMARY_STEPS = 40;
export const SUMMARY_MESSAGES = 3;
export const SUMMARY_FILES = 20;

const STATUS_WORD: Record<string, string> = { pending: "待ち", in_progress: "実行中", completed: "済み", failed: "失敗" };

/** 字（コードポイント）で頭から切る */
function head(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

const length = (s: string) => [...s].length;

function stepLine(s: RunStep): string {
  const status = s.status ? `（${STATUS_WORD[s.status] ?? s.status}）` : "";
  return `- [${s.kind ?? "other"}] ${s.title}${s.description ? ` — ${s.description}` : ""}${status}`;
}

/** 走っている仕事の記録から、要約の材料を組む（`max` 字を超えない） */
export function summaryMaterialOf(r: RunRecord, max = BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS): string {
  const parts: string[] = [];
  parts.push(`頼んだ相手：${r.agentTitle}${r.label ? `\n呼び名：${r.label}` : ""}`);
  parts.push(`頼んだ文（頭 ${SUMMARY_PROMPT_HEAD} 字）：\n${head(r.prompt, SUMMARY_PROMPT_HEAD)}`);
  if (r.plan?.length) {
    const done = r.plan.filter((p) => p.status === "completed").length;
    parts.push(`やること一覧（${done} / ${r.plan.length} 済み）：\n${r.plan.map((p) => `- [${STATUS_WORD[p.status]}] ${p.content}`).join("\n")}`);
  }
  const said = r.steps.filter((s) => s.kind === "message").slice(-SUMMARY_MESSAGES);
  if (said.length) parts.push(`最後の発言（新しい ${said.length} 件、古い順）：\n${said.map((s) => `- ${s.title}`).join("\n")}`);
  if (r.files?.length) {
    const files = [...r.files].sort((a, b) => b.wrote - a.wrote || b.read - a.read || b.lastAt - a.lastAt).slice(0, SUMMARY_FILES);
    parts.push(`触ったファイル（上位 ${files.length} / ${r.files.length}）：\n${files.map((f) => `- ${f.path}（書いた ${f.wrote}・読んだ ${f.read}）`).join("\n")}`);
  }
  const fixed = parts.join("\n\n");

  // 経過は新しいほうから、収まる分だけ（並びは古い順に戻す）
  const tools = r.steps.filter((s) => s.kind !== "message").slice(-SUMMARY_STEPS);
  const label = `経過（tool の呼び出し、新しい ${tools.length} 件まで、古い順）：`;
  let budget = max - length(fixed) - length(`\n\n${label}`);
  const lines: string[] = [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const line = stepLine(tools[i]!);
    const cost = length(line) + 1;
    if (cost > budget) break;
    budget -= cost;
    lines.unshift(line);
  }
  const text = lines.length ? `${fixed}\n\n${label}\n${lines.join("\n")}` : fixed;
  // 経過を除いても超えるとき（頼んだ文とほかの欄で上限を超えることは今の数字では無いが）は頭から切る
  return length(text) > max ? [...text].slice(0, max).join("") : text;
}
