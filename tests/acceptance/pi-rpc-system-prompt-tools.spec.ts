/**
 * imp-0004: `SpawnOptions` の systemPrompt と tools が、本当に pi へ届くこと。
 *
 * 直す前は `PiRpcDriver` がどちらも読んでおらず、
 *   - 職人の立場を伝える文面（記憶を持たない等）がどこにも届かず、
 *   - `worker.delegate` の tools 指定が黙って無視され、「調べるだけ」のつもりの委譲でも
 *     職人が write / bash を持っていた
 * という状態だった。どちらも「動いているように見える」ので、偽ドライバでは検出できない。
 *
 * そのため、引数の組み立て（速い・偽CLI）と**実プロセスでの効き目**（本物の pi）の
 * 両方を見る。後者が本題——渡した引数が pi の中で何に化けたかは、本物にしか聞けない。
 * LLM は呼ばない：pi は起動時（session_start）に道具とシステムプロンプトを確定させるので、
 * そこで拡張から書き出させれば足りる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PiRpcDriver } from "@banto/worker-pool";

// ── 偽CLI：渡された argv を書き出して即終了する ─────────────────────────────

const CAPTURE_SCRIPT = `
import * as fs from "node:fs";
const dest = process.env["CAPTURE_FILE"];
if (dest) fs.writeFileSync(dest, JSON.stringify(process.argv.slice(2)));
setTimeout(() => process.exit(0), 50);
`;

/**
 * 本物の pi に載せる覗き見用の拡張。
 *
 * `session_start` の時点で、pi が確定させた道具の一覧とシステムプロンプトを書き出す。
 * 自前の Tool も1つ登録する——`--tools` は組み込みだけでなく拡張の Tool にも効くので、
 * 「絞ると報告経路まで消える」ことをここで確かめられるようにしておく。
 */
const PROBE_EXTENSION = `
import * as fs from "node:fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される (I4)
export default function (pi: any): void {
  pi.registerTool({
    name: "probe__tool",
    label: "probe.tool",
    description: "覗き見用",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
  pi.on("session_start", (_event: unknown, ctx: any) => {
    const dest = process.env["PROBE_FILE"];
    if (!dest) return;
    fs.writeFileSync(dest, JSON.stringify({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
      tools: pi.getAllTools().map((t: any) => t.name),
      systemPrompt: ctx.getSystemPrompt(),
    }));
  });
}
`;

let tmpDir: string;
let captureScriptPath: string;
let probeExtensionPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-imp0004-"));
  captureScriptPath = path.join(tmpDir, "capture.mjs");
  fs.writeFileSync(captureScriptPath, CAPTURE_SCRIPT, "utf8");
  probeExtensionPath = path.join(tmpDir, "probe.ts");
  fs.writeFileSync(probeExtensionPath, PROBE_EXTENSION, "utf8");
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return fs.existsSync(filePath);
}

/** 環境変数を子プロセスに渡すために一時的に置く（spawn 時点の環境を引き継ぐため）。 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 偽CLIで1回 spawn し、渡された argv を返す。 */
async function captureArgs(
  name: string,
  opts: { systemPrompt: string; tools: string[] }
): Promise<string[]> {
  const sessionDir = path.join(tmpDir, name, "sessions");
  const worktreePath = path.join(tmpDir, name, "wt");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  const captureFile = path.join(tmpDir, `${name}.json`);

  const driver = new PiRpcDriver({ piCliPath: captureScriptPath, sessionBaseDir: sessionDir });

  await withEnv({ CAPTURE_FILE: captureFile }, async () => {
    // 偽CLIは即終了するので spawn は失敗する。見たいのは argv だけ
    const spawned = driver
      .spawn({
        taskId: name,
        worktreePath,
        sessionPath: path.join(sessionDir, `${name}.jsonl`),
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
      })
      .catch(() => undefined);
    await waitForFile(captureFile, 3000);
    await spawned;
  });

  assert.ok(fs.existsSync(captureFile), `偽CLIが起動していない: ${captureFile}`);
  return JSON.parse(fs.readFileSync(captureFile, "utf8")) as string[];
}

describe("[imp-0004] spawn 引数の組み立て", () => {
  it("[imp-0004] systemPrompt は --append-system-prompt として渡る", async () => {
    const args = await captureArgs("args-prompt", {
      systemPrompt: "あなたは banto の職人です。",
      tools: [],
    });

    const at = args.indexOf("--append-system-prompt");
    assert.notEqual(at, -1, `--append-system-prompt が無い: ${args.join(" ")}`);
    assert.equal(args[at + 1], "あなたは banto の職人です。");
    // 差し替えではない：pi の既定プロンプト（道具の一覧と作法）を奪わない
    assert.ok(!args.includes("--system-prompt"), "既定プロンプトを差し替えてはいけない");
  });

  it("[imp-0004] systemPrompt が空なら何も足さない", async () => {
    const args = await captureArgs("args-noprompt", { systemPrompt: "", tools: [] });
    assert.ok(
      !args.includes("--append-system-prompt"),
      `空の追記を渡してはいけない: ${args.join(" ")}`
    );
  });

  it("[imp-0004] tools は --tools のカンマ区切りとして渡る", async () => {
    const args = await captureArgs("args-tools", {
      systemPrompt: "",
      tools: ["read", "grep", "worker__report"],
    });

    const at = args.indexOf("--tools");
    assert.notEqual(at, -1, `--tools が無い: ${args.join(" ")}`);
    assert.equal(args[at + 1], "read,grep,worker__report");
  });

  it("[imp-0004] tools が空なら --tools を渡さない（ランタイムの既定のまま）", async () => {
    const args = await captureArgs("args-notools", { systemPrompt: "", tools: [] });
    // 空の許可リストを渡すと道具が1つも無い職人になる
    assert.ok(!args.includes("--tools"), `空の許可リストを渡してはいけない: ${args.join(" ")}`);
  });
});

// ── 実プロセス（本物の pi）─────────────────────────────────────────────────

/**
 * 本物の pi を起こし、覗き見用の拡張が書き出した「pi の中で確定した姿」を返す。
 *
 * PI_OFFLINE=1：起動時のネットワーク確認を止める（テストは外に出ない）。
 * LLM は呼ばない——プロンプトを送らないので推論は始まらない。
 */
async function inspectRealPi(
  name: string,
  opts: { systemPrompt: string; tools: string[] }
): Promise<{ tools: string[]; systemPrompt: string }> {
  const sessionDir = path.join(tmpDir, name, "sessions");
  const worktreePath = path.join(tmpDir, name, "wt");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  const probeFile = path.join(tmpDir, `${name}-probe.json`);

  const driver = new PiRpcDriver({
    sessionBaseDir: sessionDir,
    extensionPath: probeExtensionPath,
  });

  await withEnv({ PROBE_FILE: probeFile, PI_OFFLINE: "1" }, async () => {
    const handle = await driver.spawn({
      taskId: name,
      worktreePath,
      sessionPath: path.join(sessionDir, `${name}.jsonl`),
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
    });
    try {
      const appeared = await waitForFile(probeFile, 15_000);
      assert.ok(appeared, `pi が起動して拡張が走らなかった: ${probeFile}`);
    } finally {
      await driver.kill(handle.sessionId);
    }
  });

  return JSON.parse(fs.readFileSync(probeFile, "utf8")) as {
    tools: string[];
    systemPrompt: string;
  };
}

describe("[imp-0004] 実プロセスで効いていること", () => {
  it("[imp-0004] systemPrompt が本物の pi のシステムプロンプトに入る", async () => {
    const marker = "あなたは banto の職人です。あなたは記憶を持ちません。";
    const state = await inspectRealPi("real-prompt", { systemPrompt: marker, tools: [] });

    assert.ok(
      state.systemPrompt.includes(marker),
      "渡した文面が pi のシステムプロンプトに見当たらない（届いていない）"
    );
    // 追記であって差し替えではない：pi の既定プロンプトが残っていること
    assert.match(
      state.systemPrompt,
      /pi/,
      "既定プロンプトごと差し替わっている（道具の説明が失われる）"
    );
  });

  it("[imp-0004] tools を絞ると本物の pi でも書き込み・コマンド実行が消える", async () => {
    const state = await inspectRealPi("real-tools", {
      systemPrompt: "",
      tools: ["read", "grep", "probe__tool"],
    });

    assert.deepEqual(
      [...state.tools].sort(),
      ["grep", "probe__tool", "read"],
      `許可リストの通りにならない: ${state.tools.join(",")}`
    );
    // これが imp-0004 の実害：「調べるだけ」のつもりで渡しても書き換えられていた
    assert.ok(!state.tools.includes("write"), "絞ったのに write が残っている");
    assert.ok(!state.tools.includes("edit"), "絞ったのに edit が残っている");
    assert.ok(!state.tools.includes("bash"), "絞ったのに bash が残っている");
  });

  it("[imp-0004] 許可リストは拡張の Tool にも効く（報告経路が消える理由）", async () => {
    const state = await inspectRealPi("real-tools-ext", {
      systemPrompt: "",
      tools: ["read"],
    });

    // 拡張が登録した probe__tool は、許可リストに書かなければ消える。
    // 報告経路（worker.report / worker.ask）も同じ拡張の Tool なので、
    // 絞るときは WorkerPool が必ず足す（pool.resolveTools）
    assert.deepEqual(state.tools, ["read"], `拡張の Tool が残っている: ${state.tools.join(",")}`);
  });

  it("[imp-0004] tools を渡さなければ pi の既定一式のまま", async () => {
    const state = await inspectRealPi("real-default-tools", { systemPrompt: "", tools: [] });

    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "probe__tool"]) {
      assert.ok(state.tools.includes(name), `既定なら ${name} を持つはず: ${state.tools.join(",")}`);
    }
  });
});
