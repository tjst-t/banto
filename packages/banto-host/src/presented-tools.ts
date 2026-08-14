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
  // 落ちた職人の未コミットの成果を拾う（work-keep）。ここに無いと、機構が守った取り置きは
  // 「在るのに誰も気づけない」ものになる——実装は全部あったのに一度も発火しなかった
  // 触れる環境と同じ形の穴
  "worker.keeps",
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
   * `kobo.supersede` は**merging / paused のタスクに届く口**である
   * （`Daemon.transition` は `superseded` を `StateMachine.supersede` へ回し、
   * これは終端以外のどの状態からでも通る）。inc-0063 で merging に居座った
   * task-0097 を降ろせなかったのは、この口が提示されていなかったからでもある。
   *
   * `kobo.abandon` も**どの状態のタスクでも畳める**ようになった（PO 裁定 2026-08-14）。
   * 以前は `failed` 専用で、実運用で宙に浮く queued / paused / review-ready には届かず、
   * 実機の工場に14本が凍っていた。**降ろす口は3つとも状態では選ばない。選ぶのは理由**
   * ——別の依頼で置き換えるなら `kobo.supersede`、単に諦めるなら `kobo.abandon`、
   * 失敗ではなく工場の外で決着したなら `kobo.settle`。
   */
  "kobo.abandon",
  /**
   * **工場の外で決着したものを降ろす口**（realign 第2便・imp-0019 の4番）。
   *
   * 足した当初は `kobo.abandon` が failed 専用で、queued / paused / review-ready のまま
   * 中身が別の経路で main に入ったタスクを畳む道が無かった——2026-08-13 の棚卸しで番頭が
   * 実際にここで詰まり、判定を帳簿へ書き戻せず、文書が代わりの記録になった。
   *
   * その穴は PO 裁定 2026-08-14 で `kobo.abandon` が横断遷移になって塞がったが、**口は
   * 残してある**。違いは畳める範囲ではなく**帳簿に何を書くか**——`kobo.settle` は
   * 「失敗ではない（外で着地した／要らなくなった／直接やった）」、`kobo.abandon` は
   * 「諦めた」。混ぜると「どれだけ捨てたか」と「どれだけ工場の外で片付いたか」が
   * 混ざって数えられなくなる。
   *
   * 在庫に足すだけでは足りない。**ここに載せないとモデルには見えない**（決定82）。
   */
  "kobo.settle",
  "kobo.supersede",
  "kobo.amend",
  /**
   * **制御の口**（PO 裁定 2026-08-13・inc-0063）。頻度で選ぶと必ず落ちる——
   * 使うのは工場が壊れたときだけで、平時の呼び出しは 0 回である。それでも渡すのは、
   * **無いと止められない**から：inc-0063 では工場が1分ごとに同じタスクを起票し続け、
   * 番頭には積む口を止める術もキューを止める口も受け持ちを外す口も無かった。
   * 在庫にあっても提示していなければ「無い」のと同じ（決定82）。
   */
  "kobo.projects",
  "kobo.set_merge_queue",
  "kobo.set_watch",
  /**
   * **受け持たせる口**（実地の穴 2026-08-14）。外す `kobo.unregister_project` だけを
   * 提示していて、**入れる口が無かった**——片方だけ渡すのは `kobo.approve` に対して
   * `kobo.send_back` が無かったのと同じ形の欠陥である。
   *
   * SKILL `kobo-onboarding` は「載っていなければ `kobo.register_project` で受け持たせる」と
   * 手順に書いている。道具が無いので、実際には職人に Kobo の生 HTTP
   * （`POST /api/v1/projects`）を叩かせて迂回した。**入れる口と外す口は対で置く。**
   */
  "kobo.register_project",
  "kobo.unregister_project",
  /**
   * 器（決定78・81a）。**何が開けるかを知る口を先に置く**（実地の穴 2026-08-14）。
   *
   * システムプロンプトが「`canvas.list_catalog` says what can be opened」と書いているのに
   * 提示していなかった。`canvas.open` は開くものの名前を知っている前提の口なので、
   * 一覧が無ければ番頭は当て推量で開くか、開くのをやめるかしかない。
   */
  "canvas.list_catalog",
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
  /**
   * **幹を起こす口**（実地の穴 2026-08-14）。番頭のシステムプロンプトにも SKILL
   * `trunk-and-branch` にも「`thread.open_trunk` で幹を起こせ」と書いてあるのに、
   * 提示していなかった。新しい案件（dentaku）の幹を起こせず、番頭は PO に
   * 「画面から作ってください」と頼んだ——**幹の操作は番頭の仕事**（PO 明言）。
   *
   * `thread.open` は既に在る幹の下に**枝**を開く口で、代わりにはならない。
   */
  "thread.open_trunk",
  "thread.open",
  "thread.list",
  "thread.read",
  "thread.send",
  "thread.steer",
  "thread.consult",
  "thread.merge",
  /**
   * **名を付ける口**（実地の穴 2026-08-14）。プロンプトは「`thread.rename` で名前を付けろ」
   * と指示している。無ければ会話は開いたときの仮の題のまま並び、番頭にも PO にも
   * どれが何の話か分からなくなる——迂回は無い（題を変えられるのは画面＝PO の手だけ）。
   */
  "thread.rename",
  /**
   * **終う口**（実地の穴 2026-08-14）。プロンプトは「`thread.close_trunk` で終う」と書き、
   * 畳むときに記憶を横断の層へ持ち出すのもこの口（`carryOut`）。提示していないので、
   * 番頭は自分で起こした幹を自分で終えず、PO の手を借りることになっていた。
   * **起こす口と終う口は対で置く。**
   */
  "thread.close_trunk",
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
  /**
   * **自分を起こし直す口**（実地の穴 2026-08-14）。`kobo.set_watch` と同じで、頻度で選ぶと
   * 必ず落ちる——平時は 0 回である。それでも渡すのは**無いと自分では直せない**から。
   *
   * SKILL `safe-restart` は手順に「`system.restart` を呼ぶ」と書いている。提示していないので、
   * 番頭は職人に Main PID を `kill -9` させて systemd の `Restart=` に拾わせた。番頭を
   * 直すたびに PO か職人の手が要るのは、番頭が自分の面倒を見られないということである。
   */
  "system.restart",
];

/** ドメインごとの一行説明（決定84-5 の散文一覧を組むのに使う）。 */
const DOMAIN_BLURB: Record<string, string> = {
  worker: "delegate hands-on work to a worker, steer it, watch it, close it — your main route (D10)",
  file: "read files in a place; file.write records your own decisions within granted scope",
  artifact: "pull back a result that was offloaded to a bookmark",
  git: "read history in a place (viewing only — no commit/push/branch)",
  kobo: "put work on the factory queue, read it, approve it, send it back",
  canvas: "show things to the user in the conversation; list_catalog says what can be opened",
  thread:
    "run the conversation — raise and close trunks, name them, open branches, read what is happening inside one, steer it mid-flight, consult the trunk, merge back",
  inbox: "the one place to ask the user for a decision",
  place: "see which places you can reach, and ask for write scope",
  env: "run verification in a throwaway environment — the mechanism returns a fact, not a worker's claim (I1)",
  memory: "remember and recall across conversations",
  skill: "read the procedure for a task before doing it",
  handoff: "read a chapter handoff",
  llm: "see which model you are running on (changing it is the user's job, in settings)",
  // 説明が無いドメインは散文一覧に裸の行として出る（決定84-5）。足したら1行足す
  system: "restart the banto host itself when you have changed how it runs",
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
