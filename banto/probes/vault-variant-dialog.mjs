// 管理画面（vault-directory の manage-app）の「版」と「空」の印を、本物のブラウザで見るプローブ（2026-10-06）。
// 試験用の親ページに画面を iframe で入れ、画面が呼ぶ口（tools/call）には親が決まった答えを返す。
// 走らせ方：node probes/vault-variant-dialog.mjs（packages/modules/vault-directory を組み立ててから）
import { chromium } from "playwright";
import { MANAGE_APP_HTML } from "../packages/modules/vault-directory/dist/manage-app.js";

const answers = {
  listVaults: ["vault-infisical", "vault-local"],
  listAliases: {
    aliases: [
      { implementation: "vault-infisical", name: "PROXMOX_API_HOST", kind: "secret", group: "homelab@prod", variant: "prod", scope: "project", projects: ["P"] },
      { implementation: "vault-infisical", name: "PROXMOX_API_HOST", kind: "secret", group: "homelab", scope: "unbound", projects: [], empty: true },
      { implementation: "vault-infisical", name: "generated/ADGUARD_PASSWORD", kind: "secret", group: "homelab@prod", variant: "prod", scope: "project", projects: ["P"] },
    ],
    failures: [],
  },
  getPlacements: {
    shared: { implementation: "vault-infisical", group: "instance" },
    project: { implementation: "vault-infisical", group: "homelab@prod", baseGroup: "homelab", variant: "prod" },
    vaults: [
      { implementation: "vault-infisical", groups: ["homelab", "instance"], variants: { label: "環境", options: ["dev", "staging", "prod"], default: "dev" } },
      { implementation: "vault-local", groups: ["instance"], variants: null },
    ],
  },
  countVariants: [
    { variant: "dev", filled: 1, total: 5 },
    { variant: "staging", filled: 0, total: 0 },
    { variant: "prod", filled: 5, total: 5 },
  ],
  planProjectPlacement: { current: null, to: {}, moving: [], conflicts: [], blockedAcrossVaults: [], sharedWith: [], strandedIfNotMigrated: [] },
  setProjectPlacement: { ok: true },
};

const host = `<!doctype html><html><body style="margin:0">
<iframe id="app" style="width:1100px;height:900px;border:0"></iframe>
<script>
  window.calls = [];
  const answers = ${JSON.stringify(answers)};
  const frame = document.getElementById("app");
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0" || m.id === undefined || !m.method) return;
    let result;
    if (m.method === "ui/initialize") result = { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#e6e6e6", "--color-background-primary": "#1e1f22" } }, "dev.banto/project": { id: "P", name: "homelab" } } };
    else if (m.method === "tools/call") {
      window.calls.push({ name: m.params.name, args: m.params.arguments });
      const a = answers[m.params.name];
      if (a === undefined) { frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, error: { message: "probe: no answer for " + m.params.name } }, "*"); return; }
      result = { content: [{ type: "text", text: JSON.stringify(a) }] };
    } else result = {};
    frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
  });
  frame.srcdoc = ${JSON.stringify(MANAGE_APP_HTML).replace(/<\//g, "<\\/")};
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 920 } });
page.on("pageerror", (err) => console.log("pageerror:", err.message));
page.on("console", (msg) => { if (msg.type() === "error") console.log("console:", msg.text()); });
await page.setContent(host);
const app = page.frameLocator("#app");
const failures = [];
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failures.push(what); };

await app.locator("#place-summary").waitFor({ state: "visible", timeout: 15000 });
const summary = await app.locator("#place-summary").textContent();
check(summary.includes("homelab（環境 prod）"), `保存先の行に版が出る: ${summary}`);
// 既定の絞り込みは「この Project から使える」——紐付いていない空の行は「すべて」にして見る
await app.locator("tbody tr").first().waitFor({ timeout: 5000 });
check((await app.locator(".empty-badge").count()) === 0, "既定の絞り込み（この Project から使える）では紐付いていない空の行は出ない");
await app.locator("#target-filter").selectOption("all");
await page.waitForTimeout(200);
check((await app.locator(".empty-badge").count()) === 1, "空の印は空の行にだけ出る");
const rowsText = await app.locator("tbody").innerText();
check(rowsText.includes("（環境 prod）"), "一覧のグループの列に版が出る");
await page.screenshot({ path: "/tmp/vault-variant-list.png" });

await app.locator("#open-place").click();
await app.locator("#dlg-place[open]").waitFor({ timeout: 5000 });
await page.waitForFunction(() => window.calls.some((c) => c.name === "countVariants"));
await page.waitForTimeout(300);
check(await app.locator("#place-variant-field").isVisible(), "版を名乗る Vault では版の欄が出る");
check((await app.locator("#place-variant-label").textContent()) === "環境", "欄の呼び名は Vault が名乗ったもの");
check((await app.locator("#place-variant").inputValue()) === "prod", "いまの版が選ばれている");
check((await app.locator("#place-migrate").inputValue()) === "no", "「いまある秘密をどうするか」の既定は「移さない」");
const optColors = await app.locator("#place-variant option").first().evaluate((o) => {
  const cs = getComputedStyle(o);
  return { bg: cs.backgroundColor, fg: cs.color };
});
check(optColors.bg === "rgb(30, 31, 34)" && optColors.fg === "rgb(230, 230, 230)", `暗い画面の選択肢は暗い地に明るい字: ${JSON.stringify(optColors)}`);
check((await app.locator("#place-group").inputValue()) === "homelab", "グループは版を外した名前で選ばれている");
const opts = await app.locator("#place-variant option").allTextContents();
check(opts.some((t) => t.includes("prod") && t.includes("値あり 5／5")) && opts.some((t) => t.includes("dev（既定）") && t.includes("値あり 1／5")), `版ごとの数が添えてある: ${opts.join(" | ")}`);
const plan = (await page.evaluate(() => window.calls)).filter((c) => c.name === "planProjectPlacement").at(-1);
check(plan && plan.args.variant === "prod", "見積もりに版を渡している");
await page.screenshot({ path: "/tmp/vault-variant-dialog.png" });

await app.locator("#place-vault").selectOption("vault-local");
await page.waitForTimeout(200);
check(!(await app.locator("#place-variant-field").isVisible()), "版を名乗らない Vault では版の欄が消える");
await app.locator("#place-vault").selectOption("vault-infisical");
await page.waitForTimeout(300);
await app.locator("#place-variant").selectOption("dev");
await app.locator("#place-migrate").selectOption("no");
await page.waitForTimeout(200);
await app.locator("#place-submit").click();
await page.waitForFunction(() => window.calls.some((c) => c.name === "setProjectPlacement"));
const set = (await page.evaluate(() => window.calls)).find((c) => c.name === "setProjectPlacement");
check(set.args.variant === "dev" && set.args.group === "homelab" && set.args.implementation === "vault-infisical", `変える口に版を渡す: ${JSON.stringify(set.args)}`);

await browser.close();
console.log(failures.length === 0 ? "ALL OK" : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
