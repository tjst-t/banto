// docs/specs/v4-architecture.md §5.6「配り方——普通の MCP 資源に載せる」の読み手側。
//
// Skill は Module が `resources/list` に `dev.banto/skill` の印で出す。**名前と説明は
// 一覧の `name`・`description` から読む**——本体（`SKILL.md`）を毎回読みに行かない
// （`@banto/module-contract` の `SKILL_META_KEY` の約束）。

import { isSkillResource, skillEntryProblem, visibilityOf } from "@banto/module-contract";
import type { SkillProblem, SkillRef } from "./types.js";

/** 資源を一覧できる相手（MCP の `Client` の必要な分だけ）。 */
export interface SkillSourceClient {
  getServerCapabilities?(): { resources?: unknown } | undefined;
  listResources(
    params?: { cursor?: string },
    options?: { timeout?: number },
  ): Promise<{ resources: unknown[]; nextCursor?: string }>;
}

export interface SkillDiscovery {
  skills: SkillRef[];
  problems: SkillProblem[];
}

/**
 * **1本の Module に聞く上限**。画面つき tool の一覧（`app.ts` の `UI_TOOLS_TIMEOUT_MS`）
 * と同じ理由——答えない1本のために**会話そのものが始まらない**形にしない。
 */
export const SKILL_LIST_TIMEOUT_MS = 5_000;

/** 1本の Module の一覧を辿りきる上限（`nextCursor` が止まらない相手で回り続けない）。 */
const MAX_PAGES = 50;

interface ListedResource {
  uri?: unknown;
  name?: unknown;
  description?: unknown;
  _meta?: Record<string, unknown>;
}

/**
 * 繋がっている Module 群が配っている Skill を集める。
 *
 * - **AI に見えないもの（`visibility` が `agent` でない）は Skill として数えない**
 *   ——`instructions` に載せても、AI はその本体を読めない
 * - **形の合わないもの**（Agent Skills の名前・説明の形）は落とし、**理由を返す**
 * - **答えない Module はそこだけ落とし、理由を返す**（1本の故障で全部を止めない）
 *
 * 並びは Module の順、その中は名前の順——`instructions` の中身が毎回同じ順で
 * 並ぶようにする（アーキ仕様 §3、順序が揺れるとキャッシュが外れる）。
 */
export async function discoverSkills(
  modules: ReadonlyArray<{ name: string; client?: SkillSourceClient }>,
  options: { timeoutMs?: number } = {},
): Promise<SkillDiscovery> {
  const timeout = options.timeoutMs ?? SKILL_LIST_TIMEOUT_MS;
  const per = await Promise.all(
    modules.map(async ({ name: module, client }): Promise<SkillDiscovery> => {
      // 繋がっていない Module は、繋がらなかった理由が別の経路（受信箱）に出ている
      if (!client) return { skills: [], problems: [] };
      // **資源を名乗っていない相手には聞かない**（capability negotiation、規則12）
      if (client.getServerCapabilities && !client.getServerCapabilities()?.resources) {
        return { skills: [], problems: [] };
      }
      let listed: ListedResource[];
      try {
        listed = await listAll(client, timeout);
      } catch (err) {
        return {
          skills: [],
          problems: [
            {
              module,
              message: `資源の一覧が取れませんでした: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
      const skills: SkillRef[] = [];
      const problems: SkillProblem[] = [];
      for (const r of listed) {
        if (!isSkillResource(r) || visibilityOf(r) !== "agent") continue;
        const problem = skillEntryProblem(r.name, r.description);
        if (problem || typeof r.uri !== "string" || r.uri === "") {
          problems.push({
            module,
            message: `Skill として読めません（${typeof r.uri === "string" ? r.uri : "URI なし"}）: ${problem ?? "URI がありません"}`,
          });
          continue;
        }
        skills.push({ module, name: r.name as string, description: r.description as string, uri: r.uri });
      }
      // **同じ名前が2つあったら、どちらも効かせない**——AI から見分けがつかない。
      // 片方を黙って選ぶと、どちらが効いているかが人にも分からなくなる（規則2）
      const byName = new Map<string, SkillRef[]>();
      for (const s of skills) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
      const unique: SkillRef[] = [];
      for (const [name, same] of byName) {
        if (same.length === 1) unique.push(same[0]!);
        else problems.push({ module, message: `同じ名前の Skill が ${same.length} つあります: ${name}` });
      }
      unique.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { skills: unique, problems };
    }),
  );
  return { skills: per.flatMap((p) => p.skills), problems: per.flatMap((p) => p.problems) };
}

async function listAll(client: SkillSourceClient, timeout: number): Promise<ListedResource[]> {
  const out: ListedResource[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await client.listResources(cursor ? { cursor } : undefined, { timeout });
    out.push(...(res.resources as ListedResource[]));
    if (!res.nextCursor) return out;
    cursor = res.nextCursor;
  }
  throw new Error(`資源の一覧が ${MAX_PAGES} ページを超えました（nextCursor が止まりません）`);
}
