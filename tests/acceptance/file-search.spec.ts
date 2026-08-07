/**
 * task-0068: 探す道具が「一部しか見ていない」のをやめる（PO報告 2026-08-07）。
 *
 * 元の `file.grep` は自前でツリーを歩き、**上限に達したら走査ごと打ち切って**、
 * あと何件あるかを言わなかった。少なく返っているのに、返り値だけ見ると全部に見える。
 *
 * ここで確かめるのは2つ：
 *
 *   1. **3つの経路（rg / grep / 自前）が同じ結果を返す。** 同じ問いを3つの実装へ投げて
 *      突き合わせる——道具ごとの癖（隠しファイルの扱い・除外の書き方）で結果が変わると、
 *      どれが動いているかで答えが変わる
 *   2. **上限で切ったときに総数を返す。** 「打ち切り」だけでは取りこぼしに気づけない
 *
 * rg はこの機械に入っていないことがある。**入っていなければその経路は飛ばし、飛ばした
 * ことを出力に残す**——通ったふりをしない（I1）。`BANTO_RIPGREP_BIN` で到達先を差せる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createFileTools } from "../../packages/banto-host/src/file-tools.js";
import {
  forgetSearchBinaries,
  resolveSearchBinaries,
  type SearchEngine,
} from "../../packages/banto-host/src/file-search.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

let root: string;

/** 使える経路。rg が無ければ ripgrep は外れる（飛ばしたことは下で出す）。 */
let engines: SearchEngine[];

before(() => {
  forgetSearchBinaries();
  const bins = resolveSearchBinaries(true);
  engines = ["builtin"];
  if (bins.grep) engines.unshift("grep");
  if (bins.ripgrep) engines.unshift("ripgrep");
  if (!bins.ripgrep) {
    console.log("[file-search.spec] ripgrep が無いので rg 経路は未検証（BANTO_RIPGREP_BIN で差せる）");
  }
  if (!bins.grep) {
    console.log("[file-search.spec] grep が無いので grep 経路は未検証");
  }

  root = fs.mkdtempSync(path.join(os.tmpdir(), "file-search-"));
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });

  // 一致が散らばるように、複数のファイル・複数の階層へ置く
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(
      path.join(root, "src", `a${i}.ts`),
      `// header\nexport const NEEDLE_${i} = 1;\nconst other = "needle lower";\n`,
      "utf-8"
    );
  }
  fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "NEEDLE_deep\nNEEDLE_deep\n", "utf-8");
  fs.writeFileSync(path.join(root, "src", "notes.md"), "NEEDLE_md\n", "utf-8");
  // 既定では見に行かない場所。includeHidden でだけ出る
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "c.ts"), "NEEDLE_dep\n", "utf-8");
  fs.writeFileSync(path.join(root, ".hidden", "d.ts"), "NEEDLE_hidden\n", "utf-8");
  fs.writeFileSync(path.join(root, ".dotfile.ts"), "NEEDLE_dotfile\n", "utf-8");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  forgetSearchBinaries();
});

function toolsFor(engine: SearchEngine): NamespacedToolDefinition[] {
  return createFileTools(root, { engine });
}

async function invoke(
  engine: SearchEngine,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = toolsFor(engine).find((t) => t.name === name);
  assert.ok(tool, `${name} が無い`);
  const result = await tool!.execute(args as never, { toolCallId: "test" });
  return (result.details ?? {}) as Record<string, unknown>;
}

interface GrepDetails {
  hits: Array<{ path: string; line: number; text: string }>;
  total: number;
  totalExact: boolean;
  truncated: boolean;
  engine: SearchEngine;
}

async function grep(engine: SearchEngine, args: Record<string, unknown>): Promise<GrepDetails> {
  return (await invoke(engine, "file.grep", args)) as unknown as GrepDetails;
}

describe("[task-0068/a5] 3つの経路が同じ結果を返す", () => {
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "素の検索", args: { pattern: "NEEDLE_", limit: 500 } },
    { name: "glob で絞る", args: { pattern: "NEEDLE_", glob: "*.ts", limit: 500 } },
    { name: "大文字小文字を無視", args: { pattern: "needle_", ignoreCase: true, limit: 500 } },
    { name: "隠しも探す", args: { pattern: "NEEDLE_", includeHidden: true, limit: 500 } },
    { name: "始点を絞る", args: { pattern: "NEEDLE_", path: "src/deep", limit: 500 } },
    { name: "選択肢のある正規表現", args: { pattern: "NEEDLE_deep|NEEDLE_md", limit: 500 } },
  ];

  for (const c of cases) {
    it(`${c.name}：どの道具で探しても同じ`, async () => {
      const results = await Promise.all(
        engines.map(async (engine) => ({ engine, details: await grep(engine, c.args) }))
      );
      // どの道具が動いたかは返り値に出る（方言が揃わなかったときに追える）
      for (const { engine, details } of results) {
        assert.equal(details.engine, engine, "頼んだ道具と違うもので探している");
      }
      const key = (d: GrepDetails): string =>
        d.hits
          .map((h) => `${h.path}:${h.line}`)
          .sort()
          .join(",");
      const first = results[0]!;
      for (const other of results.slice(1)) {
        assert.equal(
          other.details.total,
          first.details.total,
          `件数が違う: ${first.engine}=${first.details.total} ${other.engine}=${other.details.total}`
        );
        assert.equal(
          key(other.details),
          key(first.details),
          `一致した行が違う: ${first.engine} と ${other.engine}`
        );
      }
    });
  }

  it("既定では node_modules と隠しへ降りない（どの道具でも）", async () => {
    for (const engine of engines) {
      const details = await grep(engine, { pattern: "NEEDLE_", limit: 500 });
      const paths = details.hits.map((h) => h.path).join("\n");
      assert.doesNotMatch(paths, /node_modules/, engine);
      assert.doesNotMatch(paths, /\.hidden/, engine);
      assert.doesNotMatch(paths, /\.dotfile/, engine);
    }
  });

  it("includeHidden なら降りる（どの道具でも）", async () => {
    for (const engine of engines) {
      const details = await grep(engine, { pattern: "NEEDLE_", includeHidden: true, limit: 500 });
      const paths = details.hits.map((h) => h.path).join("\n");
      assert.match(paths, /node_modules/, engine);
      assert.match(paths, /\.hidden/, engine);
      assert.match(paths, /\.dotfile/, engine);
    }
  });
});

describe("[task-0068/a2] 上限で切ったら総数を返す", () => {
  it("何件のうち何件を出したかが返る（「打ち切り」だけにしない）", async () => {
    for (const engine of engines) {
      const all = await grep(engine, { pattern: "NEEDLE_", limit: 500 });
      const few = await grep(engine, { pattern: "NEEDLE_", limit: 5 });

      assert.equal(few.hits.length, 5, engine);
      assert.equal(few.truncated, true, engine);
      assert.equal(
        few.total,
        all.total,
        `${engine}: 上限で切ると総数まで減っている（見落とした数が分からない）`
      );
      assert.equal(few.totalExact, true, engine);
    }
  });

  it("上限を超える limit を頼める（元は 200 で頭打ちだった）", async () => {
    const tool = toolsFor("builtin").find((t) => t.name === "file.grep")!;
    const result = await tool.execute({ pattern: "NEEDLE_", limit: 1000 } as never, {
      toolCallId: "t",
    });
    const details = (result.details ?? {}) as unknown as GrepDetails;
    // 全部で 33 件（30 + deep 2 + md 1）。200 で頭打ちなら区別が付かないので、
    // 「頼んだ数まで返る」ことを total と hits の一致で見る
    assert.equal(details.hits.length, details.total);
    assert.equal(details.truncated, false);
  });

  it("見つからなかったことと、切ったことを混同しない", async () => {
    for (const engine of engines) {
      const details = await grep(engine, { pattern: "ZZZ_NOT_THERE", limit: 500 });
      assert.equal(details.hits.length, 0, engine);
      assert.equal(details.total, 0, engine);
      assert.equal(details.truncated, false, engine);
    }
  });
});

describe("[task-0068/a1] 到達先が無くても黙って0件にしない（I2）", () => {
  it("rg も grep も無ければ自前の走査に落ちる", async () => {
    // 到達先を「無い」ものに差して、選び直させる
    const prevRg = process.env["BANTO_RIPGREP_BIN"];
    const prevGrep = process.env["BANTO_GREP_BIN"];
    process.env["BANTO_RIPGREP_BIN"] = "/nonexistent/rg";
    process.env["BANTO_GREP_BIN"] = "/nonexistent/grep";
    forgetSearchBinaries();
    try {
      const bins = resolveSearchBinaries(true);
      assert.equal(bins.ripgrep, null);
      assert.equal(bins.grep, null);

      const tool = createFileTools(root).find((t) => t.name === "file.grep")!;
      const result = await tool.execute({ pattern: "NEEDLE_", limit: 500 } as never, {
        toolCallId: "t",
      });
      const details = (result.details ?? {}) as unknown as GrepDetails;
      assert.equal(details.engine, "builtin", "外の道具が無いのに 0 件で返している");
      assert.ok(details.total > 0, "自前の走査でも見つかること");
    } finally {
      if (prevRg === undefined) delete process.env["BANTO_RIPGREP_BIN"];
      else process.env["BANTO_RIPGREP_BIN"] = prevRg;
      if (prevGrep === undefined) delete process.env["BANTO_GREP_BIN"];
      else process.env["BANTO_GREP_BIN"] = prevGrep;
      forgetSearchBinaries();
      resolveSearchBinaries(true);
    }
  });

  it("壊れた正規表現は、どの道具へ行く前に理由つきで断る", async () => {
    for (const engine of engines) {
      const tool = toolsFor(engine).find((t) => t.name === "file.grep")!;
      await assert.rejects(
        () => tool.execute({ pattern: "([unclosed" } as never, { toolCallId: "t" }),
        /正規表現が壊れています/,
        engine
      );
    }
  });
});

describe("[task-0068] 砦：番頭が書いた文字列がそのまま子プロセスへ行く面", () => {
  it("パターンが旗として読まれない（`--` で始まっても検索語として扱う）", async () => {
    for (const engine of engines) {
      // 一致しないのが正しい。**引数として食われて別の挙動になる**のが困る
      const details = await grep(engine, { pattern: "--version", limit: 10 });
      assert.equal(details.hits.length, 0, engine);
    }
  });

  it("ワークスペースの外は探せない", async () => {
    const tool = toolsFor("builtin").find((t) => t.name === "file.grep")!;
    await assert.rejects(() =>
      tool.execute({ pattern: "NEEDLE_", path: "../.." } as never, { toolCallId: "t" })
    );
  });
});

describe("[task-0068/a4] file.find / file.list も総数を返す", () => {
  it("file.find は全 N 件のうち何件を出したかを返す", async () => {
    const all = (await invoke("builtin", "file.find", { pattern: "*.ts", limit: 1000 })) as unknown as {
      matches: unknown[];
      total: number;
      truncated: boolean;
    };
    const few = (await invoke("builtin", "file.find", { pattern: "*.ts", limit: 3 })) as unknown as {
      matches: unknown[];
      total: number;
      truncated: boolean;
    };
    assert.ok(all.total > 3, "検体が足りない");
    assert.equal(few.matches.length, 3);
    assert.equal(few.truncated, true);
    assert.equal(few.total, all.total, "上限で切ると総数まで減っている");
  });

  it("file.list に limit がある（元は引数すら無かった）", async () => {
    const few = (await invoke("builtin", "file.list", { path: "src", limit: 4 })) as unknown as {
      entries: unknown[];
      total: number;
      truncated: boolean;
    };
    assert.equal(few.entries.length, 4);
    assert.equal(few.truncated, true);
    assert.ok(few.total > 4, "総数が減っている");
  });
});

describe("[task-0068] NUL を含むファイルの扱い（inc-0029）", () => {
  it("先頭だけでなく全体を見てバイナリと判定する（道具の間で食い違わせない）", async () => {
    // 先頭 8000 バイトはテキストで、その後ろに NUL がある——元の判定はこれを取り逃した
    const filler = `${"x".repeat(79)}\n`.repeat(120); // 9600 バイト
    fs.writeFileSync(
      path.join(root, "src", "late-nul.ts"),
      Buffer.concat([Buffer.from(`${filler}NEEDLE_late\n`, "utf-8"), Buffer.from([0]), Buffer.from("\n")])
    );
    try {
      for (const engine of engines) {
        const details = await grep(engine, { pattern: "NEEDLE_late", limit: 50 });
        assert.equal(
          details.hits.length,
          0,
          `${engine}: NUL を含むファイルを読んでいる（rg / grep は飛ばすので結果が食い違う）`
        );
      }
    } finally {
      fs.rmSync(path.join(root, "src", "late-nul.ts"), { force: true });
    }
  });
});
