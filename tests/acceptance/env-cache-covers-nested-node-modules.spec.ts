/**
 * **置き場（cache）は `setup` が書くものを全部覆っていること**（2026-08-15）。
 *
 * docker プロファイルの `setup` は `npm ci --include=dev`。その出力はルートの
 * `node_modules` だけでは終わらない——**巻き上げ（hoist）られない依存は
 * `packages/<pkg>/node_modules` に書かれる**。`package-lock.json` にその場所が
 * `packages/banto-host/node_modules/@anthropic-ai/sdk` のような鍵で並んでいる。
 *
 * 置き場に載っているのがルートの `node_modules` だけだと、入れ子の分の書き先は
 * **ワークツリー側の bind mount（`..:/app`）**になる。置き場は環境より長生きするので、
 *
 *   置き場が温まっている（`.banto-primed` が在る）＋ ワークツリーが素（node_modules 無し）
 *
 * の組み合わせで **`npm ci` が飛ばされ、ルートだけ置き場から現れて入れ子だけが黙って欠ける**。
 * 実測（2026-08-15）：素のワークツリーで `ls node_modules | wc -l` は 350 なのに
 * `packages/banto-host/node_modules` は無く、テストが理由の分からない形で大量に落ちた。
 * **欠けても誰も何も言わない**のが厄介なところなので、機械で見張る（P4）。
 *
 * 見張り方は「ロックが真、compose がそれに追いつく」。入れ子の依存を持つ workspace が
 * 増えた／減ったのは `package-lock.json` を見れば分かるので、そこから求めた集合の全部が
 * compose の mount 先に在ることを確かめる。
 *
 * **YAML パーサは使わない**（D6: 依存を足さない）。ここで見たいのは
 * 「`:/app/packages/<pkg>/node_modules` で終わる行が在るか」という文字列の話でしかなく、
 * 構造を読む必要が無い。素の正規表現なら、落ちたときに「どの行を探して見つからなかったか」
 * がそのまま読める。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** docker ドライバが使う compose ファイル（＝置き場を bind mount で載せている側）。 */
const COMPOSE_FILES = ["docker/test.yaml", "docker/dev.yaml"];

/**
 * `package-lock.json` から「入れ子の `node_modules` を持つ workspace」を求める。
 *
 * 鍵は `packages/<pkg>/node_modules/<dep>` の形。`<pkg>` までを拾って重複を落とす。
 */
function workspacesWithNestedDeps(): string[] {
  const lock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf-8")
  ) as { packages?: Record<string, unknown> };
  const found = new Set<string>();
  for (const key of Object.keys(lock.packages ?? {})) {
    const m = /^(packages\/[^/]+)\/node_modules\//.exec(key);
    if (m) found.add(m[1]!);
  }
  return [...found].sort();
}

describe("置き場は setup が書く node_modules を全部覆う", () => {
  it("入れ子の依存を持つ workspace は、compose の mount 先に在る", () => {
    const workspaces = workspacesWithNestedDeps();
    // ロックが空になったら見張りが空回りする。**そのことに気づけるように**先に断る
    assert.ok(
      workspaces.length > 0,
      "package-lock.json に packages/<pkg>/node_modules/... の鍵が1つも無い。" +
        "巻き上げの都合が変わったか、この見張りが読む場所を間違えている"
    );

    for (const composeRel of COMPOSE_FILES) {
      const composePath = path.join(repoRoot, composeRel);
      const text = fs.readFileSync(composePath, "utf-8");
      // コメント行は数えない（このファイル群は「なぜ」がびっしり書いてあるので、
      // 説明として書いたパスを mount と読み違えないようにする）
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => !l.startsWith("#"));

      for (const ws of workspaces) {
        const target = `/app/${ws}/node_modules`;
        // 短い記法（`<host>:<container>[:opts]`）の mount 行を探す。
        // 終端 or `:ro` 等のオプションが続く形だけを当てる
        const mounted = lines.some((l) =>
          new RegExp(`:${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:[a-z,]+)?$`).test(l)
        );
        assert.ok(
          mounted,
          `${composeRel} が ${target} を置き場で覆っていない。\n` +
            `${ws} は巻き上げられない依存を持つ（package-lock.json に ` +
            `${ws}/node_modules/... の鍵が在る）ので、npm ci はそこへ書く。\n` +
            `置き場が覆っていないと、置き場が温まっている（.banto-primed が在る）` +
            `ワークツリーでは setup が飛ばされ、**この入れ子の依存が黙って欠けて` +
            `意味不明にテストが落ちる**。\n` +
            `直し方: ${composeRel} の volumes に\n` +
            `  - \${BANTO_CACHE_DIR:-./.banto-node-modules}/pkg-${path.basename(ws)}:${target}\n` +
            `を足し、meta/environments.yaml の該当プロファイルの cache.key に ${composeRel} が` +
            `入っていること（配置が変われば置き場は別物であるべき）も確かめること。`
        );
      }
    }
  });

  it("compose ごとに置き場の小部屋は重ならない", () => {
    // 同じ小部屋を2箇所に載せると、ルートと入れ子が同じ中身を指して壊れる。
    // **足すときに間違えやすい形**なので、ここで断っておく
    for (const composeRel of COMPOSE_FILES) {
      const text = fs.readFileSync(path.join(repoRoot, composeRel), "utf-8");
      const sources = [...text.matchAll(/^\s*-\s+(\$\{BANTO_CACHE_DIR[^}]*\}\/[\w-]+):/gm)].map(
        (m) => m[1]!
      );
      assert.ok(sources.length > 0, `${composeRel} に置き場の mount が1つも無い`);
      assert.equal(
        new Set(sources).size,
        sources.length,
        `${composeRel} が同じ置き場の小部屋を2度載せている: ${sources.join(", ")}`
      );
    }
  });
});
