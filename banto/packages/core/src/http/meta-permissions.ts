// **メタ Project の権限**（追加・2026-10-23、アーキ仕様 §4.6「権限——人に残すのは publish・money・destructive」、Backlog #537）。
//
// メタ Project では、仕様の向き（spec）と LAN の中だけに届く公開まで AI に任せ、release を任せるかは Project ごとに選べる
// （既定は「任せる」）。外に届く公開・お金・消す操作は必ず人に残す。**メタ Project でない Project には何も効かない**——
// 鍵を読まず、system prompt の節も公開の刻印も出さない。
//
// 効かせ方は2つ：
// - spec・release——AI が自分で決めてよいか（まとめの決めることで人に聞くか）。system prompt の節で伝える（{@link metaPermissionsPromptSection}）
// - LAN の中の公開——Publish の承認を人に待たせない。host が呼び出しに `dev.banto/autoApproveReach: "lan"` を刻み、窓口と実装が
//   自分の届く範囲で確かめる（{@link metaAutoApproveReachFor}）
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectState } from "../project-thread/types.js";

/**
 * **release を人に残す**。Configuration の鍵（文字列 `"human"`、**Project にだけ置ける**）。値が無ければ既定の「任せる」——
 * 既定に戻すときは上書きを外す（値を持たない＝任せる。真実を1つにする）。メタ Project でない Project では読まない
 */
export const META_RELEASE_KEY = "metaProject.release";

export type MetaReleasePolicy = "delegate" | "human";

/** メタ Project の任せ方。メタ Project でなければ undefined（何も任せない・何も変えない） */
export interface MetaProjectPermissions {
  /** spec を任せる（いつも true——メタ Project の計画立案そのものに関わるため） */
  spec: true;
  /** LAN の中だけに届く公開を任せる（いつも true）。インターネットに届く公開は人に残す */
  publishLan: true;
  release: MetaReleasePolicy;
}

/** その Project の release の扱い。**Project の層だけ**を読む。値が `"human"` のときだけ人に残す */
export function metaReleasePolicy(config: Pick<RuntimeConfigStore, "layerValue"> | undefined, projectId: string): MetaReleasePolicy {
  return config?.layerValue(META_RELEASE_KEY, projectId) === "human" ? "human" : "delegate";
}

/** その Project の任せ方。**メタ Project だけ**——ほかの Project（チャット・普通の Project）は undefined */
export function metaProjectPermissions(
  config: Pick<RuntimeConfigStore, "layerValue"> | undefined,
  project: Pick<ProjectState, "id" | "kind"> | undefined,
): MetaProjectPermissions | undefined {
  if (project?.kind !== "meta") return undefined;
  return { spec: true, publishLan: true, release: metaReleasePolicy(config, project.id) };
}

/**
 * **LAN の中の公開を聞かずに許可してよいか**——Module への呼び出しに `dev.banto/autoApproveReach` を刻む口（`autoApproveFor` と同じ形）。
 * メタ Project で、判断役の会話でないときだけ `"lan"`。**呼び出しのたびに引く**（Project の種類は変わらないが、判断役かは会話で決まる）
 */
export function metaAutoApproveReachFor(deps: {
  projectThread: Pick<ProjectThreadStore, "getProject">;
  /** 判断役の会話か（判断役の会話の承認は必ず聞く、§4.3。`autoApproveAllFor` と同じ守り） */
  isJudgeThread(threadId: string): boolean;
}): (projectId: string, threadId?: string) => "lan" | undefined {
  return (projectId, threadId) => {
    if (deps.projectThread.getProject(projectId)?.kind !== "meta") return undefined;
    if (threadId && deps.isJudgeThread(threadId)) return undefined;
    return "lan";
  };
}

/** system prompt に入れるメタ Project の権限の節。メタ Project でなければ出さない */
export function metaPermissionsPromptSection(permissions: MetaProjectPermissions): string {
  const release =
    permissions.release === "delegate"
      ? "- release（main から release への取り込み・反映）：任されている。Project の Memory の決まりどおりに進めてよい"
      : "- release（main から release への取り込み・反映）：**人に残す**。行わず、まとめの決めることで人に聞く";
  return [
    "# メタ Project の権限",
    "",
    "この Project はメタ Project で、人は権限を極力あなたに任せている。次の範囲は人に聞かずに自分で決めて進めてよい（まとめの決めることに出さない）：",
    "",
    "- spec（仕様・アーキテクチャの向きの判断）：任されている。決めたら理由と一緒に Memory か Backlog に残す",
    "- LAN の中だけに届く公開（Publish の届く範囲が「この機械だけ」「LAN」）：任されている。承認を待たずに公開される",
    release,
    "",
    "次は**必ず人に残す**。行わず、まとめの決めることで人に聞く：",
    "",
    "- インターネットに届く公開（公開のリポジトリ・公開サイトへの push を含む）",
    "- お金がかかる・お金を動かす操作",
    "- 消す・取り消せない操作",
  ].join("\n");
}
