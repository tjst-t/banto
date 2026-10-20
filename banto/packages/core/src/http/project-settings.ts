// **新しい Project を作るときに一緒に書く3つのスイッチ**（決定・2026-10-20、ユーザー。v4-frontend.md §6.51）。
//
// 新しい Project の画面の「この Project の AI」——ターンの終わりのまとめ（`thread.turnSummary`）・承認をすべて自動で許可する
// （`approvals.autoApproveAll`）・空いた会話を冷める前に要約する（`thread.idleCompaction`）。`POST /api/projects` の `settings` で
// 受け、**Project を作るのと同じ処理の中で**書く（作ったあと別の要求で書くと、最初のターンに間に合わないことがある）。
//
// 書き方は各スイッチの口（`PUT /api/projects/:id/...`）と同じ——値が無いときの意味と同じ値は書かない（真実を1つにする）。
// まとめと自動で許可は「無い＝オフ」なので true だけ書く。空いた会話の要約は「無い＝オン」なので false だけ書く。
// **渡されなかった鍵は書かない**——画面以外で作った Project は今までどおりの既定
import type { RuntimeConfigStore } from "../config/runtime.js";
import { AUTO_APPROVE_ALL_KEY } from "../inbox/auto-approve.js";
import { TURN_SUMMARY_KEY } from "./turn-summary.js";

/** Configuration の鍵（真偽値）。**Project にだけ置ける**、値が無ければオン（アーキ仕様 §3.1「切り替え」） */
export const IDLE_COMPACTION_KEY = "thread.idleCompaction";

/** その Project で空いた会話の温め直しと要約をするか。Project の層だけを読む */
export function isIdleCompactionEnabled(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  projectId: string,
): boolean {
  return config?.layerValue(IDLE_COMPACTION_KEY, projectId) !== false;
}

/** 空いた会話の要約のスイッチを書く（`PUT /api/projects/:id/idle-compaction` と作るときで共通）。オンは上書きを外す */
export async function setIdleCompaction(
  config: Pick<RuntimeConfigStore, "setProjectOverride" | "unsetProjectOverride">,
  projectId: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) await config.unsetProjectOverride(projectId, IDLE_COMPACTION_KEY);
  else await config.setProjectOverride(projectId, IDLE_COMPACTION_KEY, false);
}

export interface NewProjectSettings {
  turnSummary?: boolean;
  autoApproveAll?: boolean;
  idleCompaction?: boolean;
}

const SETTING_NAMES = ["turnSummary", "autoApproveAll", "idleCompaction"] as const;

/** 本文の `settings` を確かめる。無ければ空、形が違えば断る理由（**壊れた値は入れない**、規則2——黙って既定へ落とさない） */
export function parseNewProjectSettings(raw: unknown): NewProjectSettings | { error: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "settings は { turnSummary, autoApproveAll, idleCompaction } の形で渡してください" };
  }
  const settings: NewProjectSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(SETTING_NAMES as readonly string[]).includes(key)) {
      return { error: `settings.${key} は知らない設定です（turnSummary・autoApproveAll・idleCompaction のどれか）` };
    }
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { error: `settings.${key} は true か false で渡してください` };
    settings[key as (typeof SETTING_NAMES)[number]] = value;
  }
  return settings;
}

/** 書くものがあるか（Configuration を持たない banto で断るため） */
export function hasSettingsToWrite(settings: NewProjectSettings): boolean {
  return settings.turnSummary === true || settings.autoApproveAll === true || settings.idleCompaction === false;
}

/** 作ったばかりの Project に書く。渡されなかった鍵・値が無いときの意味と同じ値は書かない */
export async function applyNewProjectSettings(
  config: Pick<RuntimeConfigStore, "setProjectOverride" | "unsetProjectOverride">,
  projectId: string,
  settings: NewProjectSettings,
): Promise<void> {
  if (settings.turnSummary === true) await config.setProjectOverride(projectId, TURN_SUMMARY_KEY, true);
  if (settings.autoApproveAll === true) await config.setProjectOverride(projectId, AUTO_APPROVE_ALL_KEY, true);
  if (settings.idleCompaction === false) await setIdleCompaction(config, projectId, false);
}
