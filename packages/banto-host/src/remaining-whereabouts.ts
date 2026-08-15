/**
 * imp-0036(d): **所在の無い残作業では枝を畳ませない**（番頭裁定 2026-08-15）。
 *
 * ## なぜ機構が要るのか
 *
 * `thread.merge` の `remaining` は**幹へ流れない**（決定108）。幹に積まれるのは結論1行
 * だけで、幹のターンも起きない（ADR-0025 決定120）。つまり残作業に書いたことは、
 * 番頭が自分から `thread.list` を見に行かない限り**誰にも届かない**。
 *
 * 実際に2度落ちた。①調査だけ終わって直しが存在しない（thread-86）。②**幹の判断が要る
 * 「問い」**が残作業に流れ込み、答えを待っている相手が居るのに約25分放置された（thread-96）。
 * 道具の説明には既に「残作業には所在を持たせろ」と書いてある——**書いてあるだけの規律**
 * だったので、ここで機械にする。
 *
 * ## 判定は緩い。狙いは書式検査ではない
 *
 * 止めたいのは「**何も考えず1行書いて畳む**」であって、書き方の統一ではない。だから
 * **起票 id か、所在を表す語のどちらかが行に含まれていれば通す**（番頭裁定）。
 * 何を所在と見なすかは下の表に**日本語で並べて**ある——正規表現1本に押し込めると、
 * 読んだ人が「何を書けば通るのか」を追えなくなる。
 *
 * ## 断って終わりにしない（D8）
 *
 * 断り文には**直し方**を書く。所在を足す例と、**判断を仰ぐなら `thread.consult` で
 * 枝が生きているうちに聞く**という道（例文まで）。止めるだけでは、番頭は同じ行を
 * 言い換えてもう一度畳みに来る。
 */

/**
 * 起票 id の形（`imp-0036` / `inc-0048` / `task-0091`）。
 *
 * 種別は `work/inbox` の3つに合わせる。桁数は縛らない——番号が4桁を超えたときに
 * 機構が黙って断り始めるのは、いちばん割に合わない壊れ方である。
 */
export const WHEREABOUTS_TICKET_PATTERN = /\b(?:imp|inc|task)-\d+/iu;

/**
 * 職人の `sessionId`（UUID）。「誰が持っているか」がそのまま所在になる唯一の形。
 */
export const WHEREABOUTS_SESSION_ID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

/**
 * **文言による所在**。id を持たない正当な所在（「幹で委譲予定」「PO 判断待ち」）が
 * 書けなくなるので、id だけに縛らない（番頭裁定）。
 *
 * 1語ずつ**なぜ所在なのか**を添える。足す・引くときは、その行が
 * 「どこへ行ったか／誰が持っているか」を言えているかで決めること。
 */
export const WHEREABOUTS_WORDS: ReadonlyArray<{ word: string; why: string }> = [
  { word: "起票", why: "票に化けた＝会話の外に残っている" },
  { word: "委譲", why: "職人・別の会話が持っている" },
  { word: "依頼", why: "誰かに預けた" },
  { word: "引き継", why: "次の誰か・次の枝が持っている" },
  { word: "預け", why: "誰かに預けた" },
  { word: "渡し", why: "渡した先がある（「幹へ渡した」）" },
  { word: "渡す", why: "渡す先がある" },
  { word: "職人", why: "職人が持っている" },
  { word: "worker", why: "職人（英語表記）" },
  { word: "kobo", why: "Kobo のキューに積んだ" },
  { word: "consult", why: "`thread.consult` で幹へ聞いた＝幹が持っている" },
  { word: "仰", why: "判断を仰いだ＝相手の返事待ち" },
  { word: "待ち", why: "誰の返事を待っているかが言えている（「PO 判断待ち」）" },
  { word: "PO", why: "PO が持っている" },
  { word: "幹へ", why: "幹が引き取る" },
  { word: "幹で", why: "幹が引き取る（「幹で委譲予定」）" },
  { word: "取次", why: "取次（inbox）に札を積んだ" },
  { word: "delegate", why: "委譲（英語表記）" },
  { word: "assigned", why: "割り当て先がある（英語表記）" },
  { word: "filed", why: "起票（英語表記）" },
];

/**
 * 語が行に出てくるか。
 *
 * **英字の語は語の切れ目で見る**（`\b`）——`PO` を素の部分一致にすると `pool` や
 * `report` が所在に化ける。日本語には語の切れ目が無いので、そちらは部分一致のまま
 * （「委譲」は「委譲予定」「委譲した」のどれでも当てたい）。
 */
function wordAppears(word: string, line: string): boolean {
  const ascii = /^[\x20-\x7e]+$/u.test(word);
  if (!ascii) return line.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "iu").test(line);
}

/** 1行に所在があるか。id・sessionId・語のいずれか1つで通す（緩く見る）。 */
export function hasWhereabouts(line: string): boolean {
  const text = line.trim();
  if (text === "") return false;
  if (WHEREABOUTS_TICKET_PATTERN.test(text)) return true;
  if (WHEREABOUTS_SESSION_ID_PATTERN.test(text)) return true;
  return WHEREABOUTS_WORDS.some(({ word }) => wordAppears(word, text));
}

/**
 * 空行を落として、所在を欠いている行だけを返す。
 *
 * 数え方は描画（`renderMergeDetail`）・一覧の件数と同じ——空白だけの行は数えない。
 */
export function remainingWithoutWhereabouts(
  remaining: readonly string[]
): string[] {
  return remaining
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !hasWhereabouts(line));
}

/** 所在と見なす語を、断り文にそのまま並べるための1行。 */
function whereaboutsVocabulary(): string {
  return (
    "起票 id（imp-NNNN / inc-NNNN / task-NNNN）・職人の sessionId（UUID）・" +
    WHEREABOUTS_WORDS.map(({ word }) => `「${word}」`).join("")
  );
}

/**
 * 断り文（D8: 直し方まで書く）。
 *
 * 3つを必ず含める：①**どの行**が所在を欠いているか（そのまま引く）②所在を足す**書き方**
 * ③**判断を仰ぐなら `thread.consult`**——枝が生きているうちに聞く道と、その例文。
 */
export function remainingWhereaboutsRefusal(missing: readonly string[]): string {
  return [
    "残作業に**所在の無い行**があるので、この枝は畳めません（imp-0036）。",
    "",
    "所在を欠いている行：",
    ...missing.map((line) => `- 「${line}」`),
    "",
    "**所在**とは、その残作業が**どこへ行ったか**です。`remaining` の各行に足してください。例：",
    '- 「器の寛容化 → imp-0036 として起票した」',
    '- 「残りの直し → 職人 019fbd87-4c21-7b3e-9a55-1f0e2d3c4b5a へ委譲した」',
    '- 「main への取り込み → 幹で委譲予定」',
    "",
    "**判断を仰ぐことなら、残作業に書いても誰にも届きません。**" +
      "`remaining` は幹へ流れず、幹のターンも起きません（ADR-0025 決定120）。" +
      "気づくのは番頭が自分から `thread.list` を見に行ったときだけで、実際に約25分放置されました。",
    "**枝が生きているいま、`thread.consult` で幹へ聞いてください。** 例：",
    '  thread.consult({kind: "question", message: ' +
      '"レビュー環境が task-0026 時点のままです。立て直すか、このまま畳むか決めてください"})',
    "返事を待って畳むか、聞いたこと自体を所在にして" +
      "「thread.consult で幹へ渡した・回答待ち」と書いて畳むか、どちらかにしてください。",
    "",
    `所在と見なす語：${whereaboutsVocabulary()}。`,
  ].join("\n");
}
