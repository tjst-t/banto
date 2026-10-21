"use client";

// 相談（下書きの Project）のモック（2026-10-21、Fork「Project 作成前の検討」）。
//
// - **中身は普通の Project**：Base Thread・Fork・Memory・根のフォルダを持つ。画面だけ別に扱う
//   （サイドバーの「相談」に並び、名前もフォルダも決めずに始まる）
// - **資源を取らない**：始めた時点ではコンテナを作らない（話す・Web で調べるだけなら要らない）。
//   AI が初めてファイルを書く・コマンドを流すときに作る。使わなくなったら眠らせ、長く触らなければ閉じる
// - **Project にする**：その場で名前・グループ・リポジトリ・GitHub への公開を決め、相談の印を外すだけ。
//   会話・Memory・試作のファイルはそのまま
//
// 真実はこのファイルの state 1か所。変わったら notifyMockStoreChange。
import { notifyMockStoreChange } from "./store-events";
import { addProjectRecord, getProject, updateProjectRecord } from "./projects";
import { addThreadRecord, renameThreadRecord } from "./threads";
import { moveToGroup, placeProject } from "./project-org";
import type { MockProject, MockStep } from "./types";

/** コンテナの様子。none=まだ作っていない（話すだけ）／running=動いている／asleep=眠っている */
export type DraftMachine = "none" | "running" | "asleep";

export interface DraftInfo {
  projectId: string;
  /** 一覧に出す「いつ」 */
  lastUsed: string;
  /** 一覧で並べる順（小さいほど新しい） */
  rank: number;
  machine: DraftMachine;
  /** 試作で作ったファイルの数（Project にするときの説明に使う） */
  files: number;
  /** AI が付けた名前か（人が付けたら false） */
  autoTitled: boolean;
}

export interface ClosedDraft {
  id: string;
  title: string;
  closedAt: string;
  why: string;
}

export type DraftCleanup = "7" | "14" | "30" | "off";

interface DraftState {
  drafts: Record<string, DraftInfo>;
  closed: ClosedDraft[];
  /** 使わなくなった相談のコンテナを眠らせるまでの分 */
  sleepAfterMinutes: number;
  /** 触らなくなった相談を閉じるまでの日数 */
  cleanup: DraftCleanup;
  counter: number;
}

let state: DraftState = {
  drafts: {},
  closed: [
    { id: "c1", title: "Raspberry Pi で温湿度を記録する", closedAt: "10月2日", why: "14日触らなかったので閉じました" },
    { id: "c2", title: "Rust と Go のどちらで CLI を書くか", closedAt: "9月28日", why: "あなたが閉じました" },
    { id: "c3", title: "社内勉強会のスライドの構成", closedAt: "9月20日", why: "14日触らなかったので閉じました" },
  ],
  sleepAfterMinutes: 15,
  cleanup: "14",
  counter: 4,
};

function set(patch: Partial<DraftState>) {
  state = { ...state, ...patch };
  notifyMockStoreChange();
}

const T = (text: string): MockStep => ({ t: "text", text });
const U = (text: string): MockStep => ({ t: "user", text });

const genericReplies = [
  {
    match: /試作|動か|コード|書いて|作って/,
    steps: [
      { t: "delay", ms: 300 } as MockStep,
      T("試しに動かしてみます。この相談ではまだコンテナを作っていなかったので、ここで用意します（2秒ほど）。"),
      {
        t: "tool",
        name: "banto_shell_run_command",
        args: { command: "mkdir -p proto && cd proto && python3 -m venv .venv && .venv/bin/pip install -q requests" },
        result: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
        runMs: 1800,
      } as MockStep,
      T("用意できました。試作は `proto/` に置きます。15分使わなければコンテナは眠り、続けて話すと起きます。"),
    ],
  },
  {
    match: /project|プロジェクト|始め|リポジトリ/i,
    steps: [
      { t: "delay", ms: 300 } as MockStep,
      T(
        "まとまってきたので、ここまでの決まったことを `docs/plan.md` に書き、Memory に5行残しました。上の帯の「Project にする」を押すと、名前・置き場・リポジトリを決めて、この会話のまま Project として続けられます。",
      ),
    ],
  },
  { match: "*" as const, steps: [{ t: "delay", ms: 300 } as MockStep, T("なるほど。もう少し詳しく聞かせてください——誰が、どんなときに使うものですか？")] },
];

/** 見本の相談 */
const seeds: { id: string; title: string; info: Omit<DraftInfo, "projectId">; seed: MockStep[] }[] = [
  {
    id: "d-power",
    title: "家の電力を見える化したい",
    info: { lastUsed: "12分前", rank: 1, machine: "running", files: 6, autoTitled: true },
    seed: [
      U("スマートメーターの B ルートで家の電力を取って、グラフで見たい。何から始めればいい？"),
      T(
        "B ルートは電力会社に申し込むと ID とパスワードがもらえ、Wi-SUN の受信機で 30 秒ごとの値が取れます。流れは3段です：\n\n1. 受信機（USB の Wi-SUN ドングル）で値を取る\n2. どこかに貯める（SQLite で十分）\n3. グラフにする（Grafana か、小さな Web の画面）\n\n手元に受信機はありますか？ 無ければ先に、届いた値の形を真似た偽物で 2 と 3 を試作できます。",
      ),
      U("まだ無い。偽物で試作してみて"),
      T("試しに動かしてみます。この相談ではまだコンテナを作っていなかったので、ここで用意します（2秒ほど）。"),
      {
        t: "tool",
        name: "banto_shell_run_command",
        args: { command: "mkdir -p proto && cd proto && python3 fake_meter.py --minutes 60 > sample.csv && python3 plot.py sample.csv" },
        result: { stdout: "120 rows → chart.png", stderr: "", exitCode: 0, timedOut: false },
        runMs: 900,
      },
      T(
        "`proto/` に偽物の受信機（fake_meter.py）・貯める部分・グラフ（chart.png）を作りました。1時間ぶんの偽の値で動いています。\n\n次に決めたいのは、グラフを家の外（携帯）からも見たいかです。見たいなら Web の画面にして公開する形、家の中だけなら Grafana で足ります。",
      ),
    ],
  },
  {
    id: "d-papers",
    title: "論文のメモを横断して探したい",
    info: { lastUsed: "昨日", rank: 2, machine: "none", files: 0, autoTitled: true },
    seed: [
      U("読んだ論文のメモが Notion と Markdown に散らばってる。まとめて探せるようにしたい"),
      T(
        "やり方は大きく2つです。\n\n- **全文検索**：メモを1か所に集めて、キーワードで探す（速くて確実。言い換えには弱い）\n- **意味で探す**：メモを埋め込みにして「似た内容」で探す（言い換えに強い。準備が要る）\n\nまず、探すときに思い出せるのは「単語」ですか、それとも「だいたいこんな話」ですか？",
      ),
    ],
  },
  {
    id: "d-trip",
    title: "週末の京都の行き先",
    info: { lastUsed: "9日前", rank: 3, machine: "none", files: 0, autoTitled: true },
    seed: [
      U("11月の週末に京都。紅葉で混まないところを3つ"),
      T("11月中旬なら、比較的すいているのは大原の三千院の奥（宝泉院）、高雄の神護寺、岩倉の実相院です。どれも朝9時前に着くと落ち着いて見られます。"),
    ],
  },
];

for (const s of seeds) {
  addProjectRecord({
    id: s.id,
    name: s.title,
    initial: s.title.slice(0, 1),
    baseThreadId: `${s.id}-base`,
    basePath: `~/banto/drafts/${s.id.replace("d-", "")}`,
    status: "active",
    draft: true,
  });
  addThreadRecord({
    id: `${s.id}-base`,
    projectId: s.id,
    kind: "base",
    title: s.title,
    parentThreadId: null,
    script: { seed: s.seed, replies: genericReplies },
    status: "open",
  });
  state.drafts[s.id] = { projectId: s.id, ...s.info };
}

export function getDrafts(): { project: MockProject; info: DraftInfo }[] {
  return Object.values(state.drafts)
    .map((info) => ({ project: getProject(info.projectId), info }))
    .filter(({ project }) => project.id === project.id && project.draft && project.status === "active")
    .sort((a, b) => a.info.rank - b.info.rank);
}

export function getDraft(projectId: string): DraftInfo | undefined {
  const p = getProject(projectId);
  return p.id === projectId && p.draft ? state.drafts[projectId] : undefined;
}

export function getClosedDrafts(): readonly ClosedDraft[] {
  return state.closed;
}

export function getDraftSettings() {
  return { sleepAfterMinutes: state.sleepAfterMinutes, cleanup: state.cleanup };
}

export function setDraftCleanup(cleanup: DraftCleanup): void {
  set({ cleanup });
}

/** 新しい相談：名前もフォルダも聞かずに作る。コンテナはまだ作らない */
export function createDraft(): MockProject {
  const n = state.counter;
  const id = `d-new-${n}`;
  const title = "新しい相談";
  const project: MockProject = {
    id,
    name: title,
    initial: "新",
    baseThreadId: `${id}-base`,
    basePath: `~/banto/drafts/2026-10-21-${n}`,
    status: "active",
    draft: true,
  };
  addProjectRecord(project);
  addThreadRecord({
    id: `${id}-base`,
    projectId: id,
    kind: "base",
    title,
    parentThreadId: null,
    script: { seed: [], replies: genericReplies },
    status: "open",
  });
  const ranks = Object.values(state.drafts).map((d) => d.rank);
  set({
    counter: n + 1,
    drafts: {
      ...state.drafts,
      [id]: { projectId: id, lastUsed: "たった今", rank: Math.min(0, ...ranks) - 1, machine: "none", files: 0, autoTitled: true },
    },
  });
  return project;
}

export function wakeDraft(projectId: string): void {
  const d = state.drafts[projectId];
  if (!d) return;
  set({ drafts: { ...state.drafts, [projectId]: { ...d, machine: "running" } } });
}

export function sleepDraft(projectId: string): void {
  const d = state.drafts[projectId];
  if (!d || d.machine === "none") return;
  set({ drafts: { ...state.drafts, [projectId]: { ...d, machine: "asleep" } } });
}

export function renameDraft(projectId: string, title: string): void {
  updateProjectRecord(projectId, { name: title, initial: title.slice(0, 1) });
  renameThreadRecord(`${projectId}-base`, title);
  const d = state.drafts[projectId];
  set({ drafts: { ...state.drafts, [projectId]: { ...d, autoTitled: false } } });
}

/** 相談を閉じる（消さない。「閉じた相談」から開き直せる） */
export function closeDraft(projectId: string, why = "あなたが閉じました"): void {
  const p = getProject(projectId);
  updateProjectRecord(projectId, { status: "closed", closedAt: "たった今" });
  const { [projectId]: _d, ...rest } = state.drafts;
  void _d;
  set({ drafts: rest, closed: [{ id: projectId, title: p.name, closedAt: "たった今", why }, ...state.closed] });
}

export type RepoChoice = "none" | "local" | "github";

export interface PromoteInput {
  name: string;
  /** フォルダとリポジトリの名前（英小文字） */
  slug: string;
  groupId: string | null;
  folder: "keep" | "move";
  repo: RepoChoice;
  visibility: "private" | "public";
}

/** 名前（英小文字）からフォルダ名を作る */
export function folderNameOf(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || "project";
}

/** Project にする：相談の印を外し、名前・置き場・グループを決める。会話・Memory・ファイルはそのまま */
export function promoteDraft(projectId: string, input: PromoteInput): void {
  const p = getProject(projectId);
  const basePath = input.folder === "move" ? `~/banto/${input.slug}` : p.basePath;
  updateProjectRecord(projectId, { draft: false, name: input.name, initial: input.name.slice(0, 1), basePath });
  renameThreadRecord(`${projectId}-base`, input.name);
  moveToGroup(projectId, input.groupId);
  placeProject(projectId, { groupId: input.groupId });
  const { [projectId]: _d, ...rest } = state.drafts;
  void _d;
  set({ drafts: rest });
}

/** フォルダ・リポジトリの名前の候補（モックでは AI が付けた体の固定値） */
export function suggestedSlugOf(projectId: string): string {
  if (projectId === "d-power") return "power-monitor";
  if (projectId === "d-papers") return "paper-search";
  return folderNameOf(getProject(projectId).name);
}

/** 名前の候補（モックでは AI が付けた体の固定値） */
export function suggestedNameOf(projectId: string): string {
  if (projectId === "d-power") return "電力の見える化";
  if (projectId === "d-papers") return "論文メモの検索";
  return getProject(projectId).name;
}
