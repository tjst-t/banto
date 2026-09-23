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
import {
  CANVAS_META_KEY,
  MODULE_META_KEY,
  SKILL_META_KEY,
  VISIBILITY_META_KEY,
  callerOf,
} from "@banto/module-contract";
import { listStoredSkills, mimeTypeOf, readSkillFile } from "./store.js";
import { IMPORT_APP_URI, MANAGE_APP_URI, UI_APP_MIME, skillsAppHtml } from "./app.js";
import { parseGithubLocation } from "./import/source.js";
import { fetchGithubSkill, type FetchLike, type GithubEndpoints } from "./import/github.js";
import { readSkillZip } from "./import/zip.js";
import {
  confirmImport,
  discardImport,
  getImport,
  importPathsFor,
  prepareImport,
  readSource,
  removeSkill,
  type ImportPreview,
} from "./import/staging.js";

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

export interface SkillsServerDeps {
  /** この Module の置き場（host が渡す `BANTO_MODULE_DATA_DIR`）。 */
  dataDir: string;
  /** GitHub から取ってくるときの口（試験で差し替える）。 */
  fetch?: FetchLike;
  github?: GithubEndpoints;
}

/** 人だけが押せる操作の印（MCP の可視性で AI からは見えない。**呼び出しの刻印でも確かめる**）。 */
function adminTool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
    _meta: { [VISIBILITY_META_KEY]: "admin" },
  };
}

function json(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

export function createSkillsServer(deps: SkillsServerDeps) {
  const reported = new Set<string>();
  const paths = importPathsFor(deps.dataDir);
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const server = new Server(
    { name: "banto-module-skills", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        // **AI は提案できる。取り込むかは人が決める**（アーキ仕様 §5.7、決定・2026-09-23）。
        // この tool は取ってきて**仮置き**するだけで、置き場には入れない。画面（取り込む
        // 前の確認）が会話に出て、人が「取り込む」を押したときだけ入る
        name: "import_skill",
        description:
          "GitHub にある Skill（SKILL.md のあるフォルダ）を取ってきて、取り込む前の確認を人の画面に出す。" +
          "**この tool は取り込まない**——取り込むかは人が画面で決める。" +
          "呼んだらターンを終えて人に知らせること。取り込まれたら資源の一覧に skill://<名前>/SKILL.md が出る。",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description:
                "Skill のフォルダの GitHub の URL（https://github.com/<owner>/<repo>/tree/<ブランチ>/<フォルダ>）" +
                "か、<owner>/<repo>/<フォルダ>@<ブランチ・タグ・commit>。ブランチを省くと既定のブランチの、いまの commit に固定する",
            },
          },
          required: ["source"],
        },
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { resourceUri: IMPORT_APP_URI } },
      },
      adminTool("prepare_skill_import", "取り込む前に取ってきて仮置きし、中身を返す（GitHub か ZIP）", {
        source: { type: "string" },
        zipBase64: { type: "string" },
        fileName: { type: "string" },
      }),
      adminTool(
        "get_skill_import",
        "仮置きの中身か、もう押したならその結果（会話の中の画面が、AI の呼び出しの結果から引く）",
        { stagingId: { type: "string" } },
        ["stagingId"],
      ),
      adminTool("confirm_skill_import", "仮置きしたものを置き場に入れる", { stagingId: { type: "string" } }, ["stagingId"]),
      adminTool("discard_skill_import", "仮置きしたものを捨てる", { stagingId: { type: "string" } }, ["stagingId"]),
      adminTool("list_installed_skills", "置き場に入っている Skill と出所", {}),
      adminTool("remove_skill", "Skill を置き場から消す", { name: { type: "string" } }, ["name"]),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const name = request.params.name;
    try {
      if (name === "import_skill") {
        const preview = await prepareFromGithub(String(args.source ?? ""));
        return {
          content: [
            {
              type: "text",
              text:
                `取り込む前の確認を、この会話に出しました（Skill「${preview.name}」・出所 ${describeSource(preview)}）。` +
                "**取り込むかは人が決めます**——このターンではこれ以上進めません。ターンを終えて人に知らせてください。" +
                `取り込まれたら、資源の一覧に skill://${preview.name}/SKILL.md が出ます。` +
                "効かせるかは人が設定で選び、次の新しい会話から効きます。" +
                // **画面はこの id から中身を引く**。中身そのもの（SKILL.md は数十 KB になる）を
                // ここに載せると、AI の文脈を食う。結果の本文は会話の記録を通って画面に届く
                // ——`structuredContent` はその道で落ちる（E2E で確認・2026-09-23）
                `\n取り込みの id：${preview.stagingId}`,
            },
          ],
        };
      }
      // ここから下は**人の操作だけ**。可視性で AI からは見えないが、呼び出しの刻印でも
      // 確かめる——人の画面からの呼び出しには、host が `{admin: true}` を刻む
      const caller = callerOf(request.params._meta);
      if (!caller || !("admin" in caller)) throw new Error(`${name} は人の操作からだけ呼べます`);
      switch (name) {
        case "prepare_skill_import": {
          if (typeof args.zipBase64 === "string" && args.zipBase64 !== "") {
            const fileName = typeof args.fileName === "string" && args.fileName ? args.fileName : "skill.zip";
            const { files, source } = readSkillZip(Buffer.from(args.zipBase64, "base64"), fileName);
            return json(await prepareImport(paths, files, source));
          }
          return json(await prepareFromGithub(String(args.source ?? "")));
        }
        case "get_skill_import":
          return json(await getImport(paths, String(args.stagingId ?? "")));
        case "confirm_skill_import":
          return json(await confirmImport(paths, String(args.stagingId ?? "")));
        case "discard_skill_import":
          await discardImport(paths, String(args.stagingId ?? ""));
          return json({ ok: true });
        case "list_installed_skills": {
          const listing = await listStoredSkills(paths.skillsDir);
          const skills = await Promise.all(
            listing.skills.map(async (s) => ({
              name: s.name,
              description: s.description,
              files: s.files.length + 1,
              source: await readSource(paths, s.name),
            })),
          );
          return json({ skills, problems: listing.problems });
        }
        case "remove_skill":
          await removeSkill(paths, String(args.name ?? ""));
          return json({ ok: true });
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (err) {
      // **理由をそのまま返す**——画面はこれを人に見せる（黙って失敗しない、規則2）
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });

  async function prepareFromGithub(source: string): Promise<ImportPreview> {
    const loc = parseGithubLocation(source);
    const { files, source: from } = await fetchGithubSkill(loc, { fetch: fetchImpl, endpoints: deps.github });
    return prepareImport(paths, files, from);
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const listing = await listStoredSkills(paths.skillsDir);
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
    // **画面**。取り込む前の確認（AI の tool の画面なので agent）と、設定の中の置き場（人だけ）
    resources.push({
      uri: IMPORT_APP_URI,
      name: "Skill の取り込み（確認）",
      mimeType: UI_APP_MIME,
      _meta: { [VISIBILITY_META_KEY]: "agent", ui: { prefersBorder: true } },
    });
    resources.push({
      uri: MANAGE_APP_URI,
      name: "Skill の置き場",
      description: "GitHub・ZIP から Skill を取り込む。入っているものを出所つきで見て、消す",
      mimeType: UI_APP_MIME,
      _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
    });
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
    if (uri === IMPORT_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: skillsAppHtml("tool") }] };
    if (uri === MANAGE_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: skillsAppHtml("manage") }] };
    const parsed = parseSkillFileUri(uri);
    if (!parsed) throw new Error(`unknown resource: ${uri}`);
    const content = await readSkillFile(paths.skillsDir, parsed.skillName, parsed.relPath);
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
  // **試験のときだけ GitHub の口を差し替える**（E2E は本物の GitHub を叩かない、規則6）。
  // 片方だけ指していたら、黙って本物へ落ちずに止まる（規則2）
  const api = process.env.BANTO_SKILLS_GITHUB_API_URL;
  const raw = process.env.BANTO_SKILLS_GITHUB_RAW_URL;
  if ((api === undefined) !== (raw === undefined)) {
    console.error("BANTO_SKILLS_GITHUB_API_URL と BANTO_SKILLS_GITHUB_RAW_URL は両方指してください");
    process.exit(1);
  }
  const server = createSkillsServer({ dataDir, ...(api && raw ? { github: { api, raw } } : {}) });
  await server.connect(new StdioServerTransport());
}

function describeSource(p: ImportPreview): string {
  return p.source.kind === "github" ? `${p.source.repo}@${p.source.commit.slice(0, 7)}` : `ZIP ${p.source.fileName}`;
}
