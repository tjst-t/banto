// 入口の画面を、banto の色と段・作り物のデータで実ブラウザに出して撮る（見た目の確かめ用。試験ではない）。
//   node scripts/preview.mjs <出力フォルダ>
// 親（banto の代わり）は MCP Apps の JSON-RPC に答えるだけ。色と段は apps/frontend の globals.css と
// canvas-host-styles.ts の対応表から、本物と同じ名前・値で渡す。
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { publishedAppHtml } from "../dist/published-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const front = join(here, "../../../../apps/frontend");
const out = process.argv[2] ?? "/tmp/publish-preview";
mkdirSync(out, { recursive: true });

const css = readFileSync(join(front, "app/globals.css"), "utf8");
function bantoVars(selector) {
  const m = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  const vars = {};
  for (const [, k, v] of (m?.[1] ?? "").matchAll(/(--banto-[\w-]+)\s*:\s*([^;]+);/g)) vars[k] = v.trim();
  return vars;
}
const light = bantoVars(":root");
const dark = { ...light, ...bantoVars(".dark") };
const map = Object.fromEntries(
  [...readFileSync(join(front, "lib/backend/canvas-host-styles.ts"), "utf8").matchAll(/"(--[\w-]+)":\s*"(--banto-[\w-]+)"/g)].map((m) => [m[1], m[2]]),
);
const resolve = (vars, v) => { let x = v; for (let i = 0; i < 5 && /var\(--banto/.test(x); i++) x = x.replace(/var\((--banto-[\w-]+)\)/g, (_, n) => vars[n] ?? ""); return x; };
const stylesFor = (vars) => Object.fromEntries(Object.entries(map).map(([k, s]) => [k, resolve(vars, vars[s] ?? "")]).filter(([, v]) => v));

const P = "2ced47c4-d4dc-40f3-a6fe-7d2d86a07b89";
const data = {
  full: {
    published: [
      { service: "web", port: 5173, url: "https://web-2ced47c4.banto.tjstkm.net", reach: "lan", reachLabel: "LAN の中", auth: "none", state: "active", method: "publish-caddy", methodTitle: "Caddy のサブドメイン", createdAt: "" },
      { service: "api", port: 8080, url: "https://api-2ced47c4.banto.tjstkm.net", reach: "lan", reachLabel: "LAN の中", auth: "basic", username: "banto", state: "not-listening", method: "publish-caddy", methodTitle: "Caddy のサブドメイン", createdAt: "" },
      { service: "docs", port: 3000, url: "https://docs-2ced47c4.banto.tjstkm.net", reach: "internet", reachLabel: "インターネット（URL を知っている誰でも）", auth: "basic", username: "banto", state: "active", method: "publish-caddy", methodTitle: "Caddy のサブドメイン", createdAt: "" },
    ],
    pending: [{ requestId: "x", service: "storybook", port: 6006, method: "publish-caddy", plannedUrl: "https://storybook-2ced47c4.banto.tjstkm.net", reach: "lan", reachLabel: "LAN の中", createdAt: "" }],
    methods: [{ name: "publish-caddy", title: "Caddy のサブドメイン", reach: "lan", reachLabel: "LAN の中", ready: true }],
    unpublished: [
      { name: "worker", port: 9229, listening: true, state: "running" },
      { name: "db-admin", port: 8081, listening: false, state: "crashed" },
    ],
  },
  empty: { published: [], pending: [], methods: [{ name: "publish-caddy", title: "Caddy のサブドメイン", reach: "lan", ready: true }], unpublished: [{ name: "web", port: 5173, listening: true, state: "running" }] },
};

const harness = (theme, variant) => `<!doctype html><html><body style="margin:0;background:${theme === "dark" ? "#16181c" : "#fff"}">
<iframe id="f" style="border:0;width:100%;height:100vh"></iframe>
<script>
const html = ${JSON.stringify(publishedAppHtml()).replace(/<\//g, "<\\/")};
const f = document.getElementById("f");
f.srcdoc = html;
const ctx = { theme: ${JSON.stringify(theme)}, displayMode: "fullscreen", styles: { variables: ${JSON.stringify(stylesFor(theme === "dark" ? dark : light))} }, "dev.banto/project": { id: ${JSON.stringify(P)}, name: "Banto開発" } };
const data = ${JSON.stringify(data[variant])};
window.addEventListener("message", (e) => {
  const m = e.data; if (!m || m.id === undefined) return;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  if (m.method === "ui/initialize") return reply({ hostContext: ctx });
  if (m.method === "tools/call") return reply({ content: [{ type: "text", text: JSON.stringify(data) }] });
  reply({});
});
</script></body></html>`;

const browser = await chromium.launch();
for (const [name, theme, variant, width] of [["full-light", "light", "full", 760], ["full-dark", "dark", "full", 760], ["narrow", "light", "full", 380], ["empty", "light", "empty", 760]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(harness(theme, variant));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: false });
  await page.close();
}
await browser.close();
console.log(`撮った：${out}`);
