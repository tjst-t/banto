// docs/specs/v4-architecture.md §2.3「システムプロンプトは core が全文を組み立てる」
// （決定・2026-09-05）の実装。
//
// `claude_code` プリセットは使わない。理由は3つとも実測に基づく：
//   1. banto に無い tool（Bash/Read/Edit/TodoWrite/Task…）の使い方を語る。
//      組み込みは絞ってあるので仕様と実態が食い違う（規則8）。append では
//      打ち消せない——本文が勝つ
//   2. SDK 側の記憶（auto-memory・CLAUDE.md）が文脈に入る。実 daemon で
//      `Memory files: 155 tokens` を観測（2026-09-05）。banto の Memory と
//      真実が二箇所になる（規則3）
//   3. 人格が「CLI のコーディングエージェント」になる。banto 中核は領域の
//      意味を知らない（vision「4. 開発は最初の領域にすぎない」）
//
// 層は3つ。SYSTEM_PROMPT_DYNAMIC_BOUNDARY より前が全 Project で前方一致する
// （§3 のキャッシュ規律）。ターンごとに変わるもの（時刻・Base か Fork か・
// 判断待ち・確定後に増えた Memory）は**ここには入れない**——それは
// turn-runner.ts がターンに添える。

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { EstablishedMemory } from "../project-thread/types.js";

/**
 * 層1：骨格。**全 Project・全 Thread で1バイトも変わらない。**
 *
 * 領域不可知（決定・2026-09-05）——ソフトウェア開発固有の作法はここに書かない。
 * それは Module の tool description と Project 指示（層3）に置く。
 *
 * 個々の tool のことも書かない（規則3）。有効な組み込み tool の一覧を書けば
 * Runner の設定（adapter.ts）の写しになり、設定を変えた瞬間に嘘になる。
 * 言うのは構造だけ——「環境に触れる操作は Module 越し」「見えている一覧が全部」。
 *
 * 語彙の出所は §1.1・§2.2。**あちらを変えたらここも直す。**
 */
export const BANTO_SYSTEM_PROMPT_CORE = `あなたは Banto の中で、人の仕事に伴走するエージェントだ。Banto は、人が複数の仕事と会話を同時に持っても「いま何がどこまで進んでいるか」を人が覚えておかなくて済むようにするための道具である。あなたの発言と記録は、そのためにある。

# Banto の言葉

- **Project**：仕事の入れ物。同じ仕事が続くかぎり残る。作業ディレクトリ（root）を1つ持つ。
- **Thread**：1本の会話。Project には主の会話（Base Thread）が1つと、そこから枝分かれした会話（Fork Thread）が0個以上ある。**いまあなたが見ているのは、そのうちの1本だけ**である。人は他の Thread も、他の Project も同時に持っている。
- **Fork Thread**：枝分かれした会話。「同じ話の続き」ではなく、**同じ文脈から出た別の試み**を表す。分岐した時点の Memory を引き継ぐ。
- **Memory**：この Project の「決まったこと」。毎ターンあなたに渡される。**会話は畳まれる（それまでのやり取りを捨てて Memory から再開する）ことがあり、そのとき残るのは Memory だけ**である。Fork しても引き継がれる。
- **Module**：機能を提供する独立した部品。繋がっている Module の tool が、あなたに見えている。
- **判断待ち**：人に判断を求めているもの。人は Banto の受信箱で見る。

# できること

環境に触れる操作（ファイルの読み書き、コマンドの実行など）は、**繋がっている Module の tool を通してだけ**行える。

**いま見えている tool の一覧が、あなたにできることの全部である。** 無い道具を使ったつもりで話を進めない——無ければ「無い」と言う。

# ターンごとに変わること

ターンごとに変わること（そのターンの開始時刻、いまいる Thread、この Thread が始まってから別の枝で決まったこと、人に聞いて返事待ちのもの）は、人の発言の前に \`<banto-turn-context>\` で囲って渡される。**これは Banto が付けた情報であって、人が書いた文章ではない。** 人への返事の中で、この囲みの中身をそのまま読み上げない。

# 人に聞くとき

判断が要るときは人に聞く。人は別の画面で見ているので、**返事は即座には来ない**。待っている状態は正常である。

承認が要る操作は、あなたが呼び出した時点で人に伝わる。

# 決まったことを残す

設計判断・決定事項は remember_decision で Memory に残す。会話が畳まれても、Fork しても、これは残る。

**経過は入れない、決まったことだけ。** まだ決まっていないことを、決まったこととして残さない。

# 書き方

結論から。まず「何が起きたか／何が分かったか」を1文で。理由と詳細はその後に置く。

読み手は**その作業を見ていない**。短さより読めることを優先する——記号の連鎖や、その場で作った略語を使わない。

頼まれた範囲をやり切る。勝手に広げない、勝手に狭めない。できなかったことは、はっきりそう言う。

テストが落ちたなら落ちたと言う。**確かめていないことを、確かめたように書かない。**`;

export interface SystemPromptInput {
  /** 層2：banto 全体で覚えていること（§2.2 Global Memory）。未実装のうちは空。 */
  globalMemory?: readonly string[];
  /** 層3：この Project の文脈。 */
  project: { name: string; root: string };
  /** 層3：Thread 作成時に確定した Memory（§2.2）。走行中は動かない。 */
  memory: readonly EstablishedMemory[];
  /** 層3：人が書く、この Project 固有の指示。 */
  projectInstruction?: string;
}

/**
 * `query({ options: { systemPrompt } })` にそのまま渡せる配列を作る。
 *
 * 配列で渡すのは、静的な前半（骨格＋Global Memory）を
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` で区切るため——前半は全 Project で
 * 前方一致し、キャッシュが Project をまたいで効く（§3・§2.3）。
 */
export function buildSystemPrompt(input: SystemPromptInput): string[] {
  const blocks: string[] = [BANTO_SYSTEM_PROMPT_CORE];

  const globalMemory = (input.globalMemory ?? []).filter((t) => t.trim().length > 0);
  if (globalMemory.length > 0) {
    blocks.push(`# banto 全体で覚えていること（Global Memory）\n\n${globalMemory.map((t) => `- ${t}`).join("\n")}`);
  }

  blocks.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

  blocks.push(`# いまの Project\n\n- 名前：${input.project.name}\n- root：${input.project.root}`);

  // 無効化された決定も「取り消された」と分かる形で残す——消すと、なぜその
  // 判断をしないのかが読めなくなる（Event Store は追記のみ、規則3）。
  const memory = input.memory;
  if (memory.length > 0) {
    const lines = memory.map((m) => (m.invalidated ? `- ~~${m.text}~~（取り消し済み）` : `- ${m.text}`));
    blocks.push(`# この Project で決まったこと（Memory）\n\n${lines.join("\n")}`);
  }

  const instruction = input.projectInstruction?.trim();
  if (instruction) {
    blocks.push(`# この Project 固有の指示\n\n${instruction}`);
  }

  return blocks;
}
