// **チャット——Project を作る前の相談**（決定・2026-10-21、ユーザー。アーキ仕様 §2.2「チャット」）。
//
// 中身は普通の Project（印 `kind: "chat"`）。`POST /api/projects { kind: "chat" }` で作り、名前も根も host が決める：
// 名前は仮に「新しいチャット」、根は置き場（`~/banto/chats`、固定）の下の `<日付>-<短い id>`。この機械のコンテナだけ。
//
// **Project のコンテナで動く Module を外して始める**——Project 層の `moduleOverlays` に `enabled: false` で書く。コンテナは
// それらを初めて繋ぐとき（`runtime.prepare`）に作られるので、話す・Web で調べるだけならコンテナは作られない
// （渡る道具は banto 全体の Module と、Claude 自身の WebSearch・WebFetch だけ）
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { loadModuleDeclarations, modulePlacement, setProjectModuleSelection } from "../modules/declaration.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectState } from "../project-thread/types.js";

/** チャットの置き場（固定。設定で変えない——ユーザー・2026-10-21） */
export const CHATS_DIR = join(homedir(), "banto", "chats");

/**
 * **Project にするときにフォルダを移す先**：置き場（チャットの置き場の親、`~/banto`）の下の `<フォルダの名前>`
 * （アーキ仕様 §2.2「フォルダを置き場へ移す」）。名前は英小文字・数字・`.`・`_`・`-`（リポジトリの名前にもなる）。
 * チャットの置き場そのもの（`chats`）は断る。合わなければ理由を返す
 */
export function promotedRootOf(chatsDir: string, folder: unknown): { root: string } | { error: string } {
  if (typeof folder !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(folder)) {
    return { error: "folder は英小文字・数字・. _ - の 100 字までで、英小文字か数字で始めてください" };
  }
  if (folder === basename(chatsDir)) return { error: `folder に ${folder}（チャットの置き場）は使えません` };
  return { root: join(dirname(chatsDir), folder) };
}

/** 題を付けるまでの仮の名前 */
export const NEW_CHAT_NAME = "新しいチャット";

/** 根のフォルダの名前：`<日付>-<短い id>`（日付はこの機械の暦の日） */
export function chatFolderName(now: Date, shortId: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${shortId}`;
}

/** チャットを1つ作る。根を作り、Project を作り、Project のコンテナで動く Module を外す */
export async function createChatProject(deps: {
  projectThread: Pick<ProjectThreadStore, "createProject">;
  runtimeConfig: RuntimeConfigStore;
  chatsDir?: string;
  now?: Date;
}): Promise<ProjectState> {
  const chatsDir = deps.chatsDir ?? CHATS_DIR;
  await mkdir(chatsDir, { recursive: true });
  const root = join(chatsDir, chatFolderName(deps.now ?? new Date(), randomUUID().slice(0, 8)));
  // 既にあれば止まる（別のチャットの根を黙って共有しない、規則2）
  await mkdir(root);
  const project = await deps.projectThread.createProject(NEW_CHAT_NAME, root, { kind: "chat" });
  // 選ぶのは「Project のコンテナで動かないもの」——外すものを名指しで持たない（Module が増えても同じ規則で外れる）
  const keep = loadModuleDeclarations(deps.runtimeConfig, "")
    .filter((d) => modulePlacement(d.meta, d.launch) !== "project-container")
    .map((d) => d.name);
  await setProjectModuleSelection(deps.runtimeConfig, project.id, keep);
  return project;
}

/** 試作を始めたあと、同じ Thread に banto が届ける続き（アーキ仕様 §2.2「コンテナは試作を始めたときに作る」） */
export const PROTOTYPING_CONTINUE_TITLE = "試作の道具が使えるようになりました";
export const PROTOTYPING_CONTINUE_TEXT = "試作の道具（Shell・FileSystem など）が使えるようになりました。続けてください";

/**
 * **試作を始める**（`start_prototyping`、決定・2026-10-21）。Project 層の差分を外して普通の Project と同じ Module の組に戻し、
 * 記録 `project.prototyping.started` を積む。**人の承認は求めない**（ユーザー・2026-10-21——コンテナを作って道具を戻すだけで、
 * 書く・走らせるのはそのあとの Shell 等がそれぞれの承認を通る）。コンテナはここでは作らない——次のターンの Module の起動
 * （今の遅延起動）が作る。
 *
 * 差分を外してから記録を積む——逆だと、記録だけ立って差分が残ったとき道具が戻らないまま tool が消える。もう始めていれば何もしない
 */
export async function startChatPrototyping(
  deps: {
    projectThread: Pick<ProjectThreadStore, "getProject" | "markPrototypingStarted">;
    runtimeConfig: RuntimeConfigStore;
  },
  projectId: string,
): Promise<{ ok: true; already: boolean } | { ok: false; error: string }> {
  const project = deps.projectThread.getProject(projectId);
  if (!project) return { ok: false, error: "この Project が見つかりません。" };
  if (project.kind !== "chat") return { ok: false, error: "試作を始められるのはチャットだけです。" };
  if (project.prototyping) return { ok: true, already: true };
  await setProjectModuleSelection(
    deps.runtimeConfig,
    projectId,
    loadModuleDeclarations(deps.runtimeConfig, "").map((d) => d.name),
  );
  await deps.projectThread.markPrototypingStarted(projectId);
  return { ok: true, already: false };
}
