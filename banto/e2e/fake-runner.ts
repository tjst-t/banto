// **試験用の Runner**（決定・2026-09-20、ユーザー）。実 LLM の代わりに、
// **spec が書いたとおりに動く**。`cli.ts` が `BANTO_FAKE_RUNNER` で読み込む。
//
// **なぜ**：E2E が見たいのは banto 自身の振る舞い（画面・Vault・Module・中継）で
// あって、**モデルがどの tool を選ぶかではない**。実 LLM を引き金にすると
// 「AI がその 180 秒のうちに呼ばなかった」だけで落ちる——2026-09-20 のフル E2E は
// 5回中2回がこれで落ちた（`vault-request-inline`。単独では7回とも緑）。
//
// **偽物にするのは AI だけ。その先は全部本物。**
// tool の実行は SDK のプロセスがやっていたので、ここで肩代わりする——
// **実際に MCP の口へ繋いで呼ぶ**。そうしないと承認カードも受信箱も Canvas も
// 動かず、試験の意味が消える（規則13——繋がっていないものを緑にしない）。
//
// ```
//   指示を読む → assistant の発言を流す
//              → tool なら承認を要求（人の判断を待つ）
//              → 承認されたら**本物の MCP を呼ぶ**
//              → tool_result を流す → 終わる
// ```

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** spec がプロンプトに埋める印。これが無ければ「ひとこと返すだけ」。 */
export const FAKE_RUNNER_MARKER = "[[fake-runner]]";
const MARKER = FAKE_RUNNER_MARKER;

export interface FakePlan {
  /** tool を呼ぶ前に言うこと。 */
  say?: string;
  /** 呼ぶ tool（順に、1つずつ承認を取りながら）。 */
  tools?: Array<{ server: string; name: string; args?: Record<string, unknown> }>;
  /**
   * 読む resource。**読んだ中身をそのまま発言に載せる**——AI が読んで報告した、
   * という形をそのまま再現する。値が混ざっていれば spec がそれを捕まえる
   * （`vault://aliases` に値が出ていないことを見る試験が、そのまま効く）。
   */
  resources?: Array<{ server: string; uri: string }>;
  /** 全部終わってから言うこと。 */
  then?: string;
  /**
   * tool を呼ぶ前に置く間（ミリ秒）。**画面が立ち上がるのを待つ必要がある spec だけ**
   * が指定する。本物の tool 呼び出しには必ず往復の時間がある。
   */
  toolDelayMs?: number;
  /**
   * **`say` を少しずつ流す**（追加・2026-09-21）。合計で何ミリ秒かけるか。
   *
   * 走行中にリロードして繋ぎ直す試験は、**ターンがまだ走っていること**を前提に
   * している。偽物が一瞬で終わると、リロードした時点でもう終わっていて試験に
   * ならない——**本物のモデルは1トークンずつ返す**ので、その時間の幅を模す。
   */
  streamMs?: number;
  /**
   * **banto がモデルに送った文脈を、そのまま発言にする**（追加・2026-09-21）。
   *
   * 「合言葉をそのまま答えて」のような試験は、本物では**モデルが覚えていて
   * 答えてくれること**に賭けていた。偽物では逆に、**banto が実際に何を送ったか**
   * を返せる——**届いたことを直接見る**ほうが強い（モデルの機嫌に依存しない）。
   */
  sayContext?: boolean;
  /**
   * **このターンがどのモデル・effort で走ったかを、そのまま発言にする**（追加・2026-09-23）。
   * 画面で選んだものが Runner まで届いたかを、発言の中身で見る（`thread-model.spec.ts`）。
   */
  sayRuntime?: boolean;
}

/**
 * **選べるモデル**（追加・2026-09-23）。本物は CLI に聞く（`runner/models.ts`）。
 * 形は本物の返り値（実測・2026-09-23）をそのまま縮めたもの——Haiku は effort を持たない。
 */
export async function listModels() {
  return [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus · 既定",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Sonnet · 普段の作業に",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    { value: "haiku", displayName: "Haiku", description: "Haiku · いちばん速い" },
  ];
}

/**
 * プロンプトから指示を読む。
 *
 * **印が無ければ既定の振る舞い**（プロンプトをそのまま読み上げる形で1行返す）
 * ——「この言葉を返して」と頼むだけの spec は、書き換えずに動く。
 */
export function parsePlan(prompt: string): FakePlan {
  const at = prompt.lastIndexOf(MARKER);
  if (at === -1) return { say: defaultReply(prompt) };
  const json = prompt.slice(at + MARKER.length).trim();
  try {
    return JSON.parse(json) as FakePlan;
  } catch (err) {
    // **読めない指示を「たぶんこう」で動かさない**（規則2）。
    // 落とせば spec の書き間違いがその場で分かる
    throw new Error(`fake-runner への指示が読めません: ${json.slice(0, 200)} / ${String(err)}`);
  }
}

/**
 * 印が無いときの返事。**プロンプトが「この語を返して」と書いていたら、その語を返す。**
 *
 * これは推測ではなく**引き写し**——spec が返させたい語をそのまま書いているので、
 * それを読み取って返すだけ。読み取れなければ「はい」を返し、**spec 側が落ちて
 * 気づける**（黙って辻褄を合わせない・規則2）。
 *
 * 「〜とだけ」「〜と1語だけ」「〜と」のどれでも拾う——ここが狭いと、
 * **書き方の揺れだけで落ちる**（2026-09-20、実際に `context-usage` が落ちた）。
 */
function defaultReply(prompt: string): string {
  const quoted = prompt.match(/[「"']([^」"']{1,80})[」"']\s*と[^。\n]{0,8}?(?:返|答)/);
  if (quoted?.[1]) return quoted[1];
  return "はい";
}

interface McpServerConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** SDK が流すメッセージの形を真似る。**banto が読んでいる欄だけ**を埋める。 */
function initMessage(sessionId: string, servers: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    // **ここが健全性の関門**（`relay/health.ts`）——全部 connected でないと
    // banto はターンを止める。偽物でもその関門は通す（素通りさせない）
    mcp_servers: Object.keys(servers).map((name) => ({ name, status: "connected" })),
    tools: [],
    model: "fake-runner",
  };
}

function assistantMessage(sessionId: string, content: unknown[]) {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_fake_${Math.abs(hash(JSON.stringify(content)))}`,
      role: "assistant",
      model: "fake-runner",
      content,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function toolResultMessage(sessionId: string, toolUseId: string, text: string, isError = false) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }], is_error: isError }],
    },
  };
}

function resultMessage(sessionId: string, text: string) {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * **文脈使用量**。SDK の `getContextUsage()` が返す形をそのまま真似る
 * （`apps/frontend/lib/backend/context-usage.ts` が読んでいる欄）。
 *
 * **数値は送ったものから導く**（規則3——でたらめな定数を置かない）。
 * 文字数 ÷ 4 を目安のトークン数とする。0 のままだと画面が
 * 「0 / 0 トークン使用中」になり、**メーターが動いたことを試験できない**。
 */
function contextUsageOf(prompt: string, systemPrompt?: string[], instructions = "") {
  const approx = (s: string) => Math.max(1, Math.ceil(s.length / 4));
  const systemTokens = approx((systemPrompt ?? []).join("\n"));
  // **MCP の `instructions` は Messages の中の添付として数えられる**（本物の SDK の実測・
  // 2026-09-23——`messageBreakdown.attachmentsByType` の `mcp_instructions_delta`）
  const instructionTokens = instructions === "" ? 0 : approx(instructions);
  const promptTokens = approx(prompt) + instructionTokens;
  const totalTokens = systemTokens + promptTokens;
  return {
    totalTokens,
    rawMaxTokens: 200_000,
    categories: [
      { name: "System prompt", tokens: systemTokens },
      { name: "Messages", tokens: promptTokens },
    ],
    mcpTools: [],
    memoryFiles: [],
    messageBreakdown: {
      attachmentsByType: instructionTokens > 0 ? [{ name: "mcp_instructions_delta", tokens: instructionTokens }] : [],
    },
  };
}

/**
 * **繋いだ MCP サーバの `instructions` を集める**（追加・2026-09-23）。本物の SDK は
 * 繋いだときに受け取ってモデルの文脈に入れる（Skill の名前と説明はここで届く、
 * アーキ仕様 §5.6）。偽物も**本物の口に繋いで**受け取る——banto が実際に何を
 * 載せたかを、試験が直接見られるようにする。
 */
async function collectInstructions(servers: Record<string, unknown>): Promise<string> {
  const blocks: string[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const config = raw as McpServerConfig;
    if (!config?.url) continue;
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
    const client = new Client({ name: "fake-runner", version: "0.0.0" });
    try {
      await client.connect(transport);
      const text = client.getInstructions();
      if (text) blocks.push(`## ${name}\n${text}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  return blocks.length > 0 ? `# MCP Server Instructions\n\n${blocks.join("\n\n")}` : "";
}

/** 決定的な id を作るための小さなハッシュ（`Math.random` を使わない）。 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** **本物の resource を読む。** 可視性の検査も本物のまま通る。 */
async function readRealResource(config: McpServerConfig, uri: string): Promise<string> {
  if (!config?.url) throw new Error(`fake-runner: MCP の口が http ではありません: ${JSON.stringify(config)}`);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  const client = new Client({ name: "fake-runner", version: "0.0.0" });
  await client.connect(transport);
  try {
    const res = (await client.readResource({ uri })) as { contents?: Array<{ text?: string }> };
    return (res.contents ?? []).map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** **本物の MCP へ繋いで呼ぶ。** ここが「AI だけ偽物」の要。 */
async function callRealTool(
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  if (!config?.url) throw new Error(`fake-runner: MCP の口が http ではありません: ${JSON.stringify(config)}`);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
  const client = new Client({ name: "fake-runner", version: "0.0.0" });
  await client.connect(transport);
  try {
    const res = (await client.callTool({ name: toolName, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n");
    return { text, isError: res.isError === true };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * `runTurn` と同じ形（`AsyncGenerator<RunTurnEvent, RunnerTurnResult>`）。
 * 型は core 側に依存させない——e2e から core の型を import すると、
 * ビルドの順番に縛られる。**形が違えば cli.ts が読み込んだ時点で壊れる**ので、
 * 黙ってずれることはない。
 */
export async function* runTurn(opts: {
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  mcpServers?: Record<string, unknown>;
  /** banto が組み立てて送る文脈。**届いたかどうかを見るのに使う**。 */
  systemPrompt?: string[];
  /** `auto` は承認を求めず、`default` が求める（`inbox.spec.ts` の前提）。 */
  permissionMode?: string;
  /** 人がこの Thread で選んだモデルと effort（選んでいなければ来ない）。 */
  model?: string;
  effort?: string;
  onToolApprovalRequested?(pending: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    resolve(result: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }): void;
  }): void;
  signal?: AbortSignal;
}): AsyncGenerator<unknown, { sessionId?: string; compactionCount: number; contextUsage?: unknown }> {
  const plan = parsePlan(opts.prompt);
  const servers = opts.mcpServers ?? {};
  // **resume は引き継ぎ、fork は新しい id にする**——banto の Fork の試験が
  // 「親と同じセッションに混ざらない」ことを見ている
  const sessionId =
    opts.resumeSessionId && !opts.forkSession
      ? opts.resumeSessionId
      : `fake-session-${Math.abs(hash(opts.prompt + (opts.resumeSessionId ?? "")))}`;

  // **何を指示され、どのモードで走ったかを残す**（規則4——観測は機構の外に置く）。
  // E2E が落ちたとき、「指示が読めていない」のか「モードが届いていない」のかを
  // ログで切り分けられる
  console.warn(
    `[fake-runner] mode=${opts.permissionMode ?? "(無し)"} model=${opts.model ?? "(既定)"} effort=${opts.effort ?? "(既定)"} plan=${JSON.stringify(plan).slice(0, 200)}`,
  );

  const instructions = await collectInstructions(servers);
  yield { type: "message", message: initMessage(sessionId, servers) };

  if (plan.say) {
    if (plan.streamMs && plan.streamMs > 0) {
      // 行ごとに分けて、合計が streamMs になるよう間を空けて流す
      const lines = plan.say.split("\n");
      const gap = Math.max(1, Math.floor(plan.streamMs / Math.max(1, lines.length)));
      let sofar = "";
      for (const line of lines) {
        if (opts.signal?.aborted) break;
        sofar = sofar === "" ? line : `${sofar}\n${line}`;
        yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text: line }]) };
        await new Promise((r) => setTimeout(r, gap));
      }
    } else {
      yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text: plan.say }]) };
    }
  }

  if (plan.sayRuntime) {
    // **どのモデル・effort で走ったか**を返す——画面で選んだものが届いたかを見る
    const text = `model=${opts.model ?? "(既定)"} effort=${opts.effort ?? "(既定)"}`;
    yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text }]) };
  }

  if (plan.sayContext) {
    // **送られてきた文脈をそのまま返す**——「届いたか」を試験が直接見られる。
    // Global Memory などの差分は **prompt の頭**に積まれる（`turn-runner.ts` が
    // `${turnContext}\n\n${prompt}` を渡す）ので、system prompt だけでは足りない。
    // **指示の印から後ろは落とす**——偽物への指図が会話に出ても意味が無い
    const at = opts.prompt.indexOf(MARKER);
    const visiblePrompt = at === -1 ? opts.prompt : opts.prompt.slice(0, at);
    const text = [...(opts.systemPrompt ?? []), ...(instructions ? [instructions] : []), visiblePrompt].join("\n");
    yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text }]) };
  }

  let lastText = plan.say ?? "";
  for (const [index, call] of (plan.tools ?? []).entries()) {
    if (opts.signal?.aborted) break;
    // **呼び出しごとに一意**（訂正・2026-09-21）。以前は tool 名と順番だけで
    // 作っていたので、**同じ tool を呼ぶ別のターンが同じ id を持った**。
    // 画面は tool 呼び出しの記録を (thread, toolCallId) で引くので、id が衝突すると
    // **別のスレッドの記録を掴んで「見つかりません」になる**——Canvas が開かない、
    // という形で出た。本物の SDK は毎回一意な id を出す（2026-09-21、実測で判明）
    const toolUseId = `toolu_fake_${sessionId}_${index}_${Math.abs(hash(call.name + JSON.stringify(call.args ?? {})))}`;
    // SDK は MCP の tool を `mcp__<server>__<tool>` の名前で扱う
    const qualified = `mcp__${call.server}__${call.name}`;
    const args = call.args ?? {};
    yield {
      type: "message",
      message: assistantMessage(sessionId, [{ type: "tool_use", id: toolUseId, name: qualified, input: args }]),
    };

    // **承認を求めるかどうかは、本物と同じ規則で決める**（規則3——写しを持たない）。
    // SDK は `permissionMode` を見て `canUseTool` を呼ぶか決めており、`auto` では
    // 呼ばない（`inbox.spec.ts` が「auto のままだと承認を求めずに実行される」と
    // 書いているのがその実物）。ここを固定にすると、**どのモードでゲートが効くか**
    // という検証そのものが消える
    const asksHuman = opts.permissionMode === "default";
    let decision: { behavior: string; message?: string } = { behavior: "allow" };
    if (asksHuman) {
      // **承認待ちは「流す」**——banto が判断待ちを立てるのは、コールバックでは
      // なく**流れてきた `approval_requested` を見たとき**（`turn-runner.ts`）。
      // 呼ぶだけで待つと、受け手にイベントが届かないまま両方が止まる
      // （2026-09-21、実際にここで詰まった）。
      // 本物は queue に積んでから待つ——ここでは yield してから待つ形で同じにする
      let settle!: (d: { behavior: string; message?: string }) => void;
      const answered = new Promise<{ behavior: string; message?: string }>((r) => {
        settle = r;
      });
      const pending = { toolCallId: toolUseId, toolName: qualified, input: args, resolve: settle };
      opts.onToolApprovalRequested?.(pending as never);
      yield { type: "approval_requested", pending };
      // ここで止まったまま人の答えを待つ（hold-the-line）
      decision = await answered;
      console.warn(`[fake-runner] 承認の答え: ${JSON.stringify(decision)}`);
      // **答えを受けてすぐ終わらない。** 本物のモデルは、答えが返ってから続きを
      // 書くまでに必ず時間がかかる。偽物が即座に終わると SSE が先に閉じ、
      // 画面が「回答：拒否する」を書き戻す前にターンが消える
      // （2026-09-21、`judgment-deny` がこれで落ちた——**本物では速さに隠れて
      // いた競合**。画面側の直しは別途・notes 参照）
      await new Promise((r) => setTimeout(r, 500));
    }

    if (decision.behavior !== "allow") {
      lastText = `拒否されました: ${decision.message ?? ""}`;
      yield { type: "message", message: toolResultMessage(sessionId, toolUseId, lastText, true) };
      // **断られたら、そう言って終わる**——本物のモデルも一言返す。
      // ここを省くと tool_result だけでターンが即終わり、画面が描き直される
      // 機会が無いまま流れが閉じる（2026-09-21、`judgment-deny` がこれで落ちた）
      yield {
        type: "message",
        message: assistantMessage(sessionId, [
          { type: "text", text: `${qualified} は許可されなかったので、実行していません。` },
        ]),
      };
      continue;
    }

    // **必要な spec だけが間を置く**（`toolDelayMs`）。本物は MCP へ往復するので
    // 必ず時間がかかり、その間に Canvas が立ち上がる。即座に結果を返すと、
    // **tool-input で開いた Canvas がまだ立ち上がる前に tool-result が届く**
    // ——題名だけ出て中身が来ない（2026-09-21、フルスクリーンの Canvas が空になった）。
    // **全体に待ちを足さない**（規則6）——要る spec が要るだけ指定する
    if (plan.toolDelayMs) await new Promise((r) => setTimeout(r, plan.toolDelayMs));

    // **本物を呼ぶ。** 失敗はそのまま tool_result のエラーとして流す
    // （握りつぶさない・規則2——AI から見た失敗の見え方も本物と同じにする）
    try {
      const { text, isError } = await callRealTool(servers[call.server] as McpServerConfig, call.name, args);
      console.warn(`[fake-runner] ${call.name} の結果(先頭120字): ${text.slice(0, 120).replace(/\n/g, " / ")}`);
      lastText = text;
      yield { type: "message", message: toolResultMessage(sessionId, toolUseId, text, isError) };
    } catch (err) {
      lastText = err instanceof Error ? err.message : String(err);
      yield { type: "message", message: toolResultMessage(sessionId, toolUseId, lastText, true) };
    }
  }

  // **resource を読んで、読めた中身を発言にする**
  for (const want of plan.resources ?? []) {
    if (opts.signal?.aborted) break;
    let text: string;
    try {
      text = await readRealResource(servers[want.server] as McpServerConfig, want.uri);
    } catch (err) {
      text = `${want.uri} を読めませんでした: ${err instanceof Error ? err.message : String(err)}`;
    }
    lastText = text;
    yield {
      type: "message",
      message: assistantMessage(sessionId, [{ type: "text", text: `${want.uri}:\n${text}` }]),
    };
  }

  // **結果を報告して終わる**——本物のモデルは tool の出力を読んで一言添える。
  // ここを省くと、記録に残る assistant の発言が**空のまま**になり、
  // 「答えたあとの続きが画面に入る」類の試験が通らない
  // （2026-09-21、`judgment-after-reload` がこれで落ちた）
  if ((plan.tools ?? []).length > 0 && !plan.then) {
    yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text: lastText }]) };
  }

  if (plan.then) {
    lastText = plan.then;
    yield { type: "message", message: assistantMessage(sessionId, [{ type: "text", text: plan.then }]) };
  }

  console.warn(`[fake-runner] ターン終了 session=${sessionId}`);
  yield { type: "message", message: resultMessage(sessionId, lastText) };
  return { sessionId, compactionCount: 0, contextUsage: contextUsageOf(opts.prompt, opts.systemPrompt, instructions) };
}
