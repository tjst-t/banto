// 承認の画面を、banto の色と段・作り物のデータで実ブラウザに出して撮る（見た目の確かめ用。試験ではない）。
//   node scripts/preview-approval.mjs <出力フォルダ>
// 撮るもの：承認前（LAN・インターネット）・Basic を選んだとき・公開後・断った後・実装が断ったとき・暗い画面・狭い幅。
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { APPROVAL_APP_HTML } from "../dist/approval-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const front = join(here, "../../../../apps/frontend");
const out = process.argv[2] ?? "/tmp/publish-approval-preview";
mkdirSync(out, { recursive: true });

const css = readFileSync(join(front, "app/globals.css"), "utf8");
const bantoVars = (sel) => {
  const m = css.match(new RegExp(`${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  const v = {};
  for (const [, k, x] of (m?.[1] ?? "").matchAll(/(--banto-[\w-]+)\s*:\s*([^;]+);/g)) v[k] = x.trim();
  return v;
};
const light = bantoVars(":root");
const dark = { ...light, ...bantoVars(".dark") };
const map = Object.fromEntries(
  [...readFileSync(join(front, "lib/backend/canvas-host-styles.ts"), "utf8").matchAll(/"(--[\w-]+)":\s*"(--banto-[\w-]+)"/g)].map((m) => [m[1], m[2]]),
);
const res = (vars, v) => { let x = v; for (let i = 0; i < 5 && /var\(--banto/.test(x); i++) x = x.replace(/var\((--banto-[\w-]+)\)/g, (_, n) => vars[n] ?? ""); return x; };
const stylesFor = (vars) => Object.fromEntries(Object.entries(map).map(([k, s]) => [k, res(vars, vars[s] ?? "")]).filter(([, v]) => v));

const ID = "79185c56-e17a-47fb-aecb-cdf3b485ed0d";
const schema = {
  type: "object",
  properties: {
    auth: { type: "string", title: "認証", enum: ["none", "basic"], enumNames: ["無し（URL を知っていれば誰でも届く）", "Basic 認証（ユーザー名とパスワード）"], default: "none" },
    username: { type: "string", title: "Basic 認証のユーザー名", default: "banto" },
    password: { type: "string", title: "Basic 認証のパスワード", description: "12文字以上。banto はハッシュ（bcrypt）だけを覚え、ここに書いたものは二度と表示しません", writeOnly: true },
    subdomain: { type: "string", title: "サブドメイン", description: "空なら <サービス名>-<Project の id の先頭8文字>" },
  },
  required: ["auth"],
};
const reachLabel = { lan: "LAN の中", internet: "インターネット（URL を知っている誰でも）" };
const pending = (reach) => ({
  request: { id: ID, state: "pending", projectId: "2ced47c4-d4dc-40f3-a6fe-7d2d86a07b89", service: "probe-web", port: 8765, implementation: "publish-caddy", plannedUrl: "https://probe-web-2ced47c4.banto.tjstkm.net", reach, reachLabel: reachLabel[reach], createdAt: "2026-09-28T01:04:00Z" },
  method: { title: "Caddy のサブドメイン", reach, reachLabel: reachLabel[reach], ready: true, configSchema: schema },
  plan: { url: "https://probe-web-2ced47c4.banto.tjstkm.net", reach, reachLabel: reachLabel[reach] },
});

const harness = (theme, reach, script) => `<!doctype html><html><body style="margin:0;padding:16px;background:${theme === "dark" ? "#16181c" : "#f3f4f6"}">
<div style="border:1px solid #8883;border-radius:12px;overflow:hidden;background:${theme === "dark" ? "#1c1f24" : "#fff"}"><iframe id="f" style="border:0;width:100%;height:40px;display:block"></iframe></div>
<script>
const f = document.getElementById("f");
f.srcdoc = ${JSON.stringify(APPROVAL_APP_HTML).replace(/<\//g, "<\\/")};
const ctx = { theme: ${JSON.stringify(theme)}, styles: { variables: ${JSON.stringify(stylesFor(theme === "dark" ? dark : light))} } };
const data = ${JSON.stringify(pending(reach))};
const script = ${JSON.stringify(script)};
window.addEventListener("message", (e) => {
  const m = e.data; if (!m) return;
  if (m.method === "ui/notifications/size-changed") { f.style.height = m.params.height + "px"; return; }
  if (m.id === undefined) return;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  const text = (o, isError) => reply({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });
  if (m.method === "ui/initialize") {
    reply({ hostContext: ctx });
    setTimeout(() => f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "承認を出しました\\n公開の承認の id：${ID}" }] } }, "*"), 30);
    return;
  }
  if (m.method === "tools/call") {
    const n = m.params.name;
    if (n === "get_publish_request") return text(script === "published" ? { request: { ...data.request, state: "published", url: data.plan.url } } : data);
    if (n === "approve_publish") return script === "refuse" ? text("Basic 認証のパスワードは 12〜72 文字です", true) : text({ state: "published", url: data.plan.url, reach: data.plan.reach, reachLabel: data.plan.reachLabel });
    if (n === "decline_publish") return text({ state: "declined" });
  }
  reply({});
});
</script></body></html>`;

const shots = [
  ["pending-lan", "light", "lan", "", 640],
  ["pending-internet", "light", "internet", "", 640],
  ["basic", "light", "lan", "basic", 640],
  ["refuse", "light", "lan", "refuse", 640],
  ["after-approve", "light", "lan", "approve", 640],
  ["after-decline", "light", "lan", "decline", 640],
  ["pending-dark", "dark", "lan", "", 640],
  ["narrow", "light", "internet", "", 360],
];
const browser = await chromium.launch();
for (const [name, theme, reach, script, width] of shots) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log(name, "err:", e.message));
  await page.setContent(harness(theme, reach, script));
  await page.waitForTimeout(500);
  const fr = page.frames()[1];
  if (script === "basic" || script === "refuse") await fr.click('input[value="basic"]');
  if (script === "refuse") { await fr.fill('input[name="password"]', "short"); await fr.click("#approve"); }
  if (script === "approve") await fr.click("#approve");
  if (script === "decline") await fr.click("#decline");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log(`撮った：${out}`);
