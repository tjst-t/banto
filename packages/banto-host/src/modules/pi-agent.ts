/**
 * pi agent 設定モジュール（task-0050）。
 *
 * pi coding agent の接続情報を GUI から表示・編集するためのモジュール。
 *
 * 表示データ：
 *   - auth.json: API キー（マスク表示）
 *   - models.json: providers の一覧
 *   - settings.json: llm.provider / llm.model の設定値（編集可能）
 *
 * 書き込み：
 *   - settings.json の `llm` セクションに `provider` / `model` を保存
 *   - 保存は settings モジュールの store を介して行う
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleSettingsSpec, SettingsWriteResult } from "@banto/core";
import type { BantoModule, ModuleRegistry } from "../module.js";
import type { CanvasViewSpec } from "../canvas.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "../tool-registry.js";
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
  /** 編集対象の設定値 */
  llm: { provider?: string; model?: string };
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

/** キャンバス表示用のビューエントリ */
const piAgentViews: CanvasViewSpec[] = [
  {
    kind: "pi.agent.viewer",
    title: "pi.agent 設定",
    description:
      "pi coding agent の接続情報（APIキー・モデル・設定値）を表示・編集する。" +
      "設定値は settings.json に保存。",
    parameters: Type.Object({}),
    component: "PiAgentViewer",
    category: "pi-agent",
    icon: "🤖",
  },
];

export interface PiAgentModuleOptions {
  /** 設定の保存先 */
  settingsStore: {
    all(): { llm?: { provider?: string; model?: string } };
    update<K extends keyof { llm?: { provider?: string; model?: string } }>(
      section: K,
      value: { provider?: string; model?: string }
    ): void;
  };
}

/** pi agent モジュールを作成する */
export function createPiAgentModule(options: PiAgentModuleOptions): BantoModule {
  const readData = (): PiAgentData => ({
    auth: readAuthJson(),
    providers: readModelsJson(),
    llm: { ...(options.settingsStore.all().llm ?? {}) },
  });

  const describe = defineNamespacedTool({
    name: "pi.agent.describe",
    label: "pi.agent: Describe",
    description:
      "pi agent の接続情報をすべて返す（GUI表示用）。" +
      "auth.json, models.json, settings.json の値を1回にまとめて返す。",
    parameters: Type.Object({}),
    async execute() {
      const data = readData();
      return {
        content: [
          {
            type: "text",
            text: `認証: ${data.auth.length}件, プロバイダ: ${data.providers.length}件, 設定: ${data.llm.provider ?? "?"}/${data.llm.model ?? "?"}`,
          },
        ],
        details: data,
      };
    },
  });

  const update = defineNamespacedTool({
    name: "pi.agent.update",
    label: "pi.agent: Update",
    description:
      "pi agent の設定値（provider, model）を保存する。" +
      "settings.json の llm セクションに書き込む。",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "プロバイダ名（例: opencode）" })),
      model: Type.Optional(Type.String({ description: "モデル名（例: deepseek-v4-flash-free）" })),
    }),
    async execute(params) {
      const current = options.settingsStore.all().llm ?? {};
      const next: { provider?: string; model?: string } = { ...current };
      if (params.provider !== undefined) next.provider = params.provider;
      if (params.model !== undefined) next.model = params.model;

      options.settingsStore.update("llm", next);

      return {
        content: [
          {
            type: "text",
            text: `設定を保存しました: ${next.provider ?? "?"}/${next.model ?? "?"}`,
          },
        ],
        details: { llm: next },
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
    title: "pi.agent 設定",
    description:
      "pi coding agent の接続設定。APIキー（auth.json）、" +
      "モデル一覧（models.json）、設定値（settings.json）を表示・編集。",
    endpoint: { baseUrl: PI_AGENT_BASE_URL },
    tools: [describe],
    internalTools: [update, authRead, modelsRead] as NamespacedToolDefinition[],
    views: piAgentViews,
    settings: {
      title: "pi.agent",
      description:
        "pi coding agent の設定。プロバイダとモデルを選択して保存。" +
        "auth.json と models.json の内容は表示のみ（編集はそちらのファイルを直接変更）。",
      fields: [
        {
          key: "provider",
          label: "プロバイダ",
          type: "text",
          placeholder: "opencode",
          description: "pi が認証するプロバイダ名。auth.json のキー名と対応",
        },
        {
          key: "model",
          label: "モデル",
          type: "text",
          placeholder: "deepseek-v4-flash-free",
          description: "使用するモデル ID。models.json の models に含まれる名前でもよい",
        },
      ],
      read: (): Record<string, unknown> => {
        const llm = options.settingsStore.all().llm ?? {};
        return {
          provider: llm.provider,
          model: llm.model,
        };
      },
      write: (values): SettingsWriteResult => {
        const current = options.settingsStore.all().llm ?? {};
        const next: { provider?: string; model?: string } = { ...current };
        if ("provider" in values) next.provider = values.provider as string;
        if ("model" in values) next.model = values.model as string;
        options.settingsStore.update("llm", next);
        return {
          applied: false,
          message: "保存しました。**次の起動から効きます**",
        };
      },
    } as ModuleSettingsSpec,
    skills: [],
  };
}
