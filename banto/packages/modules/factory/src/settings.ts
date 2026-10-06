// Factory の設定（Project ごと。v4-modules.md §4.5「設定」）。置き場は host が渡す `BANTO_MODULE_DATA_DIR`。
// **流し始めた実行は、そのときの設定の写しで最後まで走る**——途中で設定を変えても、流し直し（再開）が同じ手順になる。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentChoice {
  agent: string;
  model?: string;
  effort?: string;
}

export interface FactorySettings {
  /** テストのコマンド（`/bin/sh -c` に渡す。worktree で走らせる）。**無ければ流さない**——テストの関門が Factory の要 */
  testCommand: string;
  /** 準備のコマンド（worktree を作った直後に一度。依存の写し等）。無くてよい */
  prepareCommand: string;
  /** 取り込む先のブランチ */
  targetBranch: string;
  implementer: AgentChoice;
  reviewer: AgentChoice;
  /** 同時に走らせる件数（マージの列は別に1本） */
  concurrency: number;
  limits: { testRetries: number; reviewRounds: number; rebaseRetries: number; noCommitRetries: number };
  /** テスト1回の上限（分） */
  testTimeoutMinutes: number;
}

export const DEFAULT_SETTINGS: FactorySettings = {
  testCommand: "",
  prepareCommand: "",
  targetBranch: "main",
  implementer: { agent: "claude-code" },
  reviewer: { agent: "claude-code" },
  concurrency: 3,
  limits: { testRetries: 3, reviewRounds: 2, rebaseRetries: 3, noCommitRetries: 2 },
  testTimeoutMinutes: 60,
};

export class SettingsError extends Error {}

function settingsPath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

const intIn = (v: unknown, min: number, max: number, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new SettingsError(`${name} は ${min}〜${max} の整数で書いてください`);
  }
  return v;
};

const agentOf = (v: unknown, name: string): AgentChoice => {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.agent !== "string" || o.agent.trim() === "") throw new SettingsError(`${name}.agent が要ります`);
  return {
    agent: o.agent.trim(),
    ...(typeof o.model === "string" && o.model.trim() ? { model: o.model.trim() } : {}),
    ...(typeof o.effort === "string" && o.effort.trim() ? { effort: o.effort.trim() } : {}),
  };
};

/** 足りない欄は既定で埋め、形が違えば理由つきで断る（黙って既定に落とさない） */
export function normalizeSettings(raw: unknown): FactorySettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const str = (k: string, def: string) => {
    const v = o[k];
    if (v === undefined) return def;
    if (typeof v !== "string") throw new SettingsError(`${k} は文字列で書いてください`);
    return v.trim();
  };
  const limits = (o.limits ?? {}) as Record<string, unknown>;
  const target = str("targetBranch", d.targetBranch);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(target) || target.includes("..")) {
    throw new SettingsError("targetBranch はブランチ名（英数字と . _ / -）で書いてください");
  }
  return {
    testCommand: str("testCommand", d.testCommand),
    prepareCommand: str("prepareCommand", d.prepareCommand),
    targetBranch: target,
    implementer: o.implementer === undefined ? d.implementer : agentOf(o.implementer, "implementer"),
    reviewer: o.reviewer === undefined ? d.reviewer : agentOf(o.reviewer, "reviewer"),
    concurrency: o.concurrency === undefined ? d.concurrency : intIn(o.concurrency, 1, 16, "concurrency"),
    limits: {
      testRetries: limits.testRetries === undefined ? d.limits.testRetries : intIn(limits.testRetries, 0, 20, "limits.testRetries"),
      reviewRounds: limits.reviewRounds === undefined ? d.limits.reviewRounds : intIn(limits.reviewRounds, 0, 20, "limits.reviewRounds"),
      rebaseRetries:
        limits.rebaseRetries === undefined ? d.limits.rebaseRetries : intIn(limits.rebaseRetries, 0, 20, "limits.rebaseRetries"),
      noCommitRetries:
        limits.noCommitRetries === undefined ? d.limits.noCommitRetries : intIn(limits.noCommitRetries, 0, 20, "limits.noCommitRetries"),
    },
    testTimeoutMinutes:
      o.testTimeoutMinutes === undefined ? d.testTimeoutMinutes : intIn(o.testTimeoutMinutes, 1, 24 * 60, "testTimeoutMinutes"),
  };
}

export function readSettings(dataDir: string): FactorySettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(settingsPath(dataDir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw new SettingsError(`Factory の設定を読めません：${err instanceof Error ? err.message : String(err)}`);
  }
  return normalizeSettings(raw);
}

export function writeSettings(dataDir: string, raw: unknown): FactorySettings {
  const next = normalizeSettings(raw);
  const path = settingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return next;
}
