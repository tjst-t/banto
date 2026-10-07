// **Canvas から banto の別の面を開かせる口**（banto の拡張、2026-10-07、`docs/specs/v4-frontend.md` §6.2、
// `docs/specs/v4-modules.md` §4.4「まだ決めていない」を解いたもの）。
//
// Factory の「経過を見る」（Subagent の画面でその仕事を開く）・「設定を開く」（Project の設定の Factory の節）、
// Backlog の「取り組んだ Thread」のように、ある Module の画面から**同じ Project の中の**別の面へ移る。
// - 画面 → banto：request `dev.banto/open-surface`。開ける先は3つ：
//   - `{ surface: "launcher", server, resourceUri?, select? }`——その Module の入口（launcher）の画面。`resourceUri` を
//     省いたら、その Module の入口が1つだけのときそれ。`select` は開いた画面に「見ている場所」
//     （`dev.banto/view-state`、`canvas-view-state.ts`）として渡す——中身は開かれる画面のもので、banto は解釈しない
//     （どの形で受けるかは開かれる側の Module が決めて書く。Subagent は `{ runId }`）
//   - `{ surface: "settings", server? }`——Project の設定の、その Module の節。`server` を省いたら頼んできた Module 自身
//     （Module は自分がこの Project にどの名前で入れられたかを知らない）
//   - `{ surface: "thread", threadId }`——その Thread（Base なら Project の会話、Fork ならその Fork）
// - banto：**確かめの画面は出さずに移る**——移るのは軽く、戻れる操作（`dev.banto/open-project` と同じ）。その代わり
//   **どの面の画面からでも、人がその画面を押した直後だけ**受ける（押したことが確かめの代わり）
// - **同じ Project の中だけ**——頼んできた画面が開かれている Project の入口・設定の節・Thread だけ。banto 全体の設定の
//   画面（Project が無い）からは断る。無い Module・無い入口・畳んだ Fork は断る（黙って別のものを開かない）
// - **移っている間の頼みは受けない**——入口の一覧を取り直している間に2回押されても、2回移らない
// - core は頼んできた Module を名指ししない

import { settingsOpenHref } from "../settings-link.ts";
import { VIEW_STATE_PARAM } from "./canvas-view-state.ts";

export const OPEN_SURFACE_METHOD = "dev.banto/open-surface";

export type OpenSurfaceTarget =
  | { surface: "launcher"; server: string; resourceUri?: string; select?: unknown }
  | { surface: "settings"; server: string }
  | { surface: "thread"; threadId: string };

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** 画面から来た params を読む。読めなければ理由（画面にそのまま返す） */
export function parseOpenSurfaceParams(params: unknown, from: string): OpenSurfaceTarget | { error: string } {
  const p = params as { surface?: unknown; server?: unknown; resourceUri?: unknown; select?: unknown; threadId?: unknown } | undefined;
  if (p?.surface === "settings" && p.server === undefined) return { surface: "settings", server: from };
  if (p?.surface === "launcher" || p?.surface === "settings") {
    if (typeof p.server !== "string" || !NAME.test(p.server)) return { error: "server は Module の名前で渡してください" };
    if (p.surface === "settings") return { surface: "settings", server: p.server };
    if (p.resourceUri !== undefined && (typeof p.resourceUri !== "string" || !p.resourceUri.startsWith("ui://") || p.resourceUri.length > 500)) {
      return { error: "resourceUri は ui:// から始まる画面の資源で渡してください" };
    }
    return {
      surface: "launcher",
      server: p.server,
      ...(typeof p.resourceUri === "string" ? { resourceUri: p.resourceUri } : {}),
      ...(p.select !== undefined ? { select: p.select } : {}),
    };
  }
  if (p?.surface === "thread") {
    if (typeof p.threadId !== "string" || !ID.test(p.threadId)) return { error: "threadId は Thread の id で渡してください" };
    return { surface: "thread", threadId: p.threadId };
  }
  return { error: "surface は launcher・settings・thread のどれかで渡してください" };
}

/** 移ってよいか。よければ移る先（banto の中の URL）、だめなら理由（画面にそのまま返す） */
export function decideOpenSurface(input: {
  target: OpenSurfaceTarget;
  /** 頼んできた画面が開かれている Project。banto 全体の設定の画面なら無い */
  projectId: string | undefined;
  /** 人がその画面を押した直後か */
  activated: boolean;
  /** その Project の Module の入口（launcher の画面のときだけ見る） */
  launchers?: ReadonlyArray<{ server: string; resourceUri: string }>;
  /** その Project の設定に節を持つ Module（設定の節のときだけ見る） */
  settings?: ReadonlyArray<{ server: string }>;
  /** Thread を引く（Thread のときだけ見る） */
  getThread?: (id: string) => { projectId: string; parentThreadId: string | null; status: "open" | "closed"; title: string } | undefined;
  /** いまの URL。その Project の画面に居るなら、設定はその上に重ねる（閉じると元の画面に戻る） */
  here?: { pathname: string; search: string };
  /** `select` を URL に載せる形にする（大きすぎれば undefined） */
  serializeSelect?: (select: unknown) => string | undefined;
}): { href: string } | { error: string } {
  const { target, projectId } = input;
  if (!input.activated) return { error: "別の画面を開くのは、人が画面を押した直後だけです" };
  if (!projectId) return { error: "この画面は Project の中で開かれていないので、Project の中の画面を開けません" };
  const base = `/p/${encodeURIComponent(projectId)}`;
  if (target.surface === "launcher") {
    const mine = (input.launchers ?? []).filter((l) => l.server === target.server);
    if (mine.length === 0) return { error: `「${target.server}」の入口の画面はこの Project にありません` };
    const chosen = target.resourceUri ? mine.find((l) => l.resourceUri === target.resourceUri) : mine.length === 1 ? mine[0] : undefined;
    if (!chosen) {
      return {
        error: target.resourceUri
          ? `「${target.server}」に ${target.resourceUri} という入口の画面はありません`
          : `「${target.server}」には入口の画面が ${mine.length} つあります——resourceUri で選んでください`,
      };
    }
    const query = new URLSearchParams({ canvas: `${chosen.server}:${chosen.resourceUri}` });
    if (target.select !== undefined) {
      const json = input.serializeSelect?.(target.select);
      if (json === undefined) return { error: "select が大きすぎるか、JSON にできません" };
      query.set(VIEW_STATE_PARAM, json);
    }
    return { href: `${base}?${query.toString()}` };
  }
  if (target.surface === "settings") {
    if (!(input.settings ?? []).some((s) => s.server === target.server)) {
      return { error: `「${target.server}」はこの Project の設定に節を持っていません` };
    }
    const onProject = input.here?.pathname === base;
    return { href: settingsOpenHref(base, new URLSearchParams(onProject ? input.here?.search : ""), { project: projectId, section: `project-module:${target.server}` }) };
  }
  const thread = input.getThread?.(target.threadId);
  if (!thread || thread.projectId !== projectId) return { error: "その Thread はこの Project にありません" };
  if (thread.status === "closed") return { error: `「${thread.title}」は畳んだ Fork です——履歴から再度開いてください` };
  return { href: thread.parentThreadId === null ? base : `${base}?${new URLSearchParams({ fork: target.threadId }).toString()}` };
}

let moving = false;

/**
 * 移る手順を1本だけ走らせる。走っている間の頼みは断る（2回押されても2回移らない）。
 * `run` は移る先を調べて移る（入口・設定の一覧の取り直しを待つ）
 */
export async function runOpenSurface<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  if (moving) return { error: "別の画面へ移っているところです" };
  moving = true;
  try {
    return await run();
  } finally {
    moving = false;
  }
}
