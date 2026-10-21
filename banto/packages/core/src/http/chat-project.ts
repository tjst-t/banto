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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { loadModuleDeclarations, modulePlacement, setProjectModuleSelection } from "../modules/declaration.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectState } from "../project-thread/types.js";

/** チャットの置き場（固定。設定で変えない——ユーザー・2026-10-21） */
export const CHATS_DIR = join(homedir(), "banto", "chats");

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
