/**
 * **在庫と提示を分ける**（ADR-0019 決定82〜85）。
 *
 * 番頭に登録する道具（在庫）は減らさない。**モデルへ見せる集合（提示）だけを決める**。
 *
 * なぜ分けるか——道具は増える一方で、平坦な一覧の後ろに置かれたものは呼ばれない。
 * 実測で「必要な道具が先頭なら 16/16、39番目なら 0/10」（inc-0057）。一方、道具を
 * **消す**と壊れるものが多い: モジュールの HTTP 面（`module-serve.ts`）は
 * `BantoModule.tools` を引くので GUI が 404 になり、イベントの wire名→論理名の逆引きも
 * 外れる。**隠すが、持っている**——これが決定82。
 *
 * D5: ここに判断ロジックは無い。**どれを見せるかという決定そのもの**（版として固定した表）と、
 * その表から散文の一覧を組む写しだけ。
 * D3: 散文の一覧は提示集合から**導出する**。二重に持たない（表と説明文がずれない）。
 */

import { toWireToolName, type NamespacedToolDefinition } from "@banto/core";

/**
 * **決定83: 番頭に提示する道具**（論理名）。この順に並べる（決定85）。
 *
 * 選ぶ基準は使用頻度ではなく「**番頭に持ってほしいか**」（PO 裁定 2026-08-12）。
 * 頻度は落とす候補を見つけるのに使い、残す判断は役割から行う——頻度で決めると、
 * 「いま少ないだけの道具」が落ちる。
 *
 * **並びは呼び出し実測の降順**（`worker` 42% → `file` 25% → …）。いままでは
 * 呼び出し 0.5% の `llm.*` 19本が 9〜27番目という一等地を占めていた。
 *
 * ここに無い道具は**在庫に残るが、番頭には見えない**。足りないときは委譲する（D10）。
 */
export const PRESENTED_TOOL_NAMES: readonly NamespacedToolDefinition["name"][] = [
  // 委譲——D10 の主経路。呼び出しの42%
  "worker.delegate",
  "worker.steer",
  "worker.attach",
  "worker.events",
  "worker.list",
  "worker.close",
  "worker.wake",
  "worker.stop",
  "worker.models",
  // 場所を読む——判断の材料。25%
  "file.read",
  "file.grep",
  "file.list",
  "file.find",
  "file.stat",
  // 決定38 で開けた番頭の唯一の出力口（決定・起票・記録）。SKILL が前提にしている
  "file.write",
  // 退避した観測の引き戻し（決定47a）
  "artifact.read",
  /**
   * **検証（決定32c）——ADR-0019 の未決①。**
   *
   * 一度「番頭から外す」と裁定されたが**取り下げられた**（PO 2026-08-12）。未決なので
   * **現状のまま提示する**——決めていないことを、絞り込みのついでに実装しない。
   *
   * 外すかどうかは仕分けではなく I1 の設計の話。決定32c と `docs/spec/environment.md:126-127`
   * が「番頭は `env.*` を直接呼べる／職人には渡さない——自分の成果を自分で検証させると
   * I1 が崩れる」と明文で言っており、実測でも番頭の検証手段として動いている
   * （`env.verify` 289回・`env.list` 289回・`env.run` 150回）。**PO 判断待ち。**
   */
  "env.verify",
  "env.list",
  "env.run",
  "env.provision",
  "env.healthcheck",
  "env.teardown",
  "env.deploy",
  "env.collect",
  "env.cleanup",
  "env.teardown_orphan",
  "env.list_profiles",
  "env.events",
  // 閲覧のみ（決定37）
  "git.status",
  "git.diff",
  "git.log",
  "git.show",
  // 工場——**使用頻度で切らない**。消えると番頭は「積み方を知らない」状態になり、
  // 自分で実装を始めてしまう（`bin.ts` のモジュール登録コメント）
  "kobo.enqueue",
  "kobo.list",
  "kobo.task",
  "kobo.approve",
  /**
   * **通さない方の判断**（段2）。`kobo.approve` と対になる口で、片方だけ提示すると
   * 「通す」しか押せない——実際そうなっていて、駄目だと分かったタスクを実装へ戻す道は
   * 契約を書き換える `kobo.amend` しか無かった（報告 A 表 11b）。
   */
  "kobo.send_back",
  "kobo.reopen",
  /**
   * **後始末の口**（inc-0063 の5番）。在庫には最初からあったのに提示していなかった
   * ——その結果、機構は `kobo.task` の失敗欄と `kobo-notice.ts` の助言で
   * 「`kobo.abandon` で畳んでください」「定義を直して `kobo.amend`」と**案内し続けながら、
   * 番頭の手にはその道具が無い**という状態が続いていた。案内と道具の食い違いは、
   * 番頭から見れば「言われたとおりにできない」であって、失敗の理由が分からない。
   *
   * `kobo.supersede` は**唯一 merging / paused のタスクに届く口**でもある
   * （`Daemon.transition` は `superseded` を `StateMachine.supersede` へ回し、
   * これは終端以外のどの状態からでも通る）。inc-0063 で merging に居座った
   * task-0097 を降ろせなかったのは、この口が提示されていなかったからでもある。
   */
  "kobo.abandon",
  "kobo.supersede",
  "kobo.amend",
  /**
   * **制御の口**（PO 裁定 2026-08-13・inc-0063）。頻度で選ぶと必ず落ちる——
   * 使うのは工場が壊れたときだけで、平時の呼び出しは 0 回である。それでも渡すのは、
   * **無いと止められない**から：inc-0063 では工場が1分ごとに同じタスクを起票し続け、
   * 番頭には watcher を止める口もキューを止める口も受け持ちを外す口も無かった。
   * 在庫にあっても提示していなければ「無い」のと同じ（決定82）。
   */
  "kobo.projects",
  "kobo.set_merge_queue",
  "kobo.set_watch",
  "kobo.unregister_project",
  // 器（決定78・81a）
  "canvas.open",
  "canvas.show",
  "canvas.close",
  /**
   * 会話の仕切り（決定77）と、**幹と枝の対話**（決定105〜108・PO指示 2026-08-13）。
   *
   * `thread.read` / `thread.steer` / `thread.consult` は在庫に足すだけでは届かない
   * ——ここに載せないと「番頭の手に無い」のと同じ（決定82）。枝の中が見えない・
   * 途中で方針を渡せない・枝から相談できない、という痛みを開けるための3本なので、
   * 提示から落ちると入れた意味がそのまま消える。
   */
  "thread.open",
  "thread.list",
  "thread.read",
  "thread.send",
  "thread.steer",
  "thread.consult",
  "thread.merge",
  // 判断を求める唯一の口（決定73）
  "inbox.post",
  // 場所と書き込み範囲（決定36・38c）
  "place.list",
  "place.request_write",
  // 記憶——D11。番頭が番頭である理由
  "memory.save",
  "memory.recall",
  "memory.search",
  "memory.forget",
  // 手順の段階的開示。**決定86（束を開く）が依存する**
  "skill.list",
  "skill.read",
  // 章の引き継ぎ（決定47b）
  "handoff.read",
  "handoff.list",
  /**
   * **読み取り1本だけ残す。** 番頭が「いま自分は何で動いているか」を答えられなくなると、
   * モデルの相談そのものができない（実測32回・`llm.*` 19本の中で最多）。
   * 書き換え系18本は設定画面にあるので落とす（決定41c「設定の口は番頭に渡さない」）。
   */
  "llm.list",
];

/** ドメインごとの一行説明（決定84-5 の散文一覧を組むのに使う）。 */
const DOMAIN_BLURB: Record<string, string> = {
  worker: "delegate hands-on work to a worker, steer it, watch it, close it — your main route (D10)",
  file: "read files in a place; file.write records your own decisions within granted scope",
  artifact: "pull back a result that was offloaded to a bookmark",
  git: "read history in a place (viewing only — no commit/push/branch)",
  kobo: "put work on the factory queue, read it, approve it, send it back",
  canvas: "show things to the user in the conversation",
  thread:
    "run the conversation — open branches, read what is happening inside one, steer it mid-flight, consult the trunk, merge back",
  inbox: "the one place to ask the user for a decision",
  place: "see which places you can reach, and ask for write scope",
  env: "run verification in a throwaway environment — the mechanism returns a fact, not a worker's claim (I1)",
  memory: "remember and recall across conversations",
  skill: "read the procedure for a task before doing it",
  handoff: "read a chapter handoff",
};

/** 論理名からドメインを取る（`repo.worktree.add` → `repo`）。 */
function domainOf(name: string): string {
  return name.split(".")[0] ?? name;
}

/**
 * 在庫から提示集合を選ぶ。**表に在る順**（＝決定85 の並び）で返す。
 *
 * 表にあるのに在庫に無い名前は黙って飛ばす——モジュールが立っていない構成
 * （Kobo 無しで番頭だけ動かす等）が正当にあるため。逆に在庫にあって表に無いものは
 * 提示しない。**それが決定82 の要点**。
 */
export function selectPresentedTools(
  inventory: readonly NamespacedToolDefinition[]
): NamespacedToolDefinition[] {
  const byName = new Map(inventory.map((tool) => [tool.name, tool]));
  const picked: NamespacedToolDefinition[] = [];
  for (const name of PRESENTED_TOOL_NAMES) {
    const tool = byName.get(name);
    if (tool) picked.push(tool);
  }
  return picked;
}

/** 提示集合を pi へ渡す wire 名の並びにする（決定22）。 */
export function presentedWireNames(
  inventory: readonly NamespacedToolDefinition[]
): string[] {
  return selectPresentedTools(inventory).map((tool) => toWireToolName(tool.name));
}

/**
 * **決定84-5: システムプロンプトに出す散文の一覧。**
 *
 * いままでは一行も出ていなかった——pi は `promptSnippet` を付けた道具だけを
 * "Available tools" に載せる仕様で、banto はどれにも付けておらず、さらに
 * `systemPromptOverride` を使うため pi 側の組み立て自体が捨てられていた。
 * 結果、**100個の JSON スキーマが案内文なしでぶら下がっていた**。
 *
 * `promptSnippet` は使わない——付けると `setActiveToolsByName` のたびに
 * システムプロンプトが組み直され、キャッシュが余計に切れる（pi 公式が警告）。
 *
 * **道具1本ずつを再掲しない。** 定義はスキーマ側にあるので、二重に載せると
 * 決定84-2（盛らない）に反する——ドメイン単位で数行に留める。
 */
export function renderToolCategories(
  presented: readonly NamespacedToolDefinition[]
): string {
  const byDomain = new Map<string, string[]>();
  for (const tool of presented) {
    const domain = domainOf(tool.name);
    const list = byDomain.get(domain);
    if (list) list.push(tool.name);
    else byDomain.set(domain, [tool.name]);
  }
  if (byDomain.size === 0) return "";

  const lines: string[] = [
    "# Available tools",
    "",
    "These are the groups you have. Reach for them instead of guessing, and instead of",
    "doing the work yourself. If what you need is not here, delegate it to a worker (D10).",
    "",
  ];
  for (const [domain, names] of byDomain) {
    const blurb = DOMAIN_BLURB[domain];
    const head = names.length === 1 ? names[0] : `${domain}.*`;
    lines.push(blurb ? `- **${head}** — ${blurb}` : `- **${head}**`);
  }
  return lines.join("\n");
}
