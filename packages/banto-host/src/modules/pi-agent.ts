/**
 * pi agent 設定モジュール（task-0050）。
 *
 * pi coding agent の接続情報を GUI から表示するためのモジュール。
 * LLM の管理（provider/model の選択・tier 割り当て）は llm-registry モジュールが担う。
 *
 * 表示データ：
 *   - auth.json: API キー（マスク表示）
 *   - models.json: providers の一覧
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleSettingsSpec, SettingsWriteResult } from "@banto/core";
import type { BantoModule } from "../module.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "../tool-registry.js";
import type { CanvasViewSpec } from "../canvas.js";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const PI_AGENT_BASE_URL = "/api/pi-agent";

/** auth.json の形式 */
interface AuthJson {
  opencode?: { type: string; key: string };
  opencode_go?: { type: string; key: string };
  [key: string]: { type: string; key: string } | undefined;
}

/** models.json の形式 */
interface ModelJson {
  providers: Record<string, {
    name: string;
    baseUrl: string;
    apiKey?: string;
    api?: string;
    models: Array<{
      id: string;
      name?: string;
      input?: string[];
      contextWindow?: number;
      maxTokens?: number;
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }>;
  }>;
}

/** API キーの1エントリ */
interface AuthEntry {
  name: string;
  type: string;
  key: string;
  masked: string;
}

/** provider の1エントリ */
interface ProviderEntry {
  name: string;
  baseUrl: string;
  modelCount: number;
  models: Array<{ id: string; name?: string }>;
}

/** 表示用データ全体 */
interface PiAgentData {
  /** auth.json から読み出したキー一覧 */
  auth: AuthEntry[];
  /** models.json から読み出したプロバイダ一覧 */
  providers: ProviderEntry[];
}

/** キーをマスク表示する形式に変換 */
function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return key.slice(0, 4) + "•".repeat(key.length - 8) + key.slice(-4);
}

/** auth.json のパスを解決 */
function authJsonPath(): string {
  const agentDir = getAgentDir();
  return path.join(agentDir, "auth.json");
}

/** models.json のパスを解決 */
function modelsJsonPath(): string {
  const agentDir = getAgentDir();
  return path.join(agentDir, "models.json");
}

/** auth.json を読む（キーはマスク済みで返す） */
function readAuthJson(): AuthEntry[] {
  const filePath = authJsonPath();
  if (!fs.existsSync(filePath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }

  const auth = parsed as AuthJson;
  const entries: AuthEntry[] = [];

  for (const [name, value] of Object.entries(auth)) {
    if (value && typeof value === "object" && "key" in value && typeof value.key === "string") {
      entries.push({
        name: name.replace(/_/g, "-"),
        type: value.type,
        key: value.key,
        masked: maskKey(value.key),
      });
    }
  }

  return entries;
}

/** models.json を読む */
function readModelsJson(): ProviderEntry[] {
  const filePath = modelsJsonPath();
  if (!fs.existsSync(filePath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }

  const models = parsed as ModelJson;
  const providers: ProviderEntry[] = [];

  for (const [name, value] of Object.entries(models.providers)) {
    if (value && typeof value === "object") {
      providers.push({
        name: value.name ?? name,
        baseUrl: value.baseUrl ?? "",
        modelCount: Array.isArray(value.models) ? value.models.length : 0,
        models: (value.models ?? []).map((m) => ({ id: m.id, name: m.name })),
      });
    }
  }

  return providers;
}

/** キャンバス表示用のビューエントリ（削除：Settings Panel に統合） */
const piAgentViews: CanvasViewSpec[] = [];

/** pi agent モジュールを作成する */
export function createPiAgentModule(): BantoModule {
  const readData = (): PiAgentData => ({
    auth: readAuthJson(),
    providers: readModelsJson(),
  });

  const describe = defineNamespacedTool({
    name: "pi.agent.describe",
    label: "pi.agent: Describe",
    description:
      "pi agent の接続情報を返す（GUI表示用）。" +
      "auth.json, models.json の値を1回にまとめて返す。",
    parameters: Type.Object({}),
    async execute() {
      const data = readData();
      return {
        content: [
          {
            type: "text",
            text: `認証: ${data.auth.length}件, プロバイダ: ${data.providers.length}件`,
          },
        ],
        details: data,
      };
    },
  });

  const authRead = defineNamespacedTool({
    name: "pi.agent.auth",
    label: "pi.agent: Read Auth",
    description: "auth.json の API キー一覧を返す。",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: `${readAuthJson().length} 件` }],
        details: { keys: readAuthJson() },
      };
    },
  });

  const modelsRead = defineNamespacedTool({
    name: "pi.agent.models",
    label: "pi.agent: Read Models",
    description: "models.json のプロバイダ一覧を返す。",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: `${readModelsJson().length} プロバイダ` }],
        details: { providers: readModelsJson() },
      };
    },
  });

  return {
    name: "pi-agent",
    title: "pi.agent 接続情報",
    description:
      "pi coding agent の接続設定の表示。APIキー（auth.json）、" +
      "モデル一覧（models.json）。LLM の管理は llm-registry モジュールで行う。",
    endpoint: { baseUrl: PI_AGENT_BASE_URL },
    tools: [describe],
    internalTools: [authRead, modelsRead] as NamespacedToolDefinition[],
    views: piAgentViews,
    settings: {
      title: "pi.agent 接続情報",
      description:
        "pi coding agent の接続情報（表示専用）。APIキーとモデル一覧を確認できます。" +
        "LLM の設定（プロバイダ・モデルの選択）は「LLM 管理」で行ってください。",
      fields: [
        {
          key: "authCount",
          label: "API キー数",
          type: "text",
          description: "設定済みの API キーの数（表示専用）",
        },
        {
          key: "providerCount",
          label: "プロバイダ数",
          type: "text",
          description: "登録済みのプロバイダの数（表示専用）",
        },
      ],
      read: (): Record<string, unknown> => {
        const data = readData();
        return {
          authCount: `${data.auth.length} 件`,
          providerCount: `${data.providers.length} 件`,
        };
      },
      write: (): SettingsWriteResult => {
        return { applied: false, message: "この区画は表示専用です。" };
      },
    } as ModuleSettingsSpec,
    skills: [],
  };
}
