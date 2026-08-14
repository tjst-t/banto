/**
 * **提示表の番人**（ADR-0019 決定82・83／実地の穴 2026-08-14）。
 *
 * 決定82 で在庫と提示を分けたぶん、食い違いは**黙って**起きる:
 *   1. 表に在庫の無い名前を書いても `selectPresentedTools` は黙って飛ばす
 *      （Kobo 無しの構成を許すため。正しい設計だが、綴り間違いも同じように消える）
 *   2. システムプロンプトや SKILL が「`foo.bar` を呼べ」と書いていても、表に無ければ
 *      番頭の手にはその道具が無い。**在庫に在るかどうかは関係しない**
 *
 * 2 は実地で4つ開いた（2026-08-14）。番頭は自分のプロンプトに「`thread.open_trunk` で
 * 幹を起こせ」と書かれたまま新しい幹を起こせず PO に頼み、SKILL `kobo-onboarding` が案内する
 * `kobo.register_project` の代わりに職人へ生 HTTP を叩かせ、SKILL `safe-restart` の手順にある
 * `system.restart` の代わりに職人へ kill -9 させた。**どれも在庫には在った**。
 * 指示と道具立ての食い違いは、番頭から見れば「言われたとおりにできない」であって、
 * 失敗の理由が分からない——だから機構が見つける。
 *
 * **在庫はソースを読んで組む。** 番頭ホストの道具の一部（`system.restart` など）は
 * `bin.ts` の `main()` の中で直に `defineNamespacedTool` されており、`bin.ts` は import
 * しただけで `main()` が走るので、テストから在庫を組み直すことができない。ここは
 * 「`defineNamespacedTool` で名前が付いている道具」を在庫と見なす——`system.restart` の
 * ような**最も抜けやすい道具ほど、この経路でしか見えない**。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { PRESENTED_TOOL_NAMES } from "@banto/host";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 名前空間つきの道具名（決定9）。`repo.worktree.add` のような3段は使っていない。 */
const TOOL_NAME = /\b([a-z][a-z0-9]*\.[a-z][a-z0-9_]*)\b/g;

/** 各パッケージの `src` 以下の TypeScript を全部集める。 */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
  };
  for (const pkg of fs.readdirSync(path.join(repoRoot, "packages"))) {
    const src = path.join(repoRoot, "packages", pkg, "src");
    if (fs.existsSync(src)) walk(src);
  }
  return found;
}

/**
 * 道具の名前が置かれる場所。`name: "x.y"` の他に、名前を引数で受ける工場のための
 * union（`name: "kobo.set_watch" | "kobo.set_merge_queue"`）も拾う——ここを取りこぼすと
 * 「表に在るのに在庫に無い」と**嘘の赤**が出る。
 */
const NAME_PROPERTY =
  /name:\s*("[a-z][a-z0-9]*\.[a-z][a-z0-9_]*"(?:\s*\|\s*"[a-z][a-z0-9]*\.[a-z][a-z0-9_]*")*)/g;

/**
 * 在庫＝`defineNamespacedTool` で名前が付いている道具。
 *
 * 名前を実行時に組み立てる道具（`createSettingsTools` の `<domain>.settings_read` 等）は
 * ここに出ない。提示していないので今は困らないが、提示するなら組み方を変えること。
 */
function inventoryToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf-8");
    // 無関係な `name:` を数えないための足かせ。道具を定義していないファイルは見ない
    if (!text.includes("defineNamespacedTool")) continue;
    for (const match of text.matchAll(NAME_PROPERTY)) {
      for (const literal of (match[1] as string).matchAll(/"([^"]+)"/g)) {
        names.add(literal[1] as string);
      }
    }
  }
  return names;
}

/**
 * 番頭へ渡る本文（`bin.ts` が組む側）。
 *
 * `SYSTEM_PROMPT` の本体と、会話ごとの立場を足す `describeThread` の両方。目印が消えたら
 * **黙って空を見張る**ことになるので、見つからなければ落とす（I2）。
 */
function stewardPromptText(): string {
  const file = path.join(repoRoot, "packages/banto-host/src/bin.ts");
  const text = fs.readFileSync(file, "utf-8");

  const promptAt = text.indexOf("const SYSTEM_PROMPT = `");
  assert.ok(promptAt >= 0, "bin.ts の SYSTEM_PROMPT が見つからない（番人が何も見ていない）");
  const promptEnd = text.indexOf("`;", promptAt + "const SYSTEM_PROMPT = `".length);
  assert.ok(promptEnd > promptAt, "SYSTEM_PROMPT の終わりが見つからない");

  const threadAt = text.indexOf("function describeThread(");
  assert.ok(threadAt >= 0, "bin.ts の describeThread が見つからない（番人が何も見ていない）");
  const threadEnd = text.indexOf("\n}\n", threadAt);
  assert.ok(threadEnd > threadAt, "describeThread の終わりが見つからない");

  return text.slice(promptAt, promptEnd) + "\n" + text.slice(threadAt, threadEnd);
}

/**
 * 番頭が読める SKILL 本文（`loadBantoSkills` の中核ぶんと、各モジュールが載せるぶん）。
 *
 * 対象は `SKILL.md`——`skills/` 直下の `audit-system.md` 等は Kobo が職人へ渡す本文で、
 * 番頭の道具立ての話ではない。
 */
function skillTexts(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") {
        found.push({ file: path.relative(repoRoot, full), text: fs.readFileSync(full, "utf-8") });
      }
    }
  };
  walk(path.join(repoRoot, "packages"));
  return found;
}

/**
 * **既知の食い違い。表に足すのではなく、文の方を直すべきもの。**
 *
 * 提示から外したのが意図的で、SKILL の案内が番頭ではなく職人向けに書かれている箇所。
 * 放っておくと番人が丸ごと無効になるので、1本ずつ理由を書いて留めておく。
 * **消えたら消えたで落ちる**（下の「札は腐らせない」）——文を直したら、ここからも外す。
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  "repo.list":
    "SKILL `repository` の手順1。repo.* は提示から外してある（既存の受け入れ検証が repo.clone を" +
    "「隠す側」の例として使っている）。番頭は置き場の把握を職人へ委譲する（D10）——" +
    "直すなら SKILL の文の方",
  "repo.clone": "同上。**外に出ていく操作**（D1）なので、番頭の手に置くかどうかは PO の判断",
  "repo.init": "同上",
  "git.blame":
    "SKILL `workspace` の閲覧一覧。git.status / diff / log / show の4本だけを提示している" +
    "（決定37 の閲覧のみ）。5本目6本目を足すかは未決なので、いまは文の方が先走っている",
  "git.branches": "同上",
};

describe("[番人] 提示表と、番頭への指示が食い違わない", () => {
  it("表の道具は全部、在庫に実在する（綴り違い・消えた道具が黙って飛ばされない）", () => {
    const inventory = inventoryToolNames();
    const missing = PRESENTED_TOOL_NAMES.filter((name) => !inventory.has(name));
    assert.deepEqual(
      missing,
      [],
      `提示表に在庫の無い名前がある（selectPresentedTools は黙って飛ばす）: ${missing.join(", ")}`
    );
  });

  it("番頭のシステムプロンプトが名指す道具は、全部提示されている", () => {
    const inventory = inventoryToolNames();
    const presented = new Set<string>(PRESENTED_TOOL_NAMES);
    const named = new Set(
      [...stewardPromptText().matchAll(TOOL_NAME)]
        .map((m) => m[1] as string)
        .filter((name) => inventory.has(name))
    );
    const orphans = [...named].filter(
      (name) => !presented.has(name) && !(name in KNOWN_DIVERGENCES)
    );
    assert.deepEqual(
      orphans,
      [],
      `プロンプトが「使え」と書いているのに番頭の手に無い道具: ${orphans.join(", ")}`
    );
  });

  it("SKILL が名指す道具は、全部提示されている", () => {
    const inventory = inventoryToolNames();
    const presented = new Set<string>(PRESENTED_TOOL_NAMES);
    const offenders: string[] = [];
    for (const { file, text } of skillTexts()) {
      const named = new Set(
        [...text.matchAll(TOOL_NAME)]
          .map((m) => m[1] as string)
          .filter((name) => inventory.has(name))
      );
      const orphans = [...named].filter(
        (name) => !presented.has(name) && !(name in KNOWN_DIVERGENCES)
      );
      if (orphans.length > 0) offenders.push(`${file}: ${orphans.join(", ")}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `SKILL が手順に書いているのに番頭の手に無い道具:\n${offenders.join("\n")}`
    );
  });

  it("既知の食い違いの札は腐らせない（直したら札も外す）", () => {
    const inventory = inventoryToolNames();
    const presented = new Set<string>(PRESENTED_TOOL_NAMES);
    const corpus = [stewardPromptText(), ...skillTexts().map((s) => s.text)].join("\n");
    for (const name of Object.keys(KNOWN_DIVERGENCES)) {
      assert.ok(inventory.has(name), `札の道具が在庫に無い: ${name}`);
      assert.ok(!presented.has(name), `札の道具が提示された。札を外すこと: ${name}`);
      assert.ok(corpus.includes(name), `どの本文も名指していない。札を外すこと: ${name}`);
    }
  });
});
