/**
 * 番頭は置き場のコンテキストファイルを読まない（PO指摘 2026-08-09）。
 *
 * pi の既定は cwd から `CLAUDE.md` / `AGENTS.md` を拾ってシステムプロンプトの後ろへ
 * 継ぎ足す。番頭ホストの cwd は systemd の `WorkingDirectory`＝**banto のインストール先**
 * なので、番頭は毎セッション **banto 自身の開発規約**を読まされていた
 * （実測：システムプロンプト 4,973 文字のうち 4,399 文字）。
 *
 * `CLAUDE.md` は **banto を開発する側**への指示であって、製品としての番頭の人格ではない。
 *
 * **この見張りは banto の CLAUDE.md を名指ししない。** 名指しすると、ファイル名が変わった
 * ときや他の置き場へ入れたときに黙って効かなくなる（inc-0040・inc-0043 と同じ罠）。
 * 見るのは「cwd に置いた物がプロンプトへ入るか」そのもの。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBantoHostSession } from "@banto/host";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";

/** cwd に置いたら拾われてしまう物。pi が見る名前を並べる。 */
const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md"];
const MARKER = "コンテキストファイルの中身が漏れている目印-9f2a";

let cwd: string;

before(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ctx-"));
  for (const name of CONTEXT_FILES) {
    fs.writeFileSync(path.join(cwd, name), `# 開発者向けの規約\n\n${MARKER}\n`, "utf-8");
  }
});

after(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function systemPromptOf(): Promise<string> {
  const model = getModel("anthropic", "claude-opus-4-5");
  assert.ok(model, "組み込みのモデル表から引けること");
  const { session } = await createBantoHostSession({
    systemPrompt: "あなたは番頭です。",
    tools: [],
    cwd,
    model,
    // 完全にメモリ内で閉じる（鍵も網も要らない）
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
    }),
    sessionManager: SessionManager.inMemory(),
  });
  return session.agent.state.systemPrompt;
}

describe("[PO指摘 2026-08-09] 番頭は置き場のコンテキストファイルを読まない", () => {
  it("cwd の CLAUDE.md / AGENTS.md はシステムプロンプトに入らない", async () => {
    const prompt = await systemPromptOf();
    assert.ok(
      !prompt.includes(MARKER),
      "cwd に置いた開発者向けの文書が番頭のプロンプトへ継ぎ足されている" +
        "（pi の既定の context file 探索。`noContextFiles` で切ること）"
    );
    // 継ぎ足しの器そのものも出ない
    assert.ok(!prompt.includes("<project_context>"), "project_context の器ごと出ない");
  });

  it("番頭の人格（渡したシステムプロンプト）は残る", async () => {
    const prompt = await systemPromptOf();
    assert.ok(
      prompt.includes("あなたは番頭です。"),
      "切ったせいで番頭自身の人格まで消えていないこと"
    );
  });

  it("**職人はこの限りではない**（ワークツリーの CLAUDE.md は読ませる）", () => {
    // 職人の cwd はワークツリー＝その案件のリポジトリなので、そこの CLAUDE.md を読むのは
    // 正しい。番頭と同じ扱いにしないことを、配線の側で見張る
    const driver = fs.readFileSync(
      new URL("../../packages/banto-worker-pool/src/pi-rpc-driver.ts", import.meta.url).pathname,
      "utf-8"
    );
    assert.match(driver, /cwd:\s*worktreePath/, "職人はワークツリーで動く");
    assert.ok(
      !/noContextFiles/.test(driver),
      "職人からコンテキストファイルを取り上げてはいけない（案件の規約はそこにある）"
    );
  });
});
