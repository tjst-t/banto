// 画面の見た目を速く確かめる台（E2E より速い輪——規則15）。
// サンプルの仕事を返す偽の親ページに画面（入口・設定）を載せ、幅と明暗を変えてスクリーンショットを撮る。
//
// 色と段は banto と同じものを渡す——`globals.css` の層A から値を読み、banto の対応表
// （`canvas-host-styles.ts`）で標準の名前にする（v4-frontend.md §6.27）。PREVIEW_PLAIN=1 なら渡さない
// （banto の外の host で出る形）。
//
// usage: node scripts/preview-ui.mjs <出力ディレクトリ>   （先に npm run build。PREVIEW_EMPTY=1 で仕事が0件の形）
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { readCanvasStyles } from "../../../../apps/frontend/lib/backend/canvas-host-styles.ts";

const GLOBALS = readFileSync(new URL("../../../../apps/frontend/app/globals.css", import.meta.url), "utf8");
function tokens(selector) {
  const start = GLOBALS.indexOf(`\n${selector} {`);
  const body = GLOBALS.slice(start, GLOBALS.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/^\s*(--banto-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
}
const light = tokens(":root");
const dark = { ...light, ...tokens(".dark") };
const stylesFor = (theme) =>
  process.env.PREVIEW_PLAIN === "1" ? undefined : readCanvasStyles((name) => (theme === "dark" ? dark : light)[name] ?? "").variables;

const out = process.argv[2] ?? "/tmp/subagent-ui-preview";
mkdirSync(out, { recursive: true });
const { RUNS_APP_HTML } = await import("../dist/runs-app.js");
const { CONFIG_APP_HTML } = await import("../dist/config-app.js");

const now = Date.now();
const steps = (list) => list.map(([sec, title, kind]) => ({ at: now - 200_000 + sec * 1000, title, kind }));
const runs = [
  {
    id: "r1", agent: "claude-code", agentTitle: "Claude Code", model: "opus[1m]", status: "running", startedAt: now - 200_000,
    prompt: "テストが落ちている原因を調べて、直せるなら直して。npm test の出力も見て、直したら何を変えたかを短く教えて。",
    toolCalls: [], lastProgress: "ツール：npm test",
    steps: steps([[4, "package.json", "read"], [11, "describe(\"parser\"", "search"], [26, "src/parser.ts", "read"], [58, "npm test -- parser", "execute"], [142, "src/parser.ts", "edit"], [171, "npm test", "execute"]]),
    text: "原因は parser.ts の空行の扱いでした。末尾の空行で",
  },
  {
    id: "r2", agent: "opencode", agentTitle: "OpenCode", model: "opencode-go/qwen3.6-plus", status: "done", startedAt: now - 3_600_000, finishedAt: now - 3_560_000,
    prompt: "README の英語版を README.en.md として書いて。見出しの構成は日本語版と同じにして。",
    toolCalls: [], steps: steps([[3, "README.md", "read"], [21, "README.en.md", "edit"]]).map((s) => ({ ...s, at: s.at - 3_400_000 })),
    text: "README.en.md を作りました。見出しは日本語版と同じ7つです。用語のうち「受信箱」は Inbox、「判断待ち」は Pending decisions と訳しました。",
    sessionId: "ses_f2e889b26ffezW17pWBmq44H28", cost: { amount: 0.0083, currency: "USD" },
    usage: { inputTokens: 8031, outputTokens: 412, cachedReadTokens: 6120 }, context: { used: 8443, size: 1000000 }, notes: [],
  },
  {
    id: "r3", agent: "claude-code", agentTitle: "Claude Code", status: "error", startedAt: now - 7_200_000, finishedAt: now - 7_180_000,
    prompt: "依存を最新にして、壊れたところを直して", toolCalls: [], steps: [],
    error: "Internal error: Failed to authenticate. API Error: 401\n（banto 本体の Claude ログインのトークンが、途中で期限切れになった可能性があります。sessionId を渡して続きから頼み直してください）",
  },
  {
    id: "r4", agent: "claude-code", agentTitle: "Claude Code", model: "sonnet", status: "cancelled", startedAt: now - 86_400_000, finishedAt: now - 86_380_000,
    prompt: "長い調査", toolCalls: [], steps: steps([[2, "ls -la", "execute"]]).map((s) => ({ ...s, at: s.at - 86_200_000 })),
    stopReason: "cancelled", text: "",
  },
];
const summaries = runs.map((r) => ({
  id: r.id, agent: r.agent, agentTitle: r.agentTitle, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
  lastProgress: r.lastProgress, cost: r.cost, model: r.model, promptHead: r.prompt.slice(0, 80), toolCount: r.steps.length,
  lastStep: r.status === "running" ? r.steps.at(-1) : undefined,
}));
const agents = [
  { id: "claude-code", title: "Claude Code", hostLogin: { loggedIn: true, subscriptionType: "max" } },
  { id: "opencode", title: "OpenCode", keys: ["OPENCODE_API_KEY"] },
];
const credentials = {
  agents: [
    { id: "claude-code", title: "Claude Code", hostLogin: { loggedIn: true, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } },
    {
      id: "opencode", title: "OpenCode", importLabel: "この機械の OpenCode",
      keys: [
        { env: "OPENCODE_API_KEY", alias: "subagent.opencode.OPENCODE_API_KEY", set: true, importable: true },
        { env: "ANTHROPIC_API_KEY", alias: "subagent.opencode.ANTHROPIC_API_KEY", set: false, importable: false },
        { env: "OPENAI_API_KEY", alias: "subagent.opencode.OPENAI_API_KEY", set: false, importable: false },
        { env: "OPENROUTER_API_KEY", alias: "subagent.opencode.OPENROUTER_API_KEY", set: false, importable: true },
      ],
    },
  ],
};
const empty = process.env.PREVIEW_EMPTY === "1";
const tools = {
  listAgents: () => ({ agents }),
  listRuns: () => ({ runs: empty ? [] : summaries }),
  getRun: (a) => runs.find((r) => r.id === a.id),
  getCredentials: () => credentials,
};

const parent = (html, theme, mode) => `<!doctype html><html><body style="margin:0;background:${theme === "dark" ? "#0e1014" : "#f5f6f8"}">
<iframe id="f" style="border:0;width:100vw;height:100vh" srcdoc="${html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>
<script>
const tools = ${JSON.stringify(Object.fromEntries(Object.keys(tools).map((k) => [k, null])))};
window.addEventListener("message", (e) => {
  const m = e.data; if (!m || m.jsonrpc !== "2.0" || m.id === undefined) return;
  const reply = (result) => document.getElementById("f").contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") return reply({ hostContext: { theme: "${theme}", displayMode: "${mode}", styles: ${JSON.stringify({ variables: stylesFor(theme) })} } });
  if (m.method === "tools/call") window.__call(m.params.name, m.params.arguments).then((r) => reply({ content: [{ type: "text", text: JSON.stringify(r) }] }));
});
</script></body></html>`;

const browser = await chromium.launch();
for (const [name, html] of [["runs", RUNS_APP_HTML], ["settings", CONFIG_APP_HTML]]) {
  for (const theme of ["light", "dark"]) {
    for (const width of name === "runs" ? [420, 1000] : [760]) {
      const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2 });
      await page.exposeFunction("__call", (tool, args) => tools[tool](args));
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(parent(html, theme, name === "runs" ? "fullscreen" : "inline"));
      await page.waitForTimeout(800);
      if (name === "runs" && width < 720 && !empty) {
        const f = page.frameLocator("#f");
        await page.screenshot({ path: join(out, `${name}-${theme}-${width}-list.png`) });
        await f.locator('[data-run="r1"]').first().click();
        await page.waitForTimeout(400);
      }
      await page.screenshot({ path: join(out, `${name}-${theme}-${width}.png`) });
      // 広いときは、終わった仕事・失敗した仕事の中身も撮る
      if (name === "runs" && width >= 720 && theme === "light" && !empty) {
        for (const id of ["r2", "r3"]) {
          await page.frameLocator("#f").locator(`[data-run="${id}"]`).first().click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(out, `${name}-${theme}-${width}-${id}.png`) });
        }
      }
      if (errors.length) console.log(name, theme, width, "errors:", errors);
      await page.close();
    }
  }
}
await browser.close();
console.log("wrote", out);
