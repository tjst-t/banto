#!/usr/bin/env node
// docs/specs/v4-modules.md §2「Skill」・アーキ仕様 §5.6・§5.7 の同梱 Module。
//
// **Skill を資源として配る**。効かせるかどうかは決めない——それは core の仕事
// （core が名前と説明を `instructions` に載せる）。ここがするのは：
//
// - `SKILL.md` を `dev.banto/skill` の印つきで配る。一覧の `name`・`description` に
//   frontmatter の2項目を載せる（`@banto/module-contract` の `SKILL_META_KEY` の約束）
// - `references/` などの兄弟ファイルを、同じ Skill の URI の下に配る
//   ——本文の中の相対パスは、本文の URI からの相対でそのまま引ける
//
// **`scripts/` も配るが、banto では実行されない**（Runner に `Bash` が無い、決定・2026-09-04）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MODULE_META_KEY, SKILL_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { join } from "node:path";
import { listStoredSkills, mimeTypeOf, readSkillFile } from "./store.js";

const SELF_REPORT_URI = "skill://module";

/** Skill のファイルの URI。**区切りごとに符号化する**（空白や日本語のファイル名があっても壊れない）。 */
export function skillFileUri(skillName: string, relPath: string): string {
  return `skill://${skillName}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** URI を Skill 名と相対パスに戻す。形が違えば `undefined`。 */
export function parseSkillFileUri(uri: string): { skillName: string; relPath: string } | undefined {
  const match = uri.match(/^skill:\/\/([a-z0-9-]+)\/(.+)$/);
  if (!match) return undefined;
  try {
    return { skillName: match[1]!, relPath: match[2]!.split("/").map(decodeURIComponent).join("/") };
  } catch {
    return undefined;
  }
}

export function createSkillsServer(deps: { skillsDir: string }) {
  const reported = new Set<string>();
  const server = new Server(
    { name: "banto-module-skills", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // **いまは tool を持たない**。取り込み（`import_skill`）は別の仕事で足す
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    throw new Error(`unknown tool: ${request.params.name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const listing = await listStoredSkills(deps.skillsDir);
    // 読めなかったフォルダは host のログに残す（Module の標準エラーは host が拾う）。
    // 一覧は資源を読むたびに引かれる（可視性の確認）ので、**同じものは1度だけ**
    for (const p of listing.problems) {
      const line = `[skills] ${p.dir}: ${p.problem}`;
      if (reported.has(line)) continue;
      reported.add(line);
      console.error(line);
    }
    const resources: Array<Record<string, unknown>> = [];
    for (const skill of listing.skills) {
      resources.push({
        uri: skillFileUri(skill.name, "SKILL.md"),
        name: skill.name,
        description: skill.description,
        mimeType: "text/markdown",
        _meta: { [SKILL_META_KEY]: true },
      });
      for (const file of skill.files) {
        resources.push({
          uri: skillFileUri(skill.name, file),
          name: `${skill.name}/${file}`,
          mimeType: mimeTypeOf(file),
        });
      }
    }
    resources.push({
      uri: SELF_REPORT_URI,
      name: "この Module の申告",
      mimeType: "application/json",
      _meta: {
        [VISIBILITY_META_KEY]: "admin",
        [MODULE_META_KEY]: {
          satisfies: ["skills"],
          dependsOn: [],
          isolation: "subprocess",
          scope: "instance",
          confinement: { kind: "landlock", root: "none", profile: "files-only" },
        },
      },
    });
    return { resources } as never;
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === SELF_REPORT_URI) {
      return { contents: [{ uri, mimeType: "application/json", text: "{}" }] };
    }
    const parsed = parseSkillFileUri(uri);
    if (!parsed) throw new Error(`unknown resource: ${uri}`);
    const content = await readSkillFile(deps.skillsDir, parsed.skillName, parsed.relPath);
    return { contents: [{ uri, ...content }] } as never;
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  if (!dataDir) {
    console.error("BANTO_MODULE_DATA_DIR が必要です");
    process.exit(1);
  }
  const server = createSkillsServer({ skillsDir: join(dataDir, "skills") });
  await server.connect(new StdioServerTransport());
}
